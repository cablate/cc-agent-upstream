'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
module.exports = root => {
  const source = fs.readFileSync(path.join(root, 'channel/runner.mjs'), 'utf8');
  const platformFile = path.join(root, 'channel/platform.cjs');
  const platform = fs.existsSync(platformFile) ? require(platformFile) : null;
  const expression = pattern => { const match = source.match(pattern); if (!match) throw Error(`Missing runner extraction: ${pattern}`); return match[1]; };
  const quote = expression(/const quote=(.*);/);
  const uid = expression(/const uid=(.*?),fullAccess=/);
  const agentTmp = expression(/const agentTmp=(.*);/);
  const interval = source.slice(source.indexOf('const startup=setInterval('), source.indexOf('const pulse=setInterval('));
  if (!interval.startsWith('const startup=setInterval(') || !interval.endsWith('\n')) throw Error('Missing runner interval');
  const target = source.match(/if\((?:platform\.isWin&&)?config\.tmux!==undefined[^\n]+\nconst tmuxTarget=[^\n]+/);
  // The real startupConsent of this tree: the startup loop decides what to send from what it returns.
  const consentSource = fs.readFileSync(path.join(root, 'channel/startupConsent.mjs'), 'utf8');
  if (!/^export function startupConsent\(/m.test(consentSource)) throw Error('Missing startupConsent extraction');
  const startupConsent = vm.runInNewContext(`${consentSource.replace(/^export /m, '')}\n;startupConsent`, {});
  const run = (code, extra = {}) => vm.runInNewContext(code, { path, platform, process: { env: { HOME: '/home/fixture', TMUX_PANE: '%7' }, getuid: () => 1000 }, ...extra });
  const cases = {};
  for (const [i, s] of ['', '/a b/工具', "a'b", '$HOME`id`', 'a\\b', null, 123].entries()) cases[`W2-quote-${i}`] = () => run(`(${quote})(s)`, { s });
  const transcript = expression(/const transcript=(.*);/);
  for (const [i, HOME] of [undefined, '', '/home/fixture'].entries()) cases[`W2-transcript-${i}`] = () => run(transcript, { homeDir: HOME || '', env: HOME === undefined ? {} : { HOME }, config: { cwd: '/workspace', sessionId: 'fixture' } });
  cases['W2-uid'] = () => run(uid);
  cases['W2-uid-unavailable'] = () => run(uid, { process: { env: {}, getuid: undefined } });
  for (const [i, name] of ['abcd1234-g1', '../a-g1', '/a//b-g1', 'a/../b-g1', 'a\\b-g1'].entries()) for (const fullAccess of [true, false]) cases[`W2-temp-${i}-${fullAccess}`] = () => run(agentTmp, { fullAccess, tmpName: name, tmpRoot: '/tmp/cca-1000' });
  // The startup loop run for two ticks over one fixed screen: what it asks tmux for, what keys it sends
  // (and that it sends them once), and what it tells the server. 'elsewhere' names another folder and
  // must get no key at all.
  const screens = {
    idle: 'Welcome back\n> \n',
    'workspace-yes': 'Accessing workspace:\n\n/workspace\n\n❯ Yes, I trust this folder\n',
    'workspace-no': 'Accessing workspace:\n\n/workspace\n\nYes, I trust this folder\n❯ No, exit\n',
    'workspace-elsewhere': 'Accessing workspace:\n\n/other\n\n❯ Yes, I trust this folder\n',
    channel: 'Channels: server:executive\nWARNING: Loading development channels\n❯ 1. I am using this for local development\n',
  };
  for (const [i, config] of [{ cwd: '/workspace' }, { cwd: '/workspace', tmux: 'execagent-12345678-g1' }, { cwd: '/workspace', tmux: 'invalid' }].entries()) for (const pane of ['%7', undefined]) for (const [shown, screen] of Object.entries(screens)) cases[`W9-startup-${i}-${pane || 'missing'}-${shown}`] = () => {
    const calls = [], bridged = [];
    const box = {
      path, platform, config, process: { env: { TMUX_PANE: pane } }, tmuxSocket: 'cc-agent-1234567890abcdef', startupDeadline: 100, Date: { now: () => 1 },
      setInterval: fn => { fn(); fn(); return 1; }, clearInterval: () => {}, reportedPrompt: '', startupConsent,
      bridge: (_config, event) => { bridged.push(event); return Promise.resolve(); },
      execFileSync: (command, args, options) => { calls.push({ command, args, options }); return args.includes('capture-pane') ? screen : ''; },
    };
    vm.runInNewContext(`${target ? target[0] : ''}\n${interval}`, box);
    return { calls, bridged, reportedPrompt: box.reportedPrompt };
  };
  return cases;
};
