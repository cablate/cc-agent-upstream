<template>
  <!--
    First-entry DEFAULT state: #install-screen > .page.install-screen-page > .page-content
    > center.content-medium-width. Dark bg comes from body.dark (F7 dark page bg #121212).
    - .block-title-large#dev-mode-button is the install title/logo; tapping it 10 times
      sets localStorage.dev_mode='1' and bypasses to main.
    - #use-in-browser-button sets localStorage.in_browser='1' and enters the app.
  -->
  <div id="install-screen" style="height: 100%">
    <div class="page install-screen-page" style="display: block;">
      <div class="page-content">
        <center class="content-medium-width">
          <div class="block">
            <div style="text-align: center;">
              <div class="block-title block-title-large" id="dev-mode-button" @click="onTitleTap">
                <img :src="PRODUCT.installIcon" :alt="PRODUCT.name" style="width: 34px; height: 34px; vertical-align: middle; margin-right: 6px; position: relative; top: -3px;" />{{ PRODUCT.name }}
              </div>
              <br />
              <div class="block subtitle">
                {{ t('installSubtitle', { product: PRODUCT.name }) }}
              </div>
            </div>
          </div>
          <div class="list inset no-hairlines-between cc-grouped">
            <ul>
              <li v-for="step in steps[platform]" :key="step.text">
                <div class="item-content">
                  <div class="item-media">
                    <i style="font-size: 35px" class="f7-icons">{{ step.icon }}</i>
                  </div>
                  <div class="item-inner" style="text-align: start; white-space: normal;">
                    {{ t(step.text) }}
                  </div>
                </div>
              </li>
            </ul>
          </div>
          <br />
          <br />
          <center>
            <button
              class="col button button-outline button-round color-gray width-auto"
              id="use-in-browser-button"
              @click="$emit('use-in-browser')"
            >
              {{ t('installUseBrowser') }}
            </button>
          </center>
        </center>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { PRODUCT } from '../js/productConfig.js';
import { t } from '../js/i18n.js';

const emit = defineEmits(['use-in-browser', 'dev-mode']);
const ua = navigator.userAgent;
const platform = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'ios' : /Android/i.test(ua) ? 'android' : 'other';
const steps = {
  ios: [
    { icon: 'compass', text: 'installIosBrowser' },
    { icon: 'square_arrow_up', text: 'installIosShare' },
    { icon: 'plus_app', text: 'installIosAdd' },
  ],
  android: [
    { icon: 'globe', text: 'installAndroidBrowser' },
    { icon: 'ellipsis_vertical', text: 'installAndroidMenu' },
    { icon: 'plus_app', text: 'installAndroidAdd' },
  ],
  other: [
    { icon: 'globe', text: 'installOtherBrowser' },
    { icon: 'plus_app', text: 'installOtherAdd' },
  ],
};

// Easter egg: tapping the install title 10 times enables dev_mode and bypasses to main.
const taps = ref(0);
function onTitleTap() {
  taps.value += 1;
  if (taps.value >= 10) {
    try {
      localStorage.setItem('dev_mode', '1');
    } catch (e) {
      /* ignore */
    }
    emit('dev-mode');
  }
}
</script>
