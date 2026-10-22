<template>
 <f7-list inset accordion-list class="cc-settings-list">
  <f7-list-item accordion-item :title="ct('工程診斷資訊')">
   <f7-accordion-content><f7-block>
    <f7-button v-if="admin" @click="startTrace">{{ct('開始鍵盤排版診斷')}}</f7-button>
    <f7-button @click="copy">{{ct(copied?'已複製':'複製診斷資訊')}}</f7-button>
    <p v-if="copyError" role="alert">{{ct('無法自動複製，請選取下方文字複製。')}}</p>
    <pre class="diagnostic-text">{{text}}</pre>
   </f7-block></f7-accordion-content>
  </f7-list-item>
 </f7-list>
</template>
<script setup>
import {computed,ref} from 'vue';
import {keyboardTrace,startKeyboardTrace} from '../js/keyboardDiagnostics.js';
import {ct} from '../js/agent-i18n.js';
const props=defineProps({detail:{type:Object,required:true},status:String,admin:Boolean});
const emit=defineEmits(['trace-start']);
function startTrace(){startKeyboardTrace();emit('trace-start');}
const copied=ref(false),copyError=ref(false);
// Explicit support fields only: never serialize the account, memory, chat or credentials.
const text=computed(()=>[
 'CC Agent',
 `Version: ${typeof __APP_VERSION__==='undefined'?'dev':__APP_VERSION__}`,
 `Build: ${typeof __BUILD_ID__==='undefined'?'dev':__BUILD_ID__}`,
 `Agent ID: ${props.detail.id}`,
 `Session ID: ${props.detail.sessionId}`,
 `Generation: ${props.detail.generation}`,
 `Status: ${props.status} (${props.detail.phase})`,
 `Compact: ${props.detail.compactCount} / ${props.detail.threshold||'off (no automatic handoff)'}`,
 `Configured model: ${props.detail.model}`,
 `Configured effort: ${props.detail.effort}`,
 `Session model: ${props.detail.sessionModel||'legacy / unspecified'}`,
 `Session effort: ${props.detail.sessionEffort||'legacy / unspecified'}`,
 ...(props.admin&&keyboardTrace.value?['Keyboard layout trace:',keyboardTrace.value]:[]),
 'Session history:',
 ...(props.detail.runs||[]).map(run=>`  Generation ${run.number}: ${run.sessionId}${run.sessionId===props.detail.sessionId?' (current)':''}`),
].join('\n'));
async function copy(){copied.value=false;copyError.value=false;try{await navigator.clipboard.writeText(text.value);copied.value=true;}catch{copyError.value=true;}}
</script>
<style scoped>
.diagnostic-text {white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font-size:13px;}
</style>
