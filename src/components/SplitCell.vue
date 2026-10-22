<template>
 <!-- One conversation in a split-view cell, drawn by the page itself rather than a
      whole copy of the app in a frame (several
      frames each booting the app and asking the server on their own made the view
      slow). The same bubbles as the conversation page, a composer that sends and
      interrupts, and older turns on scrolling up. Files go with a message as on
      the conversation page: the button, or dropped on the cell. -->
 <div ref="root" class="split-conversation" @keydown.esc="onEscape" :class="{'with-terminal':terminal&&wide,'terminal-only':terminal&&!wide}" :style="terminal&&wide?{'--terminal-share':(share*100).toFixed(2)+'%'}:null">
  <div class="split-chat" @dragover.prevent @drop.prevent="dropFiles" @paste="pasteFiles">
  <div ref="scroller" class="split-scroll" @scroll.passive="onScroll">
   <p v-if="failed" class="split-failed" role="alert">{{failed}}</p>
   <MessageList v-if="detail" :messages="detail.messages" :conversation-id="conversationId" :has-older="detail.hasOlder" :older-busy="olderBusy"
    :avatar="detail.avatar||defaultAvatar(detail)" :background-text="backgroundText" :typing="typing" :typing-text="typingText" :typing-note="typingNote"
    :interruptible="canInterrupt" :interrupting="interrupting"
    :empty-text="ct('說明你的目標、背景，或想釐清的問題。')" @load-older="loadOlder" @preview="preview=$event" @interrupt="interrupt"/>
   <div v-else-if="!failed" class="split-loading"><f7-preloader/></div>
   <!-- A menu waiting in the agent's terminal is answered here too, as on the
        conversation page; otherwise the chat would show only the agent at work. -->
   <TerminalPromptCard v-if="detail?.terminalPrompt" :key="detail.terminalPrompt.key" :prompt="detail.terminalPrompt" :send="chooseTerminal" :can-open="false"/>
  </div>
  <div v-if="files.length" class="split-drafts" :aria-label="ct('附件')">
   <f7-preloader v-if="sending" :size="18"/>
   <div v-for="file in files" :key="file.key" class="split-draft">
    <a href="#" :title="file.name" @click.prevent="preview={name:file.name,size:file.size,local:file.file}"><span>{{file.name}}</span><small>{{file.size<1024?file.size+' B':(file.size/1024).toFixed(1)+' KB'}}</small></a>
    <button type="button" :disabled="sending" :aria-label="ct('移除附件')+' '+file.name" @click="removeFile(file.key)"><i class="icon f7-icons">xmark_circle_fill</i></button>
   </div>
  </div>
  <input ref="fileInput" type="file" multiple hidden @change="pickFiles"/>
  <form class="split-composer" @submit.prevent="send">
   <button type="button" class="split-action attach" :disabled="sending" :aria-label="ct('加入附件')" @click="chooseFiles"><i class="icon f7-icons">plus</i></button>
   <textarea ref="box" v-model="draft" rows="1" :placeholder="ct('輸入訊息…')" :aria-label="ct('輸入訊息…')" @keydown.enter="onEnter" @input="grow"/>
   <button type="submit" class="split-action send" :disabled="!canSend" :aria-label="ct('送出訊息')"><i class="icon f7-icons">arrow_up</i></button>
  </form>
  </div>
  <!-- The cell's terminal: beside the conversation, half each to start with and a
       divider to share them, in a cell wide enough; instead of it in a narrow one. -->
  <div v-if="terminal&&wide" class="split-cell-divider" role="separator" aria-orientation="vertical" :aria-label="ct('拖曳調整聊天室與終端機寬度')" @pointerdown.stop="startResize"/>
  <div v-if="terminal" class="split-terminal"><TerminalPane :key="detail?.sessionId||conversationId" :conversation-id="conversationId"/></div>
  <AttachmentPreview :file="preview" :conversation-id="conversationId" @close="preview=null" @change="preview=$event"/>
 </div>
</template>
<script setup>
import {ref,computed,watch,nextTick,onMounted,onUnmounted} from 'vue';
import MessageList from './MessageList.vue';
import TerminalPromptCard from './TerminalPromptCard.vue';
import TerminalPane from '../TerminalPane.vue';
import AttachmentPreview from './AttachmentPreview.vue';
import {api} from '../js/api.js';
import {defaultAvatar} from '../js/avatarShape.js';
import {ct} from '../js/agent-i18n.js';
import {shouldSendOnEnter} from '../js/chatKeyboard.js';
import * as status from '../js/conversationStatus.js';
import {useAttachmentDrafts} from '../js/attachmentDrafts.js';
import {f7} from 'framework7-vue';

const props=defineProps({conversationId:{type:String,required:true},terminal:Boolean});
// Wide enough for the terminal beside the conversation, and each side's share.
const root=ref(null),wide=ref(false),SIDE_BY_SIDE=720,SHARE_KEY='cc-terminal-share-cell';
const share=ref((()=>{try{const n=Number(localStorage.getItem(SHARE_KEY));return Number.isFinite(n)&&n>=.2&&n<=.8?n:.5;}catch{return .5;}})());
let sizeWatch=null;
function startResize(event){
 const handle=event.currentTarget,rect=root.value?.getBoundingClientRect();if(!rect)return;
 event.preventDefault();try{handle.setPointerCapture(event.pointerId);}catch{}
 document.body.classList.add('col-resizing');
 const move=e=>{share.value=Math.min(.8,Math.max(.2,(rect.right-e.clientX)/rect.width));};
 const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);document.body.classList.remove('col-resizing');try{localStorage.setItem(SHARE_KEY,share.value.toFixed(4));}catch{}};
 handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
}
const PAGE=10,WINDOW_MAX=200,POLL_MS=1500;
const detail=ref(null),draft=ref(''),sending=ref(false),interrupting=ref(false),olderBusy=ref(false),failed=ref(''),preview=ref(null);
const scroller=ref(null),box=ref(null),atBottom=ref(true);
// The conversation page's own drafts: kept per conversation, uploaded when sent.
const attachmentDrafts=useAttachmentDrafts(computed(()=>props.conversationId),ref(null),sending,ct);
const {files,fileInput,pickFiles,dropFiles,pasteFiles,removeFile,chooseFiles}=attachmentDrafts;

// A cell has no bar under a navbar, so a turn it did not start (from the terminal,
// say) shows in the typing bubble too, with the button that stops it.
const typing=computed(()=>status.awaitingReply(detail.value)||!detail.value?.compacting&&!!status.progressText(detail.value));
const typingText=computed(()=>typing.value?status.progressText(detail.value):'');
const typingNote=computed(()=>typing.value?status.progressNote(detail.value):'');
const backgroundText=computed(()=>status.backgroundText(detail.value));
const canSend=computed(()=>!!(draft.value.trim()||files.value.length)&&!sending.value&&(detail.value?.phase==='ready'||detail.value?.phase==='busy'&&!detail.value?.compacting));
const canInterrupt=computed(()=>detail.value?.mode==='claude'&&detail.value?.phase==='busy'&&!detail.value?.compacting&&!status.settlingAfterReply(detail.value));

function toBottom(){nextTick(()=>{const el=scroller.value;if(el)el.scrollTop=el.scrollHeight;});}
// The newest page, with the older ones already loaded kept in front of it, as the
// conversation page does.
function merge(local,fresh){
 if(!local?.length)return fresh;
 const seam=fresh[0]?local.findIndex(m=>m.id===fresh[0].id):-1;
 return seam<0?fresh:[...local.slice(0,seam),...fresh];
}
let fetching=false,timer=null,disposed=false;
async function refresh(){
 if(fetching||disposed)return;fetching=true;
 try{
  const shown=detail.value?.messages?.length||0;
  const d=await api(`/conversations/${props.conversationId}?limit=${Math.min(WINDOW_MAX,Math.max(PAGE,shown))}${document.hidden?'':'&viewing=1'}`);
  if(disposed)return;
  const merged=merge(detail.value?.messages,d.messages||[]);
  const changed=merged.at(-1)?.id!==detail.value?.messages?.at(-1)?.id||merged.length!==detail.value?.messages?.length;
  const first=!detail.value;
  detail.value={...d,messages:merged,hasOlder:merged.length>(d.messages||[]).length?(detail.value?.hasOlder??d.hasOlder):d.hasOlder};
  failed.value='';
  if(first||changed&&atBottom.value)toBottom();
 }catch(e){failed.value=e.message||ct('無法載入這個 Agent');}
 finally{fetching=false;}
}
function onScroll(){
 const el=scroller.value;if(!el)return;
 atBottom.value=el.scrollHeight-el.scrollTop-el.clientHeight<80;
 if(el.scrollTop<300)loadOlder();
}
// Older turns go in above the reader, who stays on the same bubble.
async function loadOlder(){
 const d=detail.value,el=scroller.value;
 if(olderBusy.value||!d?.hasOlder||!d.messages.length||!el)return;
 olderBusy.value=true;
 try{
  const older=await api(`/conversations/${props.conversationId}?limit=${PAGE}&before=${encodeURIComponent(d.messages[0].id)}`);
  if(disposed||detail.value!==d)return;
  const height=el.scrollHeight,top=el.scrollTop;
  const known=new Set(d.messages.map(m=>m.id));
  detail.value={...d,messages:[...(older.messages||[]).filter(m=>!known.has(m.id)),...d.messages],hasOlder:older.hasOlder};
  await nextTick();el.scrollTop=top+(el.scrollHeight-height);
 }catch{}finally{olderBusy.value=false;}
}
function grow(){const el=box.value;if(!el)return;el.style.height='auto';el.style.height=Math.min(el.scrollHeight,140)+'px';}
function onEnter(event){if(!shouldSendOnEnter(event,f7.device))return;event.preventDefault();send();}
async function send(){
 if(!canSend.value)return;
 const id=props.conversationId,text=draft.value,items=[...files.value],requestId=attachmentDrafts.requestId(id,text,items);sending.value=true;
 try{
  const attachmentIds=await attachmentDrafts.upload(id,items);
  await api(`/conversations/${id}/messages`,{method:'POST',body:JSON.stringify({text,requestId,attachmentIds})});
  attachmentDrafts.sent(id,items);
  if(draft.value===text){draft.value='';nextTick(grow);}
  atBottom.value=true;await refresh();toBottom();
 }catch(e){f7.dialog.alert(e.message);}
 finally{sending.value=false;}
}
async function interrupt(){
 if(interrupting.value)return;interrupting.value=true;
 try{await api(`/conversations/${props.conversationId}/interrupt`,{method:'POST',body:'{}'});await refresh();}
 catch(e){f7.dialog.alert(e.message);}
 finally{interrupting.value=false;}
}
// Esc in a cell stops that cell's turn, as on the conversation page; not in its
// terminal, which passes Esc to Claude, nor while composing in an input method.
function onEscape(event){
 if(event.isComposing||event.keyCode===229||event.target?.closest?.('.split-terminal')||!canInterrupt.value)return;
 event.preventDefault();interrupt();
}
// A typing bubble coming, changing its line or going keeps a reader at the bottom there.
watch([typing,typingText,typingNote,backgroundText,()=>detail.value?.terminalPrompt?.key],()=>{if(atBottom.value)toBottom();},{flush:'post'});
async function chooseTerminal(body){try{await api(`/conversations/${props.conversationId}/terminal-choice`,{method:'POST',body:JSON.stringify(body)});}finally{await refresh();}}
onMounted(()=>{
 refresh();timer=setInterval(()=>{if(!document.hidden)refresh();},POLL_MS);
 sizeWatch=new ResizeObserver(([entry])=>{wide.value=entry.contentRect.width>=SIDE_BY_SIDE;});sizeWatch.observe(root.value);
});
onUnmounted(()=>{disposed=true;clearInterval(timer);sizeWatch?.disconnect();});
</script>

<style scoped>
.split-conversation {position:relative;flex:1;min-height:0;display:flex;}
.split-chat {flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
.split-terminal {min-width:0;min-height:0;display:flex;flex-direction:column;background:#121212;}
.split-terminal :deep(.terminal-pane) {flex:1;min-height:0;}
.with-terminal .split-terminal {flex:0 0 var(--terminal-share,50%);border-left:1px solid color-mix(in srgb,currentColor 14%,transparent);}
.terminal-only .split-chat {display:none;}
.terminal-only .split-terminal {flex:1;}
.split-cell-divider {position:absolute;top:0;bottom:0;right:calc(var(--terminal-share,50%) - 6px);width:12px;z-index:30;cursor:col-resize;touch-action:none;}
.split-scroll {flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 0 10px;}
.split-scroll :deep(.messages) {min-height:0;}
.split-loading {display:flex;justify-content:center;padding:32px 0;}
.split-failed {margin:16px;color:var(--cc-color-text-secondary);}
.split-composer {flex:0 0 auto;display:flex;align-items:flex-end;gap:6px;padding:8px 10px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);}
.split-composer textarea {flex:1;min-width:0;min-height:36px;max-height:140px;box-sizing:border-box;resize:none;padding:8px 14px;border:0;border-radius:18px;background:var(--f7-message-received-bg-color,#2c2c2e);color:inherit;font:inherit;font-size:15px;line-height:1.35;outline:none;}
.split-action {flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:0;border-radius:18px;background:color-mix(in srgb,currentColor 12%,transparent);color:inherit;cursor:pointer;}
.split-action:disabled {opacity:.35;cursor:default;}
.split-action .icon {font-size:20px;}
.split-action.attach {background:none;}
.split-drafts {flex:0 0 auto;display:flex;align-items:center;gap:8px;overflow-x:auto;padding:8px 10px 0;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);}
.split-drafts + input + .split-composer {border-top:0;}
.split-draft {display:flex;align-items:center;gap:6px;flex:0 0 auto;max-width:220px;border-radius:var(--cc-radius-card,16px);padding:6px 6px 6px 10px;background:var(--cc-glass-fill-subtle);color:var(--cc-color-text);font-size:13px;}
.split-draft a {flex:1 1 auto;min-width:0;display:flex;flex-direction:column;color:inherit;text-decoration:none;}
.split-draft span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.split-draft small {color:var(--cc-color-text-secondary);}
.split-draft button {flex:0 0 auto;display:flex;width:auto;border:0;padding:0;background:none;color:var(--cc-color-text-secondary);cursor:pointer;}
.split-draft button .icon {font-size:18px;}
</style>
