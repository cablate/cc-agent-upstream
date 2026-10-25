'use strict';
// server/agentStore.js and channel/server.mjs: W5 (named-pipe relay identity), W6 (MCP project key),
// W9 (tmux capture flags and the tmux key in runtime.json), W15 (writable-folder fence), B3 (arguments
// resolved against home), B6 (a stopped or replaced session drops its old prompt), and the default
// behaviour of the F1 workspace / F2 globalHarness settings.
//
// Every case runs the real module: agentStore.js is compiled fresh for each case, over an empty data folder
// and home inside a parity-* folder, with only three things replaced -- the user store (it would open the
// repository's NeDB files), the lifecycle check, and `tmux` (recorded, never run). Internal functions are
// exposed by appending one export line to the source; a name that is not in the tree makes load() throw.
// channel/server.mjs cannot be imported (it connects on load), so the three bridge() calls are cut out of
// its source and evaluated against a recording bridge; a call that is not found makes load() throw.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const Module = require('node:module');

const base = fs.mkdtempSync(path.join(process.env.PARITY_TMP || os.tmpdir(), 'parity-agentStore-'));
process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
const W = path.join(base, 'w');

const INTERNALS = ['relayPeer', 'socketAgentId', 'agentWritable', 'checkArgumentProblem', 'mcpServerNames', 'syncTerminalPrompt', 'prompts'];
const ENV = ['AGENT_DATA_DIR', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'DB_DIR', 'CC_AGENT_PROTECTED_PATHS'];
const USERS = [{ _id: 'adm', role: 'admin' }, { _id: 'mem', role: 'member' }];
const PIPE = '\\\\.\\pipe\\LOCAL\\cc-msg-beta';
const MENU = [' Do you want to proceed?', '', ' ❯ 1. Yes', '   2. No', '', ' Enter to confirm · Esc to cancel'].join('\n');
const MENU_TOP = ['────────────────────────────────', MENU].join('\n');

// ---------------------------------------------------------------- world
const stub = (root, rel, exports) => {
  const id = path.resolve(root, rel);
  const m = new Module(id); m.filename = id; m.loaded = true; m.exports = exports;
  require.cache[id] = m;
};
const drop = (root) => { const prefix = path.resolve(root) + path.sep; for (const k of Object.keys(require.cache)) if (k.startsWith(prefix) && !k.includes(`${path.sep}node_modules${path.sep}`)) delete require.cache[k]; };

// Windows now and then refuses a rename onto a file something else (a scanner) has open for a moment. The code
// under test writes by rename, so the fixture retries it a few times; every retry is counted and printed at exit.
let renameRetries = 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const retryingRename = (real) => function (from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return real.call(this, from, to); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 40) throw e;
      renameRetries++; sleep(25);
    }
  }
};

function world(root, opts, fn) {
  fs.rmSync(W, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  const dirs = { home: path.join(W, 'home'), tmp: path.join(W, 'tmp'), cwd: path.join(W, 'cwd'), data: opts.data ? opts.data(W) : path.join(W, 'data') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd(), realExec = cp.execFileSync, realRename = fs.renameSync;
  const tmux = { calls: [], screen: '', sessions: new Set() };
  Object.assign(process.env, { AGENT_DATA_DIR: dirs.data, HOME: dirs.home, USERPROFILE: dirs.home, TMPDIR: dirs.tmp, TEMP: dirs.tmp, TMP: dirs.tmp, DB_DIR: path.join(W, 'db') });
  delete process.env.CC_AGENT_PROTECTED_PATHS;
  try {
    fs.renameSync = retryingRename(realRename);
    process.chdir(opts.cwd ? opts.cwd(dirs) : dirs.cwd);
    drop(root);
    stub(root, 'server/stores.js', { usersDB: { getAllData: () => USERS } });
    stub(root, 'server/services/userLifecycle.js', { isActiveUser: () => true });
    cp.execFileSync = function (file, args, options) {
      if (file !== 'tmux') return realExec.apply(this, arguments);
      tmux.calls.push({ args: [...args], options: Object.keys(options || {}).sort(), timeout: options && options.timeout });
      const sub = args[2];
      if (sub === 'has-session') { if (tmux.sessions.has(args[4])) return ''; throw Object.assign(new Error('no server running'), { status: 1 }); }
      if (sub === 'new-session') { tmux.sessions.add(args[args.indexOf('-s') + 1]); return ''; }
      if (sub === 'capture-pane') { if (tmux.screen === null) throw new Error('no pane'); return tmux.screen; }
      return '';
    };
    const file = path.resolve(root, 'server/agentStore.js');
    const source = fs.readFileSync(file, 'utf8');
    const mod = new Module(file, null); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(`${source}\n;module.exports.__internals={${INTERNALS.join(',')},get state(){return state;}};`, file);
    cp.execFileSync = realExec;
    tmux.calls.length = 0;
    const S = mod.exports, I = S.__internals;
    return fn({ S, I, root, dirs, tmux, data: dirs.data });
  } finally {
    cp.execFileSync = realExec;
    fs.renameSync = realRename;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try { process.chdir(savedCwd); } catch { /* gone */ }
    drop(root);
  }
}

// ---------------------------------------------------------------- helpers
const esc = (s) => JSON.stringify(s).slice(1, -1);
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scrub(value, w) {
  let text = JSON.stringify(value === undefined ? null : value);
  // A tree path is replaced only as a whole path: /up must not be cut out of ../up-only.
  for (const [p, label] of [[w.root, '<ROOT>'], [W, '<W>']]) for (const form of new Set([p, path.resolve(p), p.replace(/\\/g, '/'), path.resolve(p).replace(/\\/g, '/')])) text = text.replace(new RegExp(`(?<![\\w.-])${literal(esc(form))}(?![\\w.-])`, 'g'), label);
  const ids = [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [])];
  ids.forEach((id, i) => { text = text.split(id).join(`<id${i}>`).split(id.slice(0, 8)).join(`<id${i}:8>`); });
  const short = [...new Set([...text.matchAll(/(?:execagent-|cca-|prompt:)([0-9a-f]{8})/g)].map((m) => m[1]))];
  short.forEach((s, k) => { text = text.split(s).join(`<h${k}>`); });
  const tokens = [...new Set(text.match(/\b[0-9a-f]{64}\b/g) || [])];
  tokens.forEach((t, i) => { text = text.split(t).join(`<token${i}>`); });
  text = text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<iso>').replace(/\b1[6-9]\d{11}\b/g, '<ms>');
  return JSON.parse(text);
}
const mk = (w, title, o = {}) => w.S.create(o.owner || 'adm', { title, ...(o.access ? { access: o.access } : o.scoped ? {} : { access: { full: true } }), start: false, ...(o.extra || {}) }, o.owner === 'mem' ? undefined : 'admin');
const control = (w, c, g = 1) => path.join(w.data, 'workspaces', c.id, `control-g${g}`);
const workDir = (w, c, g = 1) => path.join(w.data, 'workspaces', c.id, `g${g}`);
const runtime = (w, c) => JSON.parse(fs.readFileSync(path.join(control(w, c), 'runtime.json'), 'utf8'));
const persisted = (w, owner = 'adm') => JSON.parse(fs.readFileSync(path.join(w.data, 'users', owner, 'conversations.json'), 'utf8')).conversations;
const started = (w, o) => { const c = mk(w, 'Alpha', o); w.S.launch(c); return c; };
const label = (...pairs) => (id) => (id === null || id === undefined ? id : (pairs.find(([x]) => x.id === id) || [null, '?'])[1]);
const calls = (w) => w.tmux.calls.map((x) => x.args.slice(2));
const catching = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e.message, status: e.status }; } };
function transcriptFor(w, c, records, g = 1) {
  const run = c.runs[g - 1];
  const dir = path.join(w.dirs.home, '.claude', 'projects', workDir(w, c, g).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${run.sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const T = (n) => `2099-01-01T00:00:0${n}.000Z`;
const inbound = (from, name, text, n) => ({ type: 'queue-operation', operation: 'enqueue', content: `<cross-session-message from="${from}" from-name="${name}">${text}</cross-session-message>`, timestamp: T(n) });
const outbound = (id, to, text, n) => [
  { type: 'assistant', timestamp: T(n), message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: text } }] } },
  { type: 'user', timestamp: T(n + 1), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Message sent to another Claude session' }] } },
];

// A sender and a receiver of the owner's, B registers an address through the real bridge call; C the same with a
// POSIX-looking address whose socket file does not exist.
function peers(w) {
  const A = started(w), B = mk(w, 'Beta'), C = mk(w, 'Gamma');
  for (const [x, address] of [[B, PIPE], [C, '/nonexistent/c.sock']]) { w.S.launch(x); w.S.bridge(x, 'bootstrap', { address }); }
  const sock = path.join(w.dirs.tmp, `cca-${B.id.slice(0, 8)}-g1`, 'cc-socks', '123.sock');
  fs.mkdirSync(path.dirname(sock), { recursive: true }); fs.writeFileSync(sock, '');
  const unknown = path.join(w.dirs.tmp, 'cca-deadbeef-g1', 'cc-socks', '9.sock');
  fs.mkdirSync(path.dirname(unknown), { recursive: true }); fs.writeFileSync(unknown, '');
  return { A, B, C, sock, unknown, who: label([A, 'A'], [B, 'B'], [C, 'C']) };
}

// ---------------------------------------------------------------- the case table
const specs = [];
const def = (name, run, o = {}) => specs.push({ name, run, o });

// channel/server.mjs: what the channel sends the bridge. Upstream: bootstrap {}, ready and poll no data.
const serverCalls = ['bootstrap', 'ready', 'poll'];
const SOCKETS = { unset: undefined, empty: '', pipe: PIPE, posix: '/tmp/cca-1000/abcd1234-g1/cc-socks/1.sock' };
for (const action of serverCalls) for (const [kind, socket] of Object.entries(SOCKETS)) {
  def(`W5-channel-${action}-${kind}`, (root) => {
    const source = fs.readFileSync(path.join(root, 'channel/server.mjs'), 'utf8');
    const head = `bridge(config,'${action}'`;
    const start = source.indexOf(head);
    if (start < 0) throw new Error(`Missing channel extraction: ${head}`);
    let depth = 0, end = -1;
    for (let i = start + 'bridge'.length; i < source.length; i++) { if (source[i] === '(') depth++; else if (source[i] === ')' && --depth === 0) { end = i + 1; break; } }
    if (end < 0) throw new Error(`Unterminated channel extraction: ${head}`);
    const platformFile = path.join(root, 'channel/platform.cjs');
    const recorded = [];
    const bridge = async (config, name, ...rest) => { recorded.push({ action: name, arguments: rest.length, data: rest[0] === undefined ? '<undefined>' : rest[0], body: JSON.stringify(rest[0] || {}) }); return {}; };
    const env = socket === undefined ? {} : { CLAUDE_CODE_MESSAGING_SOCKET: socket };
    return vm.runInNewContext(`(async()=>{await ${source.slice(start, end)};})()`, { bridge, config: {}, process: { env }, isWin: process.platform === 'win32', platform: fs.existsSync(platformFile) ? require(platformFile) : undefined }).then(() => recorded);
  }, { channel: true });
}

// bridge(): does a channel's address become part of the stored run?
for (const [action, kind, address] of [
  ['bootstrap', 'pipe', PIPE], ['bootstrap', 'posix', '/tmp/cca-1000/abcd1234-g1/cc-socks/1.sock'], ['bootstrap', 'none', undefined],
  ['ready', 'pipe', PIPE], ['poll', 'pipe', PIPE], ['poll', 'posix', '/tmp/cca-1000/abcd1234-g1/cc-socks/1.sock'], ['poll', 'none', undefined],
  ['bootstrap', 'toolong', 'x'.repeat(301)], ['bootstrap', 'newline', 'a\nb'], ['bootstrap', 'number', 123],
]) {
  def(`W5-bridge-${action}-address-${kind}`, (w) => {
    const c = started(w);
    const result = w.S.bridge(c, action, address === undefined ? {} : { address });
    const run = persisted(w)[0].runs[0];
    return scrub({ returned: Object.keys(result || {}).sort(), memory: Object.keys(w.S.active(c)).filter((k) => k === 'address'), stored: Object.keys(run).filter((k) => k === 'address'), storedValue: run.address === undefined ? null : run.address, view: Object.keys(w.S.publicView(c, true)).filter((k) => /address/i.test(k)) }, w);
  });
}

// relayPeer(): who a relayed message is shown as coming from or going to.
const FROMS = ['empty', 'socket', 'pipe', 'posix', 'unknownSocket'];
const NAMES = ['Beta', 'pipe', 'posix', 'uds:/other', '', undefined, 'Nobody'];
for (const direction of ['in', 'out', 'other', undefined]) for (const from of FROMS) {
  def(`W5-relayPeer-${String(direction)}-from-${from}`, (w) => {
    const { A, B, sock, unknown, who } = peers(w);
    const fromValue = { empty: '', socket: `uds:${sock}`, pipe: `uds:${PIPE}`, posix: 'uds:/nonexistent/c.sock', unknownSocket: `uds:${unknown}` }[from];
    const nameValue = { Beta: 'Beta', pipe: `uds:${PIPE}`, posix: 'uds:/nonexistent/c.sock', 'uds:/other': 'uds:/other', '': '', undefined: undefined, Nobody: 'Nobody' };
    const out = {};
    for (const n of NAMES) { const p = w.I.relayPeer(A, { direction, from: fromValue, name: nameValue[n] }); out[String(n)] = { peer: who(p.peerId), name: p.peerName }; }
    return scrub(out, w);
  });
}
def('W5-socketAgentId', (w) => {
  const { B, sock, unknown } = peers(w);
  const hit = w.I.socketAgentId(`uds:${sock}`);
  return scrub({
    own: hit === B.id.slice(0, 8), unknownFolder: w.I.socketAgentId(`uds:${unknown}`), pipe: w.I.socketAgentId(`uds:${PIPE}`), missing: w.I.socketAgentId('uds:/nonexistent/c.sock'),
    dotdot: w.I.socketAgentId(`uds:${sock}/../x`), plain: w.I.socketAgentId(sock), empty: w.I.socketAgentId(''), nul: w.I.socketAgentId('uds:/a\0b'),
  }, w);
});
def('W2-socketAgentId-missing-getuid', (w) => {
  const { sock } = peers(w), saved = process.getuid;
  try { process.getuid = undefined; return catching(() => w.I.socketAgentId(`uds:${sock}`)); }
  finally { process.getuid = saved; }
});
// The same, through the transcript: what a chat shows for a relay.
const syncRelays = (w, extra) => {
  const { A, B, sock, unknown, who } = peers(w);
  A.relaySince = '2000-01-01T00:00:00.000Z';
  transcriptFor(w, A, extra({ A, B, sock, unknown }));
  w.S.syncRelays(A);
  return scrub(A.messages.filter((m) => m.role === 'relay').map((m) => ({ text: m.text, relay: { ...m.relay, peerId: who(m.relay.peerId) } })), w);
};
def('W5-sync-in-from-own-socket', (w) => syncRelays(w, ({ sock }) => [inbound(`uds:${sock}`, 'Beta', 'hello', 1)]));
def('W5-sync-in-from-unknown-socket-named-as-address', (w) => syncRelays(w, ({ unknown }) => [inbound(`uds:${unknown}`, `uds:${unknown}`, 'hello', 1)]));
def('W5-sync-in-from-registered-posix-address', (w) => syncRelays(w, () => [inbound('uds:/nonexistent/c.sock', 'Gamma', 'hello', 1)]));
def('W5-sync-in-from-registered-pipe-address', (w) => syncRelays(w, () => [inbound(`uds:${PIPE}`, `uds:${PIPE}`, 'hello', 1)]));
def('W5-sync-out-to-title', (w) => syncRelays(w, () => outbound('t1', 'Beta', 'hi', 1)));
def('W5-sync-out-to-registered-pipe-address', (w) => syncRelays(w, () => outbound('t1', `uds:${PIPE}`, 'hi', 1)));
def('W5-sync-out-to-unknown-address', (w) => syncRelays(w, () => outbound('t1', 'uds:/somewhere/else.sock', 'hi', 1)));

// W6: which MCP servers a full-access agent is shown.
const bs = (W_) => path.join(W_, 'data\\with-backslash');
const mcp = (conf, o = {}) => (w) => {
  const c = mk(w, 'Alpha', o.agent);
  const cwd = workDir(w, c);
  fs.writeFileSync(path.join(w.dirs.home, '.claude.json'), typeof conf === 'function' ? conf(cwd) : conf);
  return { names: w.I.mcpServerNames(c), commands: w.S.commandsFor(c, 'admin').servers, cwdHasBackslash: cwd.includes('\\') };
};
const json = (o) => JSON.stringify(o);
def('W6-mcp-user-and-project', mcp((cwd) => json({ mcpServers: { user1: {} }, projects: { [cwd]: { mcpServers: { proj1: {} } } } })));
def('W6-mcp-forward-slash-key', mcp((cwd) => json({ projects: { [cwd.replace(/\\/g, '/')]: { mcpServers: { slash1: {} } } } })));
def('W6-mcp-backslash-key', mcp((cwd) => json({ projects: { [cwd.replace(/\//g, '\\')]: { mcpServers: { back1: {} } } } })));
def('W6-mcp-both-keys', mcp((cwd) => json({ projects: { [cwd]: { mcpServers: { a: {} } }, [cwd.replace(/\\/g, '/')]: { mcpServers: { b: {} } } } })));
def('W6-mcp-folder-with-backslash-slash-key', mcp((cwd) => json({ projects: { [cwd]: { mcpServers: { own: {} } }, [cwd.replace(/\\/g, '/')]: { mcpServers: { other: {} } } } })), { data: bs });
def('W6-mcp-folder-with-backslash-own-key', mcp((cwd) => json({ projects: { [cwd]: { mcpServers: { own: {} } } } })), { data: bs });
def('W6-mcp-scoped-agent', mcp((cwd) => json({ mcpServers: { user1: {} }, projects: { [cwd]: { mcpServers: { proj1: {} } } } }), { agent: { scoped: true } }));
def('W6-mcp-no-config', (w) => ({ names: w.I.mcpServerNames(mk(w, 'Alpha')) }));
def('W6-mcp-invalid-config', mcp('{not json'));

// W15: the writable-folder fence. One scoped agent is given two folders. allowedFolder() judges a folder by counting
// "/" in its real path, so on Windows (backslashes) it refuses every folder; that one refusal is recorded in the result
// (allowRefused) and the case goes on to the paths that do not depend on it. Any other failure stops the case.
const fence = (w) => {
  const granted = path.join(w.dirs.home, 'granted');
  fs.mkdirSync(path.join(granted, 'sub'), { recursive: true });
  try { mk(w, 'Scoped', { access: { allow: ['~/granted', '/srv/parity-granted'] } }); return { granted, allowRefused: null }; } catch (e) {
    if (process.platform !== 'win32' || !/^Too broad to grant/.test(e.message)) throw e;
    return { granted, allowRefused: e.message };
  }
};
const out = (w, f, value) => scrub({ allowRefused: f.allowRefused, value }, w);
const check = (w, list) => Object.fromEntries(list.map(([k, v]) => [k, w.I.agentWritable(v)]));
def('W15-agentWritable-roots', (w) => {
  const f = fence(w), d = w.data;
  return out(w, f, check(w, [['data', d], ['child', path.join(d, 'x')], ['sibling', d + 'x'], ['parent', path.dirname(d)], ['tmp', '/tmp'], ['tmpChild', '/tmp/x'], ['tmpSibling', '/tmpx'], ['private', '/private/tmp'], ['privateChild', '/private/tmp/y'], ['slashEnd', d + '/'], ['tmpFolder', w.dirs.tmp], ['tmpFolderChild', path.join(w.dirs.tmp, 'x')]]));
});
def('W15-agentWritable-granted-folder', (w) => {
  const f = fence(w);
  return out(w, f, check(w, [['granted', f.granted], ['sub', path.join(f.granted, 'sub')], ['sibling', f.granted + 'x'], ['home', w.dirs.home], ['otherChild', path.join(w.dirs.home, 'other')], ['outsideTmp', '/srv/parity-granted'], ['outsideTmpChild', '/srv/parity-granted/x'], ['outsideTmpSibling', '/srv/parity-grantedx'], ['elsewhere', '/usr/bin'], ['etc', '/etc/passwd']]));
});
def('W15-agentWritable-separators-and-drives', (w) => {
  const f = fence(w), d = w.data;
  return out(w, f, check(w, [['backslashChild', d + '\\x'], ['backslashInName', path.join(d, 'a\\b')], ['drive', 'C:\\Windows'], ['driveSlash', 'C:/Windows'], ['unc', '\\\\server\\share'], ['uncSlash', '//server/share/x'], ['dots', d + '/../x'], ['empty', ''], ['upperDrive', d.replace(/^./, (c) => c.toUpperCase())], ['lowerDrive', d.replace(/^./, (c) => c.toLowerCase())]]));
});
const arg = (w, list) => Object.fromEntries(list.map((a) => [a, w.I.checkArgumentProblem(a)]));
def('W15-checkArgument-windows-style-arguments', (w) => { const f = fence(w); return out(w, f, arg(w, ['C:\\Windows', 'c:/Windows', 'C:', '\\\\server\\share\\x', '\\x', 'D:\\a\\..\\b', 'relative', 'x/y', ''])); });
def('W15-checkArgument-non-text', (w) => { const f = fence(w); return out(w, f, [undefined, null, 5, {}, ['/tmp']].map((a) => w.I.checkArgumentProblem(a))); });
def('W15-checkArgument-absolute-and-home', (w) => {
  const f = fence(w);
  fs.mkdirSync(path.join(w.data, 'sub'), { recursive: true });
  return out(w, f, arg(w, [w.data, path.join(w.data, 'sub'), f.granted, path.join(f.granted, 'sub'), '~', '~/granted', '~/granted/sub', '~/missing', path.join(w.dirs.home, 'missing'), '/tmp', '/nonexistent/x', '/usr/bin', '/etc/passwd', '/srv/parity-granted']));
});
def('W15-checkArgument-spellings-of-the-data-folder', (w) => {
  const f = fence(w), d = w.data;
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  return out(w, f, arg(w, [d, d.replace(/\\/g, '/'), d + path.sep, d + '/.', d.replace(/^./, (c) => c.toUpperCase()), d.replace(/^./, (c) => c.toLowerCase()), path.join(d, 'sub', '..'), path.join(d, 'SUB'), path.join(d, 'missing')]));
});

// B3: a relative argument is resolved against the home folder, not the server's working folder. Under /tmp every
// existing path counts as writable, so these cases differ by which folder the name exists in.
const B3_WHY = 'a relative argument is resolved against the home folder, not the process working folder';
const relative = (cwdOf, args, setup = () => {}) => ({ run: (w) => { const f = fence(w); setup(w); return out(w, f, arg(w, args)); }, o: { cwd: cwdOf } });
const b3 = (name, spec, why) => def(name, spec.run, { ...spec.o, ...(why ? { expected: { unit: 'B3', reason: why } } : {}) });
b3('B3-relative-name-existing-only-in-working-folder', relative((d) => d.cwd, ['./work-only'], (w) => fs.mkdirSync(path.join(w.dirs.cwd, 'work-only'))), B3_WHY);
b3('B3-relative-name-existing-only-in-home', relative((d) => d.cwd, ['./home-only'], (w) => fs.mkdirSync(path.join(w.dirs.home, 'home-only'))), B3_WHY);
b3('B3-parent-relative-name', relative((d) => { const inner = path.join(d.cwd, 'inner'); fs.mkdirSync(inner); return inner; }, ['../up-only'], (w) => fs.mkdirSync(path.join(w.dirs.cwd, 'up-only'))), B3_WHY);
b3('B3-relative-names-resolving-the-same-either-way', relative((d) => d.cwd, ['../data', '../data/sub', './nothing-here', '..', '.'], (w) => fs.mkdirSync(path.join(w.data, 'sub'), { recursive: true })));
// Not part of B3's intent: an absolute argument must still mean what the system makes of "link/..", which is not
// what folding the text does. It only shows when the link leads into a folder that is writable.
def('B3-absolute-argument-through-a-link-and-dotdot', (w) => {
  const f = fence(w);
  const deep = path.join(w.dirs.tmp, 'deep'), shallow = path.join(w.dirs.tmp, 'shallow');
  fs.mkdirSync(path.join(deep, 'inner'), { recursive: true }); fs.mkdirSync(shallow);
  fs.writeFileSync(path.join(deep, 'secret'), '');
  const link = path.join(shallow, 'link');
  fs.symlinkSync(path.join(deep, 'inner'), link, 'junction');
  return out(w, f, arg(w, [`${link}/../secret`, `${link}\\..\\secret`, `${shallow}/./link/../secret`, `${shallow}//link//..//secret`, `${deep}/inner/..`, `${deep}/./secret`]));
});


def('B3-relative-link-and-dotdot-from-home', (w) => {
  const f = fence(w), deep = path.join(w.dirs.tmp, 'deep');
  fs.mkdirSync(path.join(deep, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(deep, 'secret'), '');
  fs.writeFileSync(path.join(w.dirs.home, 'plain'), '');
  fs.symlinkSync(path.join(deep, 'inner'), path.join(w.dirs.home, 'link'), 'junction');
  return out(w, f, arg(w, ['./link/../secret', '~/link/../secret', './missing/../plain']));
}, { cwd: d => d.home });

// B6: a stopped or replaced session no longer owns its terminal prompt.
const waiting = (w, o = {}) => {
  const c = started(w);
  const g = w.S.active(c);
  g.phase = 'busy'; g.ready = true; g.heartbeat = Date.now();
  w.tmux.screen = o.screen || MENU_TOP;
  w.I.syncTerminalPrompt(c); w.I.syncTerminalPrompt(c);
  return c;
};
const pending = (w) => w.S.pendingNotifications().map((n) => ({ title: n.conversation.title, id: String(n.message.id).replace(/:\d{13}$/, ''), text: n.message.notifyText || n.message.text || null }));
def('B6-prompt-pending-while-running', (w) => { waiting(w); return scrub(pending(w), w); });
def('B6-prompt-after-stop', (w) => { const c = waiting(w); w.S.stop(c); return scrub({ pending: pending(w), memory: [...w.I.prompts.keys()].length, view: w.S.publicView(c).terminalPrompt }, w); }, { expected: { unit: 'B6', reason: 'stop() drops the terminal prompt of the session it ended' } });
def('B6-prompt-after-rotation-to-new-session', (w) => {
  const c = waiting(w); w.S.active(c).phase = 'ready';
  w.S.rotate(c);
  return scrub({ generation: c.generation, pending: pending(w), memory: [...w.I.prompts.keys()].length }, w);
}, { expected: { unit: 'B6', reason: 'stop() (called by rotate) drops the terminal prompt of the session it ended' } });
def('B6-prompt-of-agent-whose-heartbeat-lapsed', (w) => { const c = waiting(w); w.S.active(c).heartbeat = Date.now() - 60000; return scrub({ pending: pending(w), memory: [...w.I.prompts.keys()].length }, w); }, { expected: { unit: 'B6', reason: 'a prompt is pushed only while its agent is alive' } });
def('B6-prompt-recorded-for-an-earlier-session', (w) => { const c = waiting(w); w.S.active(c).sessionId = '00000000-0000-4000-8000-000000000000'; return scrub({ pending: pending(w), memory: [...w.I.prompts.keys()].length }, w); }, { expected: { unit: 'B6', reason: 'a prompt is pushed only while it belongs to the active session' } });
def('B6-chat-message-notification-after-stop', (w) => {
  const c = waiting(w);
  c.messages.push({ id: 'm1', role: 'assistant', text: 'done', at: T(1), generation: 1, notifyPending: true });
  w.S.stop(c);
  return scrub(pending(w).filter((n) => !n.id.startsWith('prompt:')), w);
});
def('B6-stop-without-prompt', (w) => { const c = started(w); w.S.stop(c); return scrub({ phase: w.S.active(c).phase, pending: pending(w), tmux: calls(w).map((x) => x[0]) }, w); });

// W9: how agentStore.js asks tmux for a screen (five call sites) and what it writes for the runner.
def('W9-capture-pane-prompt-sync', (w) => { const c = started(w); w.S.active(c).phase = 'busy'; w.tmux.screen = MENU_TOP; w.tmux.calls.length = 0; w.I.syncTerminalPrompt(c); return scrub(calls(w), w); });
def('W9-capture-pane-choose-option', (w) => {
  const c = started(w);
  const prompt = require(path.join(w.root, 'server/terminalPrompt.js')).parse(MENU_TOP);
  w.tmux.screen = MENU_TOP; w.tmux.calls.length = 0;
  return scrub({ result: catching(() => w.S.chooseTerminalOption(c, { key: prompt.key, index: 1 })), calls: calls(w) }, w);
});
def('W9-capture-pane-compact-heartbeat', (w) => { const c = started(w); const g = w.S.active(c); g.compacting = true; g.compactSince = Date.now(); w.tmux.screen = 'Compacting conversation (45%)'; w.tmux.calls.length = 0; const r = w.S.bridge(c, 'heartbeat', {}); return scrub({ r, calls: calls(w), seen: g.compactSeen === true, percent: g.compactPercent }, w); });
def('W9-capture-pane-confirm-workspace', (w) => {
  const c = started(w);
  w.tmux.screen = `Accessing workspace:\n${workDir(w, c)}\n❯ Yes, I trust this folder\n  No, exit`;
  w.tmux.calls.length = 0;
  const r = catching(() => w.S.confirmWorkspace(c));
  return scrub({ r, calls: calls(w) }, w);
});
def('W9-capture-pane-confirm-workspace-mismatch', (w) => { const c = started(w); w.tmux.screen = 'something else'; w.tmux.calls.length = 0; return scrub({ r: catching(() => w.S.confirmWorkspace(c)), calls: calls(w) }, w); });
def('W9-capture-pane-confirm-channel', (w) => {
  const c = started(w);
  w.tmux.screen = 'WARNING: Loading development channels\nChannels: server:executive\n1. I am using this for local development';
  w.tmux.calls.length = 0;
  return scrub({ r: catching(() => w.S.confirmChannel(c)), calls: calls(w) }, w);
});
def('W9-capture-pane-confirm-channel-mismatch', (w) => { const c = started(w); w.tmux.screen = 'something else'; w.tmux.calls.length = 0; return scrub({ r: catching(() => w.S.confirmChannel(c)), calls: calls(w) }, w); });
def('W9-launch-runtime-json-tmux-key', (w) => { const c = started(w); const r = runtime(w, c); return scrub({ hasTmuxKey: Object.hasOwn(r, 'tmux'), keyOrder: Object.keys(r).filter((k) => ['tmuxSocket', 'tmux', 'reference'].includes(k)) }, w); });

// F1 / F2 with default settings (no workspace set, globalHarness untouched).
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
def('F1-launch-new-session-arguments', (w) => { started(w); return scrub(w.tmux.calls.map((x) => ({ args: x.args, options: x.options, timeout: x.timeout })), w); });
def('F1-launch-runtime-json-paths-and-profile', (w) => {
  const c = started(w);
  const r = runtime(w, c);
  return scrub({ ...without(r, ['tmux', 'bound', 'globalHarness', 'profile']), profile: without(r.profile, ['workspace', 'globalHarness']), keys: Object.keys(without(r, ['tmux', 'bound', 'globalHarness'])) }, w);
});
def('F1-launch-access-error-folder-side-effects', (w) => {
  const c = mk(w, 'Alpha'), access = require(path.join(w.root, 'server/agentAccess.js')), saved = access.of;
  try {
    access.of = () => { throw new Error('fixture access lookup failed'); };
    const result = catching(() => w.S.launch(c));
    return { result, own: fs.existsSync(workDir(w, c)), reference: fs.existsSync(path.join(w.data, 'workspaces', c.id, 'reference')) };
  } finally { access.of = saved; }
}, { feature: { unit: 'F1', reason: 'launchAccess runs before creating workspace/reference folders; an access lookup failure now leaves no folders' } });
def('F1-launch-folders-created', (w) => {
  const c = started(w);
  const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [rel + e.name + '/', ...walk(path.join(d, e.name), rel + e.name + '/')] : [rel + e.name])).sort();
  return scrub(walk(path.join(w.data, 'workspaces')), w);
});
def('F1-launch-restart-clears-old-files', (w) => {
  const c = started(w);
  for (const f of ['runtime.json', 'settings.json', '.mcp.json', 'started.marker']) fs.writeFileSync(path.join(workDir(w, c), f), 'old');
  w.S.stop(c); w.tmux.sessions.clear(); w.S.launch(c);
  return scrub(fs.readdirSync(workDir(w, c)).sort(), w);
});
def('F1-confirm-workspace-expects-own-folder', (w) => { const c = started(w); w.tmux.screen = `Accessing workspace:\n${workDir(w, c)}\n❯ Yes, I trust this folder`; return scrub(catching(() => w.S.confirmWorkspace(c)), w); });
def('F1-purge-removes-the-project-folder-of-each-run', (w) => {
  const c = started(w);
  const proj = (cwd) => path.join(w.dirs.home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const own = proj(workDir(w, c)); fs.mkdirSync(own, { recursive: true }); fs.writeFileSync(path.join(own, 'a.jsonl'), '');
  const other = path.join(w.dirs.home, '.claude', 'projects', 'someone-elses'); fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, 'b.jsonl'), '');
  w.S.archiveFor('adm', c.id); w.S.purgeArchived(c.id);
  return scrub({ own: fs.existsSync(own), other: fs.existsSync(other), workspace: fs.existsSync(path.join(w.data, 'workspaces', c.id)) }, w);
});
def('F1-purge-leaves-a-resumed-session-file', (w) => {
  const resume = '11111111-2222-4333-8444-555555555555';
  const projects = path.join(w.dirs.home, '.claude', 'projects', 'elsewhere'); fs.mkdirSync(projects, { recursive: true }); fs.writeFileSync(path.join(projects, `${resume}.jsonl`), '');
  const c = w.S.create('adm', { title: 'Resumed', access: { full: true }, resumeSessionId: resume, start: false }, 'admin');
  w.S.archiveFor('adm', c.id); w.S.purgeArchived(c.id);
  return scrub({ sessionFile: fs.existsSync(path.join(projects, `${resume}.jsonl`)) }, w);
});
def('F1-create-persists-workspace-key', (w) => { mk(w, 'Alpha'); const c = persisted(w)[0]; return scrub({ has: Object.hasOwn(c, 'workspace'), value: c.workspace === undefined ? null : c.workspace }, w); }, { feature: { unit: 'F1', reason: 'a new agent stores workspace: "" (no folder bound)' } });
def('F1-profile-view-workspace-key', (w) => { const c = mk(w, 'Alpha'); const v = w.S.publicView(c); return scrub({ has: Object.hasOwn(v, 'workspace'), value: v.workspace === undefined ? null : v.workspace }, w); }, { feature: { unit: 'F1', reason: 'the agent view carries workspace: ""' } });
def('F1-launch-runtime-json-bound-key', (w) => { const c = started(w); const r = runtime(w, c); return scrub({ has: Object.hasOwn(r, 'bound'), value: r.bound === undefined ? null : r.bound }, w); }, { feature: { unit: 'F1', reason: 'runtime.json carries bound: false' } });
def('F1-archived-list-workspace-key', (w) => { const c = mk(w, 'Alpha'); w.S.archiveFor('adm', c.id); const row = w.S.archivedList()[0]; return scrub({ has: Object.hasOwn(row, 'workspace'), value: row.workspace === undefined ? null : row.workspace }, w); }, { feature: { unit: 'F1', reason: 'a deleted agent row carries workspace: ""' } });
def('F1-profile-model-change-while-busy-message', (w) => { const c = mk(w, 'Alpha'); w.S.active(c).phase = 'busy'; return scrub(catching(() => w.S.updateProfile(c, { profileVersion: 0, title: 'Alpha', description: '', memory: '', model: 'claude-sonnet-5-5', effort: c.effort }, 'admin')), w); }, { feature: { unit: 'F1', reason: 'the refusal for a profile change while busy names the work folder and global setup too' } });
def('F2-create-persists-globalHarness-key', (w) => { mk(w, 'Alpha'); const c = persisted(w)[0]; return scrub({ has: Object.hasOwn(c, 'globalHarness'), value: c.globalHarness === undefined ? null : c.globalHarness }, w); }, { feature: { unit: 'F2', reason: 'a new agent stores globalHarness: true' } });
def('F2-profile-view-globalHarness-key', (w) => { const c = mk(w, 'Alpha'); const v = w.S.publicView(c); return scrub({ has: Object.hasOwn(v, 'globalHarness'), value: v.globalHarness === undefined ? null : v.globalHarness }, w); }, { feature: { unit: 'F2', reason: 'the agent view carries globalHarness: true' } });
def('F2-bootstrap-profile-globalHarness-key', (w) => { const c = started(w); const r = w.S.bridge(c, 'bootstrap', {}); return scrub({ has: Object.hasOwn(r.profile, 'globalHarness'), value: r.profile.globalHarness === undefined ? null : r.profile.globalHarness }, w); }, { feature: { unit: 'F2', reason: 'the profile an agent reads at bootstrap carries globalHarness: true' } });
def('F2-launch-runtime-json-globalHarness-key', (w) => { const c = started(w); const r = runtime(w, c); return scrub({ has: Object.hasOwn(r, 'globalHarness'), value: r.globalHarness === undefined ? null : r.globalHarness, profile: Object.hasOwn(r.profile, 'globalHarness') }, w); }, { feature: { unit: 'F2', reason: 'runtime.json carries globalHarness: true' } });

// ---------------------------------------------------------------- export
// A case that throws (as opposed to returning a refusal it caught on purpose) failed to run, and the same failure on
// both sides would compare equal. It returns a value that names its side, so it differs, and the process exits non-zero
// even if the case is declared an expected difference.
const failures = [];
const failed = (name, root, e) => { failures.push(`${name}: ${e && e.message}`); return { harnessFailure: String(e && e.message), side: root }; };
const guarded = (name, root, run) => () => { try { const v = run(); return v && typeof v.then === 'function' ? v.catch((e) => failed(name, root, e)) : v; } catch (e) { return failed(name, root, e); } };
process.on('exit', () => { if (renameRetries) console.log(`NOTE agentStore.cjs: ${renameRetries} fixture rename(s) retried after EPERM/EBUSY/EACCES`); if (failures.length) { console.log(`ERROR agentStore.cjs: ${failures.length} case(s) failed to run instead of returning a result:\n  ${failures.join('\n  ')}`); process.exitCode = 1; } });
const REQUIRED = {
  'server/agentStore.js': [/\bfunction relayPeer\(/, /\bfunction socketAgentId\(/, /\bfunction agentWritable\(/, /\bfunction checkArgumentProblem\(/, /\bfunction mcpServerNames\(/, /\bfunction syncTerminalPrompt\(/, /\bconst prompts=new Map\(\)/, /\blet state\b/],
  'channel/server.mjs': [/bridge\(config,'bootstrap'/, /bridge\(config,'ready'/, /bridge\(config,'poll'/],
};
module.exports = (root) => {
  for (const [file, patterns] of Object.entries(REQUIRED)) { const text = fs.readFileSync(path.join(root, file), 'utf8'); for (const p of patterns) if (!p.test(text)) throw new Error(`Missing extraction in ${file}: ${p}`); }
  return Object.fromEntries(specs.map((s) => [s.name, guarded(s.name, root, () => (s.o.channel ? s.run(root) : world(root, s.o, (w) => s.run(w))))]));
};
module.exports.expected = Object.fromEntries(specs.filter((s) => s.o.expected).map((s) => [s.name, s.o.expected]));
module.exports.featureDifferences = Object.fromEntries(specs.filter((s) => s.o.feature).map((s) => [s.name, s.o.feature]));
