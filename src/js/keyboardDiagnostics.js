import {ref} from 'vue';
// Explicitly started, memory-only geometry trace. No text, identifiers or network.
export const keyboardTrace=ref('');
let deadline=0,started=0,rows=[],last='';
export function startKeyboardTrace(){started=performance.now();deadline=started+30000;rows=[];last='';keyboardTrace.value='Waiting for chat input focus (30 seconds)…';}
const round=n=>Math.round(n*10)/10;
export function bindKeyboardTrace(page){
 let frame,until=0;
 function sample(){
  const now=performance.now();if(now>deadline||now>until)return;
  const vv=window.visualViewport;
  const box=el=>{if(!el)return null;const r=el.getBoundingClientRect();return [round(r.top),round(r.bottom),round(r.height)];};
  const ancestors=[];for(let el=page;el;el=el.parentElement)ancestors.push([round(el.scrollTop),round(el.getBoundingClientRect().top)]);
  const row={vv:vv?[round(vv.height),round(vv.offsetTop),round(vv.pageTop),round(vv.scale)]:null,
   window:[round(window.innerHeight),round(window.scrollY)],page:box(page),nav:box(page.querySelector('.navbar')),
   composer:box(page.querySelector('.messagebar')),editor:box(page.querySelector('[contenteditable]')),
   ancestors};
  const encoded=JSON.stringify(row);
  if(encoded!==last){last=encoded;rows.push({ms:Math.round(now-started),...row});if(rows.length>120)rows.shift();
   keyboardTrace.value=JSON.stringify({units:'CSS px; boxes=[top,bottom,height]; vv=[height,offsetTop,pageTop,scale]; ancestors=[scrollTop,top]',samples:rows},null,2);}
  frame=requestAnimationFrame(sample);
 }
 function wake(){if(performance.now()>deadline)return;until=Math.min(deadline,performance.now()+2000);cancelAnimationFrame(frame);sample();}
 page.addEventListener('focusin',wake);page.addEventListener('focusout',wake);window.visualViewport?.addEventListener('resize',wake);
 return ()=>{cancelAnimationFrame(frame);page.removeEventListener('focusin',wake);page.removeEventListener('focusout',wake);window.visualViewport?.removeEventListener('resize',wake);};
}
