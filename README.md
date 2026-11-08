# injurybug

With every conference publishing injury reports for in-conference games, this repository scrapes college football conference availability reports into Cloudflare D1 and provides an API served by a Worker
(`api/`) that also hosts the React frontend (`web/`).

Needs Node 22+ and Python 3.11+.

## Run locally

No Cloudflare account needed; wrangler serves a local D1.

```sh
pip install -r requirements.txt
cd api && npm install && npm run db:migrate:local
cd ../web && npm install
cd .. && python -m scrapers.local_d1   # loads data/*.json into the local D1
```

Then `npm run dev` in `api/` (Worker on :8787) and `npm run dev` in `web/` (Vite, proxies `/api` to
the Worker). Or `npm run build` in `web/` and use the Worker alone at http://localhost:8787.

## Deploy your own

1. `npx wrangler d1 create injurybug` and put the returned `database_id` in `api/wrangler.jsonc`.
2. `npm run db:migrate:remote` in `api/`.
3. `npm run deploy` in `api/` builds `web/` and deploys to workers.dev. For a custom domain, put
   `DEPLOY_DOMAIN=injurybug.example.com` in `api/.env` (untracked); its zone must be on the same
   Cloudflare account.
4. For scheduled scrapes, set the `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and
   `D1_DATABASE_ID` repo secrets used by `.github/workflows/scrape.yml`.
