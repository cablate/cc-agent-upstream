<template>
 <div v-if="visible" class="agent-start-state" :class="{'agent-start-panel':panel}" role="status" aria-live="polite">
  <f7-icon v-if="panel" :f7="working?'arrow_2_circlepath':'pause_circle'"/>
  <span class="agent-start-copy" :title="reason||undefined">{{label}}<small v-if="reason&&!working">{{reason.slice(0,160)}}</small></span>
  <f7-button class="agent-start-button" :disabled="working||!canStartAgent(detail)" @click="start">{{t(working?'uxAgentStarting':'uxAgentStart')}}</f7-button>
 </div>
</template>
<script setup>
import {ref,computed} from 'vue';
import {t} from '../js/i18n.js';
import {uxFeatures} from '../js/agentPreferences.js';
import {canStartAgent,agentStarting} from '../js/agentStart.js';
const props=defineProps({detail:Object,action:Function,starting:Boolean,panel:Boolean,error:String});
const busy=ref(false);
const working=computed(()=>busy.value||props.starting||(props.panel&&agentStarting(props.detail)));
const visible=computed(()=>(props.panel||uxFeatures.value.mobilePause)&&!!props.detail&&(props.panel||canStartAgent(props.detail)||working.value));
const reason=computed(()=>props.error||(props.detail?.phase==='error'?props.detail.lastError:''));
const label=computed(()=>t(working.value?'uxAgentStarting':props.detail?.phase==='stopped'?'uxAgentStopped':props.detail?.phase==='error'?'uxAgentError':'uxAgentOffline'));
async function start(){if(working.value||!canStartAgent(props.detail))return;busy.value=true;try{await props.action('start');}finally{busy.value=false;}}
</script>
<style scoped>
.agent-start-state {position:relative;z-index:1;display:flex;align-items:center;gap:12px;margin:0 20px;padding:4px 0 8px;color:var(--cc-color-text-secondary);font-size:13px;}
.agent-start-copy {flex:1;min-width:0;overflow-wrap:anywhere;}
.agent-start-copy small {display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.agent-start-button {flex:0 0 auto;min-width:64px;height:32px;line-height:32px;border-radius:16px;background:var(--cc-glass-fill-subtle,rgba(120,120,128,.16));color:var(--cc-color-text);font-size:13px;}
.agent-start-panel {flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:12px;margin:24px;text-align:center;}
.agent-start-panel>.icon {font-size:32px;}
.agent-start-panel .agent-start-copy {flex:0 0 auto;max-width:100%;font-size:15px;}
.agent-start-panel .agent-start-copy small {margin-top:8px;white-space:normal;}
</style>
