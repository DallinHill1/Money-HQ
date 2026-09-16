# Money HQ — Railway + Plaid

This repo is ready to upload to GitHub and deploy on Railway.

## Phone-only setup

1. Create a **private GitHub repo**.
2. Upload **all files/folders from this project** to that repo. Keep the `public` folder.
3. In Railway, create a project from the GitHub repo.
4. In the Railway project, add a **PostgreSQL** database service.
5. In your Money HQ web service, open **Variables** and add:
   - `PLAID_CLIENT_ID` = your Plaid client ID
   - `PLAID_SECRET` = your **new/rotated** Plaid secret
   - `PLAID_ENV` = `sandbox` while testing
6. Add/reference Railway's Postgres `DATABASE_URL` in the Money HQ web service. Railway usually exposes it from the Postgres service; use a service-variable reference if it is not already present.
7. In Railway, generate a public domain for the Money HQ web service.
8. Open that URL and tap **Connect bank**.

## Important

- Do **not** put your real Plaid secret in GitHub or in `public/index.html`.
- Because a Plaid secret was previously pasted into chat, rotate it before using real bank data.
- Start with `PLAID_ENV=sandbox`.
- This project stores the Plaid access token/cursor in Railway Postgres so it survives app redeploys/restarts.
- The app itself still stores its normal Money HQ budget data in browser storage, as the original app did.

## Health check

After deployment, opening `/api/health` on your Railway domain should return JSON showing `ok: true` when the required variables and database are configured.
