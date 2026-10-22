export function shouldSendOnEnter(event,device={}) {
  return event.key==='Enter' && !device.ios && !device.android &&
    !event.isComposing && event.keyCode!==229 &&
    !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}
