import express from 'express';
import pg from 'pg';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

const plaidEnv = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
const basePath = plaidEnv === 'production'
  ? PlaidEnvironments.production
  : plaidEnv === 'development'
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox;

const plaid = new PlaidApi(new Configuration({
  basePath,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET
    }
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT,
      item_id TEXT,
      cursor TEXT,
      institution TEXT,
      connected_at TIMESTAMPTZ,
      last_sync TIMESTAMPTZ
    )
  `);
  await pool.query(`INSERT INTO plaid_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

async function getState() {
  if (!process.env.DATABASE_URL) return {};
  const r = await pool.query('SELECT * FROM plaid_state WHERE id = 1');
  return r.rows[0] || {};
}

async function saveState(patch) {
  const current = await getState();
  const next = { ...current, ...patch };
  await pool.query(`
    UPDATE plaid_state SET
      access_token=$1,
      item_id=$2,
      cursor=$3,
      institution=$4,
      connected_at=$5,
      last_sync=$6
    WHERE id=1
  `, [
    next.access_token || null,
    next.item_id || null,
    next.cursor || null,
    next.institution || null,
    next.connected_at || null,
    next.last_sync || null
  ]);
}

function configurationProblems() {
  const missing = [];
  if (!process.env.PLAID_CLIENT_ID) missing.push('PLAID_CLIENT_ID');
  if (!process.env.PLAID_SECRET) missing.push('PLAID_SECRET');
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  return missing;
}

function safeError(e) {
  return e?.response?.data?.error_message || e?.response?.data?.error_code || e?.message || 'Server error';
}

app.get('/api/health', async (_req, res) => {
  const missing = configurationProblems();
  let database = false;
  if (!missing.includes('DATABASE_URL')) {
    try { await pool.query('SELECT 1'); database = true; } catch {}
  }
  res.json({ ok: missing.length === 0 && database, plaidEnv, database, missing });
});

app.get('/api/plaid/status', async (_req, res) => {
  try {
    const state = await getState();
    res.json({
      connected: !!state.access_token,
      item_id: state.item_id || null,
      institution: state.institution || null,
      last_sync: state.last_sync || null,
      env: plaidEnv
    });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

app.post('/api/plaid/link-token', async (_req, res) => {
  const missing = configurationProblems();
  if (missing.length) return res.status(503).json({ error: `Missing Railway variable(s): ${missing.join(', ')}` });
  try {
    const r = await plaid.linkTokenCreate({
      user: { client_user_id: 'money-hq-owner' },
      client_name: 'Money HQ',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      transactions: { days_requested: 180 }
    });
    res.json({ link_token: r.data.link_token });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

app.post('/api/plaid/exchange', async (req, res) => {
  try {
    console.log('[Plaid] Exchanging public token...');
    if (!req.body.public_token) return res.status(400).json({ error: 'Missing public_token' });
    const r = await plaid.itemPublicTokenExchange({ public_token: req.body.public_token });
    await saveState({
      access_token: r.data.access_token,
      item_id: r.data.item_id,
      cursor: null,
      institution: req.body?.metadata?.institution?.name || 'Bank',
      connected_at: new Date().toISOString(),
      last_sync: null
    });
    console.log('[Plaid] Connection saved for item', r.data.item_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Plaid] Exchange failed:', safeError(e));
    res.status(500).json({ error: safeError(e) });
  }
});

const appCategory = (t) => {
  const p = t.personal_finance_category || {};
  const primary = (p.primary || '').toUpperCase();
  const detailed = (p.detailed || '').toUpperCase();
  const name = (t.merchant_name || t.name || '').toLowerCase();
  if (primary === 'FOOD_AND_DRINK') {
    if (detailed.includes('GROCER') || /walmart|costco|smith|maceys|target/.test(name)) return 'Groceries';
    return 'Eating Out / Date Nights';
  }
  if (primary === 'TRANSPORTATION') return /gas|fuel|chevron|shell|maverik|costco/.test(name) ? 'Gas' : 'Transportation';
  if (primary === 'RENT_AND_UTILITIES') return 'Utilities (Phone, Internet, Electric)';
  if (primary === 'MEDICAL') return 'Health / Medical';
  if (primary === 'GENERAL_MERCHANDISE') return 'Household Misc';
  if (primary === 'ENTERTAINMENT') return 'Fun Money';
  if (primary === 'PERSONAL_CARE') return 'Household Misc';
  return 'Household Misc';
};

function txToMoneyHQ(t, accountNameById) {
  return {
    plaidId: t.transaction_id,
    date: t.date,
    amt: Math.round(Number(t.amount) * 100) / 100,
    cat: appCategory(t),
    who: 'Joint',
    desc: t.merchant_name || t.name || 'Bank transaction',
    pay: accountNameById[t.account_id] || 'Checking',
    note: 'Plaid import'
  };
}

app.post('/api/plaid/sync', async (_req, res) => {
  try {
    const state = await getState();
    if (!state.access_token) return res.status(409).json({ error: 'No bank is connected yet.' });

    console.log('[Plaid] Sync started');
    let cursor = state.cursor || undefined;
    const added = [], modified = [], removed = [];
    let hasMore = true;
    let transactionsStatus = null;
    while (hasMore) {
      const r = await plaid.transactionsSync({ access_token: state.access_token, cursor, count: 500 });
      added.push(...r.data.added);
      modified.push(...r.data.modified);
      removed.push(...r.data.removed);
      transactionsStatus = r.data.transactions_update_status || transactionsStatus;
      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
    }

    const ar = await plaid.accountsGet({ access_token: state.access_token });
    const accountNameById = Object.fromEntries(ar.data.accounts.map(a => [a.account_id, a.name]));
    const spend = [...added, ...modified].filter(t => Number(t.amount) > 0 && !t.pending);
    const tx = spend.map(t => txToMoneyHQ(t, accountNameById));
    const today = new Date().toISOString().slice(0, 10);
    const accounts = ar.data.accounts.map(a => ({
      plaidAccountId: a.account_id,
      asOf: today,
      cat: a.type === 'depository' ? 'Cash & Savings' : (a.type === 'investment' ? 'Investments' : 'Linked account'),
      acct: `${state.institution || 'Bank'} — ${a.name}${a.mask ? ' ••••' + a.mask : ''}`,
      bal: Number(a.balances.current ?? a.balances.available ?? 0),
      house: false,
      note: 'Synced from Plaid'
    }));

    await saveState({ cursor, last_sync: new Date().toISOString() });
    res.json({
      tx,
      accounts,
      removed: removed.map(x => x.transaction_id),
      syncedAt: new Date().toISOString(),
      institution: state.institution || 'Bank',
      transactionsStatus
    });
    console.log(`[Plaid] Sync complete: ${ar.data.accounts.length} accounts, ${tx.length} purchases, status=${transactionsStatus || 'unknown'}`);
  } catch (e) {
    console.error('[Plaid] Sync failed:', safeError(e));
    res.status(500).json({ error: safeError(e) });
  }
});

app.get('*', (_req, res) => res.sendFile(new URL('./index.html', import.meta.url).pathname));

const port = Number(process.env.PORT || 3000);
initDb()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`Money HQ listening on ${port} (${plaidEnv})`)))
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
