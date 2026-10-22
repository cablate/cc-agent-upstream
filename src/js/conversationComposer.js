// Reserve the actual composer height, including multiline text and staged files.
// F7 can initialize its messagebar before the sibling page-content is mounted.
export function measureComposer(page){
 if(!page)return;
 const bar=page.querySelector('.messagebar');
 page.style.setProperty('--conversation-composer-height',`${bar?.offsetHeight||0}px`);
}
export function bindConversationComposer(page){
 if(!page)return ()=>{};
 let bar;
 const content=()=>page.querySelector('.messages-content');
 const resize=new ResizeObserver(()=>{
  const el=content(),pinned=el&&el.scrollHeight-el.clientHeight-el.scrollTop<80;
  measureComposer(page);
  if(pinned)el.scrollTop=el.scrollHeight;
 });
 function bind(){const next=page.querySelector('.messagebar');if(next===bar)return;if(bar)resize.unobserve(bar);bar=next;if(bar){
  resize.observe(bar);
 }measureComposer(page);}
 const children=new MutationObserver(bind);children.observe(page,{childList:true});bind();
 return ()=>{resize.disconnect();children.disconnect();page.style.removeProperty('--conversation-composer-height');};
}
