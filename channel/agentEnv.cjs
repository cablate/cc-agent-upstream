// The only environment variables an agent is given, used both for the tmux client
// that starts an agent's pane and for the claude process the runner spawns.
//
// An allowlist, not a denylist: passing on everything except a few ANTHROPIC_/CLAUDE_
// names would let every agent carry any bot tokens
// in the service's environment, its JWT secret, the push keys and the SSH agent
// socket. PATH is here because an agent's MCP servers need it; TMUX and TMUX_PANE
// because the runner answers startup prompts in its own pane.
const path = require('node:path');
const platform = require('./platform.cjs');
// Windows adds the few variables its programs cannot start without (platform.cjs).
const KEEP = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMUX_TMPDIR', 'TERM', 'COLORTERM', 'TMUX', 'TMUX_PANE', ...(platform.isWin ? platform.WIN_ENV : [])];

// launchd gives the service no locale, and an agent without one runs its tools in
// the C locale, which mangles non-ASCII text. A UTF-8 fallback exists on macOS and
// Linux alike.
const FALLBACK_LANG = 'C.UTF-8';

module.exports = function agentEnv(source = process.env) {
  const env = Object.fromEntries(KEEP.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  if (!env.LANG && !env.LC_ALL) env.LANG = FALLBACK_LANG;
  // Only absolute PATH entries: an empty or relative one (a trailing `:`, `.`) makes
  // `claude` resolve in the agent's own working folder, where it could have put one.
  if (env.PATH !== undefined) env.PATH = env.PATH.split(path.delimiter).filter((dir) => path.isAbsolute(dir)).join(path.delimiter);
  const bash = platform.gitBashPath(source);
  if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
  return env;
};
module.exports.KEEP = KEEP;
