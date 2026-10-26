<template><section class="terminal-pane">
 <!-- One slim line: the state, and right after it a small icon to attach again at any
      time, such as when the screen looks stuck. A full-width button took a band of
      the screen, and the note under the terminal is gone too. -->
 <div class="terminal-bar"><span class="terminal-status" :class="{on:status==='終端已連線'}" role="status">{{ct(status)}}</span><f7-link class="terminal-reattach" icon-only icon-f7="arrow_clockwise" :aria-label="ct('重新附接')" :title="ct('重新附接')" @click="connect"/></div>
 <!-- Keys a phone keyboard does not have, for Claude Code's menus: Esc to back out,
       arrows to choose, Shift+Tab for the mode (a
       slash command opened the terminal and nothing could close its menu). They
       send without taking the focus, so the keyboard stays where it was. -->
  <div v-if="touch" class="terminal-keys" role="toolbar" :aria-label="ct('終端機按鍵')"><button v-for="k in KEYS" :key="k.label" type="button" class="terminal-key" :aria-label="k.name" @pointerdown.prevent @mousedown.prevent @click="press(k.seq)">{{k.label}}</button></div>
 <div ref="host" class="terminal-host"/></section></template>
<script setup>
import {ct} from './js/agent-i18n.js';
import {bindTerminalTouch} from './js/terminalTouch.js';
import {ref,onMounted,onUnmounted} from 'vue';
import {Terminal} from '@xterm/xterm';import {FitAddon} from '@xterm/addon-fit';import '@xterm/xterm/css/xterm.css';
const props=defineProps({conversationId:String});
const KEYS=[{label:'Esc',name:'Esc',seq:'\x1b'},{label:'Tab',name:'Tab',seq:'\t'},{label:'⇧Tab',name:'Shift+Tab',seq:'\x1b[Z'},{label:'↑',name:'Up',seq:'\x1b[A'},{label:'↓',name:'Down',seq:'\x1b[B'},{label:'←',name:'Left',seq:'\x1b[D'},{label:'→',name:'Right',seq:'\x1b[C'},{label:'^C',name:'Ctrl+C',seq:'\x03'}];
const touch=typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches;
function press(seq){if(ws?.readyState===1)ws.send(JSON.stringify({type:'input',data:seq}));}const host=ref(null),status=ref('正在附接終端…');let term,fit,ws,observer,cleanupTouch,disposed=false;
// The view follows every change of size at once, and Claude is told the new size
// once it settles: a divider dragged across the screen would otherwise make Claude
// redraw its whole screen for every step of the drag.
let resizeTimer;
function resize(){if(!term||!host.value?.clientWidth||!host.value?.clientHeight)return;fit.fit();clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));},150);}
// A connection can die without a word: a phone puts the app away, a computer
// sleeps, a network changes, and the page kept the last screen as if still attached
// (the terminal sometimes stops updating). The
// server speaks at least every 15 s; nothing for 40 s means the line is gone, and
// the pane attaches again. Coming back to the front, it checks at once, and redraws
// a screen whose line is fine.
const QUIET_MS=40000;
let lastHeard=0,watchdog;
const silent=()=>Date.now()-lastHeard>=QUIET_MS;
function checkLine(){if(!disposed&&!document.hidden&&ws?.readyState===1&&silent())connect();}
function onVisible(){if(disposed||document.hidden)return;if(!ws||ws.readyState>1||silent())connect();else term?.refresh(0,term.rows-1);}
function connect(){if(disposed)return;const old=ws;ws=null;old?.close();term?.reset();status.value='正在附接終端…';lastHeard=Date.now();const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/terminal/${props.conversationId}`);ws=socket;
 socket.onopen=()=>{if(ws!==socket)return;status.value='終端已連線';resize();
  // On a phone focus raises the keyboard over half the screen at every open and
  // every reattach; a tap on the terminal still focuses it.
  if(!touch)term.focus();};
 socket.onmessage=e=>{if(ws!==socket)return;lastHeard=Date.now();const msg=JSON.parse(e.data);if(msg.type==='data')term.write(msg.data);else if(msg.type==='error')status.value=msg.message;};
 socket.onclose=()=>{if(ws===socket)status.value='終端已離線，可重新附接';};socket.onerror=()=>{if(ws===socket)status.value='附接失敗，請確認登入與 Claude 狀態';};
}
onMounted(()=>{term=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'Menlo, monospace',scrollback:5000,theme:{background:'#121212',foreground:'#ececec'},allowProposedApi:false});fit=new FitAddon();term.loadAddon(fit);term.open(host.value);
 // Drawn on the GPU where the device allows it: Claude's screen redraws in bursts,
 // which the DOM renderer draws slower, most of all on a phone. Anything wrong with
 // WebGL, at the start or later, leaves the DOM renderer drawing.
 import('@xterm/addon-webgl').then(({WebglAddon})=>{if(disposed||!term)return;try{const webgl=new WebglAddon();webgl.onContextLoss(()=>webgl.dispose());term.loadAddon(webgl);}catch{}}).catch(()=>{});
 cleanupTouch=bindTerminalTouch(host.value);term.onData(data=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'input',data}));});observer=new ResizeObserver(resize);observer.observe(host.value);connect();
 watchdog=setInterval(checkLine,5000);document.addEventListener('visibilitychange',onVisible);window.addEventListener('focus',onVisible);});
onUnmounted(()=>{disposed=true;clearTimeout(resizeTimer);clearInterval(watchdog);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',onVisible);cleanupTouch?.();observer?.disconnect();ws?.close();term?.dispose();});
</script>

<style scoped>
.terminal-pane {display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;}
.terminal-pane > .block,.terminal-pane > .block-footer {flex-shrink:0;margin-top:8px;margin-bottom:8px;}
/* The bar belongs to the terminal, which is dark in both themes: in the light one
   it sat as a pale strip on top of it. */
.terminal-bar {flex-shrink:0;display:flex;align-items:center;gap:6px;padding:6px 16px;font-size:13px;background:#121212;color:rgba(255,255,255,.6);}
.terminal-status {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px;}
.terminal-status::before {content:'';flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#8e8e93;}
.terminal-status.on::before {background:#34c759;}
.terminal-keys {flex-shrink:0;display:flex;gap:6px;padding:0 12px 6px;overflow-x:auto;scrollbar-width:none;background:#121212;}
.terminal-keys::-webkit-scrollbar {display:none;}
.terminal-key {flex:0 0 auto;width:auto;margin:0;display:inline-flex;align-items:center;justify-content:center;line-height:1;text-transform:none;min-width:34px;height:30px;padding:0 7px;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:rgba(255,255,255,.08);color:#ececec;font:13px Menlo,monospace;touch-action:manipulation;-webkit-user-select:none;user-select:none;}
.terminal-key:active {background:rgba(255,255,255,.25);}
.terminal-reattach {flex:0 0 auto;width:auto;min-width:0;height:auto;padding:0;color:inherit;}
.terminal-reattach :deep(.icon) {font-size:14px;}
/* The rows fill the height in whole lines; what is left under the last one takes
   the terminal's own background, not the page's (a darker strip under the terminal). xterm's own viewport spans that space too,
   black by its stylesheet, and the GPU renderer never paints it the theme's colour,
   so it is set here as well (the strip was still there). */
.terminal-host {flex:1;min-height:0;overflow:hidden;touch-action:pan-x pinch-zoom;overscroll-behavior:contain;background:#121212;}
.terminal-host :deep(.xterm) {height:100%;}
.terminal-host :deep(.xterm-viewport) {background-color:#121212;}
</style>
