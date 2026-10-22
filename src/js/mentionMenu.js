// "@" in the composer lists agents: in a group,
// the members, to call on one; in an agent's own chat, the other agents, to name
// the one it should reach across sessions. Picking one writes "@name ".
import {ref,computed,watch,nextTick,getCurrentScope,onScopeDispose} from 'vue';

// Where the caret is in a composer, as an offset into its text (innerText's rules:
// text as is, a <br> or the start of a block after the first is a line break).
function textOffset(editor, node, offset) {
  let n = 0, done = false;
  const walk = (el, first) => {
    for (let i = 0; i < el.childNodes.length && !done; i++) {
      if (el === node && i === offset) { done = true; return; }
      const c = el.childNodes[i];
      if (c.nodeType === 3) { if (c === node) { n += offset; done = true; return; } n += c.data.length; }
      else if (c.nodeName === 'BR') n += 1;
      else if (c.nodeType === 1) { if (/^(DIV|P)$/.test(c.nodeName) && (i > 0 || !first)) n += 1; walk(c, false); }
    }
    if (el === node && !done) done = true;
  };
  walk(editor, true);
  return n;
}
function placeCaret(editor, at) {
  let left = at;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (left <= t.data.length) { const r = document.createRange(); r.setStart(t, left); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
    left -= t.data.length;
  }
  return false;
}

export function useMentionMenu({draft, agents}) {
  const dismissed = ref(null);
  // "@" anywhere, not only at the end: the menu
  // follows the caret in whichever composer holds this draft.
  const caret = ref(null), editorEl = ref(null);
  const readCaret = () => {
    const sel = typeof getSelection === 'function' ? getSelection() : null;
    const el = sel?.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.('.chat-editor');
    if (!el || !sel.isCollapsed) return;
    const value = draft.value || '', at = textOffset(el, sel.anchorNode, sel.anchorOffset);
    if ((el.innerText || '').replace(/\r\n?/g, '\n') !== value || at > value.length) return;
    editorEl.value = el; if (caret.value !== at) caret.value = at;
  };
  if (typeof document !== 'undefined') { document.addEventListener('selectionchange', readCaret); if (getCurrentScope()) onScopeDispose(() => document.removeEventListener('selectionchange', readCaret)); }
  // The part of the draft before the caret; all of it when the caret is not known.
  // Read afresh each time: the text has already changed when the caret's own event
  // has not yet come.
  const before = () => { readCaret(); const v = draft.value || ''; return caret.value === null || caret.value > v.length ? v : v.slice(0, caret.value); };
  // The agents picked from the menu, by id: the text alone could name the wrong one.
  const picked = ref([]);
  const current = computed(() => picked.value.filter(m => (draft.value || '').includes('@' + m.title)));
  watch(() => draft.value, v => { if (!v) picked.value = []; });
  const query = computed(() => { draft.value; caret.value; const m = /(?:^|\s)@([^\s@]*)$/.exec(before()); return m ? m[1].toLowerCase() : null; });
  const items = computed(() => {
    const q = query.value;
    if (q === null || dismissed.value === draft.value) return [];
    const all = agents.value || [];
    // Nothing typed yet: the list's own order and sections; typed, the best matches first.
    if (!q) return all.slice(0, 60);
    const starts = all.filter(a => a.title.toLowerCase().startsWith(q)), contains = all.filter(a => !starts.includes(a) && a.title.toLowerCase().includes(q));
    const list = [...starts, ...contains];
    // A name typed in full, and a space after it, is done.
    return list.length === 1 && list[0].title.toLowerCase() === q ? [] : list.slice(0, 30);
  });
  const active = ref(0);
  // Back to the top only when the choices change, not each time the list refreshes
  // with the same ones: the pick kept jumping back up.
  watch(() => items.value.map(i => i.id).join('|'), () => { active.value = 0; });
  function complete(item, toEnd) {
    if (item.disabled) return;
    const head = before().replace(/@([^\s@]*)$/, '@' + item.title + ' '), tail = (draft.value || '').slice(before().length);
    draft.value = head + tail;
    if (!item.everyone && !picked.value.some(m => m.id === item.id)) picked.value = [...picked.value, {id: item.id, title: item.title}];
    dismissed.value = null;
    // Picked in the middle: the caret goes after the name, not to the end.
    const el = editorEl.value;
    if (tail && el?.isConnected) { caret.value = head.length; nextTick(() => { el.focus(); placeCaret(el, head.length); }); }
    else { caret.value = head.length; toEnd?.(); }
  }
  function onKeydown(event, caret) {
    if (!items.value.length) return false;
    const n = items.value.length;
    if (event.key === 'ArrowDown') active.value = (active.value + 1) % n;
    else if (event.key === 'ArrowUp') active.value = (active.value - 1 + n) % n;
    else if (event.key === 'Escape') dismissed.value = draft.value;
    // A greyed-out name is not picked, and Enter then sends as usual.
    else if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) && !items.value[active.value]?.disabled) complete(items.value[active.value], caret);
    else return false;
    event.preventDefault();
    return true;
  }
  // Taken back: the name comes out of the text too.
  function drop(m) { picked.value = picked.value.filter(x => x.id !== m.id); draft.value = (draft.value || '').split('@' + m.title).join('').replace(/\s{2,}/g, ' ').trimStart(); }
  return {items, active, complete, onKeydown, current, drop};
}

// The caret to the end of a composer, after its text was set from here.
export function caretToEnd(root) {
  const el = root?.querySelector?.('[contenteditable]');
  if (!el) return;
  nextTick(() => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
}
