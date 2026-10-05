# Money HQ — individual accounts

Money HQ now requires email/password login. Each account starts with a blank budget.
Budget state is saved in Railway PostgreSQL under the authenticated user's UUID;
Plaid connections and sync requests are restricted to the same user. The browser
keeps financial data in memory only and does not use old local/native financial caches.

## Deploy to the existing Railway service

Use the existing PostgreSQL database and existing Plaid settings. No new service or
paid authentication provider is required. Commit this project's files to the branch
that Railway deploys, and keep the start command `npm start`.

The existing Railway workspace is on Free, with Serverless enabled for the app
and PostgreSQL. The app closes idle database clients after ten seconds and retries
temporary startup connection failures while PostgreSQL wakes. Free includes only
$1 of monthly resource credit; usage above that can stop services. Sleeping reduces
idle costs but does not guarantee all projects fit within that allowance.

Required environment settings:

- `DATABASE_URL`: the existing Railway PostgreSQL connection.
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`: existing Plaid settings.
- `NODE_ENV=production` (never `test` on a deployed service).
- Optional `APP_ORIGIN`: the canonical HTTPS app origin, without a trailing slash.

The schema migration runs before the server starts and is repeatable. It creates
`app_users`, `app_sessions`, `user_budget_state`, and `auth_attempts`, and adds
`plaid_items.user_id` with a foreign key. Session tokens are random, stored as
hashes in PostgreSQL, and sent only in HttpOnly, Secure, SameSite cookies. Passwords
use salted scrypt (`N=16384,r=8,p=5`). Writes require a session-specific CSRF token.
Budgets use a version check so stale tabs cannot overwrite newer saves.

## Existing data

Existing shared Plaid connections are preserved with `user_id=NULL` and are
inaccessible through the app. They are never assigned to the first account that
registers, or claimed by an unverified email address. Existing browser data is
ignored and is not deleted or imported into another person's account.

After the owner has created and signed into their own account, an administrator
can verify that exact UUID and assign only the owner's legacy connections in the
database. Do not do this using signup order or an unverified email claim. New
users can connect their own banks immediately after signing in.

This version supports signup, login, logout, and seven-day sessions. It does not
yet provide email verification or email password recovery.

## Verify

Run `npm install` then `npm test`. Tests use an isolated PostgreSQL-compatible
database and simulated Plaid responses. They do not touch the production database
or bank accounts. Tests cover two-user isolation, login/logout/session expiry,
CSRF/origin checks, blank signup, shared connection quarantine, state persistence,
save conflicts, rate limiting, source-file protection, and frontend rendering.
