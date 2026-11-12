import assert from 'node:assert/strict';
import express from 'express';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { installShowdown } from './server.js';
import { grade, normalizeEvent, selectSlate, weekKey } from './logic.js';
process.env.NODE_ENV='test';
for(const [spread,team,home,away,result,points] of [[-5.5,'home',30,20,'win',1],[-5,'away',24,20,'win',2],[-5.5,'away',24,20,'win',3],[5.5,'home',20,24,'win',3],[5,'home',20,24,'win',2],[-5,'home',25,20,'push',0],[0,'away',20,24,'win',1],[-5.5,'away',30,20,'loss',0]])assert.deepEqual(grade({status:'final',home_score:home,away_score:away,home_spread:spread},'spread',team),{result,points});
assert.equal(grade({status:'live',home_score:40,away_score:0},'straight','home').result,'pending');
assert.equal(grade({status:'final',home_score:21,away_score:21},'straight','home').result,'push');
assert.equal(grade({status:'canceled'},'straight','home').result,'void');
assert.equal(weekKey(new Date('2026-11-16T02:00Z')),'2026-11-09');assert.equal(weekKey(new Date('2026-11-16T15:00Z')),'2026-11-16');
const start=new Date(Date.now()+3*86400000).toISOString();
function event(id,homeId='1',awayId='2',rank=99){return {id:String(id),date:start,season:{year:new Date().getFullYear()},status:{type:{state:'pre',completed:false}},competitions:[{competitors:[{homeAway:'home',team:{id:homeId,displayName:'Home '+homeId},curatedRank:{current:rank},score:'0'},{homeAway:'away',team:{id:awayId,displayName:'Away '+awayId},curatedRank:{current:rank},score:'0'}],odds:[{provider:{name:'DraftKings'},spread:5.5,homeTeamOdds:{favorite:false,underdog:true},pointSpread:{home:{close:{line:'+5.5'}}}}]}]};}
let events=Array.from({length:12},(_,i)=>event(100+i,String(i+1),String(i+30),i+1));events.push(event(200,'252','999'),event(201,'254','300'));
const games=events.map(e=>normalizeEvent(e,new Date().getFullYear()));assert.equal(selectSlate(games).length,8);assert.ok(selectSlate(games).some(g=>g.home_id==='252'));assert.ok(selectSlate(games).some(g=>g.home_id==='254'));
const signed=event(999);signed.competitions[0].odds[0].spread=7.5;signed.competitions[0].odds[0].pointSpread=undefined;signed.competitions[0].odds[0].homeTeamOdds={favorite:true};assert.equal(normalizeEvent(signed,2026).home_spread,-7.5);
const absent=event(998);absent.competitions[0].odds=[];assert.equal(normalizeEvent(absent,2026).home_spread,null);
const db=new PGlite();const pool={query:async(sql,args)=>{if(!args&&sql.includes(';')){await db.exec(sql);return {rows:[],rowCount:0};}const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};}};
let upstreamFails=false;
const fetcher=async url=>{if(upstreamFails)throw Error('Test provider outage');return {ok:true,json:async()=>({events,season:{year:new Date().getFullYear()}})};};
const app=express();const control=installShowdown(app,pool,{fetcher});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
async function req(path,{method='GET',body,session,headers={}}={}){const r=await fetch(origin+'/showdown'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json().catch(()=>null),cookie:r.headers.get('set-cookie')};}
async function account(email,action='register'){const r=await req('/api/account',{method:'POST',body:{name:'Player '+email,email,password:'Test-password-123',action}});assert.equal(r.status,200,JSON.stringify(r.data));return {...r.data,cookie:r.cookie.split(';')[0]};}
try{
 await control.ready();const meta=await req('/api/weeks');assert.equal(meta.status,200);const week=meta.data.weeks[0].id;assert.equal(meta.data.weeks[0].published,true);
 let slate=(await req('/api/week/'+week)).data;assert.equal(slate.games.length,8);const id=slate.games[0].id;assert.equal((await req('/api/status')).data.apiKeyRequired,false);
 assert.equal((await req('/api/pick',{method:'PUT',body:{gameId:id,mode:'straight',team:'home'}})).status,401);
 const alice=await account('alice@example.test'),bob=await account('bob@example.test');assert.match(alice.cookie,/showdown_session=/);
 assert.equal((await req('/api/me',{session:alice})).data.name,'Player alice@example.test');
 for(const headers of [{Origin:'https://attacker.example'},{'X-CSRF-Token':'wrong'}])assert.equal((await req('/api/pick',{method:'PUT',body:{gameId:id,mode:'straight',team:'home'},session:alice,headers})).status,403);
 for(const [mode,team] of [['straight','home'],['spread','away']])assert.equal((await req('/api/pick',{method:'PUT',body:{gameId:id,mode,team},session:alice})).status,200);
 assert.equal((await req('/api/week/'+week,{session:alice})).data.games.find(g=>g.id===id).straight,'home');assert.equal((await req('/api/week/'+week,{session:bob})).data.games.find(g=>g.id===id).straight,null);assert.equal((await req('/api/reveal/'+id)).status,403);
 const oldLine=(await db.query('SELECT home_spread FROM showdown.games WHERE id=$1',[id])).rows[0].home_spread;events.forEach(e=>e.competitions[0].odds[0].pointSpread.home.close.line='-20.5');await control.refresh(true);
 assert.equal((await db.query('SELECT home_spread FROM showdown.games WHERE id=$1',[id])).rows[0].home_spread,oldLine);assert.equal((await req('/api/week/'+week)).data.games.length,8);
 await db.query("UPDATE showdown.games SET start_at=now()-INTERVAL '1 minute',status='live',home_score=14,away_score=10 WHERE id=$1",[id]);assert.equal((await req('/api/pick',{method:'PUT',body:{gameId:id,mode:'straight',team:'away'},session:alice})).status,409);
 slate=(await req('/api/week/'+week,{session:alice})).data;assert.equal(slate.games.find(g=>g.id===id).locked,true);assert.equal(slate.games.find(g=>g.id===id).home_score,14);assert.equal((await req('/api/reveal/'+id)).data.length,2);
 await db.query("UPDATE showdown.games SET status='final',home_score=24,away_score=20 WHERE id=$1",[id]);const board=(await req('/api/leaderboard')).data;assert.equal(board.straight[0].wins,1);assert.equal(board.spread[0].points,0);
 assert.equal((await req('/api/leaderboard?week='+week)).data.straight[0].wins,1);assert.deepEqual((await req('/api/leaderboard?week=1900-01-01')).data,{straight:[],spread:[]});
 await req('/api/logout',{method:'POST',body:{},session:alice});assert.equal((await req('/api/me',{session:alice})).data,null);const again=await account('alice@example.test','login');assert.equal((await req('/api/week/'+week,{session:again})).data.games.find(g=>g.id===id).straight,'home');
 upstreamFails=true;await control.refresh(true);assert.equal((await req('/api/status')).data.ok,true);assert.equal((await req('/api/week/'+week)).data.games.length,8);
 for(const path of ['/server.js','/logic.js','/.env'])assert.equal((await req(path)).status,404);assert.equal((await fetch(origin+'/showdown/')).status,200);
 for(let i=0;i<13;i++)await req('/api/account',{method:'POST',body:{email:'rate@example.test',password:'Test-password-123',action:'login'}});assert.equal((await req('/api/account',{method:'POST',body:{email:'rate@example.test',password:'Test-password-123',action:'login'}})).status,429);
 const dom=new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),{url:origin+'/showdown/',runScripts:'outside-only'});
 dom.window.fetch=(path,options)=>fetch(new URL(path,origin),options);dom.window.setInterval=()=>0;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 dom.window.HTMLDialogElement.prototype.close=function(){this.dispatchEvent(new dom.window.Event('close'));};
 dom.window.eval(readFileSync(new URL('./public/app.js',import.meta.url),'utf8'));
 for(let n=0;n<100&&!dom.window.document.querySelector('[data-mode]');n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(dom.window.document.querySelectorAll('.fixture').length,8);
 dom.window.document.querySelector('[data-mode=spread]').click();assert.match(dom.window.document.body.textContent,/Underdog covers, \+5.5 or more/);
 dom.window.document.querySelector('#standings').click();dom.window.document.querySelector('[data-scope=week]').click();assert.match(dom.window.document.body.textContent,/Weekly standings/);
 dom.window.document.querySelector('#join').click();assert.equal(dom.window.document.querySelector('[name=password]').minLength,10);dom.window.document.querySelector('.modal-close').click();dom.window.close();
 console.log('PASS Showdown: scoring thresholds, mandatory teams, automatic slate, Mountain weeks, signed/missing/frozen lines, public preview, two-user isolation, CSRF, kickoff locks, live/final scores, weekly/season boards, persistent picks, outage fallback, source protection and rate limits.');
}finally{server.close();await db.close();}
