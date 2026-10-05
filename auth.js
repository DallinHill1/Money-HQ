import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cookieName = process.env.NODE_ENV === 'test' ? 'moneyhq_session' : '__Host-moneyhq_session';
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV !== 'test', sameSite: 'strict', path: '/' };
const sessionMs = 7 * 24 * 60 * 60 * 1000;
// OWASP's lower-memory scrypt configuration, appropriate for a small Railway service.
const scryptOptions = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
let hashing = 0;
async function passwordKey(password, salt) {
  if (hashing >= 4) throw Object.assign(new Error('Sign-in is busy. Try again shortly.'), { status: 429 });
  hashing++;
  try { return await derive(password, salt, 64, scryptOptions); }
  finally { hashing--; }
}
function sessionToken(req) {
  const part = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='));
  const value = part?.slice(cookieName.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
export async function initAuthDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id),
      csrf_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS user_budget_state (
      user_id UUID PRIMARY KEY REFERENCES app_users(id), state JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start TIMESTAMPTZ NOT NULL
    );
  `);
}
export function installAuth(app, pool) {
  app.disable('x-powered-by');
  // Railway terminates HTTPS at its proxy. Never accept a caller-supplied user ID.
  app.set('trust proxy', 1);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    let origin;
    try { origin = new URL(req.get('origin') || ''); } catch {}
    const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (!origin || origin.origin !== expected || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Please use Money HQ from its own website.' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON is required.' });
    next();
  });
  app.use('/api', asyncRoute(async (req, _res, next) => {
    const token = sessionToken(req);
    if (token) {
      const result = await pool.query(`
        SELECT u.id, u.email, s.csrf_token
        FROM app_sessions s JOIN app_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>NOW()
      `, [hash(token)]);
      const row = result.rows[0];
      if (row) { req.user = { id: row.id, email: row.email }; req.csrfToken = row.csrf_token; }
    }
    next();
  }));
  async function newSession(req, res, user) {
    const oldToken = sessionToken(req);
    if (oldToken) await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [hash(oldToken)]);
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    await pool.query('INSERT INTO app_sessions (token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,$4)',
      [hash(token), user.id, csrf, new Date(Date.now() + sessionMs)]);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionMs });
    res.json({ user: { id: user.id, email: user.email }, csrfToken: csrf });
  }
  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (req.get('x-moneyhq-user') !== req.user.id) return res.status(401).json({ error: 'Your signed-in account changed. Reload Money HQ.' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const csrf = req.get('x-csrf-token') || '';
      if (csrf.length !== req.csrfToken.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(req.csrfToken))) {
        return res.status(403).json({ error: 'Your session changed. Reload and try again.' });
      }
    }
    next();
  };
  async function limit(req, res) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    for (const [key, maximum] of [[hash('ip:' + req.ip), 30], [hash('email:' + email), 10]]) {
      const result = await pool.query(`
        INSERT INTO auth_attempts (key,count,window_start) VALUES ($1,1,NOW())
        ON CONFLICT (key) DO UPDATE SET
          count=CASE WHEN auth_attempts.window_start < NOW()-INTERVAL '15 minutes' THEN 1 ELSE auth_attempts.count+1 END,
          window_start=CASE WHEN auth_attempts.window_start < NOW()-INTERVAL '15 minutes' THEN NOW() ELSE auth_attempts.window_start END
        RETURNING count
      `, [key]);
      if (result.rows[0].count > maximum) {
        res.set('Retry-After', '900').status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
        return false;
      }
    }
    return true;
  }
  function credentials(req) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 15 || password.length > 128) {
      throw Object.assign(new Error('Use a valid email and a password of 15–128 characters.'), { status: 400 });
    }
    return { email, password };
  }
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null, csrfToken: req.csrfToken || null }));
  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    if (!await limit(req, res)) return;
    const { email, password } = credentials(req);
    const salt = randomBytes(16).toString('hex');
    const key = await passwordKey(password, salt);
    const user = { id: randomUUID(), email };
    const result = await pool.query(`
      INSERT INTO app_users (id,email,password_salt,password_hash) VALUES ($1,$2,$3,$4)
      ON CONFLICT (email) DO NOTHING RETURNING id
    `, [user.id, email, salt, key.toString('hex')]);
    if (!result.rowCount) return res.status(409).json({ error: 'Unable to create this account. Try signing in instead.' });
    await newSession(req, res, user);
  }));
  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    if (!await limit(req, res)) return;
    const { email, password } = credentials(req);
    const result = await pool.query('SELECT * FROM app_users WHERE email=$1', [email]);
    const user = result.rows[0];
    // Perform the same expensive work for unknown emails to avoid a timing shortcut.
    const key = await passwordKey(password, user?.password_salt || '00000000000000000000000000000000');
    const stored = Buffer.from(user?.password_hash || '0'.repeat(128), 'hex');
    if (!timingSafeEqual(key, stored) || !user) return res.status(401).json({ error: 'Email or password is incorrect.' });
    await newSession(req, res, user);
  }));
  app.post('/api/auth/logout', requireUser, asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [hash(sessionToken(req))]);
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  }));
  app.use('/api/state', requireUser);
  app.use('/api/plaid', requireUser);
  app.get('/api/state', asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT state,version FROM user_budget_state WHERE user_id=$1', [req.user.id]);
    res.json(result.rows[0] || { state: null, version: 0 });
  }));
  app.put('/api/state', asyncRoute(async (req, res) => {
    const { state, version } = req.body || {};
    const arrays = ['tx','budget','income','debts','studentLoans','sinking','subs','networth','events'];
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.setup || typeof state.setup !== 'object' || Array.isArray(state.setup) ||
        arrays.some(k => !Array.isArray(state[k])) || !Number.isSafeInteger(version) || version < 0) {
      return res.status(400).json({ error: 'Invalid budget data.' });
    }
    let result;
    if (version === 0) {
      result = await pool.query(`INSERT INTO user_budget_state (user_id,state) VALUES ($1,$2::jsonb)
        ON CONFLICT (user_id) DO NOTHING RETURNING version`, [req.user.id, JSON.stringify(state)]);
    } else {
      result = await pool.query(`UPDATE user_budget_state SET state=$2::jsonb,version=version+1,updated_at=NOW()
        WHERE user_id=$1 AND version=$3 RETURNING version`, [req.user.id, JSON.stringify(state), version]);
    }
    if (!result.rowCount) return res.status(409).json({ error: 'Your budget changed in another tab or device. Reload before making more changes.' });
    res.json({ ok: true, version: result.rows[0].version });
  }));
  const cleanup = setInterval(() => {
    pool.query(`DELETE FROM app_sessions WHERE expires_at<NOW();
      DELETE FROM auth_attempts WHERE window_start<NOW()-INTERVAL '1 day'`).catch(() => {});
  }, 60 * 60 * 1000);
  cleanup.unref();
}
