'use strict';
// W13 / W14 / B4: spawn options, environment, kill and finish paths of server/scheduleChecks.js.
// No process is started or killed. The file's own text runs inside a function wrapper that swaps
// node:child_process for a recording fake and shadows `process` (env, kill) and the timers, so a
// scripted child and a scripted OS decide what happens. Loading throws if the file or `create` is missing.
// Cases are async because run() returns a promise; fixtures live in PARITY_TMP (or the OS temp dir).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const TMP_ROOT = process.env.PARITY_TMP || os.tmpdir();
const PENDING = '<still pending>';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A process.env with Windows-looking variables and two that must never reach a check.
const SIM_ENV = { PATH: 'C:\\sim\\bin;C:\\sim\\tools', SystemRoot: 'C:\\SimWin', windir: 'C:\\SimWin', USERPROFILE: 'C:\\Users\\sim', TEMP: 'C:\\Users\\sim\\Temp', COMSPEC: 'C:\\SimWin\\System32\\cmd.exe', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\sim\\git\\bash.exe', HOME: '/not/used', LANG: 'C', SECRET_TOKEN: 'leak-me', FOO: 'bar' };
// What the scripted OS answers when a check is killed: a POSIX group kill, Windows' taskkill and its liveness probe.
const OS_OK = { groupKill: 'ok', alive: true, taskkill: { status: 0 } };
const OS_REFUSED = { groupKill: 'EPERM', alive: true, taskkill: { status: 1, stderr: 'ERROR: Access is denied.\r\n' } };
const OS_GONE = { groupKill: 'ESRCH', alive: false, taskkill: { status: 128, stderr: 'ERROR: The process "4242" not found.\r\n' } };
const GOOD = '{"ok":true}\n';

function load(root, sim) {
  const file = path.join(root, 'server', 'scheduleChecks.js');
  const src = fs.readFileSync(file, 'utf8');
  const real = Module.createRequire(file);
  const fake = { 'node:child_process': { spawn: sim.spawn, spawnSync: sim.spawnSync } };
  const req = (id) => (Object.hasOwn(fake, id) ? fake[id] : real(id));
  const wrapper = vm.runInThisContext('(function (exports, require, module, __filename, __dirname, process, setTimeout, clearTimeout) {' + src + '\n})', { filename: file });
  const mod = { exports: {} };
  wrapper.call(mod.exports, mod.exports, req, mod, file, path.dirname(file), sim.process, sim.setTimeout, sim.clearTimeout);
  if (typeof mod.exports.create !== 'function') throw new Error(`create() missing in ${file}`);
  return mod.exports;
}

function simulate(cfg) {
  const log = { spawn: [], spawnSync: [], kill: [], delays: [], stdin: [], destroyed: [] };
  const world = { ...OS_OK, ...cfg.os };
  const env = { ...(cfg.env || SIM_ENV) };
  const snap = (options) => ({ keys: Object.keys(options).sort(), ...JSON.parse(JSON.stringify(options)) });
  const timers = [];
  let clock = 0;
  const sim = { log, env };
  sim.setTimeout = (fn, ms) => { const t = { at: clock + ms, fn, off: false, done: false, order: timers.length }; timers.push(t); log.delays.push(ms); return { unref() { return this; }, ref() { return this; }, t }; };
  sim.clearTimeout = (h) => { if (h && h.t) h.t.off = true; };
  sim.advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.off && !t.done && t.at <= end).sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!due) break;
      due.done = true; clock = due.at; due.fn();
    }
    clock = end;
  };
  const stream = (name) => Object.assign(new EventEmitter(), { closed: false, destroyed: false, destroy() { this.destroyed = true; this.closed = true; log.destroyed.push(name); } });
  sim.spawn = (file, args, options) => {
    log.spawn.push({ file, args: [...args], options: snap(options) });
    if (cfg.spawnThrows) throw new Error(cfg.spawnThrows);
    const stdin = Object.assign(new EventEmitter(), { end: (data) => { log.stdin.push(String(data)); } });
    sim.child = Object.assign(new EventEmitter(), { pid: 'pid' in cfg ? cfg.pid : 4242, exitCode: null, signalCode: null, stdout: stream('stdout'), stderr: stream('stderr'), stdin });
    return sim.child;
  };
  sim.spawnSync = (file, args, options) => {
    log.spawnSync.push({ file, args: [...args], options: snap(options) });
    if (world.taskkill.status === 0) world.alive = false;
    return world.taskkill;
  };
  const kill = (pid, signal) => {
    log.kill.push({ pid: String(pid), signal: signal === undefined ? null : signal });
    if (!Number.isInteger(pid)) throw Object.assign(new TypeError(`The "pid" argument must be of type number. Received ${pid}`), { code: 'ERR_INVALID_ARG_TYPE' });
    if (signal === 0) { if (world.alive) return true; throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', syscall: 'kill' }); }
    if (pid < 0 && world.groupKill !== 'ok') throw Object.assign(new Error('kill ' + world.groupKill), { code: world.groupKill, syscall: 'kill' });
    return true;
  };
  sim.process = new Proxy(process, { get: (target, key) => (key === 'env' ? env : key === 'kill' ? kill : Reflect.get(target, key)) });
  // What the scripted child does.
  // A destroyed stream delivers nothing more, as in Node.
  sim.out = (data) => { if (!sim.child.stdout.destroyed) sim.child.stdout.emit('data', Buffer.from(data)); };
  sim.err = (data) => { if (!sim.child.stderr.destroyed) sim.child.stderr.emit('data', Buffer.from(data)); };
  sim.flood = () => { sim.out(Buffer.alloc(600 * 1024, 'x')); sim.out(Buffer.alloc(600 * 1024, 'y')); };
  sim.exit = (code, signal) => { sim.child.exitCode = code; sim.child.signalCode = signal; sim.child.emit('exit', code, signal); };
  sim.close = (code, signal) => { sim.child.stdout.closed = true; sim.child.stderr.closed = true; sim.child.emit('close', code, signal); };
  sim.error = (e) => sim.child.emit('error', e);
  return sim;
}

const shape = (text) => (text.length > 64 ? { length: text.length, head: text.slice(0, 16), end: text.slice(-16) } : text);
const scrub = (v, subs) => (typeof v === 'string' ? subs.reduce((s, [from, to]) => s.split(from).join(to), v)
  : Array.isArray(v) ? v.map((x) => scrub(x, subs)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, subs)])) : v);

async function drive(root, cfg, script = async () => {}) {
  const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'parity-sc-'));
  try {
    const exe = path.join(tmp, 'check');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.writeFileSync(path.join(tmp, 'schedule-checks.json'), JSON.stringify({ checks: [{ id: 'sim', name: 'sim', command: [exe, '--json'], timeoutSeconds: cfg.timeoutSeconds || 120 }] }));
    const sim = simulate(cfg);
    const checks = load(root, sim).create(tmp);
    let settled = false, result;
    checks.run('sim', { lastKey: 'k' }).then((v) => { settled = true; result = v; });
    const marks = {};
    sim.mark = async (name) => { await tick(); marks[name] = settled; };
    await script(sim);
    await tick();
    const subs = [[fs.realpathSync(tmp), '<tmp>'], [tmp, '<tmp>'], [os.homedir(), '<home>']];
    const done = settled ? scrub({ ...result, durationMs: typeof result.durationMs, stdoutTail: shape(result.stdoutTail), stderrTail: shape(result.stderrTail) }, subs) : PENDING;
    return { result: done, marks, log: scrub(sim.log, subs) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const SCRIPTS = {
  ok: async (s) => { s.out(GOOD); s.exit(0, null); s.close(0, null); },
  exit3: async (s) => { s.out('no json here\n'); s.exit(3, null); s.close(3, null); },
  notJson: async (s) => { s.out('hello\n'); s.exit(0, null); s.close(0, null); },
  stragglers: async (s) => { s.out(GOOD); s.exit(0, null); await s.mark('afterExit'); s.advance(1000); await s.mark('afterOneSecond'); },
  timeout: async (s) => { s.advance(4999); await s.mark('beforeTimeout'); s.advance(1); await s.mark('atTimeout'); },
  floodKilled: async (s) => { s.flood(); await s.mark('afterFlood'); s.exit(null, 'SIGKILL'); s.close(null, 'SIGKILL'); await s.mark('afterClose'); },
  floodSelfExit: async (s) => { s.flood(); await s.mark('afterFlood'); s.exit(0, null); s.close(0, null); await s.mark('afterClose'); },
  floodLate: async (s) => { s.flood(); s.out('late output\n'); s.exit(null, 'SIGKILL'); s.close(null, 'SIGKILL'); },
  floodMixed: async (s) => { s.out(Buffer.alloc(600 * 1024, 'x')); s.err(Buffer.alloc(600 * 1024, 'e')); await s.mark('afterBoth'); s.exit(null, 'SIGKILL'); s.close(null, 'SIGKILL'); },
  atLimit: async (s) => { s.out(Buffer.concat([Buffer.alloc(4 * 256 * 1024 - 1 - GOOD.length, 'x'), Buffer.from('\n')])); s.out(GOOD); s.exit(0, null); s.close(0, null); },
  spawnError: async (s) => { s.error(new Error('spawn ENOENT')); },
};
const SCENARIOS = {
  ok: [{ os: OS_GONE }, SCRIPTS.ok],
  okGroupAlive: [{ os: OS_OK }, SCRIPTS.ok],
  okRefused: [{ os: OS_REFUSED }, SCRIPTS.ok],
  exit3: [{ os: OS_GONE }, SCRIPTS.exit3],
  notJson: [{ os: OS_GONE }, SCRIPTS.notJson],
  stragglers: [{ os: OS_OK }, SCRIPTS.stragglers],
  throws: [{ spawnThrows: 'EACCES simulated' }],
  spawnError: [{ pid: undefined }, SCRIPTS.spawnError],
  timeout: [{ timeoutSeconds: 5, os: OS_OK }, SCRIPTS.timeout],
  timeoutGone: [{ timeoutSeconds: 5, os: OS_GONE }, SCRIPTS.timeout],
  timeoutRefused: [{ timeoutSeconds: 5, os: OS_REFUSED }, SCRIPTS.timeout],
  timeoutNoSystemRoot: [{ timeoutSeconds: 5, env: { PATH: 'C:\\sim\\bin' } }, SCRIPTS.timeout],
  flood: [{ os: OS_OK }, SCRIPTS.floodKilled],
  floodSelfExit: [{ os: OS_OK }, SCRIPTS.floodSelfExit],
  floodRefused: [{ os: OS_REFUSED }, SCRIPTS.floodSelfExit],
  floodLate: [{ os: OS_OK }, SCRIPTS.floodLate],
  floodMixed: [{ os: OS_OK }, SCRIPTS.floodMixed],
  atLimit: [{ os: OS_GONE }, SCRIPTS.atLimit],
};

module.exports = (root) => {
  const go = (name) => drive(root, ...SCENARIOS[name]);
  const calls = (t) => ({ kill: t.log.kill, spawnSync: t.log.spawnSync, destroyed: t.log.destroyed, delays: t.log.delays });
  const cases = {
    // W13: what the check is spawned with
    'spawn: command, arguments and options': async () => { const { file, args, options } = (await go('ok')).log.spawn[0]; return { file, args, options }; },
    'spawn: environment built from a process.env with extra variables': async () => (await go('ok')).log.spawn[0].options.env,
    'spawn: input reaches stdin': async () => (await go('ok')).log.stdin,
    // Result and calls of a normal run, and of the other ways a run can end
    'exit 0 with JSON, group gone: result': async () => (await go('ok')).result,
    'exit 0 with JSON: kill, taskkill, destroy and timer calls': async () => calls(await go('ok')),
    'exit 0 with JSON, group still there: result': async () => (await go('okGroupAlive')).result,
    'exit 0 with JSON, kill refused: result': async () => (await go('okRefused')).result,
    'exit 3: result': async () => (await go('exit3')).result,
    'last line not JSON: result': async () => (await go('notJson')).result,
    'exit event while pipes stay open: result and marks': async () => { const t = await go('stragglers'); return { result: t.result, marks: t.marks, delays: t.log.delays }; },
    'spawn throws: result': async () => (await go('throws')).result,
    'spawn error event: result': async () => (await go('spawnError')).result,
    'spawn error event: kill attempts': async () => (await go('spawnError')).log.kill,
    // Timeout
    'timeout: result and marks': async () => { const t = await go('timeout'); return { result: t.result, marks: t.marks }; },
    'timeout: kill, taskkill, destroy and timer calls': async () => calls(await go('timeout')),
    'timeout, group gone: result': async () => (await go('timeoutGone')).result,
    'timeout, kill refused: result': async () => (await go('timeoutRefused')).result,
    // Output flood
    'flood: result once the child is killed': async () => (await go('flood')).result,
    'flood: settled when the limit is crossed': async () => (await go('flood')).marks,
    'flood: kill, taskkill, destroy and timer calls': async () => calls(await go('flood')),
    'flood: child exits 0 by itself, result': async () => { const t = await go('floodSelfExit'); return { result: t.result, marks: t.marks }; },
    'flood, kill refused: result and marks': async () => { const t = await go('floodRefused'); return { result: t.result, marks: t.marks }; },
    'flood: output arriving after the limit, result': async () => (await go('floodLate')).result,
    'flood: stdout and stderr count together, result': async () => (await go('floodMixed')).result,
    'output exactly at the limit is not a flood: result': async () => (await go('atLimit')).result,
    // W14: what is run to end a check's process tree
    'taskkill: calls when a check times out': async () => (await go('timeout')).log.spawnSync,
    'taskkill: path when process.env has no SystemRoot': async () => (await go('timeoutNoSystemRoot')).log.spawnSync,
  };
  return cases;
};

// B4: the shared finish path now owns the one kill and reports it. Each entry is a difference seen off Windows.
const KILL = 'a kill that fails for any reason but ESRCH is reported and fails the run (upstream ignored it)';
module.exports.expected = {
  'exit 0 with JSON, kill refused: result': { unit: 'B4', reason: KILL },
  'timeout, kill refused: result': { unit: 'B4', reason: KILL + '; signal is null then' },
  'flood, kill refused: result and marks': { unit: 'B4', reason: KILL + '; the run also ends at the flood, not at the child exit' },
  'timeout: kill, taskkill, destroy and timer calls': { unit: 'B4', reason: 'the timeout path kills once, from finish (upstream killed in the timer and again in finish)' },
  'flood: kill, taskkill, destroy and timer calls': { unit: 'B4', reason: 'the flood ends the run through finish, which kills once (upstream killed at the flood and again at the close)' },
  'flood: output arriving after the limit, result': { unit: 'B4', reason: 'the tail stops at the flood: once the run has ended the pipes are destroyed (upstream kept collecting until the child closed)' },
  'flood: settled when the limit is crossed': { unit: 'B4', reason: 'the run ends when the output limit is crossed, not when the killed child closes its pipes' },
  'flood: child exits 0 by itself, result': { unit: 'B4', reason: 'a flooded run reports the kill (exitCode null, SIGKILL) even when the child exits 0 at the same moment' },
  'spawn error event: kill attempts': { unit: 'B4', reason: 'no pid, no kill attempt (upstream called process.kill(NaN), which threw and was ignored)' },
};
