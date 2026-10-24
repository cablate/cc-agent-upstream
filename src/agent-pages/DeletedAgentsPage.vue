<template>
 <!-- Deleted agents: when each will be purged by
      the setting, whether its Claude session survives that, restoring one to the
      Agents list, and keeping one past the setting. Only an admin deletes agents,
      so only an admin comes here. -->
 <f7-page name="deleted-agents" class="page-large-static" @page:afterin="load">
  <f7-navbar large>
   <f7-nav-left :back-link="true"></f7-nav-left>
   <f7-nav-title sliding>{{ct('已刪除的 Agent')}}</f7-nav-title>
   <f7-nav-title-large>{{ct('已刪除的 Agent')}}</f7-nav-title-large>
  </f7-navbar>
  <f7-block-footer class="deleted-policy">{{policy}}</f7-block-footer>
  <f7-block v-if="loading&&!agents.length" class="deleted-state"><f7-preloader/></f7-block>
  <f7-block v-else-if="error" class="deleted-state" role="alert">{{error}}</f7-block>
  <f7-block v-else-if="!agents.length" class="deleted-state">{{ct('沒有已刪除的 Agent')}}</f7-block>
  <f7-list v-else inset media-list class="deleted-list">
   <f7-list-item v-for="a in agents" :key="a.id" :data-id="a.id" :title="a.title">
    <template #media><div class="agent-avatar"><img v-if="a.avatar" :src="a.avatar" :class="'agent-avatar-'+avatarShape(a.avatar)" alt="" width="45" height="45"/><img v-else :src="defaultAvatar(a)" class="agent-avatar-icon" alt=""/></div></template>
    <template #subtitle>{{ct('刪除於')}} {{when(a.archivedAt)}}<span v-if="a.owner&&a.owner!==workspace?.user?.value?.id" class="deleted-owner"> · {{ct('帳號')}} {{a.ownerName||a.owner}}</span></template>
    <template #text>
     <span class="deleted-purge" :class="{due:!!a.purgeAt}">{{purgeText(a)}}</span>
     <span class="deleted-session">{{a.sessionSurvives?ct('原本的 session 不會被清掉'):ct('清除時 session 一起刪掉')}}</span>
    </template>
    <template #after>
     <div class="deleted-actions">
      <label v-if="retentionDays" class="deleted-keep"><span>{{ct('到期清除')}}</span><span class="toggle toggle-init"><input type="checkbox" :checked="!a.keep" :disabled="busy===a.id" :aria-label="ct('到期清除')+' '+a.title" @change="setKeep(a,!$event.target.checked)"/><span class="toggle-icon"></span></span></label>
      <div class="deleted-buttons">
       <f7-button small tonal class="deleted-restore" :class="{disabled:busy===a.id}" @click="restore(a)">{{ct('復原')}}</f7-button>
       <f7-button small tonal color="red" class="deleted-purge-now" :class="{disabled:busy===a.id}" @click="purge(a)">{{ct('永久刪除')}}</f7-button>
      </div>
     </div>
    </template>
   </f7-list-item>
  </f7-list>
 </f7-page>
</template>
<script setup>
import {timeLocale} from '../js/i18n.js';
import {ref,computed,inject} from 'vue';
import {f7} from 'framework7-vue';
import {api} from '../js/api.js';
import {ct} from '../js/agent-i18n.js';
import {avatarShape,defaultAvatar} from '../js/avatarShape.js';

const workspace=inject('workspace',null);
const agents=ref([]),retentionDays=ref(null),loading=ref(false),error=ref(''),busy=ref('');
const policy=computed(()=>retentionDays.value
 ?ct('目前設定：刪除')+' '+retentionDays.value+' '+ct('天後永久清除，session 也可能一起刪掉。按「復原」可以把 Agent 拉回清單；關掉「到期清除」就一直保留。')
 :ct('目前設定：不自動清除。按「復原」可以把 Agent 拉回清單，接回原本的 session。'));
const when=iso=>iso?new Date(iso).toLocaleString(timeLocale(),{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
// Past due, it goes at the next sweep, which runs every six hours.
const purgeText=a=>!a.purgeAt?ct('不會自動清除'):Date.parse(a.purgeAt)<=Date.now()?ct('已到期，6 小時內永久清除'):ct('將於')+' '+when(a.purgeAt)+' '+ct('永久清除');
function absorb(r){agents.value=r.agents||[];retentionDays.value=Number.isInteger(r.retentionDays)?r.retentionDays:null;}
async function load(){
 loading.value=true;error.value='';
 try{absorb(await api('/archived-agents'));}catch(e){error.value=e.message;}
 finally{loading.value=false;}
}
async function setKeep(a,keep){
 busy.value=a.id;
 try{absorb(await api('/archived-agents/'+a.id+'/keep',{method:'POST',body:JSON.stringify({keep})}));}
 catch(e){f7.dialog.alert(e.message);await load();}
 finally{busy.value='';}
}
// Now rather than when due, after saying what goes; the session with it unless
// the agent was taken over from an existing one.
function purge(a){
 const what=ct('會立刻刪掉它在平台上的聊天紀錄、工作資料夾、附件和圖像')+(!a.sessionSurvives?ct('，連同它的 Claude session。'):a.generation>1?ct('；原本的 session 不會被刪，但換代後的 session 會一起刪掉。'):ct('；原本的 session 不會被刪。'))+'\n'+ct('刪了就無法復原。');
 f7.dialog.confirm(what,ct('永久刪除')+'「'+a.title+'」',async()=>{
  busy.value=a.id;
  try{absorb(await api('/archived-agents/'+a.id+'/purge',{method:'POST',body:'{}'}));f7.toast.create({text:ct('已永久刪除')+'「'+a.title+'」',closeTimeout:2200}).open();}
  catch(e){f7.dialog.alert(e.message);await load();}
  finally{busy.value='';}
 });
}
function restore(a){
 f7.dialog.confirm(ct('復原後會回到 Agents 清單，先是暫停狀態；按啟動就接回原本的 session。'),ct('復原')+'「'+a.title+'」',async()=>{
  busy.value=a.id;
  try{
   await api('/archived-agents/'+a.id+'/restore',{method:'POST',body:'{}'});
   f7.toast.create({text:ct('已復原')+'「'+a.title+'」',closeTimeout:2200}).open();
   // The Agents list shows it at once rather than at its next poll.
   const list=await api('/conversations').catch(()=>null);
   if(list&&workspace?.conversations)workspace.conversations.value=list.conversations;
   await load();
  }catch(e){f7.dialog.alert(e.message);}
  finally{busy.value='';}
 });
}
</script>
<style scoped>
.deleted-state {text-align:center;color:var(--cc-color-text-secondary);}
.deleted-list :deep(.item-text) {display:flex;flex-direction:column;gap:2px;-webkit-line-clamp:unset;max-height:none;}
.deleted-purge {color:var(--cc-color-text-secondary);}
.deleted-purge.due {color:#ff9f0a;}
.deleted-session {font-size:12px;color:var(--cc-color-text-tertiary);}
.deleted-actions {display:flex;flex-direction:column;align-items:flex-end;gap:8px;}
.deleted-keep {display:flex;align-items:center;gap:6px;font-size:12px;color:var(--cc-color-text-secondary);}
.deleted-buttons {display:flex;gap:6px;}
.deleted-restore,.deleted-purge-now {width:auto;}
.agent-avatar {width:45px;height:45px;display:flex;align-items:center;justify-content:center;border-radius:12px;overflow:hidden;background:var(--cc-glass-fill-subtle);}
.agent-avatar-photo {width:100%;height:100%;object-fit:cover;}
.agent-avatar-icon {width:76%;height:76%;object-fit:contain;}
.agent-avatar-unknown {width:76%;height:76%;visibility:hidden;}
</style>
