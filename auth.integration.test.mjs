import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgres://localhost/test';
process.env.PLAID_CLIENT_ID='test';process.env.PLAID_SECRET='test';
const {app,pool,initDb,plaid}=await import('./server.js');
const db=new PGlite();
pool.query=async(sql,args)=>{
  if(!args && sql.includes(';')){await db.exec(sql);return {rows:[],rowCount:0};}
  const result=await db.query(sql,args);
  return {...result,rowCount:result.affectedRows||result.rows.length};
};
await db.exec(`CREATE TABLE plaid_state(id INTEGER PRIMARY KEY,access_token TEXT,item_id TEXT,cursor TEXT,institution TEXT,connected_at TIMESTAMPTZ,last_sync TIMESTAMPTZ,classification_version INTEGER);
INSERT INTO plaid_state VALUES(1,'legacy-private-token','legacy-private-item',NULL,'Legacy bank',NOW(),NULL,0);`);
await initDb();await initDb();
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const origin='http://127.0.0.1:'+server.address().port;
async function request(path,{session,method='GET',body,headers={}}={}){
  const r=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken,'X-MoneyHQ-User':session.user.id}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json().catch(()=>null);return {status:r.status,data,cookie:r.headers.get('set-cookie')};
}
const budget=()=>({tx:[],income:[],budget:[],setup:{goal:123},debts:[],studentLoans:[],sinking:[],subs:[],networth:[],events:[]});
async function register(email){
  const r=await request('/api/auth/register',{method:'POST',body:{email,password:'A long test passphrase!'}});
  assert.equal(r.status,200);assert.match(r.cookie,/HttpOnly/);assert.match(r.cookie,/SameSite=Strict/i);
  return {...r.data,cookie:r.cookie.split(';')[0]};
}
try {
  for(const [path,method] of [['/api/state','GET'],['/api/state','PUT'],['/api/plaid/status','GET'],['/api/plaid/sync','POST'],['/api/plaid/link-token','POST'],['/api/plaid/exchange','POST']]){
    assert.equal((await request(path,{method,body:method==='GET'?undefined:{}})).status,401);
  }
  const alice=await register('alice@example.test'),bob=await register('bob@example.test');
  for(const session of [alice,bob]){
    assert.deepEqual((await request('/api/state',{session})).data,{state:null,version:0});
    assert.equal((await request('/api/plaid/status',{session})).data.item_count,0);
  }
  const hashes=(await db.query('SELECT password_salt,password_hash FROM app_users')).rows;
  assert.notEqual(hashes[0].password_salt,hashes[1].password_salt);assert.notEqual(hashes[0].password_hash,hashes[1].password_hash);
  assert.equal((await request('/api/state',{session:alice,method:'PUT',body:{state:budget(),version:0,user_id:bob.user.id}})).status,200);
  assert.equal((await request('/api/state',{session:bob})).data.state,null);
  assert.equal((await request('/api/state',{session:alice})).data.state.setup.goal,123);
  assert.equal((await request('/api/state',{session:alice,method:'PUT',body:{state:budget(),version:0}})).status,409);
  const other=budget();other.setup.goal=456;
  assert.equal((await request('/api/state',{session:bob,method:'PUT',body:{state:other,version:0}})).status,200);
  assert.equal((await request('/api/state',{session:alice})).data.state.setup.goal,123);
  const changed=budget();changed.setup.goal=999;
  assert.equal((await request('/api/state',{session:alice,method:'PUT',body:{state:changed,version:1}})).data.version,2);
  assert.equal((await request('/api/state',{session:alice,method:'PUT',body:{state:other,version:1}})).status,409);
  assert.equal((await request('/api/state',{session:alice,headers:{'X-MoneyHQ-User':bob.user.id}})).status,401);
  assert.equal((await request('/api/state',{session:alice,method:'PUT',body:{state:changed,version:2},headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'alice@example.test',password:'A long test passphrase!'},headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'alice@example.test',password:'Wrong test password!'}})).status,401);
  let linkUser;
  plaid.linkTokenCreate=async request=>{linkUser=request.user.client_user_id;return {data:{link_token:'test-link'}};};
  assert.equal((await request('/api/plaid/link-token',{session:alice,method:'POST',body:{user_id:bob.user.id}})).status,200);
  assert.equal(linkUser,alice.user.id);
  plaid.itemPublicTokenExchange=async({public_token})=>({data:{item_id:public_token,access_token:'access-'+public_token}});
  assert.equal((await request('/api/plaid/exchange',{session:alice,method:'POST',body:{public_token:'alice-item',user_id:bob.user.id}})).status,200);
  assert.equal((await request('/api/plaid/exchange',{session:bob,method:'POST',body:{public_token:'bob-item'}})).status,200);
  assert.equal((await request('/api/plaid/exchange',{session:bob,method:'POST',body:{public_token:'alice-item'}})).status,500);
  assert.equal((await db.query("SELECT user_id FROM plaid_items WHERE item_id='alice-item'")).rows[0].user_id,alice.user.id);
  assert.equal((await request('/api/plaid/status',{session:alice})).data.item_count,1);
  assert.equal((await request('/api/plaid/status',{session:bob})).data.item_count,1);
  const tokens=[];
  plaid.transactionsSync=async({access_token})=>{tokens.push(access_token);return {data:{added:[],modified:[],removed:[],next_cursor:'next',has_more:false}};};
  plaid.accountsGet=async()=>({data:{accounts:[]}});
  assert.equal((await request('/api/plaid/sync',{session:alice,method:'POST',body:{}})).status,200);
  assert.deepEqual(tokens,['access-alice-item']);
  assert.equal((await db.query("SELECT user_id FROM plaid_items WHERE item_id='legacy-private-item'")).rows[0].user_id,null);
  await initDb();
  assert.equal((await request('/api/state',{session:alice})).data.state.setup.goal,999);
  const logged=await request('/api/auth/login',{session:alice,method:'POST',body:{email:'alice@example.test',password:'A long test passphrase!'}});
  assert.equal(logged.status,200);
  assert.equal((await request('/api/state',{session:alice})).status,401);
  const renewed={...logged.data,cookie:logged.cookie.split(';')[0]};
  assert.equal((await request('/api/state',{session:renewed})).data.state.setup.goal,999);
  assert.equal((await request('/api/auth/logout',{session:renewed,method:'POST',body:{}})).status,200);
  assert.equal((await request('/api/state',{session:renewed})).status,401);
  await db.query('UPDATE app_sessions SET expires_at=NOW()-INTERVAL \'1 second\' WHERE user_id=$1',[bob.user.id]);
  assert.equal((await request('/api/state',{session:bob})).status,401);
  for(const path of ['/server.js','/auth.js','/env.example','/download','/.env','/package.json'])assert.equal((await fetch(origin+path)).status,404);
  for(const path of ['/','/login'])assert.equal((await fetch(origin+path)).status,200);
  for(let i=0;i<11;i++)await request('/api/auth/login',{method:'POST',body:{email:'limit@example.test',password:'wrong but long enough'}});
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'limit@example.test',password:'wrong but long enough'}})).status,429);
  for(const filename of ['index.html','login.html']){
    const html=readFileSync(new URL(filename,import.meta.url),'utf8');
    let scripts=0;for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)){new Script(match[1]);scripts++;}
    assert.ok(scripts);assert.ok(!html.includes('localStorage'));assert.ok(!html.includes('__NATIVE_STORE__'));
  }
  console.log('PASS: authentication, persistence, two-user isolation, bank ownership, legacy quarantine, CSRF, session rotation/expiry/logout, concurrent-save conflicts, rate limiting, private-file protection, frontend syntax.');
}finally{server.close();await db.close();await pool.end();}
