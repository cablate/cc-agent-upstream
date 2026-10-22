// One highlight for every composer on the page (a split view has several): each
// keeps its own ranges here, and the browser paints them all as cc-mention.
const byComposer = new Map();
export function paintMentions(owner, ranges) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  if (ranges.length) byComposer.set(owner, ranges); else byComposer.delete(owner);
  const all = [...byComposer.values()].flat();
  if (all.length) CSS.highlights.set('cc-mention', new Highlight(...all)); else CSS.highlights.delete('cc-mention');
}
