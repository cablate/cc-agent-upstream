const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Where one generation of an agent keeps its files. Two folders with two owners, never
// the same one:
//   control  CC Agent's: runtime.json, the settings and MCP config it writes for Claude, the
//            started marker, and the notice it gives Claude. The agent cannot reach it.
//   work     Claude's: its cwd and the folder tmux starts it in. By default the agent's own
//            folder (own), made and emptied by CC Agent. With a workspace, the repository an
//            admin bound the agent to, where CC Agent writes nothing and deletes nothing.
// A run remembers the folder it started in (workDir, set only for a bound one): Claude can
// resume a session only from the folder it began in, so a workspace changed later does not
// move a run that has already started.
const homeOf = (stateRoot, c) => path.join(stateRoot, 'workspaces', c.id);

function of(stateRoot, c, g) {
  const home = homeOf(stateRoot, c);
  const own = path.join(home, 'g' + g.number);
  const work = g.workDir || own;
  return { home, own, control: path.join(home, 'control-g' + g.number), work, bound: work !== own };
}

// Claude Code files a folder's sessions under ~/.claude/projects/<its path, every
// character that is not a letter or digit turned into ->/<sessionId>.jsonl.
const PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
const projectName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const projectFolder = (cwd) => path.join(PROJECTS(), projectName(cwd));

// One session's own files: its transcript and the folder of the same name beside it
// (subagents, saved tool results). Looked up under the folder's own project first, then
// in the others, since a session's id is unique wherever Claude filed it.
function sessionFiles(cwd, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return [];
  const projects = [projectFolder(cwd)];
  try { for (const e of fs.readdirSync(PROJECTS(), { withFileTypes: true })) if (e.isDirectory()) projects.push(path.join(PROJECTS(), e.name)); } catch { /* none yet */ }
  const found = new Set();
  for (const dir of projects) for (const p of [path.join(dir, sessionId + '.jsonl'), path.join(dir, sessionId)]) if (fs.existsSync(p)) found.add(p);
  return [...found];
}

module.exports = { of, homeOf, projectName, projectFolder, sessionFiles };
