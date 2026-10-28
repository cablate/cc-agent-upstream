'use strict';
// Where Windows differs from macOS and Linux, in one place for the server and the
// channel scripts.
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

const SCOPED_UNSUPPORTED = 'Windows 上的 Claude Code 沒有沙盒，無法限制 Agent 的範圍，因此只能執行「完整權限」的 Agent。請由管理員在 Agent Profile 開啟完整權限後再啟動。';

// The home folder. A Windows process has no HOME of its own (under Git Bash it is
// /c/Users/…, which is not a path to node): os.homedir() reads USERPROFILE.
const homeDir = () => (isWin ? os.homedir() : process.env.HOME || '');

// Where an agent's own temp folder (cca-<id>-g<n>) is made.
const tmpBase = () => (isWin ? os.tmpdir() : '/tmp');

// psmux drops the target of a combined -pt.
const CAPTURE = isWin ? ['-p', '-t'] : ['-pt'];

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
  return candidates.map((f) => path.resolve(f)).find(isFile);
}

// A path as a POSIX shell reads it inside quotes: Git's bash takes C:/a/b, and would
// read the backslashes of C:\a\b as part of a name. Unchanged elsewhere.
const shellPath = (p) => (isWin ? String(p).replace(/\\/g, '/') : p);

// A program path in the command handed to `tmux new-session`. psmux reads single quotes
// (which keep $ and ` literal) but not an apostrophe inside them; a path with one is
// double-quoted instead, which a Windows path can never contain.
const paneQuote = (s) => (isWin ? (s.includes("'") ? `"${s}"` : `'${s}'`) : "'" + s.replace(/'/g, "'\\''") + "'");

// Windows has no mode bits: whether an account other than this one, SYSTEM, the
// Administrators group or TrustedInstaller owns a program, may change it, or may add or
// remove files in its folder. Read by SID, since account names are translated; a rule
// that only passes down to new files is not the file's own. If the ACL cannot be read,
// the answer is yes. Windows only.
const TRUSTED_SIDS = ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'];
// WriteData, AppendData, Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE; for
// a folder AddFile and DeleteChild instead of AppendData and Delete.
const FILE_CHANGE = 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const FOLDER_CHANGE = 0x2 | 0x40 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const ACL_SCRIPT = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$sid=[Security.Principal.SecurityIdentifier];"
  + "@{me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;items=@(($env:CCA_ACL_PATHS|ConvertFrom-Json)|ForEach-Object{$a=Get-Acl -LiteralPath $_;"
  + "@{owner=$a.GetOwner($sid).Value;rules=@($a.GetAccessRules($true,$true,$sid)|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;allow=[string]$_.AccessControlType -eq 'Allow';inheritOnly=[bool]([int]$_.PropagationFlags -band 2)}})}})}|ConvertTo-Json -Depth 5 -Compress";
// null when the ACL could not be read (PowerShell failed or answered something
// unexpected): never cached, so one timeout does not settle the answer.
function aclRead(file, folder) {
  try {
    const out = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CCA_ACL_PATHS: JSON.stringify([file, folder]) } });
    const { me, items } = JSON.parse(out);
    const trusted = new Set([me, ...TRUSTED_SIDS]);
    if (!me || items.length !== 2) return null;
    return items.some(({ owner, rules }, i) => !trusted.has(owner) || rules.some((r) => r.allow && !r.inheritOnly && !trusted.has(r.sid) && (r.rights & (i ? FOLDER_CHANGE : FILE_CHANGE))));
  } catch { return null; }
}
// Each read runs PowerShell for about a second and blocks the event loop, so the last
// answer is kept until the file's or the folder's own entry changes: an ACL change is
// one, so a grant or removal made in between is still seen.
const aclAnswers = new Map();
function othersCanChange(file) {
  const folder = path.dirname(file);
  let stamp;
  try { stamp = `${fs.statSync(file).ctimeMs}|${fs.statSync(folder).ctimeMs}`; } catch { return true; }
  if (aclAnswers.get(file)?.stamp === stamp) return aclAnswers.get(file).unsafe;
  const unsafe = aclRead(file, folder);
  if (unsafe === null) return true;
  if (!aclAnswers.has(file) && aclAnswers.size >= 256) aclAnswers.delete(aclAnswers.keys().next().value);
  aclAnswers.set(file, { stamp, unsafe });
  return unsafe;
}

module.exports = { isWin, SCOPED_UNSUPPORTED, homeDir, tmpBase, CAPTURE, WIN_ENV, gitBashPath, shellPath, paneQuote, othersCanChange };
