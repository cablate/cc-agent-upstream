'use strict';
// The programs this service runs for agents (node, claude, tmux) and the folders
// they live in. No agent may be granted those folders, or write to them, since an
// agent that can replace `claude` or `node` runs its own code as the next agent. Scoped agents may still read and run them:
// the sandbox denies reading ~ by default, and tools installed under ~ (nvm,
// Homebrew under ~, ~/.local/bin) would otherwise not start.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isWin } = require('./platform.cjs');
// Windows separates folders with \ or /; elsewhere \ is an ordinary file-name character.
const norm = (p) => path.normalize(p).replace(isWin ? /(.)[\\/]+$/ : /(.)\/+$/, '$1');

// Only absolute PATH entries. An empty or relative entry means "the current
// folder": with an agent's workspace as cwd, `claude` would run ./claude.
function cleanPath(value = process.env.PATH || '') {
  return [...new Set(String(value).split(path.delimiter).filter((d) => d && path.isAbsolute(d)).map(norm))].join(path.delimiter);
}

// The first executable regular file called `name` on the clean PATH: the PATH
// entry it was found in, and the real file behind it. On Windows a program is
// name.exe; a .cmd script cannot be started without a shell, so it is not looked for.
function resolveOnPath(name, value = process.env.PATH) {
  for (const dir of cleanPath(value).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, isWin ? name + '.exe' : name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) return { entry: dir, path: candidate, real };
    } catch { /* not here */ }
  }
  return null;
}

// A folder too broad to treat as a tool folder: a whole home, its ancestors, or a
// top-level system folder. Those are never added (protecting ~ would make every
// project ungrantable; /usr/bin is already outside what an agent can be given).
function tooBroad(dir, home) {
  const depth = dir.split(isWin ? /[\\/]/ : '/').filter(Boolean).length;
  // Compared as the disk knows them (canonical, below): a home reached through a link
  // (/var and /private/var) is still that home.
  const d = canonical(dir), h = canonical(home);
  return depth < 2 || d === h || h.startsWith(d + path.sep) || ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec', '/usr/share', '/bin', '/sbin', '/System', '/Library'].some((top) => d === top.toLowerCase() || d.startsWith(`${top.toLowerCase()}/`));
}

// The install folder of a program: its folder, or the folder above bin/ (where
// node keeps lib/ and npm).
const prefixOf = (file) => {
  const dir = path.dirname(file);
  return path.basename(dir) === 'bin' ? path.dirname(dir) : dir;
};

// Real folders of the node running this service and the claude/tmux it finds on
// PATH, plus the PATH folders that name them (e.g. ~/.local/bin).
// The programs agents are started through: claude itself, tmux and node. Each one's whole
// install tree is protected, not only its folder:
// a program that reads a runtime or a selection file beside it, or tmux loading
// Homebrew's libraries, would otherwise run code an agent wrote.
const PROGRAMS = ['claude', 'tmux', 'node'];
// ~/.local/share/<tool>/… is that tool's own tree; Homebrew's prefix holds every
// formula's files and the libraries they load.
function treeOf(real, home) {
  const share = path.join(home, '.local', 'share') + '/';
  if (real.startsWith(share)) return path.join(share, real.slice(share.length).split('/')[0]);
  for (const brew of ['/opt/homebrew', '/usr/local/Homebrew', '/usr/local/Cellar']) if (real === brew || real.startsWith(brew + '/')) return brew;
  // Homebrew on an Intel Mac keeps the links its formulae load from beside the Cellar.
  if (real.startsWith('/usr/local/')) return '/usr/local';
  return prefixOf(real);
}
function toolRoots({ env = process.env, execPath = process.execPath, home = os.homedir() } = {}) {
  const roots = [];
  const add = (dir) => { if (dir && path.isAbsolute(dir)) { const d = path.normalize(dir); if (!tooBroad(d, home)) roots.push(d); } };
  const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
  try { const node = fs.realpathSync(execPath); add(prefixOf(node)); add(treeOf(node, realHome)); } catch { /* not resolvable */ }
  for (const name of PROGRAMS) {
    const found = resolveOnPath(name, env.PATH);
    if (!found) continue;
    add(prefixOf(found.real));
    add(treeOf(found.real, realHome));
    add(found.entry);
  }
  // Where the user's own launchd jobs live: a file there runs outside any sandbox.
  add(path.join(home, 'Library', 'LaunchAgents'));
  return [...new Set(roots)];
}
// What a scoped agent may read to run those programs: each program's own folder and
// the PATH folder naming it, not the whole trees protected above (those may hold
// other tools' state).
function toolReadRoots({ env = process.env, execPath = process.execPath, home = os.homedir() } = {}) {
  const roots = [];
  const add = (dir) => { if (dir && path.isAbsolute(dir)) { const d = path.normalize(dir); if (!tooBroad(d, home)) roots.push(d); } };
  try { add(prefixOf(fs.realpathSync(execPath))); } catch { /* not resolvable */ }
  for (const name of PROGRAMS) {
    const found = resolveOnPath(name, env.PATH);
    // node needs its lib/ beside bin/; the others only their own folder.
    if (found) { add(name === 'node' ? prefixOf(found.real) : path.dirname(found.real)); add(found.entry); }
  }
  return [...new Set(roots)];
}

// Paths the person who starts the service names as off limits too
// (CC_AGENT_PROTECTED_PATHS, absolute paths separated like PATH: colons, semicolons on Windows), e.g. another tool's
// program or data folders. Relative or too-broad entries are ignored.
function extraProtected({ env = process.env, home = os.homedir() } = {}) {
  return String(env.CC_AGENT_PROTECTED_PATHS || '').split(path.delimiter).filter((p) => p && path.isAbsolute(p)).map(norm).filter((p) => !tooBroad(p, home));
}

// A path as the disk knows it, for comparing one with another: its deepest existing
// folder resolved through links with the disk's own spelling (realpathSync.native),
// the rest appended, then folded. macOS volumes ignore case, so /USERS/ME/.local/bin
// is ~/.local/bin and must compare as one. Folding
// on a case-sensitive volume only makes a check refuse more, never less.
function canonical(value, hops = 0) {
  let cursor = path.resolve(String(value)); const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cursor), ...tail).normalize('NFKC').toLowerCase(); } catch {
      // A link whose target does not exist yet is followed by hand: it names where the
      // folder will be once it does.
      try {
        if (hops < 40 && fs.lstatSync(cursor).isSymbolicLink()) {
          const target = fs.readlinkSync(cursor);
          // A relative target is read from the link's real folder, not its spelling.
          return canonical(path.join(path.isAbsolute(target) ? target : path.join(canonical(path.dirname(cursor), hops + 1), target), ...tail), hops + 1);
        }
      } catch { /* not there at all */ }
      if (cursor === path.dirname(cursor)) return path.resolve(String(value)).normalize('NFKC').toLowerCase();
      tail.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}
// Whether a path is a folder or lies inside it, both compared as the disk knows them.
const inside = (file, dir) => { const f = canonical(file), d = canonical(dir); return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };

module.exports = { cleanPath, resolveOnPath, toolRoots, toolReadRoots, extraProtected, tooBroad, canonical, inside };
