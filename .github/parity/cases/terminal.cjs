'use strict';
// W8: how server/terminal.js starts the tmux attach. Two parts: the pieces cut out of the file (command, tmux
// arguments), and the real installTerminal driven through a fake upgrade, so the options node-pty is spawned
// with (command, arguments, size, cwd, env) are the file's own, with its collaborators replaced by fakes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const TMP_ROOT = process.env.PARITY_TMP || os.tmpdir();

// terminal.js with its modules faked, except the two that decide the command and are loaded from the tree.
function load(root, fakes) {
  const file = path.join(root, 'server', 'terminal.js');
  const real = Module.createRequire(file);
  const req = (id) => (id in fakes ? fakes[id] : real(id));
  const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  const mod = { exports: {} };
  wrapper.call(mod.exports, mod.exports, req, mod, file, path.dirname(file));
  return mod.exports;
}

// One browser attachment through installTerminal. The folder is put first on PATH while it runs (cases run one at a time).
async function attachViaUpgrade(root, { session, binDir, spawnFails }) {
  const spawned = [], sent = [], ended = [], audits = [], handlers = {}, wsHandlers = {};
  let killed = 0;
  const term = { onData() {}, onExit() {}, write() {}, resize() {}, kill() { killed++; } };
  const ws = { readyState: 1, bufferedAmount: 0, on(event, fn) { wsHandlers[event] = fn; }, send(data) { sent.push(JSON.parse(data)); }, ping() {}, close() {}, terminate() {} };
  const conversation = { id: 'c1', mode: 'claude' }, generation = { phase: 'running', token: 't1', tmux: session, sessionId: 's1' };
  const fakes = {
    ws: { WebSocketServer: class { constructor() { this.clients = new Set(); } handleUpgrade(req, socket, head, fn) { fn(ws); } close() {} } },
    jsonwebtoken: { verify: () => ({ id: 'u1' }) },
    './services/livePrincipal': { resolveLivePrincipal: async () => ({ id: 'u1', role: 'admin', username: 'root' }) },
    './agentStore': { get: () => conversation, active: () => generation, stateRoot: '/state', tmuxSocket: 'cc-agent-0123456789abcdef' },
    '../channel/agentEnv.cjs': () => ({ A: '1', TERM: 'dumb' }),
    './services/audit': { audit: (event) => audits.push(event) },
    './services/clientIp': { resolveClientIp: () => '203.0.113.9' },
    './siteConfig': { isAllowedSocket: () => true },
  };
  const savedPath = process.env.PATH;
  if (binDir) process.env.PATH = binDir;
  try {
    const { installTerminal } = load(root, fakes);
    const pty = { spawn(...args) { spawned.push(args); if (spawnFails) throw new Error('spawn failed'); return term; } };
    const terminal = installTerminal({ on: (event, fn) => { handlers[event] = fn; } }, { ptyModule: pty, tickMs: 1e9, sessionAlive: () => true });
    await handlers.upgrade({ url: '/terminal/12345678-1234-1234-1234-123456789abc', headers: { cookie: 'session_id=tok' } }, { on() {}, end: (text) => ended.push(text), destroyed: false }, Buffer.alloc(0));
    wsHandlers.close?.(); // stops the tick timer, kills the pty
    terminal.close();
    return { spawned: spawned.map(([command, args, options]) => ({ command: command.split(binDir || '\0').join('<bin>'), args, options })), sent, ended, audits: audits.map(({ status, source, conversation: c }) => ({ source, status, c })), killed };
  } finally { process.env.PATH = savedPath; }
}

// A PATH folder holding a tmux under both its POSIX and its Windows name, or an empty one.
async function withBin(withTmux, fn) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'parity-term-'));
  try {
    if (withTmux) for (const name of ['tmux', 'tmux.exe']) { fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, name), 0o755); }
    return await fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = root => {
  const source = fs.readFileSync(path.join(root, 'server/terminal.js'), 'utf8');
  const platformFile = path.join(root, 'channel/platform.cjs');
  const platform = fs.existsSync(platformFile) ? require(platformFile) : null;
  const match = source.match(/const tmuxCommand=([^;]+);/);
  if (!match && !source.includes("ptyModule.spawn('tmux',attachArgs(")) throw Error('Missing terminal spawn extraction');
  const attach = source.match(/const attachArgs=([\s\S]*?);\r?\nfunction installTerminal/);
  if (!attach) throw Error('Missing attachArgs extraction');
  const attachArgs = vm.runInNewContext(attach[1], { LOCKED: 'cc-agent-locked' });
  const command = match ? vm.runInNewContext(match[1], { platform, runtimeTools: { resolveOnPath: () => ({ path: 'fixture-tmux.exe' }) } }) : () => 'tmux';
  const cases = {};
  for (const session of ['execagent-12345678-g1', 'name with spaces', '%7']) cases[`W8-pty-${session}`] = () => ({ command: command(), args: attachArgs(session, 'cc-agent-1234567890abcdef') });
  for (const session of ['execagent-12345678-g1', '%7']) cases[`W8-spawn-${session}-tmux-on-PATH`] = () => withBin(true, (binDir) => attachViaUpgrade(root, { session, binDir }));
  cases['W8-spawn-no-tmux-on-PATH'] = () => withBin(false, (binDir) => attachViaUpgrade(root, { session: 'execagent-12345678-g1', binDir }));
  cases['W8-spawn-throws'] = () => withBin(true, (binDir) => attachViaUpgrade(root, { session: 'execagent-12345678-g1', binDir, spawnFails: true }));
  return cases;
};
