const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Tail, lastJsonObject } = require('./scriptSandbox');

// Built-in checks: read-only commands the owner lists by hand in
// .local/schedule-checks.json, for checks a sandboxed script cannot do, such as
// an upgrade check reading its own repository. Neither the page nor an
// agent can add one; a schedule only names it. Each runs as the owner's user
// without a shell, with PATH, HOME and LANG only, a timeout and bounded output,
// and prints one JSON object as its last line, like a background script. Its
// input is {lastKey} only. Whatever it reads from a folder an agent can write is
// data to it, never code to run: arguments naming such places are refused.
//
// {"checks":[{"id":"claude-upgrade","name":"Claude Code new release",
//   "command":["/abs/path/to/check","--json"],"timeoutSeconds":120}]}
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH_ENV = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin';
const OUTPUT_MAX = 256 * 1024;

function create(stateRoot, { problemOf = () => null, argumentProblemOf = () => null } = {}) {
  const file = path.join(stateRoot, 'schedule-checks.json');
  // Read afresh each time: the owner edits the file by hand.
  function list() {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
    const out = [];
    for (const c of Array.isArray(data?.checks) ? data.checks : []) {
      if (!c || !ID.test(String(c.id)) || !Array.isArray(c.command) || !c.command.length || c.command.some((a) => typeof a !== 'string' || a.includes('\0'))) continue;
      if (out.some((x) => x.id === c.id)) continue;
      const timeoutSeconds = Number.isInteger(c.timeoutSeconds) && c.timeoutSeconds >= 5 && c.timeoutSeconds <= 600 ? c.timeoutSeconds : 120;
      out.push({ id: c.id, name: String(c.name || c.id).slice(0, 80), description: String(c.description || '').slice(0, 500), command: c.command.slice(), timeoutSeconds });
    }
    return out;
  }
  const get = (id) => list().find((c) => c.id === id) || null;
  // What the page and the agents see: never the command itself.
  const view = (c) => ({ id: c.id, name: c.name, description: c.description, timeoutSeconds: c.timeoutSeconds });
  // What a schedule is approved against: the argv, where the program really is,
  // and the program's bytes. Any change stops the schedule until approved again.
  function signature(id) {
    const c = get(id); if (!c) return null;
    let real = '', digest = '';
    try { real = fs.realpathSync(c.command[0]); digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(real)).digest('hex'); } catch { /* missing: no match later */ }
    return require('node:crypto').createHash('sha256').update(JSON.stringify([c.command, real, digest])).digest('hex');
  }

  function run(id, input = {}, { signature: approved } = {}) {
    const c = get(id);
    const started = Date.now();
    const failed = (error) => ({ ok: false, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started, json: null, stdoutTail: '', stderrTail: '', error });
    if (!c) return Promise.resolve(failed('找不到這個內建檢查，請確認 schedule-checks.json'));
    const exe = c.command[0];
    if (!path.isAbsolute(exe)) return Promise.resolve(failed('內建檢查的指令必須是絕對路徑'));
    // The same rule as a launcher: a regular file of this account in a folder no
    // one else can write, and nowhere an agent can write.
    const problem = problemOf(exe) || c.command.slice(1).map(argumentProblemOf).find(Boolean);
    if (problem) return Promise.resolve(failed('內建檢查的指令無法使用：' + problem));
    if (approved !== undefined && signature(id) !== approved) return Promise.resolve(failed('內建檢查的指令與核准時不同，請重新核准這個排程'));
    // The resolved program, so nothing swapped in after the check runs instead.
    let real;
    try { real = fs.realpathSync(exe); } catch { return Promise.resolve(failed('找不到內建檢查的指令')); }
    return new Promise((resolve) => {
      const stdout = new Tail(OUTPUT_MAX), stderr = new Tail(4096);
      let total = 0, timedOut = false, flooded = false, done = false;
      let child;
      try {
        child = spawn(real, c.command.slice(1), { cwd: os.homedir(), detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: PATH_ENV, HOME: os.homedir(), LANG: 'en_US.UTF-8' } });
      } catch (e) { resolve(failed('內建檢查無法啟動：' + e.message)); return; }
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
      // A process it left behind may hold the pipes open for ever: the run ends at
      // the timeout, or a second after the command itself exits, not at 'close'.
      const timer = setTimeout(() => { timedOut = true; kill(); finish(null, 'SIGKILL'); }, c.timeoutSeconds * 1000);
      const count = (tail) => (chunk) => { total += chunk.length; if (total > OUTPUT_MAX * 4 && !flooded) { flooded = true; kill(); } tail.push(chunk); };
      child.stdout.on('data', count(stdout));
      child.stderr.on('data', count(stderr));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      const finish = (code, signal, error) => {
        if (done) return; done = true; clearTimeout(timer); kill();
        for (const stream of [child.stdout, child.stderr]) stream.destroy();
        const json = !timedOut && !flooded && code === 0 ? lastJsonObject(stdout.text()) : null;
        const ok = Boolean(json);
        resolve({ ok, exitCode: code ?? null, signal: signal || null, timedOut, durationMs: Date.now() - started, json,
          stdoutTail: stdout.text(4096), stderrTail: stderr.text(4096),
          error: ok ? null : error || (timedOut ? `逾時（${c.timeoutSeconds} 秒）` : flooded ? '輸出過多，已終止' : code !== 0 ? `結束代碼 ${code}` : '最後一行輸出不是 JSON 物件') });
      };
      child.on('error', (e) => finish(null, null, '內建檢查無法啟動：' + e.message));
      child.on('close', (code, signal) => finish(code, signal));
      child.on('exit', (code, signal) => { setTimeout(() => finish(code, signal), 1000).unref(); });
    });
  }
  return { list, get, view, run, signature };
}

module.exports = { create, ID };
