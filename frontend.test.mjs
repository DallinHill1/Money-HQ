import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const tick=ms=>new Promise(r=>setTimeout(r,ms));
async function mount({failRead=false,failSave=false}={}){
  const writes=[],errors=[];let version=0;
  const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{url:'https://moneyhq.example',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
    w.scrollTo=()=>{};
    w.fetch=async(path,options={})=>{
      let data,status=200;
      if(path==='/api/auth/me')data={user:{id:'test-user',email:'test@example.com'},csrfToken:'csrf'};
      else if(path==='/api/state' && !options.method){if(failRead){status=503;data={error:'Database unavailable'};}else data={state:null,version};}
      else if(path==='/api/state'){
        const payload=JSON.parse(options.body);assert.equal(options.headers['X-MoneyHQ-User'],'test-user');assert.equal(options.headers['X-CSRF-Token'],'csrf');
        if(failSave){status=409;data={error:'Changed in another tab'};}else{assert.equal(payload.version,version);writes.push(payload.state);data={version:++version};}
      }
      else if(path==='/api/plaid/status')data={connected:false};
      else throw new Error('Unexpected path '+path);
      return {ok:status===200,status,json:async()=>data};
    };
    // A contaminated old shared cache must never be consulted.
    w.localStorage.setItem('moneyhq-v2-blank',JSON.stringify({setup:{goal:987654321},tx:[{desc:'Another user private transaction'}]}));
  }});
  await tick(850);return {dom,writes,errors};
}
let result=await mount();
assert.equal(result.errors.length,0,result.errors.join('\n'));
assert.equal(result.writes.length,1);
assert.equal(result.writes[0].setup.goal,0);assert.deepEqual(result.writes[0].tx,[]);
assert.ok(!result.dom.window.document.body.textContent.includes('Another user private transaction'));
assert.equal(result.dom.window.document.getElementById('account-email').textContent,'test@example.com');
assert.equal(result.dom.window.document.getElementById('save-status').textContent,'Saved');
const unload=new result.dom.window.Event('beforeunload',{cancelable:true});result.dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,false);
await result.dom.window.flushBudget();assert.equal(result.writes.length,1);
result.dom.window.close();
result=await mount({failRead:true});assert.equal(result.writes.length,0);assert.match(result.dom.window.document.getElementById('save-status').textContent,/Database unavailable/);result.dom.window.close();
result=await mount({failSave:true});assert.equal(result.writes.length,0);assert.match(result.dom.window.document.getElementById('save-status').textContent,/Not saved/);assert.equal(result.dom.window.document.getElementById('root').inert,true);result.dom.window.close();
console.log('PASS: app renders, blank accounts ignore old browser cache, server saves work, saved data does not trigger unload warnings, failed reads do not overwrite data, conflicting saves stop further editing.');
