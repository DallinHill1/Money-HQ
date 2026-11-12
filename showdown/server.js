import express from 'express';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { weekKey, seasonYear, normalizeEvent, selectSlate, grade, standings } from './logic.js';
const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const schema = `
CREATE SCHEMA IF NOT EXISTS showdown;
CREATE TABLE IF NOT EXISTS showdown.members(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS showdown.sessions(token_hash TEXT PRIMARY KEY,member_id BIGINT NOT NULL REFERENCES showdown.members(id),csrf TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS showdown.attempts(key TEXT PRIMARY KEY,count INT NOT NULL,window_start TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS showdown.weeks(id TEXT PRIMARY KEY,season INT NOT NULL,published BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS showdown.games(id TEXT PRIMARY KEY,week_id TEXT NOT NULL REFERENCES showdown.weeks(id),home TEXT NOT NULL,away TEXT NOT NULL,home_id TEXT NOT NULL,away_id TEXT NOT NULL,start_at TIMESTAMPTZ NOT NULL,home_score INT,away_score INT,status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',home_rank INT,away_rank INT,home_spread NUMERIC(6,1),line_source TEXT,featured BOOLEAN NOT NULL DEFAULT false,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS showdown.picks(member_id BIGINT NOT NULL REFERENCES showdown.members(id),game_id TEXT NOT NULL REFERENCES showdown.games(id),mode TEXT NOT NULL CHECK(mode IN ('straight','spread')),team TEXT NOT NULL CHECK(team IN ('home','away')),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(member_id,game_id,mode));
CREATE TABLE IF NOT EXISTS showdown.sync_state(id INT PRIMARY KEY CHECK(id=1),last_success TIMESTAMPTZ,last_error TEXT);
INSERT INTO showdown.sync_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS showdown_week_games ON showdown.games(week_id);
CREATE INDEX IF NOT EXISTS showdown_pick_games ON showdown.picks(game_id);
`;
export function installShowdown(app, db, { fetcher = fetch, clock = () => new Date() } = {}) {
  const router = express.Router();
  let initialization, syncing, lastAttempt = 0, lastSuccess = null, lastError = null, hashing = 0;
  const cookieName = process.env.NODE_ENV === 'test' ? 'showdown_session' : '__Secure-showdown_session';
  const cookieOptions = { path: '/showdown', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV !== 'test' };
  async function ready() {
    if (!initialization) initialization = db.query(schema).catch(error => { initialization = null; throw error; });
    await initialization;
  }
  async function getJson(url) {
    const r = await fetcher(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Football data provider returned ${r.status}`);
    return r.json();
  }
  async function saveEvent(game) {
    if (!game) return;
    await db.query('INSERT INTO showdown.weeks(id,season) VALUES($1,$2) ON CONFLICT DO NOTHING', [game.week_id, game.season]);
    await db.query(`INSERT INTO showdown.games(id,week_id,home,away,home_id,away_id,start_at,home_score,away_score,status,detail,home_rank,away_rank,home_spread,line_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(id) DO UPDATE SET home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,status=EXCLUDED.status,detail=EXCLUDED.detail,
        start_at=CASE WHEN showdown.games.status='scheduled' AND showdown.games.start_at>now() THEN EXCLUDED.start_at ELSE showdown.games.start_at END,
        home_rank=EXCLUDED.home_rank,away_rank=EXCLUDED.away_rank,
        home_spread=CASE WHEN showdown.games.home_spread IS NULL AND showdown.games.start_at>now() AND EXCLUDED.status='scheduled' THEN EXCLUDED.home_spread ELSE showdown.games.home_spread END,
        line_source=COALESCE(showdown.games.line_source,EXCLUDED.line_source),updated_at=now()`,
    [game.id,game.week_id,game.home,game.away,game.home_id,game.away_id,game.start_at,game.home_score,game.away_score,game.status,game.detail,game.home_rank,game.away_rank,game.home_spread,game.line_source]);
  }
  async function sync() {
    await ready();
    const data = await getJson('https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=500&groups=80');
    if (!Array.isArray(data.events)) throw new Error('Football provider response is missing games');
    const events = [...data.events];
    const season = Number(data.season?.year || seasonYear(clock()));
    if (data.week?.number && data.season?.type && data.week.number < 16) {
      try {
        const next = await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=500&groups=80&week=${Number(data.week.number)+1}&seasontype=${Number(data.season.type)}&year=${season}`);
        events.push(...(next.events || []));
      } catch (error) { console.warn('[Showdown] Next week:', error.message); }
    }
    const seen = new Set();
    for (const event of events) { const game = normalizeEvent(event, season); if (game && !seen.has(game.id)) { seen.add(game.id); await saveEvent(game); } }
    // Finish previous slates even after ESPN rolls its scoreboard forward to the next week.
    const unfinished = (await db.query(`SELECT id FROM showdown.games WHERE featured=true AND status IN ('scheduled','live') AND start_at<now() AND start_at>now()-INTERVAL '30 days' ORDER BY start_at LIMIT 24`)).rows;
    for (const game of unfinished.filter(g => !seen.has(g.id))) {
      try { const summary = await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${game.id}`);
        const event = summary.header; if (event) await saveEvent(normalizeEvent({ ...event, date: event.competitions?.[0]?.date, status: event.competitions?.[0]?.status }, season));
      } catch (error) { console.warn('[Showdown] Final score:', error.message); }
    }
    const weeks = (await db.query("SELECT id FROM showdown.weeks WHERE published=false AND id >= $1 ORDER BY id", [weekKey(clock())])).rows;
    for (const week of weeks) {
      const games = (await db.query('SELECT * FROM showdown.games WHERE week_id=$1', [week.id])).rows;
      const selected = selectSlate(games, clock().getTime());
      if (!selected.length) continue;
      // Publish a complete slate once, so already-saved picks can never disappear as rankings change.
      await db.query('UPDATE showdown.games SET featured=true WHERE id=ANY($1::text[])', [selected.map(g => g.id)]);
      await db.query('UPDATE showdown.weeks SET published=true WHERE id=$1', [week.id]);
    }
    await db.query("DELETE FROM showdown.sessions WHERE expires_at<now(); DELETE FROM showdown.attempts WHERE window_start<now()-INTERVAL '1 day';");
    lastSuccess = clock().toISOString(); lastError = null;
    await db.query('UPDATE showdown.sync_state SET last_success=$1,last_error=NULL WHERE id=1', [lastSuccess]);
  }
  async function refresh(force = false) {
    if (syncing) return syncing;
    if (!force && clock().getTime() - lastAttempt < 60000) return;
    lastAttempt = clock().getTime();
    syncing = sync().catch(async error => {
      lastError = error.message; console.warn('[Showdown] Refresh:', error.message);
      await db.query('UPDATE showdown.sync_state SET last_error=$1 WHERE id=1', [lastError]).catch(() => {});
    }).finally(() => { syncing = null; });
    return syncing;
  }
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' https://a.espncdn.com; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (['GET','HEAD'].includes(req.method)) return next();
    let origin; try { origin = new URL(req.get('origin') || '').origin; } catch {}
    if (origin !== `${req.protocol}://${req.get('host')}` || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Open Saturday Showdown from its own website.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON is required.' });
    next();
  });
  router.use(express.json({ limit: '20kb' }));
  router.use('/api', route(async (req, res, next) => {
    await ready();
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const session = (await db.query('SELECT m.id,m.name,s.csrf FROM showdown.sessions s JOIN showdown.members m ON m.id=s.member_id WHERE s.token_hash=$1 AND s.expires_at>now()', [hash(token)])).rows[0];
      if (session) { req.member = session; req.sessionHash = hash(token); }
    }
    next();
  }));
  const auth = (req,res,next) => !req.member ? res.status(401).json({error:'Sign in to save your picks.'}) : next();
  const csrf = (req,res,next) => {
    if (!req.member || req.get('x-csrf-token') !== req.member.csrf) return res.status(403).json({ error: 'Reload this page and try again.' });
    next();
  };
  router.post('/api/account', route(async (req,res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0,40) : '';
    const action = req.body.action;
    if (!['login','register'].includes(action) || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password!=='string' || password.length<10 || password.length>128 || (action==='register' && name.length<2)) return res.status(400).json({ error: 'Use a valid email, a name and a password of 10–128 characters.' });
    for (const [key,max] of [[hash('ip:'+req.ip),40],[hash('email:'+email),12]]) {
      const r = await db.query(`INSERT INTO showdown.attempts(key,count,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN showdown.attempts.window_start<now()-INTERVAL '15 minutes' THEN 1 ELSE showdown.attempts.count+1 END,window_start=CASE WHEN showdown.attempts.window_start<now()-INTERVAL '15 minutes' THEN now() ELSE showdown.attempts.window_start END RETURNING count`,[key]);
      if (r.rows[0].count>max) return res.set('Retry-After','900').status(429).json({error:'Too many attempts. Try again in 15 minutes.'});
    }
    if (hashing>=2) return res.status(429).json({error:'Sign-in is busy. Try again shortly.'});
    let member = (await db.query('SELECT * FROM showdown.members WHERE email=$1',[email])).rows[0];
    const salt = action==='register' ? randomBytes(16).toString('hex') : member?.password_salt || '00000000000000000000000000000000';
    let key; hashing++;
    try { key = await derive(password,salt,64,{N:16384,r:8,p:2,maxmem:64*1024*1024}); } finally { hashing--; }
    if (action==='register') {
      const result = await db.query('INSERT INTO showdown.members(name,email,password_salt,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING id,name',[name,email,salt,key.toString('hex')]);
      if (!result.rows.length) return res.status(409).json({error:'An account already uses this email. Sign in instead.'});
      member=result.rows[0];
    } else if (!timingSafeEqual(key,Buffer.from(member?.password_hash || '0'.repeat(128),'hex')) || !member) return res.status(401).json({error:'Email or password is incorrect.'});
    if (req.sessionHash) await db.query('DELETE FROM showdown.sessions WHERE token_hash=$1',[req.sessionHash]);
    const token=randomBytes(32).toString('hex'), csrfToken=randomBytes(32).toString('hex');
    await db.query('INSERT INTO showdown.sessions(token_hash,member_id,csrf,expires_at) VALUES($1,$2,$3,$4)',[hash(token),member.id,csrfToken,new Date(clock().getTime()+30*86400000)]);
    res.cookie(cookieName,token,{...cookieOptions,maxAge:30*86400000});
    res.json({id:member.id,name:member.name,csrfToken});
  }));
  router.get('/api/me', (req,res) => res.json(req.member ? {id:req.member.id,name:req.member.name,csrfToken:req.member.csrf} : null));
  router.post('/api/logout',auth,csrf,route(async(req,res)=>{
    await db.query('DELETE FROM showdown.sessions WHERE token_hash=$1',[req.sessionHash]);res.clearCookie(cookieName,cookieOptions);res.json({ok:true});
  }));
  router.get('/api/status',route(async(req,res)=>{
    await refresh(); const status=(await db.query('SELECT last_success,last_error FROM showdown.sync_state WHERE id=1')).rows[0];
    const season=seasonYear(clock());const count=(await db.query('SELECT COUNT(*)::int AS n FROM showdown.games g JOIN showdown.weeks w ON w.id=g.week_id WHERE w.season=$1 AND g.featured=true',[season])).rows[0].n;
    res.status(status.last_success?200:503).json({ok:!!status.last_success,season,source:'ESPN',apiKeyRequired:false,lastSync:status.last_success,error:status.last_error,featuredGames:count});
  }));
  router.get('/api/weeks',route(async(req,res)=>{
    await refresh();const r=await db.query('SELECT id,published,season FROM showdown.weeks WHERE published=true AND season=$1 ORDER BY id DESC',[seasonYear(clock())]);res.json({weeks:r.rows,currentWeek:weekKey(clock()),season:seasonYear(clock()),lastSync:lastSuccess,error:lastError});
  }));
  router.get('/api/week/:id',route(async(req,res)=>{
    await refresh();const week=(await db.query('SELECT * FROM showdown.weeks WHERE id=$1 AND published=true',[req.params.id])).rows[0];
    if(!week)return res.status(404).json({error:'Week unavailable.'});
    const games=(await db.query('SELECT * FROM showdown.games WHERE week_id=$1 AND featured=true ORDER BY start_at,id',[week.id])).rows;
    const picks=req.member?(await db.query('SELECT p.game_id,p.mode,p.team FROM showdown.picks p JOIN showdown.games g ON g.id=p.game_id WHERE p.member_id=$1 AND g.week_id=$2',[req.member.id,week.id])).rows:[];
    const mine=Object.fromEntries(picks.map(p=>[p.game_id+':'+p.mode,p.team]));
    res.json({week,games:games.map(g=>({...g,home_spread:g.home_spread===null?null:Number(g.home_spread),locked:new Date(g.start_at)<=clock()||g.status!=='scheduled',straight:mine[g.id+':straight']||null,spread:mine[g.id+':spread']||null,straightGrade:mine[g.id+':straight']?grade(g,'straight',mine[g.id+':straight']):null,spreadGrade:mine[g.id+':spread']?grade(g,'spread',mine[g.id+':spread']):null})),serverNow:clock().toISOString(),lastSync:lastSuccess,error:lastError});
  }));
  router.put('/api/pick',auth,csrf,route(async(req,res)=>{
    const {gameId,mode,team}=req.body;
    if(!['straight','spread'].includes(mode)||!['home','away'].includes(team)||typeof gameId!=='string')return res.status(400).json({error:'Invalid pick.'});
    // The database rechecks kickoff within the same atomic write; client clocks never decide eligibility.
    const r=await db.query(`INSERT INTO showdown.picks(member_id,game_id,mode,team)
      SELECT $1,g.id,$3,$4 FROM showdown.games g JOIN showdown.weeks w ON w.id=g.week_id WHERE g.id=$2 AND g.featured=true AND w.published=true AND g.start_at>clock_timestamp() AND g.status='scheduled' AND ($3='straight' OR g.home_spread IS NOT NULL)
      ON CONFLICT(member_id,game_id,mode) DO UPDATE SET team=EXCLUDED.team,created_at=now()
      WHERE EXISTS(SELECT 1 FROM showdown.games g WHERE g.id=$2 AND g.start_at>clock_timestamp() AND g.status='scheduled') RETURNING game_id`,[req.member.id,gameId,mode,team]);
    if(!r.rows.length)return res.status(409).json({error:'This pick is locked, unavailable, or waiting for a spread.'});
    res.json({ok:true});
  }));
  router.get('/api/leaderboard',route(async(req,res)=>{
    const week=typeof req.query.week==='string'?req.query.week:null;
    const rows=(await db.query(`SELECT m.id AS member_id,m.name,p.mode,p.team,g.* FROM showdown.picks p JOIN showdown.members m ON m.id=p.member_id JOIN showdown.games g ON g.id=p.game_id JOIN showdown.weeks w ON w.id=g.week_id WHERE w.season=$1 AND g.featured=true AND w.published=true AND ($2::text IS NULL OR g.week_id=$2)`,[seasonYear(clock()),week])).rows;
    res.json(standings(rows));
  }));
  router.get('/api/reveal/:id',route(async(req,res)=>{
    const g=(await db.query('SELECT * FROM showdown.games WHERE id=$1 AND featured=true',[req.params.id])).rows[0];
    if(!g)return res.status(404).json({error:'Game unavailable.'});
    if(new Date(g.start_at)>clock())return res.status(403).json({error:'Picks stay hidden until kickoff.'});
    const picks=(await db.query('SELECT m.name,p.mode,p.team FROM showdown.picks p JOIN showdown.members m ON m.id=p.member_id WHERE p.game_id=$1 ORDER BY m.name',[g.id])).rows;
    res.json(picks.map(p=>({...p,team:g[p.team]})));
  }));
  router.use('/api',(_req,res)=>res.status(404).json({error:'Not found.'}));
  router.use(express.static(new URL('./public',import.meta.url).pathname,{dotfiles:'deny',index:'index.html'}));
  router.use((_req,res)=>res.status(404).send('Not found.'));
  router.use((error,req,res,next)=>{
    console.error('[Showdown]',error.code||error.message);
    if(res.headersSent)return next(error);
    res.status(error.status||503).json({error:'Saturday Showdown is temporarily unavailable. Try again shortly.'});
  });
  app.use('/showdown',router);
  return {ready,refresh};
}
