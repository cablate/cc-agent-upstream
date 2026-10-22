'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const runtimeTools = require('./runtimeTools.cjs');

// Programs an admin lets one scoped agent run outside the OS sandbox: a tool that starts a browser (Playwright) cannot run inside it.
// An entry names a program or script and its project folder, nothing else:
// {program, folder, args}. At each launch the runner writes a wrapper for it in the
// agent's control folder, which the agent can neither write nor replace: it changes to
// the project folder, clears the environment (env -i) and sets only HOME, a fixed PATH
// of system and CC Agent tool folders, LANG and a temporary folder of CC Agent's own,
// then runs the program. Claude Code is given only the wrappers' paths as
// sandbox.excludedCommands, exact, or as a prefix taking arguments when an admin
// allowed arguments (run in the agent's own folder
// with its environment, a program read what the agent controls, a cwd .env among
// them). Shared by the server (agentAccess, agentStore) and the runner.
const LIMIT = 10;
const MAX_PATH = 300;
// A plain absolute path: what the wrapper quotes and the rule names.
const PLAIN = /^\/[A-Za-z0-9._@%+=,:\/-]*$/;
const SHELL = /[;|&`$><\n\r\\'"(){}[\]*?#~!\t\0]/;
// Programs that run whatever they are given, or code from where they are run: never an
// entry's program. Nor an interpreter or a system command-line tool named directly.
const REFUSED = new Set(['env', 'sudo', 'doas', 'su', 'xargs', 'exec', 'eval', 'source', 'nohup', 'timeout', 'gtimeout', 'time', 'nice', 'command', 'builtin', 'watch', 'script', 'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uv', 'uvx', 'pipx', 'pip', 'pip3', 'make', 'launchctl', 'open', 'caffeinate', 'arch', 'chroot', 'stdbuf', 'unbuffer', 'expect', 'awk', 'gawk', 'sed', 'find', 'ssh', 'tmux', 'screen', 'claude', 'git', 'hg', 'svn', 'cargo', 'go', 'mvn', 'gradle', 'docker', 'kubectl', 'rake', 'bundle', 'gem', 'composer']);
const INTERPRETER = /^(node|nodejs|python|python[23](\.\d+)?|ruby|perl|php|bash|sh|zsh|dash|ksh|fish|tsx|ts-node|osascript|lua|rscript|deno|bun|java|swift|pwsh)$/;
const SYSTEM = ['/bin', '/sbin', '/usr', '/System', '/Library', '/opt', '/Applications', '/etc', '/private/etc'];
// Shared temporary folders, where every agent has a folder of its own (/tmp/cca-…).
const TEMP = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];
// Where node looks for modules and a project keeps its setup: what marks a project, and
// a monorepo above it.
const PROJECT = ['package.json', 'node_modules'];
// What such a program reads under the home folder whatever its project: node's global
// module folders, Playwright's browsers, Python's user site, caches, git and npm
// settings. Kept from every scoped agent like the project.
const HOME_READS = ['.node_modules', '.node_libraries', 'node_modules', 'Library/Caches/ms-playwright', 'Library/Python', '.cache', '.gitconfig', '.npmrc', '.config/git'];
// Where an interpreter's own install may sit without protecting: the system's.
const SYSTEM_PREFIX = ['/usr', '/bin', '/sbin', '/System', '/Library/Developer'];

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const within = (inner, outer) => inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`);

function plainPath(value, label) {
  if (typeof value !== 'string') throw fail(`${label} must be text`);
  const p = value.trim();
  if (!p.startsWith('/') || p.length > MAX_PATH || !PLAIN.test(p) || SHELL.test(p)) throw fail(`${label} must be a full path of plain characters, without spaces: ${p.slice(0, 80)}`);
  if (p === '/' || p.includes('//') || p.endsWith('/') || p.split('/').some((s) => s === '.' || s === '..')) throw fail(`${label} is not a plain full path: ${p.slice(0, 80)}`);
  return p;
}

// One entry checked as data, with no look at the disk.
function parse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('An unsandboxed program is {program, folder}');
  const program = plainPath(value.program, 'The program');
  const folder = plainPath(value.folder, 'The project folder');
  if (value.args !== undefined && typeof value.args !== 'boolean') throw fail('args must be true or false');
  if (!within(program, folder) || program === folder) throw fail(`The program must be inside its project folder: ${program.slice(0, 80)}`);
  if (folder.split('/').filter(Boolean).length < 2) throw fail(`Too broad a project folder: ${folder}`);
  const name = path.posix.basename(program).toLowerCase();
  if (REFUSED.has(name) || INTERPRETER.test(name)) throw fail(`Name the program or script itself, not ${name}: ${program.slice(0, 80)}`);
  if (SYSTEM.some((s) => within(folder, s))) throw fail(`A system folder is not a project folder: ${folder.slice(0, 80)}`);
  if (TEMP.some((t) => within(folder, t))) throw fail(`A temporary folder can be written by any agent: ${folder.slice(0, 80)}`);
  return { program, folder, ...(value.args === true ? { args: true } : {}) };
}

function list(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw fail('Programs must be a list');
  const seen = new Set(), out = [];
  for (const v of values) { const e = parse(v); const key = `${e.program}\n${e.folder}`; if (!seen.has(key)) { seen.add(key); out.push(e); } }
  if (out.length > LIMIT) throw fail(`At most ${LIMIT} programs`);
  return out;
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const othersWrite = (st) => (st.mode & 0o022) !== 0;

// How the wrapper starts the program: a node script with CC Agent's own node, a Python
// script with the project's own virtual environment or the system's Python, a shell
// script with /bin/bash, anything else run as it is (it must be executable).
function interpreterOf(program, folder, execPath = process.execPath) {
  if (/\.(m|c)?js$/i.test(program)) return execPath;
  if (/\.py$/i.test(program)) return ['.venv', 'venv'].map((v) => path.join(folder, v, 'bin', 'python')).find((p) => exists(p)) || '/usr/bin/python3';
  if (/\.(sh|bash)$/i.test(program)) return '/bin/bash';
  return null;
}
// Python without the user's site folder (-s): only the project's and its own modules.
const isPython = (interpreter) => /\/python[0-9.]*$/.test(String(interpreter || ''));

// The folders on PATH: the service's own, and the owner's login shell's, which Claude
// Code starts the agent's commands with. Claude Code drops `nice`, `timeout`, `nohup`,
// `stdbuf`, `time` and some variables from the front of a command before matching
// excludedCommands, so `nice <wrapper>` matches and `nice` is looked up on that PATH
// outside the sandbox: every folder on either is kept from
// every scoped agent like the project. Read by running the owner's shell as Claude Code
// does, cached a minute; null when it cannot be read, and then no program runs.
let shellPathCache = { key: '', at: 0, value: null };
function loginShellPath({ home = os.homedir(), shell = process.env.SHELL, servicePath = process.env.PATH || '' } = {}) {
  const exe = shell && path.isAbsolute(shell) && fs.existsSync(shell) ? shell : '/bin/zsh';
  const key = [exe, home, servicePath].join('\0');
  if (shellPathCache.key === key && Date.now() - shellPathCache.at < 60000) return shellPathCache.value;
  let value = null;
  try {
    const out = execFileSync(exe, ['-ilc', 'printf "\\n__CC_AGENT_PATH__%s\\n" "$PATH"'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: home, USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '', SHELL: exe, PATH: servicePath, TERM: 'dumb' } });
    const m = out.match(/__CC_AGENT_PATH__(.*)\n/);
    if (m) value = m[1];
  } catch { value = null; }
  shellPathCache = { key, at: Date.now(), value };
  return value;
}
function pathFolders({ home = os.homedir(), servicePath = process.env.PATH || '' } = {}) {
  const shellPath = loginShellPath({ home, servicePath });
  if (shellPath === null) return null;
  const entries = [servicePath, shellPath].join(':').split(':');
  // An empty or relative entry means "the current folder" to the shell, and a program
  // like nice would then be looked up in the agent's own workspace: treated
  // as a PATH that cannot be read, so no program runs.
  if (entries.some((d) => !d || !path.isAbsolute(d))) return null;
  return [...new Set(entries.filter((d) => d && path.isAbsolute(d)).map((d) => path.normalize(d).replace(/(.)\/+$/, '$1')))];
}

// What the disk says about one entry: why it cannot be used (null when it can), the
// folders the agent must not write while it may run it, and how the wrapper runs it.
// writable: folders that must stay the agent's to write (its workspace and temporary
// folder); an entry whose folders would take one of them is refused.
function inspect(entry, { home = os.homedir(), uid = process.getuid?.(), writable = [], execPath = process.execPath, pathDirs } = {}) {
  let e;
  try { e = parse(entry); } catch (err) { return { problem: err.message, dirs: [] }; }
  const no = (problem) => ({ problem, dirs: [] });
  // Written exactly as the disk has it: no link anywhere on the way, no other case.
  if (real(e.folder) !== e.folder) return no(`The project folder is missing, or is reached through a link or in another spelling: ${e.folder}`);
  if (real(e.program) !== e.program) return no(`The program is missing, or is reached through a link or in another spelling: ${e.program}`);
  let st, fst;
  try { st = fs.statSync(e.program); fst = fs.statSync(e.folder); } catch { return no(`Program not found: ${e.program}`); }
  if (!st.isFile() || !fst.isDirectory()) return no(`Not a program in a folder: ${e.program}`);
  const mine = (s) => uid === undefined || [uid, 0].includes(s.uid);
  if (!mine(st) || othersWrite(st) || !mine(fst) || othersWrite(fst) || othersWrite(fs.statSync(path.dirname(e.program)))) return no(`The program and its folders must belong to this account, and no one else may change them: ${e.program}`);
  const homeReal = real(home) || home;
  if (within(homeReal, e.folder)) return no(`The project folder holds the home folder: ${e.folder}`);
  const interpreter = interpreterOf(e.program, e.folder, execPath);
  if (!interpreter) { try { fs.accessSync(e.program, fs.constants.X_OK); } catch { return no(`Not executable, and not a .js, .py or .sh script: ${e.program}`); } }
  const dirs = new Set([e.folder, path.dirname(e.program)]);
  // A monorepo above the project, and every node_modules node would look in on the way
  // up: an agent writing there would change what the program loads.
  for (let d = path.dirname(e.folder); d !== path.dirname(d) && d !== homeReal && d.split('/').filter(Boolean).length >= 2; d = path.dirname(d)) {
    if (!PROJECT.some((m) => exists(path.join(d, m)))) break;
    dirs.add(d);
  }
  // Every node_modules on the way up, there or not yet: Node resolves modules
  // from each parent folder, so one planted higher up would load outside the sandbox.
  for (let d = path.dirname(e.folder); ; d = path.dirname(d)) {
    dirs.add(path.join(d, 'node_modules'));
    if (d === path.dirname(d)) break;
  }
  for (const h of new Set([home, homeReal])) for (const f of HOME_READS) dirs.add(path.join(h, f));
  // The interpreter's own environment, unless the system's or CC Agent's own node: a
  // virtual environment, what its python really is, and the install it was made from
  // (pyvenv.cfg's home).
  const system = (p) => SYSTEM_PREFIX.some((s) => within(p, s));
  if (interpreter && interpreter !== execPath && !system(interpreter)) {
    const env = path.dirname(path.dirname(interpreter));
    dirs.add(env);
    const realPython = real(interpreter);
    if (realPython && !system(realPython)) dirs.add(path.dirname(path.dirname(realPython)));
    try {
      const base = fs.readFileSync(path.join(env, 'pyvenv.cfg'), 'utf8').match(/^\s*home\s*=\s*(.+?)\s*$/m)?.[1];
      if (base && path.isAbsolute(base)) for (const b of [base, real(base)]) if (b && !system(b)) dirs.add(path.dirname(b));
    } catch { /* not a virtual environment */ }
  }
  const onPath = pathDirs === undefined ? pathFolders({ home }) : pathDirs;
  if (onPath === null) return no('The owner\'s shell PATH could not be read, so no program runs outside the sandbox');
  for (const d of onPath) dirs.add(d);
  const taken = [...dirs].find((d) => writable.filter(Boolean).some((w) => runtimeTools.inside(w, d)));
  if (taken) return no(`The program's folder ${taken} holds the agent's own workspace`);
  return { problem: null, dirs: [...dirs].sort(), run: { ...e, interpreter, ...(isPython(interpreter) ? { interpreterArgs: ['-s'] } : {}) } };
}

// The wrapper's text. PATH holds only folders no agent may be granted: the system's and
// the folder of the node this service runs (channel/runtimeTools.cjs protects it).
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// workspace: the agent's own folder, named to the program as CC_AGENT_WORKSPACE: a program that reads or writes files the agent names keeps to it,
// since running in its own folder would put those files beside its code.
function wrapper(run, { home, tmp, execPath = process.execPath, label = '', workspace = '' }) {
  const PATH = [path.dirname(execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return [
    '#!/bin/sh',
    `# Written by CC Agent at launch${label ? ` (${label})` : ''}: runs ${run.program} outside the sandbox, in its own`,
    '# folder, with a cleared environment. Changes here are overwritten at the next launch.',
    ...(run.args ? [] : ['[ "$#" -eq 0 ] || { echo "This program takes no arguments." >&2; exit 2; }']),
    `cd ${sh(run.folder)} || exit 1`,
    `exec /usr/bin/env -i HOME=${sh(home)} PATH=${sh(PATH)} LANG=en_US.UTF-8 TMPDIR=${sh(tmp + '/')} ${workspace ? `CC_AGENT_WORKSPACE=${sh(workspace)} ` : ''}${run.interpreter ? [run.interpreter, ...(run.interpreterArgs || [])].map(sh).join(' ') + ' ' : ''}${sh(run.program)}${run.args ? ' "$@"' : ''}`,
    '',
  ].join('\n');
}

// An entry as one line on the admin's page, and back.
const toLine = (e) => `${e.program} ${e.folder}${e.args ? ' +args' : ''}`;

module.exports = { parse, list, inspect, wrapper, toLine, within, pathFolders, loginShellPath, HOME_READS, LIMIT };
