<template>
 <!-- What was said, found by the server across every page of one's conversations,
      or of one of them. A tap opens the
      conversation at that message. The matched words are marked without HTML. -->
 <div v-if="active" class="message-search-results">
  <f7-block-title v-if="heading">{{ct('聊天記錄')}}</f7-block-title>
  <f7-block v-if="error" class="message-search-state" role="alert">{{error}}</f7-block>
  <f7-block v-else-if="loading&&!hits.length" class="message-search-state"><f7-preloader :size="20"/></f7-block>
  <f7-block v-else-if="!hits.length" class="message-search-state">{{ct('聊天記錄裡找不到')}}</f7-block>
  <f7-list v-else inset media-list class="message-search-list">
   <f7-list-item v-for="h in hits" :key="h.messageId" link="#" :data-message-id="h.messageId" @click="$emit('pick',h)">
    <template #title><span class="message-search-who">{{h.role==='user'?ct('你'):h.role==='relay'?(h.relay?.direction==='out'?ct('傳給 '):ct('來自 '))+(h.relay?.peerName||''):h.title}}</span><span v-if="showTitle&&h.role==='relay'" class="message-search-agent"> · {{h.title}}</span><span v-if="showTitle&&h.role==='user'" class="message-search-agent"> · {{h.title}}</span></template>
    <template #after>{{when(h.at)}}</template>
    <template #text><span class="message-search-snippet"><template v-for="(part,i) in parts(h.snippet)" :key="i"><mark v-if="part.hit">{{part.text}}</mark><template v-else>{{part.text}}</template></template></span></template>
   </f7-list-item>
  </f7-list>
  <f7-block-footer v-if="total>hits.length" class="message-search-more">{{searchTotal(total,hits.length)}}</f7-block-footer>
 </div>
</template>
<script setup>
import {ref,computed,watch,inject,onBeforeUnmount} from 'vue';
import {ct,searchTotal} from '../js/agent-i18n.js';
// searcher: a group's own search, in place of the conversations'.
const props=defineProps({query:{type:String,default:''},conversationId:String,showTitle:Boolean,heading:Boolean,searcher:Function});
defineEmits(['pick']);
const workspace=inject('workspace');
const hits=ref([]),total=ref(0),loading=ref(false),error=ref('');
// One character of Chinese says something; one Latin letter matches everything.
const words=computed(()=>props.query.trim());
const active=computed(()=>words.value.length>=2||/[^\x00-\x7f]/.test(words.value));
let timer=null,asked=0;
async function run(){
 const run=++asked,q=words.value;
 if(!active.value){hits.value=[];total.value=0;loading.value=false;error.value='';return;}
 loading.value=true;error.value='';
 try{
  const r=props.searcher?await props.searcher(q):await workspace.searchMessages(q,props.conversationId);
  if(run!==asked)return;
  hits.value=r.results||[];total.value=r.total||0;
 }catch(e){if(run===asked){error.value=e.message;hits.value=[];total.value=0;}}
 finally{if(run===asked)loading.value=false;}
}
watch(()=>[words.value,props.conversationId],()=>{clearTimeout(timer);timer=setTimeout(run,250);},{immediate:true});
onBeforeUnmount(()=>{clearTimeout(timer);asked++;});
const when=iso=>{
 if(!iso)return '';
 const d=new Date(iso),today=new Date();
 const sameDay=d.toDateString()===today.toDateString();
 return sameDay?d.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false}):d.toLocaleDateString('zh-TW',{month:'numeric',day:'numeric'});
};
// The snippet in pieces, each searched word marked wherever it appears, spaces
// inside it or not, as the server matched it.
const escape=c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function parts(text){
 const list=[...new Set(words.value.toLowerCase().split(/\s+/).filter(Boolean))].sort((a,b)=>b.length-a.length);
 if(!list.length)return [{text,hit:false}];
 const find=new RegExp(list.map(w=>Array.from(w).map(escape).join('\\s*')).join('|'),'giu');
 const out=[];let at=0;
 for(const m of text.matchAll(find)){
  if(!m[0])continue;
  if(m.index>at)out.push({text:text.slice(at,m.index),hit:false});
  out.push({text:m[0],hit:true});at=m.index+m[0].length;
 }
 if(at<text.length)out.push({text:text.slice(at),hit:false});
 return out;
}
</script>
<style scoped>
.message-search-state {text-align:center;color:var(--cc-color-text-secondary);}
.message-search-list :deep(.item-text) {-webkit-line-clamp:3;max-height:none;}
.message-search-who {font-weight:600;}
.message-search-agent {font-weight:400;color:var(--cc-color-text-secondary);}
.message-search-snippet mark {background:color-mix(in srgb,#ff9f0a 35%,transparent);color:inherit;border-radius:3px;padding:0 1px;}
.message-search-more {text-align:center;}
</style>
