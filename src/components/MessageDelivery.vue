<template>
 <span v-if="label" class="message-delivery" :data-delivery="message.delivery"> · {{t(label)}}</span>
</template>
<script setup>
import {computed} from 'vue';
import {t} from '../js/i18n.js';
const props=defineProps({message:{type:Object,required:true}});
const labels={queued:'uxChatQueued',delivered:'uxChatDelivered',completed:'uxChatReplied',interrupted:'uxChatInterrupted',unanswered:'uxChatUnanswered'};
const label=computed(()=>props.message.role==='user'&&!props.message.imported&&!props.message.schedule&&!props.message.limitResume&&!props.message.wrapUp&&!props.message.speaker?labels[props.message.delivery]:null);
</script>
<style scoped>
.message-delivery {font-size:12px;}
</style>
