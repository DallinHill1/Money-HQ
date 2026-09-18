import express from 'express';
import pg from 'pg';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

const { Pool } = pg;
const app = express();
const CLASSIFICATION_VERSION = 3;

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
    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      institution TEXT,
      cursor TEXT,
      connected_at TIMESTAMPTZ,
      last_sync TIMESTAMPTZ,
      classification_version INTEGER DEFAULT 0
    )
  `);

  // Migrate the original one-item schema so the bank that is already connected
  // survives this upgrade to multiple Plaid Items.
  try {
    const old = await pool.query(`
      SELECT access_token, item_id, cursor, institution, connected_at, last_sync, classification_version
      FROM plaid_state
      WHERE id = 1
    `);

    const row = old.rows[0];

    if (row?.access_token && row?.item_id) {
      await pool.query(`
        INSERT INTO plaid_items
          (item_id, access_token, institution, cursor, connected_at, last_sync, classification_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (item_id) DO NOTHING
      `, [
        row.item_id,
        row.access_token,
        row.institution || 'Bank',
        row.cursor || null,
        row.connected_at || new Date().toISOString(),
        row.last_sync || null,
        row.classification_version || 0
      ]);
    }
  } catch {
    // Fresh installs may not have the old plaid_state table.
  }
}

async function getItems() {
  if (!process.env.DATABASE_URL) return [];

  const r = await pool.query(`
    SELECT *
    FROM plaid_items
    ORDER BY connected_at ASC NULLS LAST
  `);

  return r.rows;
}

async function upsertItem(item) {
  await pool.query(`
    INSERT INTO plaid_items
      (item_id, access_token, institution, cursor, connected_at, last_sync, classification_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (item_id) DO UPDATE SET
      access_token=EXCLUDED.access_token,
      institution=COALESCE(EXCLUDED.institution, plaid_items.institution),
      cursor=COALESCE(EXCLUDED.cursor, plaid_items.cursor),
      connected_at=COALESCE(plaid_items.connected_at, EXCLUDED.connected_at),
      last_sync=COALESCE(EXCLUDED.last_sync, plaid_items.last_sync),
      classification_version=COALESCE(EXCLUDED.classification_version, plaid_items.classification_version)
  `, [
    item.item_id,
    item.access_token,
    item.institution || 'Bank',
    item.cursor ?? null,
    item.connected_at || new Date().toISOString(),
    item.last_sync ?? null,
    item.classification_version ?? 0
  ]);
}

async function updateItem(itemId, patch) {
  const items = await getItems();
  const current = items.find(x => x.item_id === itemId);
  if (!current) return;

  await upsertItem({
    ...current,
    ...patch,
    item_id: itemId
  });
}

function configurationProblems() {
  const missing = [];

  if (!process.env.PLAID_CLIENT_ID) missing.push('PLAID_CLIENT_ID');
  if (!process.env.PLAID_SECRET) missing.push('PLAID_SECRET');
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');

  return missing;
}

function safeError(e) {
  return (
    e?.response?.data?.error_message ||
    e?.response?.data?.error_code ||
    e?.message ||
    'Server error'
  );
}

function errorCode(e) {
  return e?.response?.data?.error_code || '';
}

app.get('/api/health', async (_req, res) => {
  const missing = configurationProblems();
  let database = false;

  if (!missing.includes('DATABASE_URL')) {
    try {
      await pool.query('SELECT 1');
      database = true;
    } catch {}
  }

  res.json({
    ok: missing.length === 0 && database,
    plaidEnv,
    database,
    missing
  });
});

app.get('/api/plaid/status', async (_req, res) => {
  try {
    const items = await getItems();
    const institutions = [...new Set(items.map(x => x.institution).filter(Boolean))];

    res.json({
      connected: items.length > 0,
      item_count: items.length,
      institutions,
      last_sync: items
        .map(x => x.last_sync)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      env: plaidEnv
    });
  } catch (e) {
    res.status(500).json({
      error: safeError(e)
    });
  }
});

app.post('/api/plaid/link-token', async (_req, res) => {
  const missing = configurationProblems();

  if (missing.length) {
    return res.status(503).json({
      error: `Missing Railway variable(s): ${missing.join(', ')}`
    });
  }

  try {
    const request = {
      user: {
        client_user_id: 'money-hq-owner'
      },
      client_name: 'Money HQ',
      products: [Products.Transactions],
      // Consent now so investment accounts such as Fidelity can be added later
      // without narrowing the bank list shown by Link.
      additional_consented_products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: 'en',
      transactions: {
        days_requested: 180
      }
    };

    const r = await plaid.linkTokenCreate(request);

    res.json({
      link_token: r.data.link_token
    });
  } catch (e) {
    res.status(500).json({
      error: safeError(e)
    });
  }
});

app.post('/api/plaid/exchange', async (req, res) => {
  try {
    console.log('[Plaid] Exchanging public token...');

    if (!req.body.public_token) {
      return res.status(400).json({
        error: 'Missing public_token'
      });
    }

    const r = await plaid.itemPublicTokenExchange({
      public_token: req.body.public_token
    });

    await upsertItem({
      access_token: r.data.access_token,
      item_id: r.data.item_id,
      cursor: null,
      institution:
        req.body?.metadata?.institution?.name ||
        'Bank',
      connected_at: new Date().toISOString(),
      last_sync: null,
      classification_version: 0
    });

    console.log(
      '[Plaid] Connection saved for item',
      r.data.item_id,
      req.body?.metadata?.institution?.name || ''
    );

    res.json({
      ok: true,
      item_id: r.data.item_id
    });
  } catch (e) {
    console.error(
      '[Plaid] Exchange failed:',
      safeError(e)
    );

    res.status(500).json({
      error: safeError(e)
    });
  }
});

const transactionText = t =>
  `${t.merchant_name || ''} ${t.name || ''} ${t.original_description || ''}`
    .toLowerCase();

const financeCategory = t => {
  const p = t.personal_finance_category || {};

  return {
    primary: String(p.primary || '').toUpperCase(),
    detailed: String(p.detailed || '').toUpperCase()
  };
};

const cents = n =>
  Math.round(
    Math.abs(Number(n || 0)) * 100
  );

const dayDistance = (a, b) => {
  const da = new Date(`${a}T12:00:00Z`).getTime();
  const db = new Date(`${b}T12:00:00Z`).getTime();

  if (!Number.isFinite(da) || !Number.isFinite(db)) {
    return 999;
  }

  return Math.abs(da - db) / 86400000;
};

function matchingCounterpart(t, allPosted) {
  const amount = Number(t.amount || 0);
  if (!amount) return null;

  return allPosted.find(other =>
    other.transaction_id !== t.transaction_id &&
    other.account_id !== t.account_id &&
    Number(other.amount || 0) * amount < 0 &&
    cents(other.amount) === cents(amount) &&
    dayDistance(other.date, t.date) <= 3
  ) || null;
}

function isChurchTithing(t) {
  const name = transactionText(t);

  return /church of jesus christ|the church of jesus christ|lds church|church donations?|tithing/
    .test(name);
}

function isVenmoRent(t) {
  return (
    Number(t.amount || 0) >= 1000 &&
    /\bvenmo\b/.test(transactionText(t))
  );
}

function isCreditCardPayment(
  t,
  allPosted,
  accountMetaById
) {
  if (Number(t.amount || 0) <= 0) {
    return false;
  }

  const { detailed } = financeCategory(t);
  const name = transactionText(t);

  if (
    /\b4321\b/.test(name) ||
    /\bdiscover\b/.test(name)
  ) {
    return true;
  }

  if (detailed.includes('CREDIT_CARD_PAYMENT')) {
    return true;
  }

  const other = matchingCounterpart(t, allPosted);

  if (!other) return false;

  const meta = accountMetaById[other.account_id] || {};

  const metaName =
    `${meta.name || ''} ${meta.official_name || ''}`.toLowerCase();

  return (
    meta.mask === '4321' ||
    meta.type === 'credit' ||
    /\bdiscover\b/.test(metaName)
  );
}

function isInternalAccountTransfer(
  t,
  allPosted
) {
  if (Number(t.amount || 0) <= 0) {
    return false;
  }

  const { primary, detailed } = financeCategory(t);

  if (
    primary === 'TRANSFER_IN' ||
    primary === 'TRANSFER_OUT' ||
    primary === 'TRANSFER'
  ) {
    return true;
  }

  if (
    detailed.includes('TRANSFER_IN') ||
    detailed.includes('TRANSFER_OUT') ||
    detailed.includes('ACCOUNT_TRANSFER') ||
    detailed.includes('BANK_TRANSFER')
  ) {
    return true;
  }

  return !!matchingCounterpart(t, allPosted);
}

const appCategory = (
  t,
  allPosted,
  accountMetaById
) => {
  const { primary, detailed } = financeCategory(t);
  const name = transactionText(t);

  // User rule: Walmart is always groceries, regardless of Plaid's category.
  if (/\bwalmart\b/.test(name)) {
    return 'Groceries';
  }

  if (isChurchTithing(t)) {
    return 'Tithing';
  }

  if (isVenmoRent(t)) {
    return 'Rent';
  }

  if (
    isCreditCardPayment(
      t,
      allPosted,
      accountMetaById
    )
  ) {
    return 'Card Payment';
  }

  if (isInternalAccountTransfer(t, allPosted)) {
    return 'Transfer';
  }

  if (primary === 'FOOD_AND_DRINK') {
    if (
      detailed.includes('GROCER') ||
      /costco|smith|maceys|target/.test(name)
    ) {
      return 'Groceries';
    }

    return 'Eating Out / Date Nights';
  }

  if (primary === 'TRANSPORTATION') {
    return (
      /gas|fuel|chevron|shell|maverik|costco/.test(name)
        ? 'Gas'
        : 'Transportation'
    );
  }

  if (primary === 'RENT_AND_UTILITIES') {
    if (
      detailed.includes('RENT') ||
      /\brent\b|landlord|apartment|property management/.test(name)
    ) {
      return 'Rent';
    }

    return 'Utilities (Phone, Internet, Electric)';
  }

  if (primary === 'MEDICAL') {
    return 'Health / Medical';
  }

  if (primary === 'GENERAL_MERCHANDISE') {
    return 'Household Misc';
  }

  if (primary === 'ENTERTAINMENT') {
    return 'Fun Money';
  }

  if (primary === 'PERSONAL_CARE') {
    return 'Household Misc';
  }

  return 'Household Misc';
};

function txToMoneyHQ(
  t,
  accountNameById,
  allPosted,
  accountMetaById
) {
  return {
    plaidId: t.transaction_id,
    date: t.date,
    amt: Math.round(Number(t.amount) * 100) / 100,
    cat: appCategory(
      t,
      allPosted,
      accountMetaById
    ),
    who: 'Joint',
    desc:
      t.merchant_name ||
      t.name ||
      'Bank transaction',
    pay:
      accountNameById[t.account_id] ||
      'Checking',
    note: 'Plaid import'
  };
}

function isIncomeTransaction(
  t,
  allPosted
) {
  const { primary, detailed } = financeCategory(t);

  if (
    primary === 'TRANSFER_IN' ||
    primary === 'TRANSFER_OUT' ||
    primary === 'TRANSFER' ||
    detailed.includes('TRANSFER_IN') ||
    detailed.includes('TRANSFER_OUT') ||
    detailed.includes('ACCOUNT_TRANSFER') ||
    detailed.includes('BANK_TRANSFER')
  ) {
    return false;
  }

  if (matchingCounterpart(t, allPosted)) {
    return false;
  }

  if (primary === 'INCOME') {
    return true;
  }

  const name = String(
    t.merchant_name ||
    t.name ||
    ''
  );

  return /\b(payroll|paycheck|salary|wages|direct deposit)\b/i
    .test(name);
}

function txToIncome(
  t,
  accountNameById
) {
  return {
    plaidId: t.transaction_id,
    week: t.date,
    date: t.date,
    who:
      t.merchant_name ||
      t.name ||
      'Income',
    amount:
      Math.round(
        Math.abs(Number(t.amount)) * 100
      ) / 100,
    account:
      accountNameById[t.account_id] ||
      'Bank',
    note: 'Plaid income'
  };
}

function accountBalance(a) {
  const raw =
    a?.balances?.current ??
    a?.balances?.available ??
    0;

  return Number(raw || 0);
}

function accountText(a) {
  return `${a._institution || ''} ${a.name || ''} ${a.official_name || ''} ${a.subtype || ''}`
    .toLowerCase();
}

function countsTowardGoal(a) {
  const text = accountText(a);

  return (
    /fidelity/.test(text) ||
    /12\s*(?:month|mo).*add(?:-|\s)?on/.test(text)
  );
}

function accountLabel(a) {
  const institution = a._institution || 'Bank';
  const name = a.name || a.official_name || 'Account';
  const mask = a.mask ? ` ••••${a.mask}` : '';

  return `${institution} — ${name}${mask}`;
}

function mergeAccount(map, a, institution) {
  if (!a?.account_id) return;

  const existing = map.get(a.account_id) || {};

  map.set(a.account_id, {
    ...existing,
    ...a,
    balances: {
      ...(existing.balances || {}),
      ...(a.balances || {})
    },
    _institution: institution || a._institution || existing._institution || 'Bank'
  });
}

app.post(
  '/api/plaid/sync',
  async (req, res) => {
    try {
      const items = await getItems();

      if (!items.length) {
        return res.status(409).json({
          error: 'No bank is connected yet.'
        });
      }

      const requestFull =
        String(req.query.full || '') === '1';

      const allAdded = [];
      const allModified = [];
      const removed = [];
      const accountMap = new Map();
      const warnings = [];

      let transactionsStatus = null;

      for (const item of items) {
        const forceFull =
          requestFull ||
          Number(item.classification_version || 0) < CLASSIFICATION_VERSION;

        console.log(
          `[Plaid] Sync started: ${item.institution || item.item_id}` +
          (forceFull ? ' (full backfill)' : '')
        );

        let nextCursor = forceFull
          ? undefined
          : (item.cursor || undefined);

        let itemTransactionsWorked = true;

        try {
          let hasMore = true;

          while (hasMore) {
            const r = await plaid.transactionsSync({
              access_token: item.access_token,
              cursor: nextCursor,
              count: 500
            });

            allAdded.push(...r.data.added);
            allModified.push(...r.data.modified);
            removed.push(...r.data.removed);

            transactionsStatus =
              r.data.transactions_update_status ||
              transactionsStatus;

            nextCursor = r.data.next_cursor;
            hasMore = r.data.has_more;
          }
        } catch (e) {
          itemTransactionsWorked = false;
          warnings.push(
            `${item.institution || 'Institution'} transactions: ${safeError(e)}`
          );

          console.warn(
            `[Plaid] Transactions unavailable for ${item.institution || item.item_id}:`,
            errorCode(e) || safeError(e)
          );
        }

        try {
          const ar = await plaid.accountsGet({
            access_token: item.access_token
          });

          ar.data.accounts.forEach(a =>
            mergeAccount(
              accountMap,
              a,
              item.institution
            )
          );

          // If this Item contains an investment account (or is Fidelity), try to
          // initialize/read Investments Holdings. This is what lets Fidelity assets
          // count toward the house goal when Plaid makes the product available.
          const mayHaveInvestments =
            /fidelity/i.test(item.institution || '') ||
            ar.data.accounts.some(a => a.type === 'investment');

          if (mayHaveInvestments) {
            try {
              const ir = await plaid.investmentsHoldingsGet({
                access_token: item.access_token
              });

              (ir.data.accounts || []).forEach(a =>
                mergeAccount(
                  accountMap,
                  a,
                  item.institution
                )
              );
            } catch (e) {
              warnings.push(
                `${item.institution || 'Investment institution'} holdings: ${safeError(e)}`
              );

              console.warn(
                `[Plaid] Investment holdings unavailable for ${item.institution || item.item_id}:`,
                errorCode(e) || safeError(e)
              );
            }
          }
        } catch (e) {
          warnings.push(
            `${item.institution || 'Institution'} accounts: ${safeError(e)}`
          );

          console.warn(
            `[Plaid] Accounts unavailable for ${item.institution || item.item_id}:`,
            errorCode(e) || safeError(e)
          );
        }

        await updateItem(item.item_id, {
          cursor: itemTransactionsWorked ? (nextCursor || item.cursor || null) : item.cursor,
          last_sync: new Date().toISOString(),
          classification_version: CLASSIFICATION_VERSION
        });
      }

      const accountMetaById =
        Object.fromEntries(accountMap.entries());

      const accountNameById =
        Object.fromEntries(
          [...accountMap.entries()].map(
            ([id, a]) => [id, a.name || a.official_name || 'Account']
          )
        );

      const changedPosted = [
        ...allAdded,
        ...allModified
      ].filter(t => !t.pending);

      const spend =
        changedPosted.filter(
          t => Number(t.amount) > 0
        );

      const incomePosted =
        changedPosted.filter(
          t =>
            Number(t.amount) < 0 &&
            isIncomeTransaction(
              t,
              changedPosted
            )
        );

      const classifiedOutgoing =
        spend.map(t => ({
          raw: t,
          app:
            txToMoneyHQ(
              t,
              accountNameById,
              changedPosted,
              accountMetaById
            )
        }));

      const excludedOutgoing =
        classifiedOutgoing.filter(
          x =>
            x.app.cat === 'Transfer' ||
            x.app.cat === 'Card Payment'
        );

      const tx =
        classifiedOutgoing
          .filter(
            x =>
              x.app.cat !== 'Transfer' &&
              x.app.cat !== 'Card Payment'
          )
          .map(x => x.app);

      const income =
        incomePosted.map(
          t =>
            txToIncome(
              t,
              accountNameById
            )
        );

      const today =
        new Date()
          .toISOString()
          .slice(0, 10);

      const linkedAccounts =
        [...accountMap.values()];

      const assets =
        linkedAccounts
          .filter(
            a =>
              a.type !== 'credit' &&
              a.type !== 'loan'
          )
          .map(a => ({
            plaidAccountId: a.account_id,
            asOf: today,
            cat:
              a.type === 'depository'
                ? 'Cash & Savings'
                : (
                    a.type === 'investment'
                      ? 'Investments'
                      : 'Linked account'
                  ),
            acct: accountLabel(a),
            bal: accountBalance(a),
            house: countsTowardGoal(a),
            institution: a._institution || 'Bank',
            note: 'Synced from Plaid'
          }));

      const debts =
        linkedAccounts
          .filter(
            a =>
              a.type === 'credit' ||
              a.type === 'loan'
          )
          .map(a => ({
            plaidAccountId: a.account_id,
            asOf: today,
            name: accountLabel(a),
            bal: Math.max(0, accountBalance(a)),
            institution: a._institution || 'Bank',
            note: 'Synced from Plaid'
          }));

      const institutions =
        [...new Set(
          items
            .map(x => x.institution)
            .filter(Boolean)
        )];

      res.json({
        tx,
        income,
        accounts: assets,
        debts,
        removed: [
          ...new Set([
            ...removed.map(x => x.transaction_id),
            ...excludedOutgoing.map(
              x => x.raw.transaction_id
            )
          ])
        ],
        syncedAt: new Date().toISOString(),
        institution:
          institutions.length === 1
            ? institutions[0]
            : `${institutions.length} institutions`,
        institutions,
        itemCount: items.length,
        transactionsStatus,
        warnings
      });

      console.log(
        `[Plaid] Sync complete: ${items.length} items, ${linkedAccounts.length} accounts, ` +
        `${tx.length} spending rows, ${excludedOutgoing.length} transfers/card payments hidden, ` +
        `${income.length} income deposits, ${debts.length} debt accounts, ` +
        `${assets.filter(a => a.house).length} goal accounts`
      );
    } catch (e) {
      console.error(
        '[Plaid] Sync failed:',
        safeError(e)
      );

      res.status(500).json({
        error: safeError(e)
      });
    }
  }
);

app.get(
  '*',
  (_req, res) =>
    res.sendFile(
      new URL(
        './index.html',
        import.meta.url
      ).pathname
    )
);

const port =
  Number(
    process.env.PORT || 3000
  );

initDb()
  .then(() =>
    app.listen(
      port,
      '0.0.0.0',
      () =>
        console.log(
          `Money HQ listening on ${port} (${plaidEnv})`
        )
    )
  )
  .catch(err => {
    console.error(
      'Database initialization failed:',
      err
    );

    process.exit(1);
  });
