// Whose agents a schedule may start: accounts that can still sign in, read afresh
// for every tick and every "run now".
const {usersDB}=require('./stores');
const {isActiveUser}=require('./services/userLifecycle');
async function activeOwners(){
 const users=await new Promise((ok,no)=>usersDB.find({},(e,x)=>e?no(e):ok(x||[])));
 const active=new Set(users.filter(isActiveUser).map(u=>String(u._id)));
 return id=>active.has(String(id));
}
module.exports={activeOwners};
