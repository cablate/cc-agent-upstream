export async function bridge(config,action,data,{timeout=8000}={}){
 const response=await fetch(`${config.server}/bridge/${config.conversationId}/${action}`,{method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},body:JSON.stringify(data||{}),signal:AbortSignal.timeout(timeout)});
 if(!response.ok){let why='';try{why=(await response.json()).message||'';}catch{}throw new Error(`bridge ${action}: ${response.status}${why?' '+why:''}`);}return response.json();
}
