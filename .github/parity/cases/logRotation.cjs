'use strict';
// W11: O_NOFOLLOW handling in server/services/logRotation.js. The file's own text runs against real files
// in an isolated fixture folder (PARITY_TMP or the OS temp dir), through a wrapper around fs that can hide
// fs.constants.O_NOFOLLOW (the situation of a platform without it), record open flags, and swap a link in for
// the log right after the first lstat of it. Loading throws if the file or any internal function is missing.
// Cases are async-safe; they return plain values.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const Module = require('node:module');

const TMP_ROOT = process.env.PARITY_TMP || os.tmpdir();
const NOW = new Date('2026-10-25T00:00:00.000Z');
const LOG = 'api-audit.log';
const lines = (ts) => `${JSON.stringify({ ts, event: 'first' })}\n${JSON.stringify({ ts: '2026-10-24T12:00:00.000Z', event: 'second' })}\n`;

function load(root, fsImpl) {
  const file = path.join(root, 'server', 'services', 'logRotation.js');
  const src = fs.readFileSync(file, 'utf8');
  const real = Module.createRequire(file);
  const req = (id) => (id === 'node:fs' ? fsImpl : real(id));
  const footer = '\n;module.exports.__internals = { firstLineTimeMs, hardenRegularNoFollow, createOrOpenPrivateLog, rotateFile };\n';
  const wrapper = vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + src + footer + '})', { filename: file });
  const mod = { exports: {} };
  wrapper.call(mod.exports, mod.exports, req, mod, file, path.dirname(file));
  return mod.exports;
}

// kind 'link': a link to the decoy takes the path's place (needs permission to make links, which Windows may not give).
// kind 'file': the decoy, an ordinary file with its own identity, is renamed over the path, as an attacker without
// link rights would. A swap the platform refuses (Windows cannot replace a file that is open) is recorded in
// swap.failed and the case reports an unavailable fixture instead of a pass.
function doSwap(swap, p) {
  try {
    if (swap.kind === 'file') fs.renameSync(swap.decoy, p);
    else { fs.rmSync(p); fs.symlinkSync(swap.decoy, p); }
    swap.done = true;
  } catch (e) { swap.failed = e.code || e.message; }
}

function wrapFs({ hideNoFollow = false, opens, swap }) {
  const constants = { ...fs.constants };
  if (hideNoFollow) delete constants.O_NOFOLLOW;
  const bit = fs.constants.O_NOFOLLOW; // undefined on Windows
  const hooks = {
    constants,
    openSync(p, flags, ...rest) {
      opens.push({ file: path.basename(String(p)), flags, noFollow: bit ? (flags & bit) !== 0 : false, create: (flags & fs.constants.O_CREAT) !== 0 });
      return fs.openSync(p, flags, ...rest);
    },
    lstatSync(p, ...rest) {
      // The swap happens at the swap.nth-th lstat of swap.target, just before it (so it sees the new file) or just after it.
      const hit = swap && !swap.done && String(p) === swap.target && ++swap.seen === swap.nth;
      if (hit && swap.before) doSwap(swap, p);
      const info = fs.lstatSync(p, ...rest);
      if (hit && !swap.before) doSwap(swap, p);
      return info;
    },
  };
  return { ...fs, ...hooks };
}

function tree(dir) {
  const out = [];
  (function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name), info = fs.lstatSync(full), rel = path.relative(dir, full).split(path.sep).join('/');
      const mode = (info.mode & 0o777).toString(8);
      if (info.isSymbolicLink()) out.push({ path: rel, type: 'link' });
      else if (info.isDirectory()) { out.push({ path: rel, type: 'dir', mode }); walk(full); }
      else out.push({ path: rel, type: 'file', size: info.size, mode });
    }
  }(dir));
  return out;
}

const scrub = (v, subs) => (typeof v === 'string' ? subs.reduce((s, [from, to]) => s.split(from).join(to), v)
  : Array.isArray(v) ? v.map((x) => scrub(x, subs)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, subs)])) : v);

// setup(ctx) builds the fixture; act(mod, ctx) defaults to a full runLogRotation pass.
function scenario(root, { setup, act, hideNoFollow, swap, plain }) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'parity-lr-'));
  try {
    const ctx = { dir, logs: path.join(dir, 'logs'), log: path.join(dir, 'logs', LOG), archive: path.join(dir, 'logs', 'archive'), decoy: path.join(dir, 'decoy.log') };
    ctx.segment = path.join(ctx.archive, 'api-audit-20261025T000000Z.log'); // where the rotated log lands at NOW
    fs.mkdirSync(ctx.logs);
    if (swap && swap.kind === 'link') { // swapping in a link needs permission to make one; Windows without it cannot run these cases
      try { const probe = path.join(dir, 'probe-link'); fs.symlinkSync(ctx.log, probe, 'file'); fs.rmSync(probe); } catch (e) { return { setupFailed: e.code || e.message }; }
    }
    try { setup?.(ctx); } catch (e) { return { setupFailed: e.code || e.message }; }
    const opens = [];
    const state = swap && { nth: 1, before: false, at: 'log', ...swap, seen: 0, done: false, target: ctx[swap.at || 'log'], decoy: ctx.decoy };
    const mod = load(root, plain ? fs : wrapFs({ hideNoFollow, opens, swap: state }));
    let out;
    try { out = { value: act ? act(mod, ctx) : mod.runLogRotation({ logsDir: ctx.logs, now: NOW, files: [LOG] }) }; } catch (e) { out = { threw: e.message }; }
    if (state && !state.done) return { setupFailed: state.failed ? `swap refused: ${state.failed}` : 'swap never happened' }; // never a pass that tested nothing
    return scrub({ ...out, swapped: state ? true : undefined, tree: tree(dir), opens: plain ? undefined : opens }, [[fs.realpathSync(dir), '<dir>'], [dir, '<dir>']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const oldLog = (ctx) => fs.writeFileSync(ctx.log, lines('2026-10-01T00:00:00.000Z'), { mode: 0o644 });
const youngLog = (ctx) => fs.writeFileSync(ctx.log, lines('2026-10-24T00:00:00.000Z'));
const withDecoy = (ctx) => { fs.writeFileSync(ctx.decoy, lines('2026-10-01T00:00:00.000Z')); oldLog(ctx); };
const linkedLog = (ctx) => { fs.writeFileSync(ctx.decoy, lines('2026-10-01T00:00:00.000Z')); fs.symlinkSync(ctx.decoy, ctx.log); };
const segment = (ctx, name, ageDays) => { fs.mkdirSync(ctx.archive, { recursive: true }); const f = path.join(ctx.archive, name); fs.writeFileSync(f, 'x\n'); const t = new Date(NOW.getTime() - ageDays * 86400000); fs.utimesSync(f, t, t); };
const segments = (ctx) => { segment(ctx, 'api-audit-20230101T000000Z.log', 800); segment(ctx, 'api-audit-20260101T000000Z.log', 300); segment(ctx, 'other-20230101T000000Z.log', 800); };
const ok = () => ({ ok: true });

module.exports = (root) => ({
  // O_NOFOLLOW present (every real POSIX platform): the upstream behavior
  'rotate: 24-day-old log is archived and recreated empty': () => scenario(root, { setup: oldLog }),
  'rotate: 1-day-old log is left alone': () => scenario(root, { setup: youngLog }),
  'rotate: dry run names the segment and changes nothing': () => scenario(root, { setup: oldLog, act: (m, c) => m.runLogRotation({ logsDir: c.logs, now: NOW, files: [LOG], dryRun: true }) }),
  'rotate: first line is not JSON': () => scenario(root, { setup: (c) => fs.writeFileSync(c.log, 'not json\n') }),
  'rotate: empty log': () => scenario(root, { setup: (c) => fs.writeFileSync(c.log, '') }),
  'rotate: missing log': () => scenario(root, {}),
  'rotate: segment name clashes with an existing one': () => scenario(root, { setup: (c) => { oldLog(c); segment(c, 'api-audit-20261025T000000Z.log', 0); } }),
  'rotate: log that is a symlink is refused': () => scenario(root, { setup: linkedLog }),
  'rotate: opens carry O_NOFOLLOW': () => scenario(root, { setup: oldLog }).opens,
  'rotate: log swapped for a link after the lstat': () => scenario(root, { setup: withDecoy, swap: { kind: 'link' } }),
  // Ordinary-file swaps need no link permission, so they also run where the five link cases above are skipped
  // (Windows without Developer Mode: rotate x2, retention, no-O_NOFOLLOW x2, each reported as a SKIP).
  // Each moves a different file over the path at a different step; the identity checks must then refuse.
  'identity: log replaced by another file after the first lstat': () => scenario(root, { setup: withDecoy, swap: { kind: 'file' } }),
  'identity: log replaced by another file before the lstat that precedes the rename': () => scenario(root, { setup: withDecoy, swap: { kind: 'file', nth: 2, before: true } }),
  'identity: rotated segment replaced by another file after its lstat': () => scenario(root, { setup: withDecoy, swap: { kind: 'file', at: 'segment' } }),
  'identity: new log replaced by another file before its lstat': () => scenario(root, { setup: withDecoy, swap: { kind: 'file', nth: 3, before: true } }),
  'retention: segments past a year are deleted': () => scenario(root, { setup: segments }),
  'retention: dry run deletes nothing': () => scenario(root, { setup: segments, act: (m, c) => m.runLogRotation({ logsDir: c.logs, now: NOW, files: [LOG], dryRun: true }) }),
  'retention: archive folder that is a link is skipped': () => scenario(root, { setup: (c) => { fs.mkdirSync(path.join(c.dir, 'elsewhere')); fs.writeFileSync(path.join(c.dir, 'elsewhere', 'api-audit-20230101T000000Z.log'), 'x\n'); fs.symlinkSync(path.join(c.dir, 'elsewhere'), c.archive, 'dir'); } }),
  'wrapper control: hooks alone do not change a pass': () => {
    const a = scenario(root, { setup: oldLog }), b = scenario(root, { setup: oldLog, plain: true });
    delete a.opens;
    return { same: util.isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))), value: a.value };
  },
  'constant: O_NOFOLLOW as given to the module, and the exact open flags it then uses': () => {
    const given = (hideNoFollow) => { const value = wrapFs({ hideNoFollow, opens: [] }).constants.O_NOFOLLOW; return { value: value ?? null, isInteger: Number.isInteger(value) }; };
    const flags = (hideNoFollow) => scenario(root, { setup: oldLog, hideNoFollow }).opens.map((o) => o.flags);
    return { present: { ...given(false), openFlags: flags(false) }, hidden: { ...given(true), openFlags: flags(true) } };
  },
  // O_NOFOLLOW missing: a platform without it must refuse (upstream), except Windows (this tree)
  'no O_NOFOLLOW: 24-day-old log': () => scenario(root, { setup: oldLog, hideNoFollow: true }),
  'no O_NOFOLLOW: 1-day-old log': () => scenario(root, { setup: youngLog, hideNoFollow: true }),
  'no O_NOFOLLOW: dry run': () => scenario(root, { setup: oldLog, hideNoFollow: true, act: (m, c) => m.runLogRotation({ logsDir: c.logs, now: NOW, files: [LOG], dryRun: true }) }),
  'no O_NOFOLLOW: missing log': () => scenario(root, { hideNoFollow: true }),
  'no O_NOFOLLOW: log that is a symlink': () => scenario(root, { setup: linkedLog, hideNoFollow: true }),
  'no O_NOFOLLOW: log swapped for a link after the lstat': () => scenario(root, { setup: withDecoy, hideNoFollow: true, swap: { kind: 'link' } }),
  'no O_NOFOLLOW: retention still deletes old segments': () => scenario(root, { setup: segments, hideNoFollow: true }),
  'no O_NOFOLLOW: firstLineTimeMs': () => scenario(root, { setup: oldLog, hideNoFollow: true, act: (m, c) => m.__internals.firstLineTimeMs(c.log, fs.lstatSync(c.log)) }),
  'no O_NOFOLLOW: hardenRegularNoFollow': () => scenario(root, { setup: oldLog, hideNoFollow: true, act: (m, c) => { m.__internals.hardenRegularNoFollow(c.log); return ok(); } }),
  'no O_NOFOLLOW: createOrOpenPrivateLog': () => scenario(root, { hideNoFollow: true, act: (m, c) => { m.__internals.createOrOpenPrivateLog(c.log); return ok(); } }),
});

// W11 is gated, not a B unit: no intentional differences.
module.exports.expected = {};
