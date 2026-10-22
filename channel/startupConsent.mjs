// Only classify the two locally authorized startup notices. Never generic Enter.
export function startupConsent(screen,cwd){
 if(/^\s*Channels: server:executive\s*$/m.test(screen)&&screen.includes('WARNING: Loading development channels')&&screen.includes('❯ 1. I am using this for local development'))return 'channel';
 if(!screen.includes('Accessing workspace:')||!screen.includes('Yes, I trust this folder'))return null;
 const after=screen.split('Accessing workspace:')[1].replace(/^\s*\n/,'');
 const shown=after.split(/\n\s*\n/)[0].replace(/\s/g,'');
 if(shown!==cwd.replace(/\s/g,''))return null;
 if(screen.includes('❯ No, exit'))return 'workspace-no';
 if(screen.includes('❯ Yes, I trust this folder'))return 'workspace-yes';
 return null;
}
