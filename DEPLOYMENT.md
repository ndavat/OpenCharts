# Deploying the stocks fork

Live site: **https://ndavat.github.io/OpenCharts/**

This fork runs the full US-equity/ETF terminal (Yahoo Finance data, ~11,000
symbols, paper trading) as a **static GitHub Pages** site. Three workflows do the
work:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `Deploy data proxy Worker` | push to `main` touching the Worker, or manual | Deploys `examples/yahoo-stocks-adapter/worker/yahoo-proxy.js` to Cloudflare. Serves `/yh/*` (Yahoo) and `/symdir/*` (Nasdaq Trader) with CORS. |
| `Deploy stocks terminal to Pages` | push to `main`, or manual | Builds with `VITE_ADAPTER=stocks`, `BASE_PATH=/OpenCharts/` and the proxy origin, then publishes `dist/` to Pages. |
| `Sync upstream` | daily 06:00 UTC, or manual | Merges `dylanpersonguy/OpenCharts@main` into a `sync/upstream` branch and opens/updates a PR. Conflicts are reported, never force-merged. |

## One-time setup

1. **Pages source.** In the fork: Settings → Pages → *Build and deployment* →
   Source: **GitHub Actions**.

2. **Cloudflare secrets.** Settings → Secrets and variables → Actions →
   *Repository secrets*:
   - `CLOUDFLARE_API_TOKEN` — a token with **Account:View** and
     **Workers Scripts:Edit** for the target account.
   - `CLOUDFLARE_ACCOUNT_ID` — the account ID from the Cloudflare dashboard.

3. **Deploy the Worker.** Run the **Deploy data proxy Worker** workflow
   (Actions → select it → *Run workflow*). Its log prints the deployed URL,
   e.g. `https://opencharts-proxy.<subdomain>.workers.dev`.

4. **Repository variable.** Settings → Secrets and variables → Actions →
   *Variables* → New repository variable:
   - Name: `PROXY_ORIGIN`
   - Value: the Worker origin from step 3, **no trailing slash**, e.g.
     `https://opencharts-proxy.<subdomain>.workers.dev`

5. **Rebuild the site.** Re-run **Deploy stocks terminal to Pages**. The origin
   is compiled into the bundle, so the site cannot use the Worker until it has
   been rebuilt with `PROXY_ORIGIN` set.

From then on, every push to `main` redeploys both as needed. Merging a
`Sync upstream` PR also triggers a fresh Pages deploy.

## Why a Worker is required

Yahoo Finance and Nasdaq Trader send no CORS headers, and Yahoo returns `429`
without a browser `User-Agent`. Locally, Vite's `server.proxy` forwards `/yh`
and `/symdir`. GitHub Pages is static — it cannot proxy — so the browser talks
to the Cloudflare Worker instead. `VITE_PROXY_ORIGIN` switches the adapter from
same-origin routes to the Worker's absolute URLs at build time, and
`VITE_CSP_EXTRA_CONNECT` adds that origin to the strict `connect-src` policy.

If `PROXY_ORIGIN` is unset, the site still builds and opens, but quotes and the
symbol directory stay empty. The local dev server is unaffected: `npm run dev`
keeps using the Vite proxies.

## Sync behaviour

The daily sync never writes to `main` directly. It merges upstream into a
throwaway `sync/upstream` branch, force-pushes that branch, and opens (or
refreshes) one PR. If the merge conflicts, the workflow aborts, leaves `main`
untouched, and writes manual resolution steps into the run summary. Our
stocks-specific files are ordinary commits on `main`, so they survive upstream
merges unless upstream edits the same lines.

To sync immediately, run **Sync upstream** with *Run workflow*.

## Local development

```sh
git remote -v        # upstream = dylanpersonguy, origin = ndavat fork
npm run dev          # http://localhost:5173, uses Vite's /yh + /symdir proxies
```

`.env.local` stays local (git-ignored) and currently sets `VITE_ADAPTER=stocks`.
To run the original demo build locally, change it to `VITE_ADAPTER=demo`.
