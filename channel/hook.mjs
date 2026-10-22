import fs from 'node:fs';import {bridge} from './client.mjs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const data=JSON.parse(raw||'{}');
if(data.session_id!==config.sessionId)process.exit(0);
// A turn that ends on an API error (a usage limit, an overload) fires StopFailure,
// not Stop; without it the page waited on a reply that was never coming.
const action=({PreCompact:'precompact',PostCompact:'postcompact',Stop:'result',StopFailure:'failure'})[data.hook_event_name];
if(!action)process.exit(0);
let boundary='';
if(data.transcript_path){try{const st=fs.statSync(data.transcript_path);boundary=String(st.size);}catch{}}
const eventKey=boundary||!['result','failure'].includes(action)?boundary+':'+(data.compact_summary||''):undefined;
const result=await bridge(config,action,{compact_summary:data.compact_summary,eventKey,trigger:data.trigger,error:data.error,error_details:data.error_details,
 checkFinal:action==='result',stopHookActive:data.stop_hook_active===true});
// The server decides whether a final delivery is still owed; terminal or reasoning content is never read or reposted.
if(action==='result'&&result.decision==='block')process.stdout.write(JSON.stringify({decision:'block',reason:result.reason})+'\n');
