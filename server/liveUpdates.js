const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {WebSocketServer}=require('ws');
const jwt=require('jsonwebtoken');
const {resolveLivePrincipal}=require('./services/livePrincipal');
const {audit}=require('./services/audit');
// The page learns that something changed from this socket instead of asking every
// 1.2 s. It carries no conversation data: it says
// "changed", and the page fetches what it shows through the same authenticated API
// as before, so what a person can read is decided in one place. The server looks
// every tickMs at what each connected person's list, and the conversation they have
// open, would return, and says "changed" when that differs. A page whose socket is
// down polls as it always did.
//
// It also says which build is served, so an open page offers a new version within
// seconds of a deploy rather than at its next half-hourly check.
const {isAllowedSocket}=require('./siteConfig');
const UUID=/^[a-f0-9-]{36}$/;
// Each open socket costs a look every tick, so one person gets a few (a phone, a
// computer, a split view), and says which conversation is open a few times a
// second at most.
const PER_PERSON=8,VIEWS_PER_SECOND=5;
// The live servers running, for endSignIn below.
const servers=new Set();
// A sign-in just ended here (signed out, or from the device list): its pages are
// told at once with 4401 instead of at the next check.
function endSignIn(tokenHash){
 if(typeof tokenHash!=='string'||!tokenHash)return 0;
 const {hashSessionToken}=require('./services/sessionTokens');let n=0;
 for(const wss of servers)for(const ws of wss.clients){try{if(ws.readyState===1&&hashSessionToken(ws.token)===tokenHash){ws.close(4401,'signed out');n++;}}catch{}}
 return n;
}
const digest=value=>crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
function readBuildId(file){try{const id=JSON.parse(fs.readFileSync(file,'utf8')).buildId;return typeof id==='string'&&id?id:null;}catch{return null;}}
function installLiveUpdates(server,{
 agents=require('./agentStore'),
 tickMs=700,
 pingEvery=20,
 versionFile=path.join(__dirname,'..','dist','version.json'),
 principalOf=resolveLivePrincipal,
 secret=()=>process.env.JWT_SECRET,
}={}){
 // autoPong off: the library answers every ping by itself and queues the answers for a
 // peer that pings without reading, so memory grew without end. Pings are answered below, counted like messages.
 const wss=new WebSocketServer({noServer:true,maxPayload:4096,autoPong:false});
 servers.add(wss);
 // A refused connection takes no sign-in to make: at most thirty lines a minute of
 // them in the audit log.
 let auditMinute=0,audited=0;const mayAudit=()=>{const m=Math.floor(Date.now()/60000);if(m!==auditMinute){if(audited>30)audit({source:'live',action:'refusals-not-logged',count:audited-30});auditMinute=m;audited=0;}return ++audited<=30;};
 server.on('upgrade',async(req,socket,head)=>{
  if((req.url||'').split('?')[0]!=='/live')return;
  socket.on('error',()=>{});
  const reject=status=>{if(mayAudit())audit({source:'live',path:'/live',status});socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
  try{
   if(!isAllowedSocket(req))return reject(403);
   const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));const token=cookies.session_id;
   if(!token)return reject(401);
   let decoded;try{decoded=jwt.verify(token,secret());}catch{return reject(401);}
   const principal=await principalOf(token,decoded.id);if(!principal)return reject(401);
   if([...wss.clients].filter(ws=>ws.owner===principal.id).length>=PER_PERSON)return reject(429);
   if(socket.destroyed)return;
   wss.handleUpgrade(req,socket,head,ws=>{
    ws.owner=principal.id;ws.token=token;ws.viewing=null;ws.seen=null;ws.isAlive=true;ws.ticks=0;ws.storeFails=0;
    audit({source:'live',path:'/live',status:101,username:principal.username,role:principal.role});
    ws.on('pong',()=>{ws.isAlive=true;});
    let windowStart=0,views=0;
    ws.on('ping',data=>{
     if(Date.now()-windowStart>1000){windowStart=Date.now();views=0;}
     if(++views>VIEWS_PER_SECOND){if(views>VIEWS_PER_SECOND*10)ws.terminate();return;}
     if(ws.readyState===1&&ws.bufferedAmount<65536)ws.pong(data,false,()=>{});
    });
    ws.on('message',raw=>{
     if(Date.now()-windowStart>1000){windowStart=Date.now();views=0;}
     if(++views>VIEWS_PER_SECOND){if(views>VIEWS_PER_SECOND*10)ws.close();return;}
     try{
      const msg=JSON.parse(raw.toString());
      // Which conversation the page has open, and whether it is on screen: the
      // detail it would fetch joins what is compared, and on screen keeps the
      // conversation marked as read, as the page's own fetch did every 1.2 s.
      // Whether the page is out of sight: a page out of sight needs no looks until it
      // is back.
      if(msg.type==='presence'){
       const wasHidden=ws.hidden;ws.hidden=msg.hidden===true;if(wasHidden&&!ws.hidden)ws.seen=null;
       return;
      }
      if(msg.type!=='view')return ws.close();
      const id=typeof msg.id==='string'&&UUID.test(msg.id)?msg.id:null;
      // A conversation, or one of the owner's group chats.
      let group=false;
      if(id){try{agents.get(id,ws.owner);}catch{try{agents.groupFor(id,ws.owner);group=true;}catch{ws.viewing=null;return;}}}
      ws.viewing=id;ws.viewingGroup=group;
      if(id&&msg.onScreen===true)agents.markViewing(ws.owner,id);
     }catch{ws.close();}
    });
    ws.on('error',()=>ws.terminate());
    ws.hidden=false;
    send(ws,{type:'hello',buildId});
   });
  }catch(e){reject(e.status||500);}
 });
 const send=(ws,data)=>{if(ws.readyState===1&&ws.bufferedAmount<65536)ws.send(JSON.stringify(data));};
 // What the page would see: the same views its fetches return. Only compared, never sent.
 // Worked out once a tick for each person and conversation, however many sockets share them.
 const snapshot=(ws,memo)=>{
  const key=ws.owner+':'+(ws.viewing||'');
  if(memo.has(key))return memo.get(key);
  // The list's groups count too: a new or renamed group, empty or not, is news.
  if(!memo.has(ws.owner))memo.set(ws.owner,[agents.list(ws.owner),agents.listPreferences(ws.owner),agents.groupList(ws.owner)]);
  let detail=null;
  if(ws.viewing){try{detail=ws.viewingGroup?agents.groupView(agents.groupFor(ws.viewing,ws.owner),true):agents.publicView(agents.get(ws.viewing,ws.owner),true);}catch{ws.viewing=null;}}
  const value=digest([memo.get(ws.owner),detail]);memo.set(key,value);return value;
 };
 let buildId=readBuildId(versionFile),busy=false;
 const timer=setInterval(async()=>{
  if(busy)return;busy=true;
  try{
   const latest=readBuildId(versionFile);
   const moved=latest&&latest!==buildId;if(latest)buildId=latest;
   const memo=new Map();
   for(const ws of wss.clients){
    if(ws.readyState!==1)continue;
    if(moved)send(ws,{type:'version',buildId});
    // A dead line is let go, and a signed-out or removed account loses its socket
    // as it would its next fetch.
    if(++ws.ticks%pingEvery===0){
     if(!ws.isAlive){ws.terminate();continue;}
     ws.isAlive=false;try{ws.ping();}catch{}send(ws,{type:'ping'});
     let current=null;try{jwt.verify(ws.token,secret());}catch{ws.close(4401,'signed out');continue;}
     // A store that cannot answer now says nothing about the sign-in: the socket stays
     // and is asked again at the next check. Three
     // in a row close it with 1011, which the page reconnects from, so a long outage
     // keeps no unchecked socket.
     try{current=await principalOf(ws.token,ws.owner);ws.storeFails=0;}catch{if(++ws.storeFails>=3)ws.close(1011,'try again');continue;}
     // Closed with 4401 so the page knows it is signed out, not cut off (a sign-in ended
     // elsewhere, such as from the device list).
     if(!current||current.id!==ws.owner){ws.close(4401,'signed out');continue;}
    }
    if(ws.hidden)continue;
    let seen;try{seen=snapshot(ws,memo);}catch{continue;}
    // The first look says changed too: whatever moved between the page's own fetch
    // and its socket opening is fetched then.
    if(seen!==ws.seen)send(ws,{type:'changed'});
    ws.seen=seen;
   }
  }finally{busy=false;}
 },tickMs);
 timer.unref?.();
 const close=()=>{clearInterval(timer);servers.delete(wss);for(const ws of wss.clients)ws.close();wss.close();};
 return {close,wss};
}
module.exports={installLiveUpdates,endSignIn};
