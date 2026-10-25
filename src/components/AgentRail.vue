<template>
  <nav class="agent-rail" :aria-label="t('navRail')">
    <div class="rail-heading" :title="t('navShortcut')">{{ t('navRail') }}<span aria-hidden="true">Ctrl Alt ↑↓</span></div>
    <div class="rail-list">
      <p v-if="!rows.length" class="rail-empty"><f7-icon f7="pin"/>{{ t('uxRailEmpty') }}</p>
      <a v-for="row in rows" :key="row.kind + ':' + row.id" :href="row.kind === 'agent' ? agentUrl(row.id) : '/?group=' + encodeURIComponent(row.id)" class="rail-agent external" :class="{ selected: current === row.kind + ':' + row.id }" :data-id="row.id" :data-kind="row.kind" :aria-current="current === row.kind + ':' + row.id ? 'page' : undefined" @click.prevent="open(row)">
        <span class="rail-avatar"><img v-if="row.kind === 'agent'" :src="row.agent.avatar || defaultAvatar(row.agent)" alt=""/><f7-icon v-else f7="person_2"/><i v-if="row.kind === 'agent'" class="rail-dot" :class="status(row.agent)" :title="t('navStatus_' + status(row.agent))"></i></span>
        <span class="rail-copy"><span class="rail-name">{{ row.kind === 'agent' ? row.agent.title : row.group.name }}</span><span class="rail-status">{{ row.kind === 'agent' ? t('navStatus_' + status(row.agent)) : t('uxGroupChat') }}</span></span>
        <span v-if="row.kind === 'agent' && w.unreadOf(row.agent)" class="badge color-red">{{ w.unreadLabel(w.unreadOf(row.agent)) }}</span>
      </a>
    </div>
  </nav>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted } from 'vue';
import { t } from '../js/i18n.js';
import { agentUrl } from '../js/agentUrl.js';
import { defaultAvatar } from '../js/avatarShape.js';
import { agentListStatus } from '../js/agent-list-status.js';
import {railPins,uxFeatures} from '../js/agentPreferences.js';
import {groups,viewingGroup} from '../js/groups.js';
import {activeTab} from '../js/tab-session.js';
const w = inject('workspace');
// Only what the user pinned, in pin order; a pin whose agent or group room is gone is skipped.
const rows = computed(() => railPins.value.flatMap(pin => { const item = (pin.kind === 'agent' ? w.conversations.value : groups.value).find(x => x.id === pin.id); return item ? [{ ...pin, [pin.kind]: item }] : []; }));
const current = computed(() => activeTab.value === 'view-groups' && viewingGroup.value ? 'group:' + viewingGroup.value : activeTab.value === 'view-chat' ? 'agent:' + (w.openingId.value || w.selected.value) : null);
const status = agent => uxFeatures.value.statusColors ? agentListStatus(agent, w.activity(agent), w.user.value?.role==='admin') : (w.activity(agent)||agent.connected&&(agent.phase==='busy'||agent.background>0)?'busy':agent.connected?'online':'offline');
const open = row => row.kind === 'agent' ? w.select(row.id) : w.openGroup(row.id);
function onSwitch(event) {
  if (event.repeat || event.getModifierState?.('AltGraph')) return;
  if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  if (event.target?.closest?.('.terminal-pane') || document.querySelector('.dialog.modal-in,.popup.modal-in,.sheet-modal.modal-in,.popover.modal-in,.actions-modal.modal-in,[aria-modal="true"]')) return;
  if (!window.matchMedia('(min-width: 1024px)').matches || !rows.value.length) return;
  const index = rows.value.findIndex(row => row.kind + ':' + row.id === current.value);
  const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.value.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.value.length) % rows.value.length;
  event.preventDefault();
  open(rows.value[next]);
}
onMounted(() => document.addEventListener('keydown', onSwitch));
onUnmounted(() => document.removeEventListener('keydown', onSwitch));
</script>

<style scoped>
.agent-rail {display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto;padding:0 12px;}
.rail-heading {display:flex;align-items:center;justify-content:space-between;padding:4px 10px 10px;color:var(--cc-color-text-secondary);font-size:12px;font-weight:600;}
.rail-heading span {font-size:10px;font-weight:400;}
.rail-list {min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-bottom:8px;}
.rail-empty {margin:0;padding:6px 10px;color:var(--cc-color-text-secondary);font-size:12px;line-height:1.6;}
.rail-empty .icon {font-size:14px;margin-right:4px;}
.rail-agent {display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:12px;color:var(--cc-color-text);}
.rail-agent:hover {background:color-mix(in srgb,currentColor 6%,transparent);}
.rail-agent.selected {background:color-mix(in srgb,currentColor 12%,transparent);box-shadow:inset 3px 0 var(--cc-color-accent,#d97757);}
.rail-agent:focus-visible {outline:2px solid var(--cc-color-accent,#d97757);outline-offset:-2px;}
.rail-avatar {position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 30px;width:30px;height:30px;}
.rail-avatar img {width:100%;height:100%;object-fit:contain;border-radius:10px;}
.rail-avatar>.icon {font-size:24px;color:var(--cc-color-text-secondary);}
.rail-dot {position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;border-radius:50%;background:#8e8e93;box-shadow:0 0 0 2px var(--cc-color-page,#121212);}
.rail-dot.online {background:#34c759;}
.rail-dot.busy {background:#5ac8fa;}
.rail-dot.waiting {background:#ff9f0a;}
.rail-dot.error {background:#ff453a;}
.rail-copy {display:flex;flex:1;min-width:0;flex-direction:column;gap:2px;}
.rail-name {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;}
/* One line per agent: the dot shows the status; the words stay for screen readers. */
.rail-status {position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.badge {flex-shrink:0;font-size:10px;min-width:17px;height:17px;}
</style>
