// The slash menu over the composer: typing "/"
// offers Claude Code's own commands, which run in the agent's terminal, and the
// agent's skills, which go as a message it runs itself and answers in the chat.
// ↑/↓ choose, Tab completes, Enter picks (and sends a command that takes no
// arguments), Esc closes; a tap completes.
import {ref,computed,watch,nextTick} from 'vue';
import {api} from './api.js';

const FRESH_MS = 60000;

// caret: where the caret goes after a pick; a group chat has its own composer.
export function useSlashMenu({draft, conversationId, caret = caretToEnd}) {
  const commands = ref({terminal: [], skills: [], lists: {}});
  let loadedFor = null, loadedAt = 0, loading = null;
  // Esc closes the menu for the draft as it stands; typing reopens it.
  const dismissed = ref(null);
  const query = computed(() => { const m = /^\/([^\s]*)$/.exec(draft.value || ''); return m ? m[1].toLowerCase() : null; });
  // After a command or skill and a space, its options one level at a time, as
  // Claude Code's terminal offers them: "/plugin "
  // offers list, enable…; "/plugin enable " the installed plugins; "/config " the
  // settings and "/config theme=" their values. A level is a list of {value,
  // description} with, for more to come, `next` (a list), `then` (a list the server
  // sends by name) or `values` (full key=value choices for the same word).
  const optionItems = computed(() => {
    if (dismissed.value === draft.value) return [];
    const m = /^\/([a-z][a-z0-9:-]*) (.*)$/.exec(draft.value || '');
    if (!m) return [];
    const command = commands.value.terminal.find(c => c.name === m[1] || (c.aliases || []).includes(m[1])) || commands.value.skills.find(s => s.name === m[1]);
    if (!command?.options?.length) return [];
    const lists = commands.value.lists || {};
    const words = m[2].split(' '), typed = words.pop();
    let level = command.options;
    for (const word of words) {
      const node = level.find(o => o.value === word);
      if (!node) return [];
      level = node.next || (node.then && lists[node.then]) || null;
      if (!level) return [];
    }
    const prefix = '/' + m[1] + ' ' + words.map(w => w + ' ').join('');
    const more = o => !!(o.next || o.then || o.values);
    const item = (value, description, open) => ({kind: 'option', name: (prefix + value).slice(1), label: prefix + value, fill: prefix + value + (open && !value.endsWith('=') ? ' ' : ''), then: open, description: description || '', aliases: [], hint: ''});
    // "key=" typed: that setting's values.
    const keyed = typed.includes('=') ? level.find(o => o.values && o.value === typed.slice(0, typed.indexOf('=') + 1)) : null;
    if (keyed) return keyed.values.filter(v => v.toLowerCase().startsWith(typed.toLowerCase()) && v !== typed).map(v => item(v, '', false)).slice(0, 80);
    const t = typed.toLowerCase();
    return level.filter(o => o.value.toLowerCase().startsWith(t) && o.value !== typed).map(o => item(o.value, o.description, more(o))).slice(0, 80);
  });
  watch(optionItems, list => { if (list.length) load(); });
  const items = computed(() => {
    const q = query.value;
    if (q === null) return optionItems.value;
    if (dismissed.value === draft.value) return [];
    const all = [...commands.value.terminal.map(c => ({...c, kind: 'terminal'})), ...commands.value.skills.map(s => ({...s, kind: 'skill', aliases: [], hint: ''}))];
    const names = i => [i.name, ...(i.aliases || [])];
    const starts = all.filter(i => names(i).some(n => n.startsWith(q)));
    const contains = all.filter(i => !starts.includes(i) && names(i).some(n => n.includes(q)));
    return [...starts, ...contains].slice(0, 80);
  });
  const active = ref(0);
  // Back to the top only when the choices change, not each time the list refreshes
  // with the same ones: the pick kept jumping back up.
  watch(() => items.value.map(i => i.kind + ':' + i.name).join('|'), () => { active.value = 0; });

  async function load(force = false) {
    const id = conversationId.value;
    if (!id) return;
    // An empty skill list is not kept: a new agent's Claude Code may not have named its
    // skills yet, and the next "/" should ask again.
    if (!force && loadedFor === id && Date.now() - loadedAt < FRESH_MS && commands.value.skills.length) return;
    if (loading) return loading;
    loading = api('/conversations/' + id + '/commands').then(r => {
      if (conversationId.value === id) { commands.value = {terminal: r.terminal || [], skills: r.skills || [], lists: r.lists || {}}; loadedFor = id; loadedAt = Date.now(); }
    }).catch(() => {}).finally(() => { loading = null; });
    return loading;
  }
  watch(query, q => { if (q !== null) load(); });
  watch(conversationId, () => { commands.value = {terminal: [], skills: [], lists: {}}; loadedFor = null; dismissed.value = null; });

  // The terminal command a draft names, by name or alias, or null: a path such as
  // /Users/… or a skill is a message. The server checks it again.
  function terminalCommand(text) {
    const m = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(String(text || '').trim());
    return m ? commands.value.terminal.find(c => c.name === m[1] || (c.aliases || []).includes(m[1])) || null : null;
  }
  // A draft that might be one is checked against a fresh list before it is sent.
  async function resolveTerminal(text) {
    if (!/^\/[a-z]/.test(String(text || '').trim())) return null;
    await load();
    return terminalCommand(text);
  }

  function complete(item) {
    draft.value = item.kind === 'option' ? item.fill : '/' + item.name + (item.hint || item.kind === 'skill' ? ' ' : '');
    // A command with options, or an option with more after it, opens the next level.
    const opens = item.kind === 'option' ? item.then : !!item.options?.length;
    dismissed.value = opens ? null : draft.value;
    nextTick(caret);
  }
  // Returns true when the key was the menu's.
  function onKeydown(event, send) {
    if (!items.value.length) return false;
    const n = items.value.length;
    if (event.key === 'ArrowDown') active.value = (active.value + 1) % n;
    else if (event.key === 'ArrowUp') active.value = (active.value - 1 + n) % n;
    else if (event.key === 'Tab') complete(items.value[active.value]);
    else if (event.key === 'Escape') dismissed.value = draft.value;
    else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const item = items.value[active.value];
      complete(item);
      // One that takes arguments waits for them, and so does a skill, whose arguments
      // are not listed, so it is not sent before they are typed. A command that takes none goes at once, as in the terminal.
      // An option runs once nothing more comes after it.
      if (item.kind === 'option' ? !item.then : !item.hint && item.kind !== 'skill') { dismissed.value = null; nextTick(send); }
    } else return false;
    event.preventDefault();
    return true;
  }
  return {items, active, load, complete, onKeydown, terminalCommand, resolveTerminal};
}

function caretToEnd() {
  const el = document.querySelector('#view-chat .page-current #cc-agent-prompt');
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
