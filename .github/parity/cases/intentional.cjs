'use strict';
// Intentional cross-platform changes whose observable effect the parity run must show:
//   B1 refuse bridge calls that any tunnel or proxy forwarded (server/app.js)
//   B2 answer only the lowercase /bridge spelling (server/app.js)
//   B5 keep a terminal-menu push pending while its chat is open (server/notifications.js)
// The real source text is extracted and evaluated against fake request, response, audit
// and push objects: no Express, no server, no credentials. A source that cannot be found
// fails the file load, so a moved block shows up as ERROR rather than as a pass.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const read = (root, rel) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw Error(`Missing source: ${file}`);
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
};

// The /bridge guard, with its FORWARDED_HEADERS table where the tree has one.
function bridgeGuard(root) {
  const text = read(root, 'server/app.js');
  const start = text.indexOf("app.use('/bridge'");
  const end = start < 0 ? -1 : text.indexOf('\n});', start);
  if (start < 0 || end < 0) throw Error(`Missing bridge middleware extraction in ${root}/server/app.js`);
  const table = text.match(/^const FORWARDED_HEADERS = .*;$/m);
  const mounts = [], audits = [];
  vm.runInNewContext(`${table ? table[0] : ''}\n${text.slice(start, end + 4)}`, {
    app: { use: (mount, fn) => mounts.push({ mount, fn }) },
    audit: (entry) => audits.push(entry),
    resolveClientIp: () => '127.0.0.1',
  });
  if (mounts.length !== 1 || mounts[0].mount !== '/bridge' || typeof mounts[0].fn !== 'function') throw Error(`Bridge middleware did not register once in ${root}`);
  return { run: mounts[0].fn, audits };
}

// Express matches a mount path case-insensitively, on a segment boundary, and strips nothing from originalUrl.
const mountMatches = (url) => /^\/bridge\/?(?=\/|$)/i.test(url.split('?')[0]);

function bridgeCall(root, { url, headers = {}, finish }) {
  const guard = bridgeGuard(root);
  if (!mountMatches(url)) return { reached: false };
  const req = { method: 'GET', originalUrl: url, headers };
  const res = Object.assign(new EventEmitter(), { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.emit('finish'); return this; } });
  let nexted = false;
  guard.run(req, res, () => { nexted = true; });
  const refused = { status: res.statusCode, body: res.body ?? null };
  if (nexted && finish) { res.statusCode = finish; res.emit('finish'); }
  return { reached: true, nexted, ...(nexted ? {} : refused), audits: guard.audits };
}

const FORWARDED = ['cf-connecting-ip', 'cf-ray', 'cdn-loop', 'tailscale-user-login', 'x-forwarded-for', 'forwarded'];
const NEWLY_REFUSED = ['tailscale-user-login', 'x-forwarded-for', 'forwarded'];
const NOT_FORWARDING = ['x-real-ip', 'x-forwarded-proto', 'x-forwarded-host', 'via', 'cf-visitor', 'cf-ipcountry'];
const SPELLINGS = ['/bridge', '/bridge/', '/bridge/a/b?x=1', '/bridge/BRIDGE/x', '/bridgex', '/api/bridge'];
const WRONG_CASE = ['/BRIDGE/x', '/Bridge', '/bRiDgE/ready?x=1'];

const response = (r) => (r.reached === false ? r : { reached: true, nexted: r.nexted, status: r.status ?? null, body: r.body ?? null });
// The audit entries without their reason text, and the reason texts alone: the wording
// changed on purpose (B1), everything else in an entry must not.
const audited = (r) => (r.reached === false ? r : r.audits.map(({ reason, ...rest }) => rest));
const reasons = (r) => (r.reached === false ? r : r.audits.map((a) => a.reason ?? null));

// B5: flushReplies through the real startNotifications, with push and pending-list fakes.
function notifier(root) {
  const stubs = { './services/pushService': { getDefaultPushService: () => ({}) }, './services/pushCrypto': { getPushConfig: () => ({ available: true }) } };
  const file = path.join(root, 'server/notifications.js'), source = read(root, 'server/notifications.js');
  if (!source.includes('async function flushReplies()')) throw Error(`Missing flushReplies extraction in ${file}`);
  const real = Module.createRequire(file), mod = { exports: {} };
  vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, { filename: file })(mod.exports, (id) => (Object.hasOwn(stubs, id) ? stubs[id] : real(id)), mod, file, path.dirname(file));
  return mod.exports;
}

// Each flush step names whether the owner is looking at the conversation at that moment.
async function replies(root, { messages, steps = [{ viewing: false }], viewingApi = true, conversation = { id: 'c1', owner: 'u1', title: 'Agent' } }) {
  const items = messages.map((message) => ({ conversation, message: { notifyPending: true, text: 'hello', ...message } }));
  const pushes = [], errors = [], saves = [], ids = [];
  let viewing = steps[0].viewing;
  const agents = {
    pendingNotifications: () => items.filter((i) => i.message.notifyPending),
    pendingReportNotifications: () => [], markReportsNotified() {}, pendingScheduleNotifications: () => [], markScheduleNotified() {},
    save: () => { saves.push(1); },
    ...(viewingApi ? { isViewing: (owner, id) => { ids.push([owner, id]); return viewing; } } : {}),
  };
  const service = { start() {}, stop() {}, notifyAgentReply: async (n) => { pushes.push(n); }, notifyAccessReport: async () => {} };
  const original = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); };
  try {
    const stop = notifier(root).startNotifications(agents, service, async () => [], { now: () => 0 });
    const after = [];
    for (const [i, step] of steps.entries()) {
      viewing = step.viewing;
      await stop.flush();
      after.push({ pushes: pushes.length, pending: items.map((x) => x.message.notifyPending), saves: saves.length });
      if (i === steps.length - 1) stop();
    }
    return { after, pushes, errors, viewingAsked: ids.length };
  } finally { console.error = original; }
}

const PROMPT = 'prompt:abcd1234:key:1700000000000';
module.exports = (root) => {
  const cases = {};
  for (const h of [...FORWARDED, ...NOT_FORWARDING]) {
    cases[`B1-header-${h}-response`] = () => response(bridgeCall(root, { url: '/bridge/ready', headers: { [h]: 'value' } }));
    cases[`B1-header-${h}-audit`] = () => audited(bridgeCall(root, { url: '/bridge/ready', headers: { [h]: 'value' } }));
    cases[`B1-header-${h}-audit-reason`] = () => reasons(bridgeCall(root, { url: '/bridge/ready', headers: { [h]: 'value' } }));
  }
  cases['B1-header-empty-value-response'] = () => response(bridgeCall(root, { url: '/bridge/ready', headers: { 'cf-ray': '', 'x-forwarded-for': '' } }));
  cases['B1-header-names-are-lowercase-only'] = () => response(bridgeCall(root, { url: '/bridge/ready', headers: { 'X-Forwarded-For': '1.2.3.4' } }));
  cases['B1-all-headers-response'] = () => response(bridgeCall(root, { url: '/bridge/ready', headers: Object.fromEntries(FORWARDED.map((h) => [h, '1'])) }));
  cases['B1-all-headers-audit'] = () => audited(bridgeCall(root, { url: '/bridge/ready', headers: Object.fromEntries(FORWARDED.map((h) => [h, '1'])) }));
  cases['B1-all-headers-audit-reason'] = () => reasons(bridgeCall(root, { url: '/bridge/ready', headers: Object.fromEntries(FORWARDED.map((h) => [h, '1'])) }));
  cases['B1-clean-call-then-failure-audit'] = () => bridgeCall(root, { url: '/bridge/ready', finish: 404 });
  cases['B1-clean-call-then-server-error-audit'] = () => bridgeCall(root, { url: '/bridge/ready', finish: 500 });
  cases['B1-clean-call-then-ok-no-audit'] = () => bridgeCall(root, { url: '/bridge/ready', finish: 200 });
  for (const url of [...SPELLINGS, ...WRONG_CASE]) {
    cases[`B2-url-${url}-response`] = () => response(bridgeCall(root, { url }));
    cases[`B2-url-${url}-audit`] = () => audited(bridgeCall(root, { url }));
    cases[`B2-url-${url}-audit-reason`] = () => reasons(bridgeCall(root, { url }));
  }
  cases['B2-wrong-case-then-failure-audit'] = () => bridgeCall(root, { url: '/Bridge/x', finish: 404 });
  cases['B2-wrong-case-with-cloudflare-header-audit'] = () => audited(bridgeCall(root, { url: '/BRIDGE/x', headers: { 'cf-ray': 'abc' } }));
  cases['B2-wrong-case-with-cloudflare-header-audit-reason'] = () => reasons(bridgeCall(root, { url: '/BRIDGE/x', headers: { 'cf-ray': 'abc' } }));
  cases['B2-lowercase-with-cloudflare-header-audit'] = () => audited(bridgeCall(root, { url: '/bridge/x', headers: { 'cf-ray': 'abc' } }));
  cases['B2-lowercase-with-cloudflare-header-audit-reason'] = () => reasons(bridgeCall(root, { url: '/bridge/x', headers: { 'cf-ray': 'abc' } }));

  const prompt = { id: PROMPT, text: 'menu', notifyText: 'Terminal waits' };
  cases['B5-reply-not-viewing'] = () => replies(root, { messages: [{ id: 'm1', role: 'assistant' }] });
  cases['B5-reply-viewing'] = () => replies(root, { messages: [{ id: 'm1', role: 'assistant' }], steps: [{ viewing: true }, { viewing: false }] });
  cases['B5-relay-viewing'] = () => replies(root, { messages: [{ id: 'relay:1', role: 'relay' }], steps: [{ viewing: true }] });
  cases['B5-prompt-not-viewing'] = () => replies(root, { messages: [prompt] });
  cases['B5-prompt-viewing'] = () => replies(root, { messages: [prompt], steps: [{ viewing: true }] });
  cases['B5-prompt-viewing-then-leaves'] = () => replies(root, { messages: [prompt], steps: [{ viewing: true }, { viewing: false }] });
  cases['B5-prompt-id-not-at-start'] = () => replies(root, { messages: [{ id: 'x:prompt:1', role: 'assistant' }], steps: [{ viewing: true }] });
  cases['B5-prompt-and-reply-viewing'] = () => replies(root, { messages: [{ id: 'm1', role: 'assistant' }, prompt, { id: 'm2', role: 'assistant' }], steps: [{ viewing: true }, { viewing: false }] });
  cases['B5-group-prompt-viewing'] = () => replies(root, { messages: [prompt], steps: [{ viewing: true }, { viewing: false }], conversation: { id: 'g1', owner: 'u1', title: 'Room', groupId: 'g1' } });
  cases['B5-no-viewing-api'] = () => replies(root, { messages: [prompt], viewingApi: false });
  cases['B5-message-without-id'] = () => replies(root, { messages: [{ role: 'assistant' }] });
  return cases;
};

const expected = {};
const WORDING = 'The audit reason for a forwarded bridge call now reads "forwarded by a tunnel or proxy" (was "forwarded by Cloudflare").';
for (const h of FORWARDED.slice(0, 3)) expected[`B1-header-${h}-audit-reason`] = { unit: 'B1', reason: WORDING };
for (const h of NEWLY_REFUSED) {
  expected[`B1-header-${h}-response`] = { unit: 'B1', reason: 'Bridge calls carrying this tunnel or proxy header are refused with 404 (upstream refused only the Cloudflare headers).' };
  expected[`B1-header-${h}-audit`] = { unit: 'B1', reason: 'A refused call carrying this header is audited (upstream let it through unaudited).' };
  expected[`B1-header-${h}-audit-reason`] = { unit: 'B1', reason: 'Its audit reason is "forwarded by a tunnel or proxy".' };
}
expected['B1-all-headers-audit-reason'] = { unit: 'B1', reason: WORDING };
for (const url of WRONG_CASE) {
  expected[`B2-url-${url}-response`] = { unit: 'B2', reason: 'Only the lowercase /bridge spelling is the bridge; Express matches any case, so other spellings are refused with 404.' };
  expected[`B2-url-${url}-audit`] = { unit: 'B2', reason: 'A refused wrong-case spelling is audited (upstream let it through to the bridge routes).' };
  expected[`B2-url-${url}-audit-reason`] = { unit: 'B2', reason: 'A refused wrong-case spelling is audited as "not spelled /bridge".' };
}
expected['B2-wrong-case-then-failure-audit'] = { unit: 'B2', reason: 'A wrong-case bridge call is refused and audited at the guard instead of reaching the bridge routes.' };
expected['B2-wrong-case-with-cloudflare-header-audit-reason'] = { unit: 'B1', reason: WORDING + ' (the wrong spelling is refused in both trees when a Cloudflare header is present.)' };
expected['B2-lowercase-with-cloudflare-header-audit-reason'] = { unit: 'B1', reason: WORDING };
expected['B5-prompt-viewing'] = { unit: 'B5', reason: 'A terminal-menu push stays pending while the owner has the chat open (upstream marked it sent without pushing).' };
expected['B5-prompt-viewing-then-leaves'] = { unit: 'B5', reason: 'The pending terminal-menu push is sent once the owner leaves the chat.' };
expected['B5-prompt-and-reply-viewing'] = { unit: 'B5', reason: 'Only the terminal-menu push is kept pending while viewing; ordinary replies are still marked sent.' };
expected['B5-group-prompt-viewing'] = { unit: 'B5', reason: 'Same rule for a group chat conversation carrying a terminal-menu push.' };
expected['B5-message-without-id'] = { unit: 'B5', reason: 'Invalid input, not a general fix: a pending message with no string id now makes the reply queue throw (caught and logged by flush). agentStore add() and groupStore.addMessage always assign an id, so a real queue does not hit it.' };
module.exports.expected = expected;
