'use strict';
// W3: path handling in channel/runtimeTools.cjs. Backslash is a file-name character on Linux.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Fixture tree shared by both sides of one run: a PATH folder with an executable `claude`,
// a folder whose name ends in a backslash, and one with a backslash in the middle. Every program
// exists under both its POSIX name and `name.exe`, since Windows resolves only the second.
// A folder of its own per run, removed on exit, so runs at the same time never delete each other's files.
const base = fs.mkdtempSync(path.join(process.env.PARITY_TMP || os.tmpdir(), 'parity-rt-'));
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
for (const d of ['home/u/.local/bin', 'opt/tool\\', 'opt/a\\b/bin', 'usr/local/bin']) fs.mkdirSync(path.join(base, d), { recursive: true });
for (const f of ['home/u/.local/bin/claude', 'opt/tool\\/claude', 'opt/a\\b/bin/tmux', 'usr/local/bin/node']) {
  for (const name of [f, `${f}.exe`]) { fs.writeFileSync(path.join(base, name), '#!/bin/sh\n'); fs.chmodSync(path.join(base, name), 0o755); }
}

// Joined with the platform's PATH delimiter; a plain string is used as written (Windows paths and odd spellings).
const at = (...entries) => entries.join(path.delimiter);
const PATHS = ['/usr/bin:/bin', '/opt/tool\\:/usr/bin', '/opt/tool\\\\', '/a//b///:/a/b/', ':.:rel:/x', '/ab\\cd:/ab\\cd/',
  at(`${base}/opt/tool\\`, `${base}/home/u/.local/bin`), `${base}/opt/a\\b/bin`, 'C:\\tools;D:\\bin', '/',
  at(`${base}/home/u/.local/bin`, `${base}/usr/local/bin`, `${base}/opt/a\\b/bin`, `${base}/opt/tool\\`)];
const DIRS = ['/', '/opt', '/ab\\cd', '/ab\\cd\\ef', '/opt/tool\\', '/home/test', '/home', '/usr/bin/x', '/Library/x', '/srv/a\\b/c', '\\\\server\\share', `${base}/opt/a\\b`];
const HOME = '/home/test';
// [dir, home]: a home's ancestors are too broad, a name that only starts like one is not. A backslash is part of
// a name off Windows and a separator on it, so each spelling that differs by one is paired with the other.
const ANCESTORS = [['/home/te', '/home/test'], ['/home/test/p', '/home/test'], ['/var/home', '/var/home/test'], ['/var/home/', '/var/home/test'], ['/var/ho', '/var/home/test'],
  ['/x/y', '/x/y\\z'], ['/x/y\\', '/x/y\\/z'], ['/x/y\\z', '/x/y\\z/w'], ['/x/y\\z', '/x/y/z/w'], ['/x/y/z', '/x/y\\z/w'], ['/x/y', '/x\\y/z']];
const shown = (s) => s.split(base).join('$B');

module.exports = (root) => {
  const m = require(path.join(root, 'channel/runtimeTools.cjs'));
  // Without a program found in the fixture every resolveOnPath case would return null and compare nothing.
  for (const name of ['claude', 'tmux', 'node']) if (!m.resolveOnPath(name, at(`${base}/home/u/.local/bin`, `${base}/opt/a\\b/bin`, `${base}/usr/local/bin`))) throw new Error(`Fixture ${name} not found on this platform`);
  const env = (PATH, extra = {}) => ({ PATH, ...extra });
  const cases = {};
  PATHS.forEach((p, i) => { cases[`cleanPath#${i} ${shown(p)}`] = () => m.cleanPath(p); });
  PATHS.forEach((p, i) => { for (const name of ['claude', 'tmux', 'node']) cases[`resolveOnPath#${i} ${name} ${shown(p)}`] = () => m.resolveOnPath(name, p); });
  DIRS.forEach((d, i) => { cases[`tooBroad#${i} ${shown(d)}`] = () => m.tooBroad(d, HOME); cases[`tooBroad-home=dir#${i}`] = () => m.tooBroad(d, d); });
  ANCESTORS.forEach(([d, h]) => { cases[`tooBroad ${d} home ${h}`] = () => m.tooBroad(d, h); });
  PATHS.forEach((p, i) => { cases[`extraProtected#${i} ${shown(p)}`] = () => m.extraProtected({ env: env('', { CC_AGENT_PROTECTED_PATHS: p }), home: HOME }); });
  PATHS.forEach((p, i) => { cases[`toolRoots#${i}`] = () => m.toolRoots({ env: env(p), execPath: `${base}/usr/local/bin/node`, home: `${base}/home/u` }); });
  PATHS.forEach((p, i) => { cases[`toolReadRoots#${i}`] = () => m.toolReadRoots({ env: env(p), execPath: `${base}/usr/local/bin/node`, home: `${base}/home/u` }); });
  for (const [f, d] of [['/a/b', '/a'], ['/a\\b', '/a'], ['/ab', '/a'], ['/a/b', '/a/'], [`${base}/opt/tool\\/claude`, `${base}/opt/tool\\`], [`${base}/opt/tool\\/claude`, `${base}/opt/tool`]]) cases[`inside ${shown(f)} ${shown(d)}`] = () => m.inside(f, d);
  for (const p of ['/a/b/', '/opt/tool\\', `${base}/opt/tool\\`, '/nonexistent/x/']) cases[`canonical ${shown(p)}`] = () => m.canonical(p);
  return cases;
};
