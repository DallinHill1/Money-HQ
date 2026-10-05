import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const tick=ms=>new Promise(r=>setTimeout(r,ms));
async function mount({failRead=false,failSave=false,state=null}={}){
  const writes=[],errors=[];let version=0;
  const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{url:'https://moneyhq.example',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
    w.scrollTo=()=>{};
    w.fetch=async(path,options={})=>{
      let data,status=200;
      if(path==='/api/auth/me')data={user:{id:'test-user',email:'test@example.com'},csrfToken:'csrf'};
      else if(path==='/api/state' && !options.method){if(failRead){status=503;data={error:'Database unavailable'};}else data={state,version};}
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
const fixture=structuredClone(result.writes[0]);
assert.ok(!result.dom.window.document.body.textContent.includes('Another user private transaction'));
assert.equal(result.dom.window.document.getElementById('account-email').textContent,'test@example.com');
assert.equal(result.dom.window.document.getElementById('save-status').textContent,'Saved');
const unload=new result.dom.window.Event('beforeunload',{cancelable:true});result.dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,false);
await result.dom.window.flushBudget();assert.equal(result.writes.length,1);
result.dom.window.close();
result=await mount({failRead:true});assert.equal(result.writes.length,0);assert.match(result.dom.window.document.getElementById('save-status').textContent,/Database unavailable/);result.dom.window.close();
result=await mount({failSave:true});assert.equal(result.writes.length,0);assert.match(result.dom.window.document.getElementById('save-status').textContent,/Not saved/);assert.equal(result.dom.window.document.getElementById('root').inert,true);result.dom.window.close();

// Existing tithing budgets and payments stay intact but do not affect spending.
fixture.setup.startMonth='2026-09-01';
fixture.budget=[{id:'groceries',cat:'Groceries',group:'Food',amt:1000},{id:'tithing',cat:'Tithing',group:'Giving',amt:9999},{id:'transfer',cat:'Transfer',group:'Transfer',amt:700}];
fixture.income=[{id:'income',week:'2026-09-01',amount:1000}];
fixture.tx=[{id:'purchase',date:'2026-09-02',cat:'Groceries',amt:150,desc:'Groceries'},{id:'tithe',date:'2026-09-02',cat:'Tithing',amt:200,desc:'Church donation'},{id:'old-tithe',date:'2026-08-02',cat:'Tithing',amt:300},{id:'transfer',date:'2026-09-02',cat:'Transfer',amt:700}];
result=await mount({state:fixture});
assert.equal(result.errors.length,0,result.errors.join('\n'));
let doc=result.dom.window.document;
assert.match(doc.body.textContent,/Income \$1,000\s*·\s*Spent \$150/);
assert.match(doc.body.textContent,/Budget used 15%/);
assert.match(doc.body.textContent,/\$150 of \$1,000/);
assert.equal(doc.querySelectorAll('[title="spending $150"]').length,1);
assert.equal(doc.querySelectorAll('[title="spending $350"]').length,0);
assert.ok(!doc.getElementById('root').textContent.includes('Tithing'));
doc.querySelector('button[aria-label="Activity"]').click();await tick(30);
assert.match(doc.body.textContent,/\$150\.00 spent/);
assert.ok(doc.body.textContent.includes('Church donation'));
doc.querySelector('button[aria-label="Plan"]').click();await tick(30);
let buttons=Array.from(doc.querySelectorAll('button'));
let budgetSection=buttons.find(b=>b.textContent.startsWith('Monthly budget')).parentElement;
let tithingSection=buttons.find(b=>b.textContent.startsWith('Tithing')).parentElement;
assert.match(budgetSection.textContent,/Monthly budget\$1,000/);
assert.ok(!budgetSection.textContent.includes('Tithing'));
assert.match(tithingSection.textContent,/10% of income\$100/);
assert.match(tithingSection.textContent,/Paid this month\$200/);
assert.deepEqual(result.writes[0].tx,fixture.tx);
assert.deepEqual(result.writes[0].budget,fixture.budget);
result.dom.window.close();
console.log('PASS: app renders, blank accounts ignore old browser cache, server saves work, saved data does not trigger unload warnings, failed reads do not overwrite data, conflicting saves stop further editing.');
console.log('PASS: tithing remains separate from monthly budgets, spending totals and weekly charts while its target, payments and saved records stay visible.');
