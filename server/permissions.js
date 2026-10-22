// Native tool-use consent, scoped to one active generation. No model tool can decide it.
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const ttl=10*60*1000;
function expire(g){for(const p of g.permissions||[])if(['pending','decided'].includes(p.status)&&p.expiresAt<=Date.now())p.status='expired';}
function pending(g){expire(g);return (g.permissions||[]).filter(p=>p.status==='pending').map(({request_id,tool_name,description,input_preview,expiresAt})=>({request_id,tool_name,description,input_preview,expiresAt,generation:g.number}));}
function request(g,data){
 if(!/^[a-km-z]{5}$/.test(data.request_id)||!['tool_name','description','input_preview'].every(k=>typeof data[k]==='string')||data.input_preview.length>100000)throw fail('Invalid permission request',400);
 g.permissions??=[];expire(g);
 if(g.permissions.some(p=>p.request_id===data.request_id))return;
 g.permissions.push({...data,status:'pending',expiresAt:Date.now()+ttl});
}
function decide(g,{request_id,behavior,generation}){
 expire(g);if(generation!==g.number||!['allow','deny'].includes(behavior))throw fail('Invalid permission decision',400);
 const p=g.permissions?.find(p=>p.request_id===request_id&&p.status==='pending');if(!p)throw fail('這項確認已失效或已處理，請查看最新狀態。');
 p.behavior=behavior;p.status='decided';
}
function deliveries(g){expire(g);return (g.permissions||[]).filter(p=>p.status==='decided').map(({request_id,behavior})=>({request_id,behavior}));}
function ack(g,id){const p=g.permissions?.find(p=>p.request_id===id&&p.status==='decided');if(p)p.status='sent';}
function cancel(g){for(const p of g.permissions||[])if(['pending','decided'].includes(p.status))p.status='closed';}
module.exports={pending,request,decide,deliveries,ack,cancel};
