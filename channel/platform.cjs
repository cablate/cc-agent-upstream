'use strict';
// Where Windows differs from macOS and Linux, in one place; the rest of the code asks
// this file instead of testing process.platform itself.
//
// Windows runs a full-access agent only: Claude Code has no sandbox there, and
// everything scoped (access.allow, the OS sandbox, the temp folder fence) is built on it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

// psmux keeps a standby server with spare shells ready for the next session, and leaves
// it behind after the last one ends. Agents start rarely and wait on Claude Code far
// longer than on a shell, so it is off for every tmux this process and its children run.
if (isWin && process.env.PSMUX_NO_WARM === undefined) process.env.PSMUX_NO_WARM = '1';

// Shown wherever a scoped agent would have to start.
const SCOPED_UNSUPPORTED = 'Windows 上的 Claude Code 沒有沙箱，無法限制 Agent 的範圍，因此只能執行「完整權限」的 Agent。請由管理員在這個 Agent 的設定開啟完整權限後再啟動。';

// The home folder. A Windows process has no HOME of its own (under Git Bash it is
// /c/Users/…, which is not a path to node): os.homedir() reads USERPROFILE.
const homeDir = () => (isWin ? os.homedir() : process.env.HOME || '');

// Where an agent's own temp folder (cca-<id>-g<n>) is made.
const tmpBase = () => (isWin ? os.tmpdir() : '/tmp');

// What a Windows program needs to start and to find the user's files: without
// SystemRoot, node cannot open sockets; without USERPROFILE, Claude cannot find ~/.claude.
const WIN_ENV = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATHEXT', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'CLAUDE_CODE_GIT_BASH_PATH', 'PSMUX_NO_WARM'];

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// Claude Code on Windows runs its shell tool and its hooks through Git's bash.exe and
// stops with "requires a shell tool" when it cannot find one. It looks in the usual
// install folders only, so a Git from Scoop is not found: named here instead.
// Never System32\bash.exe, which is the WSL launcher.
function gitBashPath(env = process.env) {
  if (!isWin) return undefined;
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return env.CLAUDE_CODE_GIT_BASH_PATH;
  const candidates = [];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d))) {
    if (!isFile(path.join(dir, 'git.exe'))) continue;
    candidates.push(path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', '..', 'bin', 'bash.exe'), path.join(dir, 'bash.exe'));
    // Scoop: PATH holds a git.exe shim, the real Git is in apps\git\current.
    if (path.basename(dir).toLowerCase() === 'shims') candidates.push(path.join(dir, '..', 'apps', 'git', 'current', 'bin', 'bash.exe'));
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  for (const scoop of [env.SCOOP, env.USERPROFILE && path.join(env.USERPROFILE, 'scoop')]) if (scoop) candidates.push(path.join(scoop, 'apps', 'git', 'current', 'bin', 'bash.exe'));
  const found = candidates.map((f) => path.resolve(f)).find(isFile);
  return found;
}

// A path as a POSIX shell reads it inside quotes: Git's bash takes C:/a/b, and would
// read the backslashes of C:\a\b as part of a name. Unchanged elsewhere.
const shellPath = (p) => (isWin ? String(p).replace(/\\/g, '/') : String(p));

// A program path in the command handed to `tmux new-session`. psmux reads single quotes
// (which keep $ and ` literal) but not an apostrophe inside them; a path with one is
// double-quoted instead, which a Windows path can never contain.
const paneQuote = (s) => (isWin ? (s.includes("'") ? `"${s}"` : `'${s}'`) : "'" + s.replace(/'/g, "'\\''") + "'");

module.exports = { isWin, SCOPED_UNSUPPORTED, homeDir, tmpBase, WIN_ENV, gitBashPath, shellPath, paneQuote };
