'use strict';
// W7: the usage meter's login lookup (server/claudeUsage.js). Only Windows may read
// ~/.claude/.credentials.json; every other platform keeps upstream's Keychain lookup
// through /usr/bin/security. The real source is evaluated again for each case with the
// child-process module replaced, a fixture HOME, and a fetch stub: no Keychain, no real
// login, no network. Each scenario runs on the host's own platform and with
// process.platform set to darwin, so a Windows host also exercises the non-Windows branch.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const BASE = path.join(process.env.PARITY_TMP || os.tmpdir(), `parity-w7-${process.pid}`);
const login = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token } });
const OK = { five_hour: { utilization: 12.4, resets_at: '2026-10-25T10:00:00Z' }, seven_day: { utilization: 55.5, resets_at: '2026-10-30T00:00:00Z' } };
const NOT_FOUND = Object.assign(new Error('not found'), { code: 44 });
const DENIED = Object.assign(new Error('denied'), { code: 1 });

const reply = (status, body, headers = {}) => async () => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k] ?? null }, json: async () => { if (body instanceof Error) throw body; return body; } });

// Same source, new instance, with node:child_process replaced.
function loadUsage(root, child) {
  const file = path.join(root, 'server/claudeUsage.js');
  if (!fs.existsSync(file)) throw Error(`Missing claudeUsage source: ${file}`);
  const real = Module.createRequire(file), mod = { exports: {} };
  const wrapped = `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\n})`;
  vm.runInThisContext(wrapped, { filename: file })(mod.exports, (id) => (id === 'node:child_process' ? child : real(id)), mod, file, path.dirname(file));
  if (typeof mod.exports.create !== 'function') throw Error(`Missing claudeUsage.create in ${file}`);
  return mod.exports;
}

// keychain(args) -> { error?, stdout? } for the two lookups (with and without -a <user>).
// file: contents of HOME/.claude/.credentials.json, or undefined for no file.
async function scenario(root, { platform, keychain = () => ({ error: NOT_FOUND }), file, http = reply(200, OK), steps = [{ at: 0 }] }) {
  const execCalls = [], fetchCalls = [], user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const child = { execFile: (command, args, options, done) => { execCalls.push({ command, args: args.map((a) => (a === user ? '<user>' : a)), options }); const r = keychain(args); setImmediate(() => done(r.error || null, r.stdout || '')); } };
  const home = path.join(BASE, `h${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (file !== undefined) fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), file);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, original = Object.getOwnPropertyDescriptor(process, 'platform');
  let clock = 1_700_000_000_000;
  const results = [];
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    if (platform) Object.defineProperty(process, 'platform', { ...original, value: platform });
    const usage = loadUsage(root, child).create({ now: () => clock, fetchImpl: async (url, init) => { fetchCalls.push({ url, authorization: init.headers.Authorization, beta: init.headers['anthropic-beta'], signal: typeof init.signal }); return http(); } });
    for (const step of steps) { clock += step.at; results.push(await usage({ fresh: step.fresh === true })); }
  } finally {
    Object.defineProperty(process, 'platform', original);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
    try { fs.rmdirSync(BASE); } catch { /* another case still has its folder here */ }
  }
  return { results, fetch: fetchCalls, exec: execCalls };
}

module.exports = (root) => {
  const own = (token) => (args) => (args.includes('-a') ? { stdout: login(token) } : { stdout: login('fixture-any') });
  const scenarios = {
    'keychain-own-login': { keychain: own('fixture-own') },
    'keychain-own-missing-falls-back': { keychain: (args) => (args.includes('-a') ? { error: NOT_FOUND } : { stdout: login('fixture-any') }) },
    'keychain-none': { keychain: () => ({ error: NOT_FOUND }) },
    'keychain-denied': { keychain: () => ({ error: DENIED }) },
    'keychain-own-denied-any-found': { keychain: (args) => (args.includes('-a') ? { error: DENIED } : { stdout: login('fixture-any') }) },
    'keychain-not-json': { keychain: () => ({ stdout: 'not json' }) },
    'keychain-empty-token': { keychain: () => ({ stdout: login('') }) },
    'keychain-number-token': { keychain: () => ({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: 7 } }) }) },
    'file-valid-keychain-none': { file: login('fixture-file'), keychain: () => ({ error: NOT_FOUND }) },
    'file-valid-keychain-valid': { file: login('fixture-file'), keychain: own('fixture-own') },
    'file-not-json': { file: '{broken', keychain: () => ({ error: NOT_FOUND }) },
    'file-empty-token': { file: login(''), keychain: () => ({ error: NOT_FOUND }) },
    'file-number-token': { file: JSON.stringify({ claudeAiOauth: { accessToken: 7 } }), keychain: () => ({ error: NOT_FOUND }) },
    'file-missing-keychain-none': { keychain: () => ({ error: NOT_FOUND }) },
    'file-missing-keychain-valid': { keychain: own('fixture-own') },
    // The answer handling after a token is found, with a login both Windows and the others can read.
    'http-ok': { file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-ok-cached-then-asked-again': { file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }), steps: [{ at: 0 }, { at: 60_000 }, { at: 400_000 }] },
    'http-ok-fresh-pull': { file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }), steps: [{ at: 0 }, { at: 5_000, fresh: true }, { at: 20_000, fresh: true }] },
    'http-401': { http: reply(401, {}), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-403': { http: reply(403, {}), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-429-retry-after': { http: reply(429, {}, { 'retry-after': '30' }), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }), steps: [{ at: 0 }, { at: 1_000 }, { at: 60_000 }] },
    'http-429-default-wait': { http: reply(429, {}), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-500': { http: reply(500, {}), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-network-error': { http: async () => { throw new Error('offline'); }, file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-body-not-json': { http: reply(200, new Error('bad json')), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
    'http-no-weekly-window': { http: reply(200, { five_hour: OK.five_hour }), file: login('fixture-token'), keychain: () => ({ stdout: login('fixture-token') }) },
  };
  const cases = {};
  for (const [name, spec] of Object.entries(scenarios)) {
    cases[`W7-${name}-native`] = () => scenario(root, spec);
    cases[`W7-${name}-darwin`] = () => scenario(root, { ...spec, platform: 'darwin' });
  }
  return cases;
};
