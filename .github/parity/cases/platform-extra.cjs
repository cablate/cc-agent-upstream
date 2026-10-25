'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
module.exports = root => {
  const file = path.join(root, 'channel/platform.cjs');
  // Upstream has no Windows helper; its side states the absence contract. agentEnv.cjs exercises real call sites.
  if (!fs.existsSync(file)) return {
    'W1-git-bash-posix': () => undefined,
    'W1-no-windows-env-posix': () => [],
  };
  const source = fs.readFileSync(file, 'utf8');
  const load = p => {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require, process: { platform: p, env: {} } });
    return module.exports;
  };
  return {
    'W1-git-bash-posix': () => ['linux', 'darwin'].map(p => load(p).gitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: 'fixture-bash', PATH: '/usr/bin' })).filter(x => x !== undefined).at(0),
    'W1-no-windows-env-posix': () => ['linux', 'darwin'].filter(p => load(p).isWin),
  };
};
