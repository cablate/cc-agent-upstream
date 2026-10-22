<template>
  <!-- The Claude limits, each bar led by its source's logo; Claude's 5-hour limit shows in the sidebar again above its
       weekly one. Data and timer are shared
       (src/js/usage.js). -->
  <!-- On the Admin page each limit is its own list row, its logo in the icon column,
       sized and placed as the rows below it. -->
  <div v-if="list" class="list inset"><ul>
    <li v-for="row in rows" :key="row.key" class="usage-item" :data-usage="row.group.key">
      <div class="item-content">
        <div class="item-media"><img class="usage-icon" :src="row.group.logo" :alt="row.group.name"/></div>
        <div class="item-inner">
          <div v-if="row.note" class="usage-main usage-note">{{ row.note }}</div>
          <div v-else class="usage-main">
            <div class="usage-label"><span>{{ t(row.meter.label) }}</span><span>{{ t('usageUsed', { percent: row.meter.percent }) }}</span></div>
            <div class="usage-bar" role="progressbar" :aria-label="row.group.name + ' ' + t(row.meter.label)" :aria-valuenow="row.meter.percent" aria-valuemin="0" aria-valuemax="100"><i :class="row.meter.level" :style="{ width: row.meter.percent + '%' }"></i><b v-if="row.meter.share" class="usage-session" :style="{ left: Math.max(0, row.meter.percent - row.meter.share) + '%', width: row.meter.share + '%' }"></b></div>
            <div v-if="row.meter.resets" class="usage-reset">{{ t('usageResets', { time: row.meter.resets }) }}<template v-if="row.meter.share"> · {{ t('usageSession', { share: row.meter.share }) }}</template></div>
            <div v-if="row.meter.stale" class="usage-reset usage-stale">{{ row.meter.stale }}</div>
          </div>
        </div>
      </div>
    </li>
  </ul></div>
  <div v-else-if="usageGroups.length" class="usage-meters">
    <div v-for="group in usageGroups" :key="group.key" class="usage-group" :data-usage="group.key">
      <div v-if="group.note" class="usage-row"><img class="usage-logo" :src="group.logo" :alt="group.name"/><div class="usage-main usage-note">{{ group.note }}</div></div>
      <div v-for="meter in group.meters" :key="meter.key" class="usage-row">
        <img class="usage-logo" :src="group.logo" :alt="group.name"/>
        <div class="usage-main">
          <div class="usage-label"><span>{{ t(meter.label) }}</span><span>{{ t('usageUsed', { percent: meter.percent }) }}</span></div>
          <div class="usage-bar" role="progressbar" :aria-label="group.name + ' ' + t(meter.label)" :aria-valuenow="meter.percent" aria-valuemin="0" aria-valuemax="100"><i :class="meter.level" :style="{ width: meter.percent + '%' }"></i><b v-if="meter.share" class="usage-session" :style="{ left: Math.max(0, meter.percent - meter.share) + '%', width: meter.share + '%' }"></b></div>
          <div v-if="meter.resets" class="usage-reset">{{ t('usageResets', { time: meter.resets }) }}<template v-if="meter.share"> · {{ t('usageSession', { share: meter.share }) }}</template></div>
          <div v-if="meter.stale" class="usage-reset usage-stale">{{ meter.stale }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { t } from '../js/i18n.js';
import { usageGroups, watchUsage } from '../js/usage.js';

defineProps({ list: Boolean });
const rows = computed(() => usageGroups.value.flatMap(group => group.note ? [{ key: group.key + ':note', group, note: group.note }] : group.meters.map(meter => ({ key: group.key + ':' + meter.key, group, meter }))));
let stop = null;
onMounted(() => { stop = watchUsage(); });
onUnmounted(() => stop?.());
</script>

<style scoped>
.usage-meters {display:flex;flex-direction:column;gap:14px;padding:0 20px 12px;}
.usage-group {display:flex;flex-direction:column;gap:10px;}
.usage-row {display:flex;align-items:center;gap:10px;}
.usage-logo {flex:0 0 22px;width:22px;height:22px;border-radius:6px;}
.usage-main {flex:1;min-width:0;}
.usage-label {display:flex;justify-content:space-between;font-size:12px;color:var(--cc-color-text-secondary, #8e8e93);margin-bottom:4px;}
.usage-bar {position:relative;height:6px;border-radius:3px;background:var(--usage-track, rgba(255,255,255,.12));overflow:hidden;}
/* The current 5-hour window, the bright end of the week's bar. */
.usage-session {position:absolute;top:0;bottom:0;background:rgba(255,255,255,.5);border-radius:0 3px 3px 0;}
.usage-bar i {display:block;height:100%;border-radius:3px;transition:width .4s ease;}
.usage-bar i.low {background:#34c759;}
.usage-bar i.mid {background:#ff9f0a;}
.usage-bar i.high {background:#ff453a;}
.usage-reset {margin-top:3px;font-size:11px;color:var(--cc-color-text-secondary, #8e8e93);}
.usage-note {font-size:12px;color:var(--cc-color-text-secondary, #8e8e93);}
.usage-item .item-inner {padding-top:10px;padding-bottom:10px;}
.usage-icon {display:block;width:28px;height:28px;border-radius:7px;}
</style>
