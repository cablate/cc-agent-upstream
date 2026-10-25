<template>
  <section v-if="items.length || refreshError" class="attention-panel" aria-labelledby="attention-title">
    <h2 id="attention-title">{{ t('navAttention') }}<span v-if="items.length" class="attention-count">{{ items.length }}</span></h2>
    <p v-if="refreshError" class="attention-error" role="status">{{ t('navAttentionRefreshFailed') }}</p>
    <div v-for="group in groups" :key="group.kind" class="attention-group">
      <h3>{{ t('navAttention_' + group.kind) }}<span>{{ group.items.length }}</span></h3>
      <a v-for="item in group.items" :key="item.id" :href="item.href" class="attention-item external" :data-kind="item.kind" @click="open($event, item)">
        <i class="attention-dot" :class="item.kind" aria-hidden="true"></i>
        <span class="attention-copy"><strong>{{ item.title }}</strong><span v-if="item.detail">{{ item.detail }}</span></span>
        <i class="icon f7-icons attention-chevron" aria-hidden="true">chevron_right</i>
      </a>
    </div>
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
    const kind = agentListStatus(agent);
    if (kind !== 'error' && (kind !== 'waiting' || !admin.value)) return [];
    return [{ kind, id: agent.id, title: agent.title, href: agentUrl(agent.id), detail: kind === 'error' ? agent.lastError : agent.terminalPrompt?.title, agent: true }];
  }),
  ...(admin.value ? reports.value.filter(r => r.status === 'open').map(r => ({ kind: 'report', id: r.id, title: r.agentTitle || r.title || t('navAttention_report'), detail: r.description || r.tool || '', href: '/?access-report=' + encodeURIComponent(r.id) })) : []),
  ...(admin.value ? schedules.value.filter(s => s.status === 'pending').map(s => ({ kind: 'schedule', id: s.id, title: s.title, detail: s.agentTitle || s.reason || '', href: '/?schedule=' + encodeURIComponent(s.id) })) : []),
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
.attention-panel {margin:24px 16px;padding:18px 16px 8px;border-radius:var(--cc-radius-card,20px);background:var(--cc-surface-card);box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 12%,transparent);}
.attention-panel h2 {display:flex;align-items:center;gap:8px;margin:0 0 14px;font-size:18px;font-weight:600;}
.attention-count {font-size:12px;padding:2px 7px;border-radius:12px;background:color-mix(in srgb,currentColor 12%,transparent);color:var(--cc-color-text-secondary);}
.attention-group {margin-bottom:12px;}
.attention-group h3 {display:flex;gap:7px;margin:10px 0 2px;font-size:12px;font-weight:500;color:var(--cc-color-text-secondary);}
.attention-group h3 span {font-variant-numeric:tabular-nums;}
.attention-item {display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 0;color:var(--cc-color-text);}
.attention-item:focus-visible {outline:2px solid var(--cc-color-accent,#d97757);outline-offset:3px;border-radius:6px;}
.attention-dot {flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:#ff9f0a;}
.attention-dot.error {background:#ff453a;}.attention-dot.report {background:#bf5af2;}.attention-dot.schedule {background:#5ac8fa;}
.attention-copy {display:flex;flex:1;min-width:0;flex-direction:column;gap:3px;overflow-wrap:anywhere;}
.attention-copy strong {font-size:14px;font-weight:500;}.attention-copy>span {font-size:12px;color:var(--cc-color-text-secondary);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}
.attention-chevron {font-size:12px;color:var(--cc-color-text-secondary);}
.attention-error {font-size:12px;color:var(--cc-color-text-secondary);}
@media(min-width:1024px){.attention-panel{max-width:828px;box-sizing:border-box;margin-left:auto;margin-right:auto;}}
</style>
