const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Background scripts: an agent proposes a
// script, the owner approves that exact file, and the scheduler runs it with
// nobody watching. So each run is held to its frozen copy, its own state
// directory, the domains the owner approved, a time limit, bounded output and
// an empty environment, inside Anthropic's sandbox runtime (Seatbelt + proxy).
//
// Each run gets its own helper process (this file, run with HELPER_FLAG) that
// loads the runtime, starts its proxy and spawns the script. The runtime is a
// per-process singleton whose proxy reads one global allowlist, and it hooks
// SIGINT/SIGTERM; keeping it out of the server gives every run its own
// allowlist, lets runs overlap, and closes the proxy when the run ends.

const HELPER_FLAG = '--script-sandbox-helper';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TAIL_BYTES = 4096;
const MAX_INPUT_BYTES = 1024 * 1024;
const FLOOD_FACTOR = 4;

const INTERPRETERS = Object.freeze({
  node: process.execPath,
  python: '/usr/bin/python3',
  sh: '/bin/sh',
  bash: '/bin/bash',
  zsh: '/bin/zsh',
});
// Startup files are read from HOME, which is the writable state directory; a
// run must not be able to plant code the next run executes without asking.
const INTERPRETER_FLAGS = { python: ['-I'], zsh: ['-f'] };

// Everything a user or another program keeps lies under these; the script gets
// back only its own directory. System paths the interpreters need stay readable.
// Also where installed tools keep their own settings and keys: Homebrew's etc
// under /opt and /usr/local, and the system-wide application support and
// preferences (API keys can sit there).
const READ_DENY = ['/Users', '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/Library/Keychains',
  '/opt', '/usr/local', '/Applications', '/Library/Application Support', '/Library/Preferences', '/Library/Managed Preferences',
  '/Library/LaunchAgents', '/Library/LaunchDaemons'];
// A state folder past this size fails the run: nothing else bounds the disk.
const STATE_MAX_BYTES = 200 * 1024 * 1024;
// One file may not grow past this: 100 MB (ulimit -f in /bin/sh, which is bash
// on macOS and counts 1024-byte blocks).
const FILE_BLOCKS = 102400;
// The runtime always lets its children write here; scripts must not share a scratch space.
const WRITE_DENY = ['/tmp/claude', '/private/tmp/claude'];
// An approved name must not lead into the LAN either (loopback and this host are refused by the runtime).
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'];

function argError(message) { return new TypeError(`runScript: ${message}`); }

// Paths go into a Seatbelt profile, where * ? [ are glob syntax.
function checkPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw argError(`${label} must be an absolute path`);
  if (/[\0-\x1f\x7f*?[\]{}]/.test(value)) throw argError(`${label} contains characters that are not allowed`);
  return path.normalize(value);
}

const DOMAIN = /^(\*\.)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
function checkDomains(list) {
  if (!Array.isArray(list) || list.length > 50) throw argError('allowDomains must be an array of at most 50 domains');
  return [...new Set(list.map((d) => {
    const name = typeof d === 'string' ? d.trim().toLowerCase() : '';
    // A wildcard needs at least two labels under it: *.example.com, never *.com.
    if (!DOMAIN.test(name) || (name.startsWith('*.') && name.split('.').length < 3)) throw argError(`allowDomains entry not allowed: ${JSON.stringify(d)}`);
    return name;
  }))];
}

function checkInt(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw argError(`${label} must be an integer in ${min}..${max}`);
  return value;
}

const isAtOrUnder = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

// A bounded window over the newest bytes of a stream.
class Tail {
  constructor(limit) { this.limit = limit; this.chunks = []; this.size = 0; }
  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.limit) this.size -= this.chunks.shift().length;
  }
  text(limit = this.limit) {
    let buf = Buffer.concat(this.chunks);
    if (buf.length > limit) {
      buf = buf.subarray(buf.length - limit);
      let skip = 0; // don't start inside a UTF-8 sequence
      while (skip < 3 && skip < buf.length && (buf[skip] & 0xc0) === 0x80) skip += 1;
      buf = buf.subarray(skip);
    }
    return buf.toString('utf8');
  }
}

function lastJsonObject(stdout) {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line, (key, v) => (key === '__proto__' ? undefined : v));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }
  return null;
}

// Refusals the caller could have avoided throw; everything that depends on the
// machine or the script comes back as {ok:false}.
function prepare(options) {
  if (!options || typeof options !== 'object') throw argError('options are required');
  const { interpreter, allowDomains, timeoutMs, maxOutputBytes, input } = options;
  if (!Object.prototype.hasOwnProperty.call(INTERPRETERS, interpreter)) throw argError(`unknown interpreter ${JSON.stringify(interpreter)}`);
  const scriptFile = checkPath(options.scriptFile, 'scriptFile');
  const stateDir = checkPath(options.stateDir, 'stateDir');
  const domains = checkDomains(allowDomains);
  checkInt(timeoutMs, 1000, 600_000, 'timeoutMs');
  checkInt(maxOutputBytes, 1024, 4 * 1024 * 1024, 'maxOutputBytes');
  let stdin = '';
  if (input !== undefined) {
    stdin = JSON.stringify(input);
    if (typeof stdin !== 'string') throw argError('input must be JSON');
    if (Buffer.byteLength(stdin) > MAX_INPUT_BYTES) throw argError('input is too large');
  }

  let st;
  try { st = fs.lstatSync(scriptFile); } catch { throw argError('scriptFile does not exist'); }
  if (st.isSymbolicLink() || !st.isFile()) throw argError('scriptFile must be a regular file, not a symlink');
  try { st = fs.lstatSync(stateDir); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(stateDir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw argError('stateDir must be a directory, not a symlink');

  const realScript = fs.realpathSync(scriptFile);
  const realState = fs.realpathSync(stateDir);
  const home = fs.realpathSync(os.homedir());
  // A script that can rewrite its own frozen copy would run unapproved code next time.
  if (isAtOrUnder(realScript, realState)) throw argError('scriptFile must not be inside stateDir');
  if (realState === '/' || isAtOrUnder(home, realState)) throw argError('stateDir is too broad');
  const scriptDir = path.dirname(realScript);
  if (scriptDir === '/' || isAtOrUnder(home, scriptDir)) throw argError('scriptFile must be in its own directory');
  checkPath(realScript, 'scriptFile'); checkPath(realState, 'stateDir');
  return { interpreter, realScript, realState, scriptDir, domains, timeoutMs, maxOutputBytes, stdin };
}

// /usr/bin/python3 is an xcrun shim that writes a cache into the per-user temp
// directory, which the sandbox denies; it works but complains on every run. So
// the real interpreter is looked up out here, from the system tool, and only a
// path inside the developer tools is taken.
// Looked up once: spawnSync holds the server's event loop while it waits.
let pythonFound = null;
function pythonBehindShim() {
  if (pythonFound) return pythonFound;
  pythonFound = lookUpPython();
  return pythonFound;
}
function lookUpPython() {
  const shim = INTERPRETERS.python;
  const found = spawnSync('/usr/bin/xcrun', ['-f', 'python3'], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: SYSTEM_PATH, HOME: os.homedir() },
  });
  const real = found.status === 0 ? found.stdout.trim() : '';
  if (!/^\/(Library\/Developer|Applications\/Xcode[^/]*\.app)\/[^\0\n]+\/python3$/.test(real)) return shim;
  try { return fs.realpathSync(real); } catch { return shim; }
}

function failure(error, started) {
  return { ok: false, exitCode: null, signal: null, timedOut: false, durationMs: started ? Date.now() - started : 0,
    json: null, stdoutTail: '', stderrTail: '', error };
}

async function runScript(options) {
  const p = prepare(options);
  if (process.platform !== 'darwin') return failure('背景腳本沙盒目前只支援 macOS');

  let interpreterPath;
  try {
    interpreterPath = fs.realpathSync(p.interpreter === 'python' ? pythonBehindShim() : INTERPRETERS[p.interpreter]);
    if (!fs.statSync(interpreterPath).isFile()) throw new Error('not a file');
    fs.accessSync(interpreterPath, fs.constants.X_OK);
  } catch { return failure(`找不到直譯器 ${INTERPRETERS[p.interpreter]}`); }

  // TMPDIR lives inside the state directory. It is kept between runs: removing
  // a tree the script controls from outside the sandbox could follow its links.
  const tmpDir = path.join(p.realState, '.tmp');
  try {
    try { fs.mkdirSync(tmpDir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(tmpDir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a directory');
  } catch { return failure('狀態目錄內的 .tmp 不是一般目錄，未執行'); }
  // Checked before a run as well: something left from an earlier run may have grown it.
  const before = dirSize(p.realState);
  if (before === null || before > STATE_MAX_BYTES) return failure('狀態目錄過大或檔案太多，未執行');

  const allowRead = [p.scriptDir, p.realState];
  // node usually lives under the home directory (nvm); only the binary is re-opened.
  if (p.interpreter === 'node') allowRead.push(interpreterPath);
  // Python from a full Xcode sits under /Applications, which is otherwise closed.
  const xcode = interpreterPath.match(/^\/Applications\/Xcode[^/]*\.app/);
  if (xcode) allowRead.push(xcode[0]);
  // Every process of this run carries this mark, so one that left the process
  // group (setsid) can still be found and ended afterwards.
  const mark = require('node:crypto').randomBytes(12).toString('hex');
  const env = {
    PATH: p.interpreter === 'node' ? `${SYSTEM_PATH}:${path.dirname(INTERPRETERS.node)}` : SYSTEM_PATH,
    HOME: p.realState,
    TMPDIR: tmpDir,
    LANG: 'en_US.UTF-8',
    CCA_SCRIPT_RUN: mark,
  };
  // Node's fetch and http ignore HTTP(S)_PROXY unless told to use them.
  if (p.interpreter === 'node' && p.domains.length) env.NODE_USE_ENV_PROXY = '1';
  const plan = {
    argv: [interpreterPath, ...(INTERPRETER_FLAGS[p.interpreter] || []), p.realScript],
    limits: { fileBlocks: FILE_BLOCKS, cpuSeconds: Math.ceil(p.timeoutMs / 1000) + 5 },
    mark,
    cwd: p.realState,
    env,
    tmpDir,
    config: {
      network: { allowedDomains: p.domains, deniedDomains: [], strictAllowlist: true, deniedResolvedAddresses: PRIVATE_RANGES },
      filesystem: { denyRead: READ_DENY, allowRead, allowWrite: [p.realState], denyWrite: WRITE_DENY },
    },
  };
  return supervise(plan, p);
}

// Runs the helper in its own process group and holds it to the time and output limits.
function supervise(plan, p) {
  const started = Date.now();
  return new Promise((resolve) => {
    const stdout = new Tail(p.maxOutputBytes);
    const stderr = new Tail(TAIL_BYTES);
    let total = 0, truncated = false, flooded = false, timedOut = false;
    let exit = null, helperError = null, settled = false, exited = false;
    let child;
    try {
      child = spawn(process.execPath, [__filename, HELPER_FLAG], {
        cwd: plan.cwd,
        detached: true, // own process group, so one kill reaches every descendant
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { PATH: SYSTEM_PATH, HOME: os.homedir(), LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir(), CLAUDE_CODE_TMPDIR: plan.tmpDir },
      });
    } catch (e) {
      resolve(failure(`沙盒無法啟動：${e.message}`, started));
      return;
    }
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    // Every process seen under the helper while it runs, with its command, so one
    // that left the group (setsid) and no longer carries the mark in a readable
    // environment is still ended afterwards.
    const seen = new Map();
    const watch = setInterval(() => descendants(child.pid, seen), 300);
    watch.unref();
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, p.timeoutMs);

    const count = (tail) => (chunk) => {
      total += chunk.length;
      if (total > p.maxOutputBytes) truncated = true;
      if (total > p.maxOutputBytes * FLOOD_FACTOR && !flooded && !exited) { flooded = true; killGroup(); }
      tail.push(chunk);
    };
    child.stdout.on('data', count(stdout));
    child.stderr.on('data', count(stderr));
    child.stdin.on('error', () => {}); // the script may exit without reading its input
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'exit') exit = { code: Number.isInteger(m.code) ? m.code : null, signal: typeof m.signal === 'string' ? m.signal : null };
      else if (m.type === 'error') helperError = String(m.message).slice(0, 500);
    });
    child.on('error', (e) => { helperError = helperError || e.message; finish(); });
    child.send({ type: 'run', plan }, (err) => {
      if (err) { helperError = `無法傳送設定：${err.message}`; killGroup(); return; }
      child.stdin.end(p.stdin);
    });

    // 'close' waits for the pipes; a process that left the group could hold them
    // open, so after the helper exits we wait only briefly.
    // The helper kills its own group on the way out. If it died without saying
    // how the script ended, it could not, and whatever it left still holds the group id.
    child.on('exit', () => {
      exited = true;
      clearTimeout(timer);
      if (!exit) killGroup();
      setTimeout(finish, 1000).unref();
    });
    child.on('close', finish);

    function finish() {
      if (settled) return;
      if (!exited && child.exitCode === null && child.signalCode === null) return;
      settled = true;
      clearTimeout(timer);
      for (const s of [child.stdout, child.stderr]) s.destroy();
      const out = stdout.text();
      const json = exit && !timedOut && !flooded ? lastJsonObject(out) : null;
      const exitCode = exit ? exit.code : null;
      const signal = exit ? exit.signal : (timedOut || flooded ? 'SIGKILL' : child.signalCode);
      const ok = Boolean(exit && exitCode === 0 && !timedOut && !flooded && json);
      let error = null;
      if (!ok) {
        if (timedOut) error = `逾時（${p.timeoutMs} ms），已終止整個程序群組`;
        else if (flooded) error = `輸出超過上限的 ${FLOOD_FACTOR} 倍，已終止`;
        else if (helperError) error = `沙盒無法啟動：${helperError}`;
        else if (!exit) error = '沙盒程序意外結束';
        else if (exitCode !== 0) error = exitCode === null ? `被訊號 ${signal} 終止` : `結束代碼 ${exitCode}`;
        else error = '最後一行輸出不是 JSON 物件';
        if (truncated && !flooded) error += '（輸出已截斷）';
      }
      clearInterval(watch);
      sweep(plan.mark, seen);
      const used = dirSize(plan.cwd);
      if (used === null || used > STATE_MAX_BYTES) {
        resolve({ ok: false, exitCode, signal: null, timedOut, durationMs: Date.now() - started, json: null,
          stdoutTail: stdout.text(TAIL_BYTES), stderrTail: stderr.text(TAIL_BYTES), error: used === null ? `狀態目錄的檔案超過 ${STATE_MAX_ENTRIES} 個` : `狀態目錄超過 ${STATE_MAX_BYTES / 1024 / 1024} MB` });
        return;
      }
      resolve({ ok, exitCode, signal: ok ? null : signal, timedOut, durationMs: Date.now() - started, json,
        stdoutTail: stdout.text(TAIL_BYTES), stderrTail: stderr.text(TAIL_BYTES), error });
    }
  });
}

// Ends whatever of one run is still alive, found by the mark in its environment,
// in the background so the caller is not held up.
function sweep(mark, seen = new Map()) {
  if (!/^[0-9a-f]{24}$/.test(String(mark))) return;
  require('node:child_process').execFile('/bin/ps', ['-E', '-ww', '-ax', '-o', 'pid=,lstart=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 10000 }, (err, out) => {
    if (err) return;
    for (const line of String(out).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!(pid > 1) || pid === process.pid) continue;
      // Marked, or seen under this run with the same start time: the same process
      // even after it exec'd another program, never a reused pid.
      if (line.includes('CCA_SCRIPT_RUN=' + mark) || seen.get(pid) === m[2]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  });
}
// The helper's descendants now, added to what was seen (pid → start time).
function descendants(root, seen) {
  require('node:child_process').execFile('/bin/ps', ['-ax', '-o', 'pid=,ppid=,lstart='], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (err, out) => {
    if (err) return;
    const children = new Map();
    for (const line of String(out).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})/);
      if (!m) continue;
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push([Number(m[1]), m[3]]);
    }
    const stack = [root];
    while (stack.length) for (const [pid, started] of children.get(stack.pop()) || []) { if (!seen.has(pid)) seen.set(pid, started); stack.push(pid); }
  });
}
// How much a state folder holds, links not followed, counting stops past a bound.
// null when there are more entries than the bound: too many files fails the run
// too, rather than being counted as small.
const STATE_MAX_ENTRIES = 20000;
function dirSize(root, maxEntries = STATE_MAX_ENTRIES) {
  let total = 0, seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let handle;
    // Read entry by entry, so a folder of a million files stops at the bound
    // instead of being listed whole first.
    try { handle = fs.opendirSync(dir); } catch { continue; }
    try {
      for (let e = handle.readSync(); e; e = handle.readSync()) {
        if (++seen > maxEntries) return null;
        const full = path.join(dir, e.name);
        try { const st = fs.lstatSync(full); total += st.size; if (st.isDirectory()) stack.push(full); } catch { /* raced */ }
      }
    } finally { handle.closeSync(); }
  }
  return total;
}

// ---- helper process ----

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function helperMain() {
  let group = false;
  const killGroup = () => { if (group) { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* gone */ } } };
  // The server went away: take the script down with us.
  process.on('disconnect', () => { killGroup(); process.exit(1); });
  const reply = (m) => new Promise((r) => { if (process.connected) process.send(m, () => r()); else r(); });

  const plan = await new Promise((r) => process.once('message', (m) => r(m && m.plan)));
  let SandboxManager, SandboxRuntimeConfigSchema;
  try {
    ({ SandboxManager, SandboxRuntimeConfigSchema } = await import('@anthropic-ai/sandbox-runtime'));
    const config = SandboxRuntimeConfigSchema.parse(plan.config);
    // Per-process limits the sandbox has no word for: file size and CPU time.
    const limits = plan.limits || {};
    const command = `ulimit -f ${Number(limits.fileBlocks) | 0} -t ${Number(limits.cpuSeconds) | 0} 2>/dev/null; exec ` + plan.argv.map(shellQuote).join(' ');
    let wrapped;
    if (config.network.allowedDomains.length) {
      await SandboxManager.initialize(config);
      wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/sh');
    } else {
      // No proxy at all: the profile then allows no network, not even loopback.
      wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/sh', config);
    }
    if (!wrapped.includes('/usr/bin/sandbox-exec')) throw new Error('sandbox profile was not applied');
    group = true;
    // The runtime hands back one shell string; every part of it is quoted by the runtime or by shellQuote.
    const child = spawn('/bin/sh', ['-c', 'exec ' + wrapped], { cwd: plan.cwd, env: plan.env, stdio: ['inherit', 'inherit', 'inherit'] });
    const result = await new Promise((r) => {
      child.on('error', (e) => r({ error: e.message }));
      child.on('exit', (code, signal) => r({ code, signal }));
    });
    if (result.error) await reply({ type: 'error', message: result.error });
    else await reply({ type: 'exit', code: result.code, signal: result.signal });
  } catch (e) {
    await reply({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
  try { if (SandboxManager) await SandboxManager.reset(); } catch { /* exiting anyway */ }
  killGroup(); // leftovers the script forked, and this helper with them
  process.exit(0);
}

if (require.main === module && process.argv[2] === HELPER_FLAG) helperMain();

module.exports = { runScript, INTERPRETERS, Tail, lastJsonObject };
