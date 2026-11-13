const root=document.querySelector('#app'),identity=document.querySelector('#identity'),logout=document.querySelector('#signout');
const state={me:null,weeks:[],week:null,season:new Date().getFullYear(),mode:'straight',view:'picks',scope:'season',board:{straight:[],spread:[]},weekly:{straight:[],spread:[]},message:'',offset:0,busy:false};
let renderPending=false;
const modalOpen=()=>!!document.querySelector('#modal[open]');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=d=>new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Denver',timeZoneName:'short'}).format(new Date(d));
const weekLabel=w=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(w+'T12:00:00Z'));
const now=()=>Date.now()+state.offset;
async function api(path,opts={}){
 const r=await fetch('/showdown/api'+path,{credentials:'same-origin',...opts,headers:{'Content-Type':'application/json',...(state.me?{'X-CSRF-Token':state.me.csrfToken}:{}),...opts.headers}});
 const data=await r.json().catch(()=>({})); if(!r.ok){const e=new Error(data.error||'Unable to load. Please try again.');e.status=r.status;throw e;} return data;
}
async function refresh(){
 try{
  const meta=await api('/weeks');state.weeks=meta.weeks;state.season=meta.season;
  if(!state.week||!state.weeks.some(w=>w.id===state.week))state.week=state.weeks.find(w=>w.id===meta.currentWeek)?.id||state.weeks.find(w=>w.id>meta.currentWeek)?.id||state.weeks[0]?.id;
  const [data,board,weekly]=await Promise.all([state.week?api('/week/'+state.week):null,api('/leaderboard'),state.week?api('/leaderboard?week='+state.week):{straight:[],spread:[]}]);
  state.data=data;state.board=board;state.weekly=weekly;state.lastSync=data?.lastSync||meta.lastSync;state.error=data?.error||meta.error;
  if(data)state.offset=new Date(data.serverNow).getTime()-Date.now();render();
 }catch(e){if(modalOpen()){state.message=e.message;return;}root.innerHTML=`<section class="panel"><h2>Taking a quick timeout</h2><p class="muted">${esc(e.message)}</p><button class="primary" id="retry">Try again</button></section>`;document.querySelector('#retry').onclick=refresh;}
}
function render(){
 if(modalOpen()){renderPending=true;return;}renderPending=false;
 identity.textContent=state.me?.name||`${state.season} SEASON`;
 logout.classList.remove('hidden');logout.textContent=state.me?'Log out':'Sign in';
 const games=state.data?.games||[],active=state.mode;
 const picked=games.filter(g=>g[active]).length,win=games.filter(g=>g[active+'Grade']?.result==='win').length,loss=games.filter(g=>g[active+'Grade']?.result==='loss').length,points=games.reduce((n,g)=>n+(g[active+'Grade']?.points||0),0);
 root.innerHTML=`${!state.me?`<div class="join-banner"><div><strong>Your Saturday. Your bragging rights.</strong><p>Eight marquee games. Two competitions. One season to prove it.</p></div><button class="primary" id="join">Join the competition <span aria-hidden="true">↗</span></button></div>`:''}
 <nav class="tabs" aria-label="Game modes"><button class="tab ${active==='straight'?'active':''}" data-mode="straight" aria-pressed="${active==='straight'}">Straight Up</button><button class="tab ${active==='spread'?'active':''}" data-mode="spread" aria-pressed="${active==='spread'}">Spread Challenge</button><button class="tab ${state.view==='leaderboard'?'active':''}" id="standings">Leaderboards</button></nav>
 <div class="toolbar"><div><span class="live-dot"></span> ${state.error?'Data delayed · showing saved games':'Automatic scores & results'}${state.lastSync?` <span class="sync-time">· Updated ${new Date(state.lastSync).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span>`:''}</div><label class="sr-only" for="week">Choose week</label><select class="weekselect" id="week">${state.weeks.map(w=>`<option value="${w.id}" ${w.id===state.week?'selected':''}>Week of ${weekLabel(w.id)}</option>`).join('')||'<option>No slate yet</option>'}</select></div>
 ${state.message?`<div class="notice" role="status">${esc(state.message)}</div>`:''}
 <div class="layout"><section class="panel"><div class="panel-head"><div><p class="section-kicker">${state.view==='picks'?'THE WEEKEND SLATE':state.scope==='season'?'THE LONG GAME':'THIS WEEK’S RACE'}</p><h2>${state.view==='picks'?(active==='straight'?'Pick the winners.':'Find the edge.'):state.scope==='season'?'Season standings':'Weekly standings'}</h2></div><span class="chip">${state.view==='picks'?`${games.length} GAMES`:state.season}</span></div>
 ${state.view==='leaderboard'?`<div class="scope-tabs"><button class="ghost ${state.scope==='season'?'chosen':''}" data-scope="season">Season</button><button class="ghost ${state.scope==='week'?'chosen':''}" data-scope="week">This week</button></div>${leaders(state.scope==='season'?state.board:state.weekly,200)}`:games.length?games.map(gameCard).join(''):'<div class="empty"><h3>The next slate is on deck.</h3><p>Featured games will appear automatically when the schedule is available. BYU, Utah, and Oregon are always included when they play.</p></div>'}</section>
 <aside><section class="panel"><div class="panel-head"><h2>Your week</h2><span class="chip">${picked}/${games.length} PICKS</span></div><div class="summary-stats"><div><div class="stat">${win}</div><div class="stat-label">Correct</div></div><div><div class="stat">${loss}</div><div class="stat-label">Wrong</div></div><div><div class="stat">${active==='spread'?points:picked}</div><div class="stat-label">${active==='spread'?'Points':'Saved'}</div></div></div><p class="muted">${state.me?'Every pick saves automatically. Change it any time before kickoff.':'Create an account to save picks and build your record.'}</p></section>
 <section class="panel"><div class="panel-head"><h2>Season leaders</h2><span class="meta">${active==='straight'?'WINS':'POINTS'}</span></div>${leaders(state.board,5)}</section>
 <section class="panel"><div class="panel-head"><h2>The playbook</h2></div>${active==='straight'?'<div class="rule"><span>Correct winner</span><b>1 POINT</b></div><div class="rule"><span>Wrong winner</span><b>0 POINTS</b></div>':'<div class="rule"><span>Favorite or pick’em covers</span><b>1 PT</b></div><div class="rule"><span>Underdog below +5.5 wins outright</span><b>2 PTS</b></div><div class="rule"><span>Underdog +5.5 or more wins outright</span><b>3 PTS</b></div><div class="rule"><span>Underdog only covers</span><b>0 PTS</b></div><div class="rule"><span>Push / canceled / postponed</span><b>0 PTS</b></div><p class="muted">Underdog points require an outright win. Lines freeze when first imported, so everyone plays the same spread. Missing lines stay unavailable until posted.</p>'}<p class="muted">Picks lock individually at kickoff. Everyone’s picks are revealed after the game starts.</p></section></aside></div>`;
 wire();
}
function gameCard(g){
 const mode=state.mode,pick=g[mode],result=g[mode+'Grade'];
 const locked=g.locked||new Date(g.start_at).getTime()<=now();
 const unavailable=mode==='spread'&&g.home_spread===null;
 const disabled=locked||unavailable||state.busy;
 const line=side=>{if(mode==='straight')return 'To win';if(unavailable)return 'Line pending';const v=side==='home'?g.home_spread:-g.home_spread;return v===0?'PK':v>0?'+'+v:String(v);};
 const points=side=>{if(mode==='straight'||unavailable)return '';const v=side==='home'?g.home_spread:-g.home_spread;return `<small>${v>0?(v>=5.5?'3 PTS if upset · 0 if only covers':'2 PTS if upset · 0 if only covers'):'1 PT if correct'}</small>`;};
 const team=side=>`<button class="team ${pick===side?'selected':''}" data-pick="${g.id}" data-side="${side}" aria-pressed="${pick===side}" ${disabled?'disabled':''}><div class="team-name">${g[side+'_rank']?`<span class="rank">${g[side+'_rank']}</span>`:''}<b>${esc(g[side])}</b></div><span>${line(side)}${pick===side?' · ✓ Picked':''}</span>${points(side)}</button>`;
 const status=g.status==='live'?`LIVE · ${g.away_score??0}–${g.home_score??0}`:g.status==='final'?`FINAL · ${g.away_score}–${g.home_score}`:['canceled','postponed'].includes(g.status)?g.status.toUpperCase():locked?'LOCKED':'OPEN';
 return `<article class="fixture"><div class="fixture-top"><span>${fmt(g.start_at)}</span><span class="chip ${locked?'lock':''} ${g.status==='live'?'in-progress':''}">${esc(status)}</span></div><div class="teams">${team('away')}<span class="versus">AT</span>${team('home')}</div><div class="game-bottom"><span>${g.status==='live'?esc(g.detail):locked?'Picks locked':unavailable?'Waiting for a posted line':pick?'✓ Pick saved':state.me?'Tap a team to make your pick':'Sign in to make your picks'}</span>${result&&['win','loss','push','void'].includes(result.result)?`<span class="${result.result==='win'?'correct':result.result==='loss'?'wrong':''}">${{win:'✓ Correct',loss:'✕ Incorrect',push:'Push',void:'Void'}[result.result]}${result.points?' · +'+result.points:''}</span>`:locked?`<button class="ghost" data-reveal="${g.id}">View picks</button>`:''}</div></article>`;
}
function leaders(board,limit){return (board?.[state.mode]||[]).slice(0,limit).map((p,i)=>`<div class="leader ${String(p.id)===String(state.me?.id)?'you':''}"><span class="place">${i+1}</span><div><strong>${esc(p.name)}${String(p.id)===String(state.me?.id)?' · You':''}</strong><small>${p.wins}–${p.losses}${p.pushes?'–'+p.pushes:''} ${state.mode==='spread'?'ATS':'record'}${p.pending?' · '+p.pending+' pending':''}</small></div><span class="score">${p.points}</span></div>`).join('')||'<div class="empty"><p>The board is wide open. Make the first pick.</p></div>';}
function wire(){
 document.querySelector('#join')?.addEventListener('click',()=>showAccount('register'));
 document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;state.view='picks';state.message='';render();});
 document.querySelector('#standings').onclick=()=>{state.view='leaderboard';render();};
 document.querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>{state.scope=b.dataset.scope;render();});
 document.querySelector('#week').onchange=async e=>{state.week=e.target.value;state.message='';await refresh();};
 document.querySelectorAll('[data-pick]').forEach(b=>b.onclick=async()=>{
  if(!state.me){showAccount('register');return;} if(state.busy)return;state.busy=true;document.querySelectorAll('[data-pick]').forEach(b=>b.disabled=true);
  try{await api('/pick',{method:'PUT',body:JSON.stringify({gameId:b.dataset.pick,mode:state.mode,team:b.dataset.side})});state.message='Your pick is saved.';}
  catch(e){state.message=e.message;if(e.status===401){state.me=null;showAccount('login');}}
  finally{state.busy=false;await refresh();}
 });
 document.querySelectorAll('[data-reveal]').forEach(b=>b.onclick=async()=>{try{const picks=await api('/reveal/'+b.dataset.reveal);showDialog(`<h2 id="dialog-title">Game picks</h2><p class="muted">Revealed after kickoff</p>${picks.map(p=>`<div class="rule"><span>${esc(p.name)}<small class="reveal-mode">${p.mode==='straight'?'Straight Up':'Spread Challenge'}</small></span><b>${esc(p.team)}</b></div>`).join('')||'<p>No picks were submitted for this game.</p>'}`);}catch(e){state.message=e.message;render();}});
}
function showDialog(content){
 document.querySelector('#modal')?.remove();
 const d=document.createElement('dialog');d.id='modal';d.setAttribute('aria-labelledby','dialog-title');
 d.innerHTML=`<button class="modal-close ghost" type="button" aria-label="Close">✕</button>${content}`;
 document.body.append(d);document.body.classList.add('modal-open');
 d.querySelector('.modal-close').onclick=()=>d.close();
 d.addEventListener('close',()=>{d.remove();if(!modalOpen()){document.body.classList.remove('modal-open');if(renderPending)render();}});
 // Keep drafts in place if a click/drag lands outside a field. Use Close or Escape to dismiss.
 d.showModal();d.querySelector('input')?.focus({preventScroll:true});return d;
}
function showAccount(action='login'){
 let accountAction=action;
 const d=showDialog(`<p class="eyebrow">WELCOME TO SATURDAY</p><h2 id="dialog-title"></h2><p class="muted" id="account-intro"></p><form id="account"><label id="name-label" for="account-name">Display name<input id="account-name" name="name" minlength="2" maxlength="40" autocomplete="nickname" placeholder="How you’ll appear on the board"></label><label for="account-email">Email<input id="account-email" name="email" type="email" required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false"></label><label for="account-password">Password<input id="account-password" name="password" type="password" minlength="10" maxlength="128" required></label><p class="muted">Use at least 10 characters. Accounts are separate from Money HQ.</p><button class="primary" type="submit"></button><p id="formerror" role="alert"></p></form><button class="switch-account" type="button" id="switch"></button>`);
 const name=d.querySelector('#account-name'),email=d.querySelector('#account-email'),password=d.querySelector('#account-password');
 const button=d.querySelector('[type=submit]');
 function setAction(){
  const registering=accountAction==='register';
  d.querySelector('#dialog-title').textContent=registering?'Join the competition':'Welcome back';
  d.querySelector('#account-intro').textContent=registering?'Free to play. Your picks, your record, all season.':'Sign in to pick up where you left off.';
  d.querySelector('#name-label').hidden=!registering;name.required=registering;name.disabled=!registering;
  password.autocomplete=registering?'new-password':'current-password';
  button.textContent=registering?'Create account →':'Sign in →';
  d.querySelector('#switch').textContent=registering?'Already playing? Sign in':'New here? Create an account';
  d.querySelector('#formerror').textContent='';
 }
 setAction();(accountAction==='register'?name:email).focus({preventScroll:true});
 // Toggle the same inputs, preserving typed text, browser autofill and cursor state.
 d.querySelector('#switch').onclick=()=>{accountAction=accountAction==='register'?'login':'register';setAction();email.focus({preventScroll:true});};
 d.querySelector('#account').onsubmit=async e=>{
  e.preventDefault();if(button.disabled)return;button.disabled=true;d.querySelector('#switch').disabled=true;
  try{state.me=await api('/account',{method:'POST',body:JSON.stringify({...Object.fromEntries(new FormData(e.target)),action:accountAction})});d.close();state.message=accountAction==='register'?'You’re in. Pick your winners below.':'Welcome back. Your picks are ready.';await refresh();}
  catch(error){d.querySelector('#formerror').textContent=error.message;button.disabled=false;d.querySelector('#switch').disabled=false;}
 };
}
logout.onclick=async()=>{if(!state.me){showAccount('login');return;}try{await api('/logout',{method:'POST',body:'{}'});state.me=null;state.message='You’re signed out.';await refresh();}catch(e){state.message=e.message;render();}};
async function start(){try{state.me=await api('/me');}catch{}await refresh();}
start();setInterval(()=>{if(!document.hidden&&!state.busy&&!modalOpen())refresh();},60000);
setInterval(()=>{if((state.data?.games||[]).some(g=>!g.locked&&new Date(g.start_at).getTime()<=now())){state.data.games.forEach(g=>{if(new Date(g.start_at).getTime()<=now())g.locked=true;});if(!state.busy)render();}},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.busy&&!modalOpen())refresh();});
