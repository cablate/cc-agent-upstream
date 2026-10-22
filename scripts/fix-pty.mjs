// Some node-pty npm prebuilds ship spawn-helper without its executable bit.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
if(process.platform==='darwin'){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 for(const suffix of [`prebuilds/darwin-${process.arch}/spawn-helper`,'build/Release/spawn-helper']){
  const helper=path.join(root,'node_modules/node-pty',suffix);
  if(fs.existsSync(helper)){const mode=fs.statSync(helper).mode;if(!(mode&0o100))fs.chmodSync(helper,mode|0o111);}
 }
}
