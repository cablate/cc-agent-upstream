<template>
  <section v-if="items.length || refreshError" class="attention-panel" aria-labelledby="attention-title">
    <h2 id="attention-title">{{ t('navAttention') }}</h2>
    <!-- One chip per kind, opening its first item: one alone is named, more are counted. -->
    <a v-for="group in groups" :key="group.kind" :href="group.items[0].href" class="attention-chip external" :data-kind="group.kind" :title="group.items.map(item => item.title + (item.detail ? ' · ' + item.detail : '')).join('\n')" @click="open($event, group.items[0])">
      <i class="attention-dot" :class="group.kind" aria-hidden="true"></i>{{ t('navAttention_' + group.kind) }}
      <span class="attention-chip-more">{{ group.items.length === 1 ? group.items[0].title : group.items.length }}</span>
    </a>
    <p v-if="refreshError" class="attention-error" role="status">{{ t('navAttentionRefreshFailed') }}</p>
  </section>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../js/api.js';
import { t } from '../js/i18n.js';
import { activeTab } from '../js/tab-session.js';
import { agentUrl } from '../js/agentUrl.js';
import { agentListStatus } from '../js/agent-list-status.js';
const props = defineProps({ visible: Boolean });
const w = inject('workspace');
const reports = ref([]), schedules = ref([]), refreshError = ref(false);
const admin = computed(() => w.user.value?.role === 'admin');
const onScreen = () => props.visible && activeTab.value === 'view-chat' && !document.hidden;
const items = computed(() => [
  ...w.conversations.value.flatMap(agent => {
    const kind = agentListStatus(agent, w.activity(agent), admin.value);
    if (kind !== 'error' && (kind !== 'waiting' || !admin.value)) return [];
    return [{ kind, id: agent.id, title: agent.title, href: agentUrl(agent.id), detail: kind === 'error' ? agent.lastError : agent.terminalPrompt?.title, agent: true }];
  }),
  ...(admin.value ? reports.value.filter(r => r.status === 'open').map(r => ({ kind: 'report', id: r.id, title: r.agentTitle || r.title || t('navAttention_report'), detail: r.description || r.tool || '', href: '/?access-report=' + encodeURIComponent(r.id) })) : []),
  ...(admin.value ? schedules.value.filter(s => s.status === 'pending').map(s => ({ kind: 'schedule', id: s.id, title: s.name, detail: s.agentTitle || s.reason || '', href: '/?schedule=' + encodeURIComponent(s.id) })) : []),
]);
const groups = computed(() => ['error', 'waiting', 'report', 'schedule'].map(kind => ({ kind, items: items.value.filter(item => item.kind === kind) })).filter(group => group.items.length));
let loading = false, disposed = false;
async function refresh() {
  if (!onScreen() || loading || !admin.value) return;
  loading = true;
  const owner = w.user.value?.id;
  try {
    const [r, s] = await Promise.all([api('/access-reports'), api('/schedules')]);
    if (disposed || w.user.value?.id !== owner) return;
    reports.value = r.reports || [];
    schedules.value = s.schedules || [];
    refreshError.value = false;
  } catch {
    if (!disposed && w.user.value?.id === owner) refreshError.value = true;
  } finally { loading = false; }
}
function open(event, item) {
  if (!item.agent || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  w.select(item.id);
}
watch(() => w.user.value?.id, () => { reports.value = []; schedules.value = []; refreshError.value = false; });
watch([() => props.visible, activeTab, admin], refresh, { immediate: true });
let timer;
onMounted(() => {
  timer = setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  refresh();
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', refresh);
  window.removeEventListener('focus', refresh);
});
</script>

<style scoped>
.attention-panel {display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 16px 4px;}
.attention-panel h2 {margin:0 4px 0 0;font-size:13px;font-weight:600;color:var(--cc-color-text-secondary);}
.attention-chip {display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:36px;box-sizing:border-box;padding:4px 12px;border-radius:18px;background:var(--cc-surface-card);box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 12%,transparent);color:var(--cc-color-text);font-size:13px;}
.attention-chip:focus-visible {outline:2px solid var(--cc-color-accent,#d97757);outline-offset:2px;}
.attention-chip-more {min-width:0;max-width:12em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cc-color-text-secondary);font-variant-numeric:tabular-nums;}
.attention-dot {flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:#ff9f0a;}
.attention-dot.error {background:#ff453a;}.attention-dot.report {background:#bf5af2;}.attention-dot.schedule {background:#5ac8fa;}
.attention-error {flex-basis:100%;margin:0;font-size:12px;color:var(--cc-color-text-secondary);}
@media(min-width:1024px){.attention-panel{max-width:828px;box-sizing:border-box;margin-left:auto;margin-right:auto;}}
</style>
