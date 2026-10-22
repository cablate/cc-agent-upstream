<template>
  <f7-page name="access-reports" class="page-large-static" ptr :ptr-mousewheel="true" @ptr:refresh="refresh" @page:afterin="load">
    <f7-navbar large>
      <f7-nav-left :back-link="true"></f7-nav-left>
      <f7-nav-title sliding>{{ ct('範圍報告單') }}</f7-nav-title>
      <f7-nav-title-large>{{ ct('範圍報告單') }}</f7-nav-title-large>
    </f7-navbar>

    <f7-block-footer>{{ ct('Agent 碰到範圍外的動作時會被擋下，並在這裡開一張報告單。可以略過，或替那個 Agent 開通。') }}</f7-block-footer>

    <div class="page-col-medium">
      <div class="report-filters">
        <label>
          <span>{{ ct('狀態') }}</span>
          <select v-model="filter">
            <option value="open">{{ ct('未處理') }}</option>
            <option value="resolved">{{ ct('已處理') }}</option>
            <option value="">{{ ct('全部') }}</option>
          </select>
        </label>
      </div>

      <f7-block v-if="loading && !reports.length" class="report-state"><f7-preloader /></f7-block>
      <f7-block v-else-if="error" class="report-state report-error">{{ error }}</f7-block>
      <f7-block v-else-if="!shown.length" class="report-state report-muted">{{ ct('目前沒有報告單') }}</f7-block>

      <div v-else class="report-cards">
        <button v-for="r in shown" :key="r.id" type="button" class="report-card" @click="open(r)">
          <div class="report-card-head">
            <i class="f7-icons report-icon" :class="reportMeta(r).cls">{{ reportMeta(r).icon }}</i>
            <div class="report-card-title">
              <strong>{{ r.agentTitle || r.title }}</strong>
              <span>{{ r.ownerName }} · {{ reportTime(r.at) }}</span>
            </div>
            <span class="report-status" :class="reportMeta(r).cls">{{ reportMeta(r).label }}</span>
          </div>
          <div class="report-card-lines">
            <div>🛠 {{ r.tool || ct('未知工具') }}：{{ excerpt(r.detail) }}</div>
            <div v-if="r.error">⛔ {{ excerpt(r.error) }}</div>
            <div v-if="r.messageExcerpt">💬 {{ excerpt(r.messageExcerpt, 80) }}</div>
          </div>
          <div class="report-card-foot">
            <span>{{ reportKind(r) }}</span>
            <span>{{ ct('第') }} {{ r.generation }} {{ ct('代') }}</span>
            <i class="f7-icons">chevron_right</i>
          </div>
        </button>
      </div>
    </div>
  </f7-page>
</template>

<script setup>
import { computed, ref } from 'vue';
import { f7 } from 'framework7-vue';
import { api } from '../js/api.js';
import { ct } from '../js/agent-i18n.js';
import { reportMeta, reportKind, reportTime, excerpt } from '../js/access-reports.js';

const reports = ref([]);
const loading = ref(false);
const error = ref('');
const filter = ref('open');
const shown = computed(() => reports.value.filter((r) => !filter.value || r.status === filter.value));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    reports.value = (await api('/access-reports')).reports || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function refresh(done) {
  await load();
  done();
}
function open(r) {
  f7.views.get('#view-admin').router.navigate(`/access-report/?id=${encodeURIComponent(r.id)}`);
}
</script>

<style scoped>
.report-filters { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 0 16px 14px; }
.report-filters label { display: flex; flex-direction: column; gap: 5px; color: var(--f7-block-footer-text-color, rgba(255, 255, 255, 0.58)); font-size: 12px; }
.report-filters select { width: 100%; min-height: 42px; padding: 0 12px; border: 0; border-radius: 13px; color: inherit; background: rgba(127, 127, 127, 0.16); font: inherit; font-size: 14px; }
.report-state { min-height: 140px; display: flex; align-items: center; justify-content: center; }
.report-error { color: #ff453a; }
.report-muted { opacity: 0.6; }
.report-cards { display: flex; flex-direction: column; gap: 12px; padding: 0 16px 24px; }
.report-card {
  width: 100%; padding: 15px 16px; border: 0; border-radius: 20px; color: inherit; text-align: left;
  background: rgba(127, 127, 127, 0.12);
  box-shadow: rgba(255, 255, 255, 0.4) 2px 2px 2px -2px inset, rgba(255, 255, 255, 0.4) -2px -2px 2px -2px inset;
}
.report-card-head { display: flex; align-items: center; gap: 11px; }
.report-icon { font-size: 32px; }
.report-card-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.report-card-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.report-card-title span { opacity: 0.55; font-size: 13px; }
.report-status { padding: 4px 8px; border-radius: 10px; background: rgba(127, 127, 127, 0.14); font-size: 11px; font-weight: 700; white-space: nowrap; }
.report-open { color: #ff9f0a; }
.report-granted { color: #30d158; }
.report-dismissed { color: #8e8e93; }
.report-card-lines { margin-top: 12px; font-size: 13px; line-height: 1.7; opacity: 0.85; overflow-wrap: anywhere; }
.report-card-foot { display: flex; gap: 12px; align-items: center; margin-top: 10px; opacity: 0.55; font-size: 12px; }
.report-card-foot .f7-icons { margin-left: auto; font-size: 15px; }
</style>
