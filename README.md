# Money HQ — Railway + Plaid (Blank Build)

This build contains **no preloaded personal financial data**. On a fresh browser/origin it starts with:

- no transactions
- no linked-account balances
- no income history
- no debts, sinking funds, subscriptions, or goal events
- zero-dollar generic budget category labels only

After Plaid is connected, posted purchases and linked account balances populate from the bank feed.

## Railway variables

Add these to the Money HQ service:

- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV=sandbox` while testing
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PORT=3000` if your Railway public domain is targeting port 3000

Do not commit a `.env` file or Plaid secret to GitHub.

## Railway build

There is intentionally no `railway.toml`. Railway should detect `package.json` as a Node app and run `npm start`.

## Updating an existing GitHub repo

Replace `index.html` and `server.js` with the versions in this package, and delete `railway.toml` if your repo still has one. Commit the changes; Railway should redeploy automatically.
