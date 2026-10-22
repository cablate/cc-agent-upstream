<template>
 <!-- The first page of the Agents tab: the app
      opens here, looks for a tapped notification, and only then goes to the list or
      straight into that conversation, so the list is never shown on the way. -->
 <f7-page name="start" class="start-page" :page-content="false">
  <div class="start-page__wait"><f7-preloader :size="28"/></div>
 </f7-page>
</template>
<style>
.start-page__wait {position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
</style>
