<template>
 <!-- A menu waiting in the agent's terminal, answered from the chat (computer use asked for macOS permissions in the terminal
      and the chat only showed the agent still at work). The server reads it off the
      screen; a choice is sent only while the same menu is still there. -->
 <div class="terminal-prompt" role="group" :aria-label="ct('終端機在等你選擇')">
  <div class="tp-head"><f7-icon f7="exclamationmark_bubble" :size="16"/>{{ct('終端機在等你選擇')}}</div>
  <div v-if="prompt.title" class="tp-title">{{prompt.title}}</div>
  <div v-if="prompt.body" class="tp-body">{{prompt.body}}</div>
  <div class="tp-options">
   <button v-for="(o,i) in prompt.options" :key="i" type="button" class="tp-option" :class="{current:i===prompt.selected}" :disabled="busy" @click="choose(i)">
    <span>{{o.label}}</span><small v-if="o.detail">{{o.detail}}</small>
   </button>
  </div>
  <div class="tp-foot">
   <button type="button" class="tp-link" :disabled="busy" @click="cancel">{{ct('取消（Esc）')}}</button>
   <button v-if="canOpen" type="button" class="tp-link" @click="$emit('open-terminal')">{{ct('開啟終端機')}}</button>
  </div>
 </div>
</template>
<script setup>
import {ref} from 'vue';
import {ct} from '../js/agent-i18n.js';
const props=defineProps({prompt:{type:Object,required:true},send:{type:Function,required:true},canOpen:Boolean});
defineEmits(['open-terminal']);
const busy=ref(false);
async function go(body){if(busy.value)return;busy.value=true;try{await props.send({key:props.prompt.key,...body});}finally{busy.value=false;}}
const choose=index=>go({index});
const cancel=()=>go({cancel:true});
</script>
<style scoped>
.terminal-prompt{margin:10px 16px 16px;padding:12px 14px;border-radius:16px;border:1px solid rgba(255,159,10,.55);background:rgba(255,159,10,.08);max-width:560px}
.tp-head{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#ff9f0a;margin-bottom:6px}
.tp-title{font-weight:600;margin-bottom:4px;overflow-wrap:anywhere}
.tp-body{font-size:13px;opacity:.75;white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px}
.tp-options{display:flex;flex-direction:column;gap:6px}
.tp-option{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;padding:9px 12px;border-radius:10px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.12);color:inherit;font:inherit;cursor:pointer}
.tp-option.current{border-color:#0a84ff}
.tp-option small{font-size:12px;opacity:.65}
.tp-option:disabled,.tp-link:disabled{opacity:.5;cursor:default}
.tp-foot{display:flex;gap:16px;margin-top:8px}
.tp-link{background:none;border:0;padding:4px 0;color:#0a84ff;font:inherit;font-size:14px;cursor:pointer}
</style>
