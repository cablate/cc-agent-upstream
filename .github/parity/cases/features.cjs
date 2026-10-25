'use strict';
// F3-F11 and terminal-first: what a non-Windows user sees and gets with the DEFAULT
// settings, in the upstream tree and in ours. Nothing here switches a setting on. A case
// that differs is a feature divergence at defaults and is declared in featureDifferences
// with its unit; a case that stays the same is the evidence that the new behaviour is off
// by default. Gates are checked by evaluating their real expression with every toggle off
// (and drawn() also requires the expression to turn true for its own toggle, so a gate
// that stopped depending on the setting fails instead of passing quietly).
//
// Server cases evaluate the real server/agentStore.js again for each case, with
// node:child_process replaced by a fake tmux and the user store replaced by a fixture
// (one active admin). Client cases cut the real expressions out of the Vue single-file
// components and ES modules and evaluate them with fixture state: the components
// themselves are not mounted. Whatever cannot be found fails the file load or the case
// with the tree's root in the message, so a moved block shows up as a difference.
//
// Terminal-first has no F number of its own; its cases carry F10 (stored UX settings).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const TMP = process.env.PARITY_TMP || os.tmpdir();
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
// Why a root is named in every failure: the same failure in both trees must not look equal.
const fail = (root, message) => { throw Error(`${message} [${root}]`); };
const pick = (object, keys) => Object.fromEntries(keys.map((k) => [k, object?.[k] === undefined ? null : object[k]]));
const settle = (fn) => { try { return { ok: fn() }; } catch (e) { return { error: String(e && e.message || e), status: e && e.status || null }; } };

// ---------------------------------------------------------------- server fixture

const ADMIN = { _id: 'admin1', role: 'admin', language: 'en' };

// A fresh agentStore: its own data folder, a fake tmux, a fixed set of users.
function openStore(root, { users = [ADMIN], tmux = () => '' } = {}) {
  const file = path.join(root, 'server/agentStore.js');
  if (!fs.existsSync(file)) fail(root, 'Missing agentStore source');
  const dataDir = fs.mkdtempSync(path.join(TMP, 'parity-f-store-'));
  const stubs = {
    'node:child_process': { execFileSync: (command, args, options) => tmux(command, args, options) },
    './stores': { usersDB: { getAllData: () => users } },
  };
  const real = Module.createRequire(file), mod = { exports: {} }, saved = process.env.AGENT_DATA_DIR;
  try {
    process.env.AGENT_DATA_DIR = dataDir;
    vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file })(mod.exports, (id) => (Object.hasOwn(stubs, id) ? stubs[id] : real(id)), mod, file, path.dirname(file));
  } finally { if (saved === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = saved; }
  if (typeof mod.exports.getPreferences !== 'function') fail(root, 'Missing agentStore.getPreferences');
  return { store: mod.exports, close: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}
const withStore = (root, fn) => async () => {
  const opened = openStore(root);
  try { return await fn(opened.store); } finally { opened.close(); }
};
const groupsOf = (groups) => groups.map(({ name, source }) => ({ name, source }));

// A Claude Code question menu as tmux prints it.
const MENU = ['Some question', '', '──────────────────────────────', ' ❯ 1. Yes', '   2. No', '', ' Enter to select · Esc to cancel'].join('\n');
const normalise = (value, conversationId) => JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'string' ? v.split(conversationId.slice(0, 8)).join('<c8>').replace(/:\d{10,}/g, ':<ts>') : v)));

// Drives the real terminal-menu bookkeeping: syncAllRelays reads the fake screen twice
// (a menu counts once it is seen twice), the push queue marks what it sent, and the
// clock then moves on.
function terminalMenuFlow(root, { phase = 'busy', laterMinutes = 11 }) {
  const open = openStore(root, { tmux: (command, args) => (args.includes('capture-pane') ? MENU : '') });
  const { store } = open, realNow = Date.now;
  try {
    const c = store.create('owner1', { title: 'Menu agent', mode: 'claude', start: false });
    const g = store.active(c);
    const alive = () => { g.phase = phase; g.ready = true; g.heartbeat = Date.now(); };
    const snapshot = () => normalise(store.pendingNotifications().map(({ message }) => ({ id: message.id, notifyPending: message.notifyPending, notifyText: message.notifyText ?? null })), c.id);
    alive(); store.syncAllRelays();
    const first = snapshot();
    alive(); store.syncAllRelays();
    const second = snapshot(), shown = pick(store.publicView(c).terminalPrompt, ['key', 'title', 'options', 'selected']);
    for (const { message } of store.pendingNotifications()) message.notifyPending = false;
    const clockStart = Date.now();
    Date.now = () => clockStart + laterMinutes * 60_000;
    alive(); store.syncAllRelays();
    return { first, second, shown, later: snapshot() };
  } finally { Date.now = realNow; open.close(); }
}

// ---------------------------------------------------------------- client extraction

// null when the file does not exist in this tree (a component the feature added).
const source = (root, rel) => (exists(root, rel) ? read(root, rel) : null);
const must = (root, rel) => { const text = source(root, rel); if (text === null) fail(root, `Missing client source ${rel}`); return text; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The opening tag that contains the marker (the first marker found), or null when none does.
function openingTag(root, text, markers) {
  for (const marker of [].concat(markers)) {
    const at = text.indexOf(marker);
    if (at < 0) continue;
    if (text.indexOf(marker, at + 1) >= 0) fail(root, `Ambiguous marker ${marker}`);
    const start = text.lastIndexOf('<', at);
    let quote = null, i = start;
    for (; i < text.length; i++) { const ch = text[i]; if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') break; }
    return text.slice(start, i + 1);
  }
  return null;
}
const attribute = (tag, name) => { const m = tag.match(new RegExp(`\\s${escapeRe(name)}="([^"]*)"`)); return m ? m[1] : null; };
function evaluate(root, expression, scope) {
  try { return new Function('scope', `with (scope) { return (${expression}); }`)(scope); }
  catch (e) { return fail(root, `Cannot evaluate ${expression}: ${e.message}`); }
}
const flatten = (value) => (Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? Object.entries(value).filter(([, on]) => on).map(([k]) => k) : value ? String(value).split(/\s+/).filter(Boolean) : []);
const classesOf = (root, tag, scope) => {
  const dynamic = attribute(tag, ':class');
  return [...new Set([...(attribute(tag, 'class') || '').split(/\s+/).filter(Boolean), ...(dynamic === null ? [] : flatten(evaluate(root, dynamic, scope)))])].sort();
};

// Is the element drawn: no such element or a false v-if is no; no v-if is yes.
// A file that uses the interface toggles but has lost the element is a failure, not "no
// element". With gateKey, the gate must also answer to that toggle (true with it on).
function drawn(root, rel, markers, scope, { gateKey, signal = 'uxFeatures' } = {}) {
  const text = source(root, rel);
  if (text === null) return false;
  const tag = openingTag(root, text, markers);
  if (tag === null) {
    if (text.includes(signal)) fail(root, `Missing element ${[].concat(markers).join(' | ')} in ${rel}`);
    return false;
  }
  const gate = attribute(tag, 'v-if');
  if (gate === null) return true;
  const value = !!evaluate(root, gate, scope);
  if (gateKey && !evaluate(root, gate, { ...scope, uxFeatures: ONLY(gateKey) })) fail(root, `${gate} does not answer to ${gateKey}`);
  return value;
}
function classesAt(root, rel, markers, scope) {
  const text = source(root, rel);
  const tag = text === null ? null : openingTag(root, text, markers);
  if (tag === null) fail(root, `Missing element ${[].concat(markers).join(' | ')} in ${rel}`);
  return classesOf(root, tag, scope);
}

// An ES module with its imports removed and exports made local; null if the file is not there.
function esm(root, rel, sandbox = {}) {
  const text = source(root, rel);
  if (text === null) return null;
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:const|let|function)\s+(\w+)/gm)].map((m) => m[1]);
  const code = text.replace(/^import\s.*$/gm, '').replace(/^export\s+/gm, '');
  try { return vm.runInNewContext(`${code}\n;({${names.join(',')}})`, sandbox); } catch (e) { return fail(root, `Cannot evaluate ${rel}: ${e.message}`); }
}

const OFF = { desktopRail: false, attentionPanel: false, statusColors: false, messageStatus: false, readingEnhancements: false, mobilePause: false };
const ONLY = (key) => ({ ...OFF, [key]: true });
const ct = (s) => `ct(${s})`;
const PHASES = ['stopped', 'error', 'starting', 'ready', 'busy', 'handing-off', 'awaiting-workspace', 'awaiting-confirmation'];
const details = PHASES.flatMap((phase) => [true, false].map((connected) => ({ phase, connected })));
const tableOf = (fn) => Object.fromEntries(details.map((d) => [`${d.phase}/${d.connected ? 'connected' : 'offline'}`, fn(d)]));

// A one-line statement cut out of a source file by pattern; fails when the pattern is gone.
function cut(root, rel, pattern, group = 0) {
  const m = must(root, rel).match(pattern);
  if (!m) fail(root, `Missing extraction ${pattern} in ${rel}`);
  return m[group];
}
// Same, for a statement a tree that predates the feature does not have: null then. A file
// that mentions the feature (signal) but no longer matches the pattern is a failure, so a
// reworded line cannot pass as "feature absent".
function maybeCut(root, rel, signal, pattern, group = 0) {
  const text = source(root, rel);
  if (text === null || !text.includes(signal)) return null;
  const m = text.match(pattern);
  if (!m) fail(root, `Missing extraction ${pattern} in ${rel}`);
  return m[group];
}

function agentChatFunction(root, name, shape, sandbox) {
  const text = must(root, 'src/js/agent-chat.js');
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) fail(root, `Missing function ${name}`);
  const end = shape === 'line' ? text.indexOf('\n', start) : text.indexOf('\n}', start) + 2;
  return vm.runInNewContext(`${text.slice(start, end)}\n;${name}`, sandbox);
}

// What pressing pause shows, in each dialog the app has for it.
function pauseDialogs(root, features) {
  const calls = [];
  const sandbox = {
    f7: { dialog: { confirm: (text, title, ok) => { calls.push({ text, title }); ok(); } } }, ct,
    action: (name) => { calls.push({ action: name }); }, everyAgent: (kind) => { calls.push({ everyAgent: kind }); },
    listAgentAction: (c, kind) => { calls.push({ listAgentAction: [c.id, kind] }); }, chosenNames: () => 'A、B',
    agentPreferences: { uxFeatures: { value: features } }, chosenList: { value: [] },
  };
  const out = {};
  agentChatFunction(root, 'pause', 'line', sandbox)(); out.pause = calls.splice(0);
  for (const phase of ['busy', 'ready', 'stopped']) { agentChatFunction(root, 'pauseAgent', 'line', sandbox)({ id: 'a1', title: 'Agent', phase }); out[`pauseAgent-${phase}`] = calls.splice(0); }
  for (const chosen of [[], [{ title: 'A' }, { title: 'B' }]]) { sandbox.chosenList.value = chosen; agentChatFunction(root, 'pauseEveryAgent', 'block', sandbox)(); out[`pauseEvery-${chosen.length}`] = calls.splice(0); }
  const cell = cut(root, 'src/js/cellAgent.js', /^ const pause=.*;$/m);
  vm.runInNewContext(`${cell}\npause()`, { f7: sandbox.f7, ct, action: sandbox.action, uxFeatures: { value: features } }); out.cellPause = calls.splice(0);
  return out;
}

function profilePauseButton(root, features) {
  const text = must(root, 'src/components/AgentProfilePanel.vue');
  const object = cut(root, 'src/components/AgentProfilePanel.vue', /^\s*(\{key:'pause',.*\}),$/m, 1);
  const button = evaluate(root, object, { w: { ct, pause() {} }, uxFeatures: { value: features }, stopped: false });
  const tag = openingTag(root, text, 'class="profile-action"');
  if (tag === null) fail(root, 'Missing profile-action element');
  return { short: button.short, label: button.label, off: button.off, classes: classesOf(root, tag, { b: { ...button, cls: undefined }, uxFeatures: features }) };
}

function canStartTable(root) {
  const expression = cut(root, 'src/components/AgentProfilePanel.vue', /^ const canStart=computed\(\(\)=>(.*)\);$/m, 1);
  const start = esm(root, 'src/js/agentStart.js');
  return (detail) => evaluate(root, expression, { w: { detail: { value: detail } }, canStartAgent: start?.canStartAgent });
}

// ChatListPage's presence functions and the template expressions that use them.
function listRows(root, features) {
  const text = must(root, 'src/agent-pages/ChatListPage.vue');
  const status = esm(root, 'src/js/agent-list-status.js');
  const w = { activity: (c) => c.working || '', ct, user: { value: { role: 'admin' } } };
  const names = ['status', 'thinking', 'presenceLabel', 'dotClass', 'preview', 'waitingChoice'].filter((n) => new RegExp(`^ const ${n}=`, 'm').test(text));
  const code = names.map((n) => text.match(new RegExp(`^ const ${n}=.*;$`, 'm'))[0]).join('\n');
  let fns;
  try { fns = vm.runInNewContext(`${code}\n;({${names.join(',')}})`, { w, ct, uxFeatures: { value: features }, t: (k) => `t(${k})`, agentListStatus: status?.agentListStatus, agentListPreview: status?.agentListPreview }); }
  catch (e) { fail(root, `Cannot evaluate ChatListPage setup: ${e.message}`); }
  const tags = { tag: openingTag(root, text, '<span v-else class="tag-dot"'), dot: openingTag(root, text, 'class="presence-dot"'), row: openingTag(root, text, '<f7-list-item v-else :swipeout') };
  for (const [k, v] of Object.entries(tags)) if (v === null) fail(root, `Missing ChatListPage element ${k}`);
  const rows = [];
  for (const connected of [true, false]) for (const phase of ['ready', 'busy', 'stopped', 'error', 'starting']) for (const background of [0, 2]) for (const working of ['', 'typing']) for (const prompt of [null, { title: 'Pick one', options: [{ label: 'Yes' }] }]) {
    const agent = { id: 'a1', title: 'Agent', connected, phase, background, working, terminalPrompt: prompt, lastError: phase === 'error' ? 'boom' : '', preview: 'last words' };
    const scope = { ...fns, activity: w.activity, ct, a: agent, row: { agent, group: null, last: false }, uxFeatures: features, openingId: null, listSource: 'native', autoSort: false, editMode: false, user: { role: 'admin' } };
    rows.push({
      agent: `${connected ? 'on' : 'off'}/${phase}/bg${background}/${working || 'idle'}/${prompt ? 'menu' : 'nomenu'}`,
      tag: { classes: classesOf(root, tags.tag, scope), label: evaluate(root, attribute(tags.tag, ':aria-label'), scope) },
      dot: { classes: classesOf(root, tags.dot, scope), label: evaluate(root, attribute(tags.dot, ':aria-label'), scope) },
      row: { classes: classesOf(root, tags.row, scope), text: evaluate(root, attribute(tags.row, ':text'), scope) },
    });
  }
  return rows;
}

// The install screen's visible words for one browser, in both languages.
function installTexts(root, navigator) {
  const rel = 'src/components/InstallScreen.vue';
  const text = must(root, rel);
  const dictText = source(root, 'src/js/i18n.js');
  const literal = dictText?.match(/^const dict = (\{[\s\S]*?\n\});$/m)?.[1];
  const dict = literal ? vm.runInNewContext(`(${literal})`) : null;
  const translate = (lang) => (key, params = {}) => { let s = (dict[lang] || dict.en)[key]; if (s === undefined) s = dict.en[key]; for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v); return s; };
  const mustaches = (raw, scope) => raw.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_, e) => evaluate(root, e, scope)).replace(/\s+/g, ' ').trim();
  const subtitle = text.match(/<div class="block subtitle">([\s\S]*?)<\/div>/)?.[1];
  const items = [...text.matchAll(/<div class="item-inner"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  const button = text.match(/id="use-in-browser-button"[\s\S]*?>\s*([\s\S]*?)\s*<\/button>/)?.[1];
  if (subtitle === undefined || !items.length || button === undefined) fail(root, `Missing install screen text in ${rel}`);
  const loop = /v-for="step in steps\[platform\]"/.test(text);
  if (/\bt\(/.test(subtitle + items.join('') + button) && !dict) fail(root, 'Missing i18n dictionary');
  const render = (lang) => {
    const scope = { PRODUCT: { name: 'CC Agent' }, t: dict ? translate(lang) : (k) => k };
    let list;
    if (loop) {
      const platform = evaluate(root, text.match(/const platform = ([\s\S]*?);\nconst steps/)[1], { ua: navigator.userAgent, navigator });
      const steps = evaluate(root, text.match(/const steps = (\{[\s\S]*?\n\});/)[1], {});
      list = steps[platform].map((step) => mustaches(items[0], { ...scope, step }));
    } else list = items.map((i) => mustaches(i, scope));
    return { subtitle: mustaches(subtitle, scope), steps: list, button: mustaches(button, scope) };
  };
  return { en: render('en'), 'zh-TW': render('zh-TW') };
}
const BROWSERS = {
  iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari', platform: 'iPhone', maxTouchPoints: 5 },
  ipad: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari', platform: 'MacIntel', maxTouchPoints: 5 },
  android: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile', platform: 'Linux armv8l', maxTouchPoints: 5 },
  windows: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', platform: 'Win32', maxTouchPoints: 0 },
  mac: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari', platform: 'MacIntel', maxTouchPoints: 0 },
  linux: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko Firefox', platform: 'Linux x86_64', maxTouchPoints: 0 },
};

// Markdown code fences, with markdown-it's own rule for what a highlighter may return:
// an empty answer falls back to the escaped text (emulated, markdown-it is not loaded).
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function fences(root, features) {
  must(root, 'src/js/markdown.js');
  const line = maybeCut(root, 'src/js/markdown.js', 'highlight', /^\s*md\.options\.highlight=(.*);$/m, 1);
  const diff = esm(root, 'src/js/diffLines.js');
  const highlight = line ? evaluate(root, line, { uxFeatures: { value: features }, diffLines: diff?.diffLines, md: { utils: { escapeHtml } } }) : null;
  const inputs = [['diff', '--- a\n+++ b\n@@ -1 +1 @@\n-old <b>\n+new\n context'], ['patch', 'diff --git a b\nindex 1..2\n+x'], ['js', 'a < b && c'], ['', 'plain text'], ['diff', '']];
  return inputs.map(([language, content]) => (highlight ? highlight(content, language) : '') || escapeHtml(content));
}

// The client's stored settings after the tree's own server answered with its defaults.
async function clientSettings(root, newRefs) {
  const open = openStore(root);
  try {
    const { store } = open;
    const answers = { '/preferences': () => store.getPreferences('admin1'), '/agent-list': () => store.listPreferences('admin1') };
    const ref = (value) => ({ value });
    const text = must(root, 'src/js/agentPreferences.js');
    const module = esm(root, 'src/js/agentPreferences.js', { ref, api: async (url) => JSON.parse(JSON.stringify(answers[url]())) });
    if (!text || !module) fail(root, 'Missing agentPreferences');
    await module.loadAgentPreferences(); await module.loadListPreferences();
    const names = newRefs
      ? ['uxFeatures', 'railPins', 'terminalFirst', 'terminalPromptReminder', 'scopedAgents', 'uxFeatureKeys']
      : ['compactThreshold', 'terminalSwitch', 'transcriptSwitch', 'archiveRetentionDays', 'wrapUp', 'preferencesLoaded', 'autoSort', 'listGroups'];
    return Object.fromEntries(names.map((n) => [n, module[n] === undefined ? null : (module[n] && typeof module[n] === 'object' && 'value' in module[n] ? module[n].value : module[n])]));
  } finally { open.close(); }
}


module.exports = (root) => {
  const cases = {};

  // ---- server: F10 stored list settings, answers and refusals
  cases['F10-listPreferences-default'] = withStore(root, (s) => s.listPreferences('u1'));
  cases['F10-listPreferences-existing-keys'] = withStore(root, (s) => pick(s.listPreferences('u1'), ['autoSort', 'groups']));
  cases['F10-setListPreferences-autoSort'] = withStore(root, (s) => settle(() => pick(s.setListPreferences('u1', { autoSort: true }), ['autoSort', 'groups'])));
  cases['F10-setListPreferences-groups'] = withStore(root, (s) => settle(() => groupsOf(s.setListPreferences('u1', { groups: [{ id: 'g-1', name: 'Work' }] }).groups)));
  cases['F10-setListPreferences-nothing'] = withStore(root, (s) => settle(() => s.setListPreferences('u1', {})));
  cases['F10-setListPreferences-bad-autoSort'] = withStore(root, (s) => settle(() => s.setListPreferences('u1', { autoSort: 'yes' })));
  cases['F10-setListPreferences-too-many-groups'] = withStore(root, (s) => settle(() => s.setListPreferences('u1', { groups: Array.from({ length: 21 }, (_, i) => ({ id: `g-${i}`, name: `G${i}` })) })));
  cases['F10-setListPreferences-unknown-key-with-valid-one'] = withStore(root, (s) => settle(() => pick(s.setListPreferences('u1', { autoSort: true, bogus: 1 }), ['autoSort'])));
  cases['F10-setListPreferences-unknown-key-alone'] = withStore(root, (s) => settle(() => s.setListPreferences('u1', { bogus: 1 })));

  // Pins on the defaults themselves: the answers above differ by design, these must not.
  cases['F10-default-no-interface-feature-on'] = withStore(root, (s) => Object.values(s.listPreferences('u1').uxFeatures || {}).some(Boolean));
  cases['F4-default-no-pins'] = withStore(root, (s) => (s.listPreferences('u1').railPins || []).length);
  cases['F10-default-admin-flags-off'] = withStore(root, (s) => { const p = s.getPreferences('admin1'); return [p.terminalFirst, p.terminalPromptReminder].some((v) => v === true); });
  cases['F11-default-new-agents-scoped-off-windows'] = withStore(root, (s) => s.getPreferences('admin1').scopedAgents !== false || process.platform === 'win32');
  cases['F10-default-terminal-first-stays-off-with-switch-on'] = withStore(root, (s) => { s.setPreferences('admin1', { terminalSwitch: true }); return s.getPreferences('admin1').terminalFirst === true; });

  // ---- server: the admin preferences (F3 reminder, terminal-first, F11 platform flag)
  cases['F10-getPreferences-existing-keys'] = withStore(root, (s) => pick(s.getPreferences('admin1'), ['wrapUp', 'archiveRetentionDays', 'compactThreshold', 'terminalSwitch', 'transcriptSwitch']));
  cases['F10-getPreferences-terminalFirst-default'] = withStore(root, (s) => s.getPreferences('admin1').terminalFirst ?? null);
  cases['F3-getPreferences-terminalPromptReminder-default'] = withStore(root, (s) => s.getPreferences('admin1').terminalPromptReminder ?? null);
  cases['F11-getPreferences-scopedAgents'] = withStore(root, (s) => s.getPreferences('admin1').scopedAgents ?? null);
  cases['F10-setPreferences-nothing'] = withStore(root, (s) => settle(() => s.setPreferences('admin1', {})));
  cases['F10-setPreferences-unknown-key'] = withStore(root, (s) => settle(() => s.setPreferences('admin1', { bogus: true })));
  cases['F10-setPreferences-terminalSwitch'] = withStore(root, (s) => settle(() => pick(s.setPreferences('admin1', { terminalSwitch: true }), ['terminalSwitch', 'transcriptSwitch', 'compactThreshold'])));
  cases['F10-setPreferences-bad-values'] = withStore(root, (s) => ['compactThreshold', 'terminalSwitch', 'transcriptSwitch'].map((k) => settle(() => s.setPreferences('admin1', { [k]: k === 'compactThreshold' ? 11 : 'x' }))));

  // ---- server: F3 a terminal menu waits on the owner (reminder setting off)
  cases['F3-terminal-menu-busy-default'] = () => terminalMenuFlow(root, { phase: 'busy' });
  cases['F3-terminal-menu-idle-default'] = () => terminalMenuFlow(root, { phase: 'ready' });

  // ---- client: the settings rows (F3, F10, terminal-first)
  cases['F3-admin-reminder-row-default'] = () => drawn(root, 'src/pages/AdminPage.vue', 'class="terminal-prompt-reminder"', { terminalSwitch: false }, { signal: 'terminalPromptReminder' });
  cases['F10-admin-terminal-first-row-default'] = () => drawn(root, 'src/pages/AdminPage.vue', 'class="terminal-first"', { terminalSwitch: false }, { signal: 'terminalFirst' });
  cases['F10-settings-fold-row-default'] = () => drawn(root, 'src/pages/SettingsPage.vue', 'class="ux-settings-fold"', {}, { signal: 'uxFeatureKeys' });
  // The fold starts closed unless the device remembers it open (no saved choice here).
  cases['F10-settings-toggle-rows-default'] = () => {
    const text = must(root, 'src/pages/SettingsPage.vue');
    const tag = openingTag(root, text, '<f7-list-item v-for="key in uxExpanded?uxFeatureKeys:[]"');
    if (tag === null && text.includes('uxFeatureKeys')) fail(root, 'Missing interface toggle rows');
    if (tag === null) return 0;
    const initial = cut(root, 'src/pages/SettingsPage.vue', /^const uxExpanded=(ref\(.*\));$/m, 1);
    const uxExpanded = evaluate(root, initial, { ref: (value) => ({ value }), localStorage: { getItem: () => null }, UX_EXPANDED_KEY: 'k' }).value;
    return evaluate(root, attribute(tag, 'v-for').replace(/^key in /, ''), { uxExpanded, uxFeatureKeys: Object.keys(OFF) }).length;
  };
  cases['F10-client-new-settings-off-before-load'] = () => {
    const module = esm(root, 'src/js/agentPreferences.js', { ref: (value) => ({ value }), api: async () => ({}) });
    if (module === null) fail(root, 'Missing agentPreferences');
    return [Object.values(module.uxFeatures?.value || {}).some(Boolean), module.terminalFirst?.value === true, module.terminalPromptReminder?.value === true, (module.railPins?.value || []).length, module.scopedAgents?.value === false];
  };
  cases['F10-client-settings-after-server-defaults'] = () => clientSettings(root, false);
  cases['F10-client-new-settings-after-server-defaults'] = () => clientSettings(root, true);

  // ---- client: one gate per feature, with its toggle off
  for (const [name, key, rel, markers, scope] of [
    ['F4-rail-in-sidebar', 'desktopRail', 'src/App.vue', '<AgentRail ', { desktop: true }],
    ['F4-rail-pin-button', 'desktopRail', 'src/components/RailPin.vue', 'class="rail-pin"', {}],
    ['F5-attention-panel', 'attentionPanel', 'src/agent-pages/ChatListPage.vue', '<AttentionPanel ', {}],
    ['F7-message-delivery-label', 'messageStatus', 'src/components/MessageList.vue', '<MessageDelivery ', {}],
    ['F7-composer-sending-note', 'messageStatus', 'src/components/ChatComposer.vue', 'class="composer-sending"', { sending: true }],
  ]) cases[`${name}-default`] = () => drawn(root, rel, markers, { ...scope, uxFeatures: OFF }, { gateKey: key });
  cases['F4-app-panel-classes-default'] = () => classesAt(root, 'src/App.vue', ['class="page-content"', ':class="[\'page-content\''], { uxFeatures: OFF });
  cases['F6-chat-list-page-classes-default'] = () => classesAt(root, 'src/agent-pages/ChatListPage.vue', 'name="chats"', { uxFeatures: OFF });
  cases['F6-agent-rows-default'] = () => listRows(root, OFF);
  cases['F9-message-list-classes-default'] = () => classesAt(root, 'src/components/MessageList.vue', '<f7-messages :init="false"', { uxFeatures: OFF });
  cases['F9-code-fences-default'] = () => fences(root, OFF);

  // ---- client: F8 pause and start in the conversation
  cases['F8-pause-dialogs-default'] = () => pauseDialogs(root, OFF);
  cases['F8-profile-pause-button-default'] = () => profilePauseButton(root, OFF);
  cases['F8-more-menu-default'] = () => {
    const body = cut(root, 'src/agent-pages/ConversationPage.vue', /const moreItems=computed\(\(\)=>(\[[\s\S]*?\n\])\);/, 1);
    return ['ready', 'busy', 'stopped'].map((phase) => evaluate(root, body, { uxFeatures: { value: OFF }, workspace: { detail: { value: { phase } }, ct }, t: (k) => `t(${k})` }));
  };
  cases['F8-start-bar-default'] = () => {
    const start = esm(root, 'src/js/agentStart.js');
    const expression = maybeCut(root, 'src/components/AgentStart.vue', 'visible', /const visible=computed\(\(\)=>(.*)\);/, 1);
    return tableOf((detail) => (expression === null ? false : !!evaluate(root, expression, { props: { panel: false, detail }, uxFeatures: { value: OFF }, canStartAgent: start.canStartAgent, working: { value: false } })));
  };
  cases['F8-can-start-by-phase'] = () => { const can = canStartTable(root); return tableOf((d) => !!can(d)); };
  cases['F8-can-start-without-detail'] = () => { const can = canStartTable(root); return [null, undefined].map((d) => !!can(d)); };

  // ---- client: terminal-first off
  cases['F10-terminal-first-waiting-panel-default'] = () => {
    const expression = maybeCut(root, 'src/agent-pages/ConversationPage.vue', 'terminalWaiting', /const terminalWaiting=computed\(\(\)=>(.*)\);/, 1);
    const start = esm(root, 'src/js/agentStart.js');
    return tableOf((detail) => (expression === null ? false : !!evaluate(root, expression, { terminalFirst: { value: false }, workspace: { showTerminalSwitch: { value: true }, detail: { value: detail } }, canStartAgent: start.canStartAgent, agentStarting: start.agentStarting, startInProgress: { value: false } })));
  };
  cases['F10-terminal-first-operation-default'] = () => {
    const statement = cut(root, 'src/js/agent-chat.js', /if\(selected\.value===id\)\{infoOpen\.value=false;profilePanelOpen\.value=false;[^}]*\}/);
    return ['start', 'stop', 'rotate'].map((kind) => {
      const state = { infoOpen: { value: true }, profilePanelOpen: { value: true }, terminalOpen: { value: true } };
      vm.runInNewContext(statement, { selected: { value: 'a1' }, id: 'a1', kind, ...state, agentPreferences: { terminalFirst: { value: false } }, showTerminalSwitch: { value: true } });
      return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.value]));
    });
  };
  cases['F10-terminal-first-open-agent-default'] = () => {
    const statement = maybeCut(root, 'src/js/agent-chat.js', 'terminalFirst', /^\s*(if\(.*\)\{terminalOpen\.value=true;chatHidden\.value=wideScreen\.value;\})$/m, 1);
    const state = { terminalOpen: { value: false }, chatHidden: { value: false } };
    if (statement !== null) vm.runInNewContext(statement, { showTerminalSwitch: { value: true }, agentPreferences: { terminalFirst: { value: false } }, wideScreen: { value: true }, ...state });
    return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.value]));
  };

  // ---- client: F11 install instructions
  for (const [name, navigator] of Object.entries(BROWSERS)) cases[`F11-install-screen-${name}`] = () => installTexts(root, navigator);
  return cases;
};

// What a user with default settings sees or gets differently from upstream. Every other
// case in this file stayed equal to upstream.
const F = (unit, reason) => ({ unit, reason });
module.exports.featureDifferences = {
  'F10-listPreferences-default': F('F10', 'The Agents-list settings answer carries uxFeatures (all false) and railPins ([]) next to autoSort and groups.'),
  'F10-setListPreferences-unknown-key-with-valid-one': F('F10', 'An unknown key now refuses the whole request; upstream ignored it and saved the valid ones.'),
  'F10-setListPreferences-unknown-key-alone': F('F10', 'An unknown key alone is refused as unsupported; upstream answered "nothing to update".'),
  'F10-getPreferences-terminalFirst-default': F('F10', 'Terminal-first adds the terminalFirst field to the preferences answer (false by default).'),
  'F3-getPreferences-terminalPromptReminder-default': F('F3', 'The 10-minute reminder adds terminalPromptReminder to the preferences answer (false by default).'),
  'F11-getPreferences-scopedAgents': F('F11', 'Preferences answer adds scopedAgents (true off Windows); the new-agent form reads it for the platform note and default access (W16 owner decision pending).'),
  'F3-admin-reminder-row-default': F('F3', 'The Admin page shows a "remind again after 10 minutes" switch (off) to every admin.'),
  'F10-settings-fold-row-default': F('F10', 'Settings shows a collapsed "Interface enhancements" row (0/6 on) to everyone.'),
  'F10-client-new-settings-after-server-defaults': F('F10', 'The client keeps uxFeatures, railPins, terminalFirst, terminalPromptReminder and scopedAgents; upstream has none of them.'),
  'F8-can-start-without-detail': F('F8', 'canStart is false without a conversation (upstream: true); the only reader is the button list, which is empty without one.'),
  'F11-install-screen-iphone': F('F11', 'Install steps reworded ("Tap the Share button"), subtitle loses the phone emoji, text follows the language.'),
  'F11-install-screen-ipad': F('F11', 'Same rewording as the iPhone steps; a touch Mac is treated as iOS.'),
  'F11-install-screen-android': F('F11', 'Android gets its own Chrome menu steps; upstream showed the Safari steps.'),
  'F11-install-screen-windows': F('F11', 'Desktop browsers get generic add-to-home-screen steps; upstream showed the Safari steps.'),
  'F11-install-screen-mac': F('F11', 'Desktop browsers get generic add-to-home-screen steps; upstream showed the Safari steps.'),
  'F11-install-screen-linux': F('F11', 'Desktop browsers get generic add-to-home-screen steps; upstream showed the Safari steps.'),
};
