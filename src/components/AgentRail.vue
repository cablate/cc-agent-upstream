<template>
  <nav class="agent-rail" :aria-label="t('navRail')">
    <div class="rail-heading" :title="t('navShortcut')">{{ t('navRail') }}<span aria-hidden="true">Ctrl Alt ↑↓</span></div>
    <div class="rail-list">
      <template v-for="row in rows" :key="row.kind + ':' + row.id">
        <div v-if="row.kind !== 'agent'" class="rail-group">{{ row.name }}</div>
        <a v-else :href="agentUrl(row.id)" class="rail-agent external" :class="{ selected: current === row.id }" :data-id="row.id" :aria-current="current === row.id ? 'page' : undefined" @click.prevent="w.select(row.id)">
          <span class="rail-avatar"><img :src="row.agent.avatar || defaultAvatar(row.agent)" alt=""/><i class="rail-dot" :class="status(row.agent)" :title="t('navStatus_' + status(row.agent))"></i></span>
          <span class="rail-copy"><span class="rail-name">{{ row.agent.title }}</span><span class="rail-status" :class="status(row.agent)">{{ t('navStatus_' + status(row.agent)) }}</span></span>
          <span v-if="w.unreadOf(row.agent)" class="badge color-red">{{ w.unreadLabel(w.unreadOf(row.agent)) }}</span>
        </a>
      </template>
    </div>
  </nav>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted } from 'vue';
import { t } from '../js/i18n.js';
import { agentUrl } from '../js/agentUrl.js';
import { defaultAvatar } from '../js/avatarShape.js';
import { agentListStatus } from '../js/agent-list-status.js';
import {listGroups,uxFeatures} from '../js/agentPreferences.js';
const w = inject('workspace');
const rows = computed(() => {
  const items=w.conversations.value;
  const known=new Set(listGroups.value.map(g=>g.id));
  const agentRows=items=>items.map(agent=>({kind:'agent',id:agent.id,agent}));
  return [...agentRows(items.filter(a=>!known.has(a.listGroup))),...listGroups.value.flatMap(group=>{const members=items.filter(a=>a.listGroup===group.id);return members.length?[{kind:'group',id:group.id,name:group.name},...agentRows(members)]:[];})];
});
const agents = computed(() => rows.value.filter(row => row.kind === 'agent'));
const current = computed(() => w.openingId.value || w.selected.value);
const status = agent => uxFeatures.value.statusColors ? agentListStatus(agent, w.activity(agent), w.user.value?.role==='admin') : (w.activity(agent)||agent.connected&&(agent.phase==='busy'||agent.background>0)?'busy':agent.connected?'online':'offline');
function onSwitch(event) {
  if (event.repeat || event.getModifierState?.('AltGraph')) return;
  if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  if (event.target?.closest?.('.terminal-pane') || document.querySelector('.dialog.modal-in,.popup.modal-in,.sheet-modal.modal-in,.popover.modal-in,.actions-modal.modal-in,[aria-modal="true"]')) return;
  if (!window.matchMedia('(min-width: 1024px)').matches || !agents.value.length) return;
  const index = agents.value.findIndex(row => row.id === current.value);
  const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : agents.value.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + agents.value.length) % agents.value.length;
  event.preventDefault();
  w.select(agents.value[next].id);
}
onMounted(() => document.addEventListener('keydown', onSwitch));
onUnmounted(() => document.removeEventListener('keydown', onSwitch));
</script>

<style scoped>
.agent-rail {display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto;padding:0 12px;}
.rail-heading {display:flex;align-items:center;justify-content:space-between;padding:4px 10px 10px;color:var(--cc-color-text-secondary);font-size:12px;font-weight:600;}
.rail-heading span {font-size:10px;font-weight:400;}
.rail-list {min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-bottom:8px;}
.rail-group {padding:10px 10px 4px;font-size:11px;color:var(--cc-color-text-secondary);overflow-wrap:anywhere;}
.rail-agent {display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:12px;color:var(--cc-color-text);}
.rail-agent:hover {background:color-mix(in srgb,currentColor 6%,transparent);}
.rail-agent.selected {background:color-mix(in srgb,currentColor 12%,transparent);box-shadow:inset 3px 0 var(--cc-color-accent,#d97757);}
.rail-agent:focus-visible {outline:2px solid var(--cc-color-accent,#d97757);outline-offset:-2px;}
.rail-avatar {position:relative;flex:0 0 30px;width:30px;height:30px;}
.rail-avatar img {width:100%;height:100%;object-fit:contain;border-radius:10px;}
.rail-dot {position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;border-radius:50%;background:#8e8e93;box-shadow:0 0 0 2px var(--cc-color-page,#121212);}
.rail-dot.online {background:#34c759;}
.rail-dot.busy {background:#5ac8fa;}
.rail-dot.waiting {background:#ff9f0a;}
.rail-dot.error {background:#ff453a;}
.rail-copy {display:flex;flex:1;min-width:0;flex-direction:column;gap:2px;}
.rail-name {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;}
.rail-status {font-size:10px;color:var(--cc-color-text-secondary);}
.rail-status.error {color:#ff453a;}.rail-status.waiting {color:#ff9f0a;}
.badge {flex-shrink:0;font-size:10px;min-width:17px;height:17px;}
</style>
