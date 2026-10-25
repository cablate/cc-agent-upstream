'use strict';
const path = require('node:path');
module.exports = root => {
  const agentEnv = require(path.join(root, 'channel/agentEnv.cjs'));
  const cases = {};
  const paths = ['', '/usr/bin:/bin', ':/usr/bin:.:relative:/opt/a\\b', '//server/share:/a//b/:/a b', 'C:\\tools;D:\\bin', '/a\n/b:/a\tb'];
  paths.forEach((PATH, i) => { cases[`W1-env-path-${i}`] = () => agentEnv({ PATH, HOME: '/home/test', USER: 'fixture', SECRET: 'omitted' }); });
  for (const [i, source] of [{}, { LANG: '' }, { LC_ALL: 'zh_TW.UTF-8' }, { LANG: 'en_US.UTF-8', LC_ALL: '' }, { SystemRoot: 'fixture-root', USERPROFILE: 'fixture-home', CLAUDE_CODE_GIT_BASH_PATH: 'fixture-bash' }].entries()) cases[`W1-env-locale-${i}`] = () => agentEnv(source);
  for (const [i, PATH] of [null, 5, {}, []].entries()) cases[`W1-env-invalid-path-${i}`] = () => agentEnv({ PATH });
  cases['W1-env-allowlist'] = () => agentEnv(Object.fromEntries(['HOME','USER','LOGNAME','SHELL','PATH','LANG','LC_ALL','LC_CTYPE','TMPDIR','TMUX_TMPDIR','TERM','COLORTERM','TMUX','TMUX_PANE','JWT_SECRET','ANTHROPIC_API_KEY'].map(k => [k, k === 'PATH' ? '/usr/bin' : 'fixture-' + k])));
  return cases;
};
