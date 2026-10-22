// Checklists an agent keeps in its conversation:
// a workflow, to-dos, things still to verify. The agent and the owner both change
// them, one item at a time, and the page shows where each stands.
const {randomUUID}=require('node:crypto');

const STATUSES=['todo','doing','done','blocked'];
const MAX_LISTS=20,MAX_ITEMS=100,MAX_TITLE=80,MAX_TEXT=300,MAX_NOTE=500;
// All of an agent's lists together: they travel with every page refresh and to the
// agent, so they stay a working list, not a store.
const MAX_TOTAL=40000;
const size=lists=>lists.reduce((n,l)=>n+l.title.length+l.items.reduce((m,i)=>m+i.text.length+(i.note||'').length,0),0);

function fail(message){const e=new Error(message);e.status=400;return e;}
function text(value,max,label){
 if(typeof value!=='string'||!value.trim())throw fail(label+'不能是空的');
 const v=value.trim();if(v.length>max)throw fail(label+'最多 '+max+' 字');return v;
}
function note(value){
 if(value===undefined)return undefined;
 if(value===null||value==='')return '';
 if(typeof value!=='string')throw fail('說明要是文字');
 const v=value.trim();if(v.length>MAX_NOTE)throw fail('說明最多 '+MAX_NOTE+' 字');return v;
}
function status(value){
 if(value===undefined)return undefined;
 if(!STATUSES.includes(value))throw fail('狀態只能是 '+STATUSES.join('、'));return value;
}

// One change to one list: create it (no listId, a title), rename it, add, update or
// remove items, or delete it. by is 'agent' or 'owner', never taken from the body.
// Everything is checked before anything is changed, so a bad request changes nothing.
function apply(c,data,by){
 if(!data||typeof data!=='object')throw fail('內容不正確');
 const lists=c.checklists||(c.checklists=[]);
 const now=new Date().toISOString();
 let list;
 if(data.listId!==undefined&&data.listId!==null){
  list=lists.find(l=>l.id===data.listId);
  if(!list)throw fail('找不到這份清單');
  if(data.deleteList===true){c.checklists=lists.filter(l=>l!==list);return {deleted:list.id};}
 }else if(lists.length>=MAX_LISTS)throw fail('清單最多 '+MAX_LISTS+' 份');
 const title=data.title!==undefined?text(data.title,MAX_TITLE,'清單名稱'):undefined;
 if(!list&&title===undefined)throw fail('新清單要有名稱');
 const add=data.add===undefined?[]:Array.isArray(data.add)?data.add:null;
 const update=data.update===undefined?[]:Array.isArray(data.update)?data.update:null;
 const remove=data.remove===undefined?[]:Array.isArray(data.remove)?data.remove:null;
 if(!add||!update||!remove)throw fail('add、update、remove 要是陣列');
 if(add.length>MAX_ITEMS||update.length>MAX_ITEMS||remove.length>MAX_ITEMS)throw fail('一次最多改 '+MAX_ITEMS+' 項');
 const items=list?list.items:[];
 const added=add.map(x=>({id:randomUUID(),text:text(x?.text,MAX_TEXT,'項目'),status:status(x?.status)||'todo',note:note(x?.note)||'',by,updatedAt:now}));
 const changes=update.map(x=>{
  const item=items.find(i=>i.id===x?.id);if(!item)throw fail('找不到項目 '+String(x?.id).slice(0,40));
  return {item,text:x.text===undefined?undefined:text(x.text,MAX_TEXT,'項目'),status:status(x.status),note:note(x.note)};
 });
 for(const id of remove)if(!items.some(i=>i.id===id))throw fail('找不到項目 '+String(id).slice(0,40));
 // Counted on what would be left: the same id twice removes one item.
 const kept=items.filter(i=>!remove.includes(i.id));
 if(kept.length+added.length>MAX_ITEMS)throw fail('一份清單最多 '+MAX_ITEMS+' 項');
 const after=kept.map(i=>{const x=changes.find(ch=>ch.item===i);return x?{...i,text:x.text??i.text,note:x.note??i.note}:i;}).concat(added);
 if(size(lists.filter(l=>l!==list).concat({title:title??list?.title??'',items:after}))>MAX_TOTAL)throw fail('清單內容合計最多 '+MAX_TOTAL+' 字，請先刪掉用不到的項目或清單');
 if(!list){list={id:randomUUID(),title,items:[],createdAt:now,updatedAt:now};lists.push(list);}
 else if(title!==undefined)list.title=title;
 for(const {item,...next} of changes){
  for(const key of ['text','status','note'])if(next[key]!==undefined)item[key]=next[key];
  item.by=by;item.updatedAt=now;
 }
 list.items=list.items.filter(i=>!remove.includes(i.id)).concat(added);
 list.updatedAt=now;
 return {list};
}

// What the agent reads: ids to refer back to, and who changed what last.
// What a new session starts with: each list's progress and what is not done yet;
// the checklists tool reads the rest.
const summary=c=>(c.checklists||[]).map(l=>({id:l.id,title:l.title,done:l.items.filter(i=>i.status==='done').length,total:l.items.length,open:l.items.filter(i=>i.status!=='done').slice(0,30).map(i=>({id:i.id,text:i.text,status:i.status}))}));
const view=c=>(c.checklists||[]).map(l=>({id:l.id,title:l.title,updatedAt:l.updatedAt,items:l.items.map(i=>({id:i.id,text:i.text,status:i.status,...(i.note?{note:i.note}:{}),by:i.by,updatedAt:i.updatedAt}))}));

module.exports={apply,view,summary,STATUSES};
