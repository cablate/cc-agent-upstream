'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
module.exports = root => {
  const file = path.join(root, 'channel/platform.cjs');
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const cases = {};
  const store = fs.readFileSync(path.join(root, 'server/agentStore.js'), 'utf8');
  const quoteMatch = store.match(/const quote=s=>[^\r\n]+;/);
  if (!source && !quoteMatch) throw Error('Missing upstream pane quote extraction');
  const upstreamQuote = quoteMatch ? vm.runInNewContext(quoteMatch[0].replace('const quote=', '').replace(/;$/, '')) : null;
  // Upstream has no platform module; these substitutes check helper values only.
  const load = (env = {}, processPlatform = process.platform) => {
    if (!source) return { homeDir: () => env.HOME || '', tmpBase: () => '/tmp', shellPath: s => s, paneQuote: upstreamQuote, gitBashPath: () => undefined, env };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require, process: { platform: processPlatform, env } });
    return { ...module.exports, env };
  };
  // runner.cjs checks the actual POSIX call sites, including errors; shellPath is Windows-only.
  for (const [i, env] of [{}, { HOME: '' }, { HOME: '/home/a b/工具' }].entries()) cases[`W2-home-${i}`] = () => load(env).homeDir();
  cases['W2-tmp-base'] = () => load().tmpBase();
  for (const [i, s] of ['', 'a b', "a'b", '$HOME`id`', '工具/路徑', 'C:\\a\\b'].entries()) cases[`W4-pane-quote-${i}`] = () => load().paneQuote(s);
  // Both POSIX platforms can be exercised without starting a shell or touching env.
  for (const p of [...new Set(['linux', 'darwin', process.platform])]) for (const warm of [undefined, '', '0', '1']) cases[`W10-warm-${p}-${String(warm)}`] = () => {
    const env = warm === undefined ? {} : { PSMUX_NO_WARM: warm };
    load(env, p); return env;
  };
  return cases;
};
