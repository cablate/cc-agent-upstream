// The agents in the Agents list's own order and grouping: by source, then its groups,
// the ones in no group first, as the list shows them (the split view's picker and the @ menu read as a jumble).
import {SOURCES, sourceOf} from './agent-models.js';

const ORDER = ['native'];
const sourceOfAgent = c => c.source || sourceOf();

// [{label, agents}] with each section's label "Source" or "Source · Group".
export function agentSections(agents, groups = []) {
  const out = [];
  for (const source of ORDER) {
    const mine = agents.filter(c => sourceOfAgent(c) === source);
    if (!mine.length) continue;
    const own = groups.filter(g => (g.source || 'native') === source), known = new Set(own.map(g => g.id));
    const name = SOURCES[source]?.name || source;
    const loose = mine.filter(c => !c.listGroup || !known.has(c.listGroup));
    if (loose.length) out.push({label: name, agents: loose});
    for (const g of own) { const inside = mine.filter(c => c.listGroup === g.id); if (inside.length) out.push({label: name + ' · ' + g.name, agents: inside}); }
  }
  return out;
}
// The same flattened, each agent carrying its section's label.
export const inSections = (agents, groups) => agentSections(agents, groups).flatMap(s => s.agents.map(a => ({...a, section: s.label})));
