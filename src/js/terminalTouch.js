// Feed touch scrolling through xterm's wheel handler, including tmux mouse mode.
// Scrolling only the local DOM viewport misses tmux's alternate-screen history.
export function bindTerminalTouch(host) {
  let gesture=null, suppressClickUntil=0;
  function start(event) {
    gesture=null;
    if(event.touches.length!==1)return;
    const t=event.touches[0];
    if(t.clientX<24)return; // Framework7's edge-swipe back gesture.
    gesture={id:t.identifier,x:t.clientX,y:t.clientY,lastY:t.clientY,dragging:false,
      target:host.querySelector('.xterm-screen')};
  }
  function move(event) {
    if(!gesture)return;
    if(event.touches.length!==1){gesture=null;return;}
    const t=Array.from(event.touches).find(t=>t.identifier===gesture.id);
    if(!t)return;
    const dx=t.clientX-gesture.x,dy=t.clientY-gesture.y;
    if(!gesture.dragging){
      if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;
      if(Math.abs(dx)>Math.abs(dy)){gesture=null;return;}
      gesture.dragging=true;
    }
    if(!gesture.target)return;
    event.preventDefault();event.stopPropagation();
    const deltaY=gesture.lastY-t.clientY;gesture.lastY=t.clientY;
    if(!deltaY)return;
    const rect=gesture.target.getBoundingClientRect();
    const Wheel=host.ownerDocument.defaultView.WheelEvent;
    gesture.target.dispatchEvent(new Wheel('wheel',{bubbles:true,cancelable:true,deltaMode:0,deltaY,
      clientX:Math.max(rect.left+1,Math.min(rect.right-1,t.clientX)),
      clientY:Math.max(rect.top+1,Math.min(rect.bottom-1,t.clientY))}));
  }
  function end(){if(gesture?.dragging)suppressClickUntil=Date.now()+500;gesture=null;}
  function click(event){if(Date.now()<suppressClickUntil){event.preventDefault();event.stopPropagation();}}
  const options={capture:true,passive:false};
  host.addEventListener('touchstart',start,options);
  host.addEventListener('touchmove',move,options);
  host.addEventListener('touchend',end,options);
  host.addEventListener('touchcancel',end,options);
  host.addEventListener('click',click,true);
  return ()=>{gesture=null;for(const [type,fn] of [['touchstart',start],['touchmove',move],['touchend',end],['touchcancel',end],['click',click]])host.removeEventListener(type,fn,true);};
}
