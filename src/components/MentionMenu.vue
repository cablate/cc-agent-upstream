<template>
 <!-- The agents "@" offers, over the composer where the slash menu shows. -->
 <div class="slash-menu mention-menu" role="listbox" :aria-label="ct('提及 agent')" @mousedown.prevent>
  <template v-for="(item,index) in items" :key="item.id"><div v-if="item.section&&item.section!==items[index-1]?.section" class="mention-section">{{item.section}}</div><button type="button" role="option" class="slash-item mention-item" :class="{active:index===active,disabled:item.disabled}" :aria-selected="String(index===active)"
   @mouseenter="$emit('hover',index)" @click="$emit('pick',item)">
   <span class="slash-line"><span v-if="item.group||item.everyone" class="mention-avatar mention-group-icon"><i class="icon f7-icons">person_3_fill</i></span><img v-else class="mention-avatar" :src="item.avatar||defaultAvatar(item)" alt=""/><b>{{item.title}}</b><span v-if="item.note" class="slash-kind">{{item.note}}</span></span>
  </button></template>
 </div>
</template>
<script setup>
import {watch,nextTick,getCurrentInstance} from 'vue';
import {ct} from '../js/agent-i18n.js';
import {defaultAvatar} from '../js/avatarShape.js';
const props=defineProps({items:{type:Array,default:()=>[]},active:{type:Number,default:0}});
defineEmits(['pick','hover']);
const instance=getCurrentInstance();
watch(()=>props.active,()=>nextTick(()=>instance?.proxy?.$el?.querySelector?.('.slash-item.active')?.scrollIntoView({block:'nearest'})));
</script>
<style scoped>
.slash-menu {--slash-bottom:calc(var(--conversation-composer-lift,0px) + var(--conversation-composer-height,calc(var(--f7-messagebar-height,56px) + var(--f7-safe-area-bottom,0px))) + 8px);
 position:absolute;left:12px;right:12px;bottom:var(--slash-bottom);z-index:140;max-width:420px;
 max-height:min(52vh,420px,calc(100% - var(--slash-bottom) - var(--f7-navbar-height,44px) - var(--f7-safe-area-top,0px) - 8px));
 overflow-y:auto;overscroll-behavior:contain;padding:6px;border-radius:16px;box-sizing:border-box;
 background:color-mix(in srgb,var(--cc-color-page) 88%,var(--cc-color-text) 12%);box-shadow:0 8px 28px rgba(0,0,0,.35);}
.slash-item {display:flex;width:100%;padding:8px 10px;border:0;border-radius:10px;background:none;color:var(--cc-color-text);text-align:left;cursor:pointer;font:inherit;}
.slash-item.active {background:color-mix(in srgb,currentColor 12%,transparent);}
.slash-item.disabled {opacity:.45;cursor:default;}
.slash-line {display:flex;align-items:center;gap:10px;min-width:0;width:100%;font-size:15px;}
.slash-line b {font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mention-section {padding:8px 10px 3px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--cc-color-text-secondary);text-transform:uppercase;}
.mention-group-icon {display:inline-flex;align-items:center;justify-content:center;background:rgba(10,132,255,.2);color:#0a84ff;}
.mention-group-icon .icon {font-size:15px;}
.mention-avatar {flex:0 0 auto;width:26px;height:26px;border-radius:7px;object-fit:cover;}
.slash-kind {margin-left:auto;flex:0 0 auto;padding:1px 7px;border-radius:8px;font-size:11px;color:var(--cc-color-text-secondary);background:color-mix(in srgb,currentColor 12%,transparent);}
</style>
