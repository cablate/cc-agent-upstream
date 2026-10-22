// The way back in from this machine, for an only admin nothing else lets in:
//
//   node scripts/sign-in-rescue.mjs two-step <username>    turn two-step sign-in off
//   node scripts/sign-in-rescue.mjs protection <username>  lift the account's protection
//   node scripts/sign-in-rescue.mjs block <ip address>     lift an address's block
//   then restart the service
//
// It leaves a note in the data folder; the server acts on it at its next start and
// removes it (server/controllers/authController.js, applySignInRescue). A note more
// than a day old is removed without being acted on: restart soon after leaving it.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The same settings the service starts with (scripts/start.mjs), so the note lands in its data folder.
createRequire(import.meta.url)('dotenv').config({path:path.join(root,'server','.env'),quiet:true});
const {PRODUCT}=createRequire(import.meta.url)('../server/siteConfig.js');
// The folder the server reads the note from (authController, applySignInRescue): DB_DIR,
// else the data folder's auth, else this product's usual one.
const dir=path.resolve(process.env.DB_DIR||(process.env[PRODUCT.env.dataDir]?path.join(process.env[PRODUCT.env.dataDir],'auth'):path.join(root,PRODUCT.accountDbDir)));
const [what,username]=process.argv.slice(2);
if(!['two-step','protection','block'].includes(what)||!username){console.error('usage: node scripts/sign-in-rescue.mjs <two-step|protection|block> <username or ip address>');process.exit(1);}
const file=path.join(dir,'sign-in-rescue.json');
fs.writeFileSync(file,JSON.stringify({what,username}),{mode:0o600});
console.log(`Noted in ${file}. Restart ${PRODUCT.name} within a day to apply it to "${username}".`);
