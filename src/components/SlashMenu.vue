<template>
 <!-- The slash menu over the composer (js/slashMenu.js): Claude Code's own commands,
      marked as running in the terminal, and the agent's skills. -->
 <div class="slash-menu" role="listbox" :aria-label="ct('斜線指令')" @mousedown.prevent>
  <button v-for="(item,index) in items" :key="item.kind+':'+item.name" type="button" role="option" class="slash-item" :class="{active:index===active}" :aria-selected="String(index===active)"
   @mouseenter="$emit('hover',index)" @click="$emit('pick',item)">
   <span class="slash-line"><b>{{item.label||'/'+item.name}}</b><span v-if="item.hint" class="slash-hint">{{item.hint}}</span><span class="slash-kind" :class="item.kind">{{item.kind==='terminal'?ct('終端機'):item.kind==='option'?ct('選項'):ct('技能')}}</span></span>
   <span v-if="item.description" class="slash-description">{{item.description}}</span>
  </button>
 </div>
</template>
<script setup>
import {watch,nextTick,getCurrentInstance} from 'vue';
import {ct} from '../js/agent-i18n.js';
const props=defineProps({items:{type:Array,default:()=>[]},active:{type:Number,default:0}});
defineEmits(['pick','hover']);
// The chosen row stays in view as ↑/↓ move through a long list.
const instance=getCurrentInstance();
watch(()=>props.active,()=>nextTick(()=>instance?.proxy?.$el?.querySelector?.('.slash-item.active')?.scrollIntoView({block:'nearest'})));
</script>
<style scoped>
/* Just above the composer wherever it is: lifted over a phone's keyboard, and as
   tall as its text. The menu stayed at the page's foot, under the lifted composer
   and the keyboard, so it follows the same lift
   and fits between the navbar and the composer. The composer's height already
   includes the safe area. */
.slash-menu {--slash-bottom:calc(var(--conversation-composer-lift,0px) + var(--conversation-composer-height,calc(var(--f7-messagebar-height,56px) + var(--f7-safe-area-bottom,0px))) + 8px);
 position:absolute;left:12px;right:12px;bottom:var(--slash-bottom);z-index:140;max-width:560px;
 max-height:min(52vh,420px,calc(100% - var(--slash-bottom) - var(--f7-navbar-height,44px) - var(--f7-safe-area-top,0px) - var(--slash-top-extra,0px) - 8px));
 overflow-y:auto;overscroll-behavior:contain;padding:6px;border-radius:16px;box-sizing:border-box;
 background:color-mix(in srgb,var(--cc-color-page) 88%,var(--cc-color-text) 12%);box-shadow:0 8px 28px rgba(0,0,0,.35);}
.slash-item {display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%;padding:8px 10px;border:0;border-radius:10px;background:none;color:var(--cc-color-text);text-align:left;cursor:pointer;font:inherit;}
.slash-item.active {background:color-mix(in srgb,currentColor 12%,transparent);}
.slash-line {display:flex;align-items:baseline;gap:8px;min-width:0;font-size:14px;}
.slash-line b {font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;}
.slash-hint {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--cc-color-text-secondary);}
.slash-kind {margin-left:auto;flex:0 0 auto;padding:1px 7px;border-radius:8px;font-size:11px;color:var(--cc-color-text-secondary);background:color-mix(in srgb,currentColor 12%,transparent);}
.slash-kind.skill {color:#34c759;}
.slash-description {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--cc-color-text-secondary);}
</style>
