<template>
 <f7-link v-if="uxFeatures.desktopRail" icon-only class="rail-pin" :class="{disabled:busy}" :icon-f7="pinned?'pin_fill':'pin'" :aria-label="t(pinned?'uxRailUnpin':'uxRailPin')" :title="t(pinned?'uxRailUnpin':'uxRailPin')" :aria-pressed="String(pinned)" :aria-disabled="busy" @click="toggle"/>
</template>
<script setup>
import {ref,computed} from 'vue';
import {f7} from 'framework7-vue';
import {t} from '../js/i18n.js';
import {railPins,uxFeatures,saveListPreferences} from '../js/agentPreferences.js';
const props=defineProps({kind:String,id:String});
const busy=ref(false),pinned=computed(()=>railPins.value.some(p=>p.kind===props.kind&&p.id===props.id));
async function toggle(){
 if(busy.value)return;busy.value=true;
 const pins=railPins.value,next=pinned.value?pins.filter(p=>p.kind!==props.kind||p.id!==props.id):[...pins,{kind:props.kind,id:props.id}];
 try{await saveListPreferences({railPins:next});}catch(e){f7.dialog.alert(e.message||t('settingsFailed'));}finally{busy.value=false;}
}
</script>
<style scoped>
@media(max-width:1023px){.rail-pin {display:none!important;}}
</style>
