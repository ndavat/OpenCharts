# Yahoo stocks adapter

US equities in OpenCharts: candles, watchlist, indicators and drawing tools from
Yahoo Finance's public chart endpoint, with the bundled paper-trading engine
behind them. No API key, no account.

```
VITE_ADAPTER=stocks
```

That is the whole setup for local use — the Vite dev server proxies `/yh` to
`query1.finance.yahoo.com` and `/symdir` to `nasdaqtrader.com` for you (see
`server.proxy` in `vite.config.ts`), and `npm run preview` does the same for a
built `dist/`.

## Why a proxy

Yahoo serves its chart JSON without CORS headers, so a browser cannot call it
directly, and it answers `429` to requests that do not carry a browser
`User-Agent`. The adapter therefore requests `/yh/v8/finance/chart/...` on its
own origin:

- **dev / preview** — Vite forwards `/yh/*` and `/symdir/*` (already configured)
- **hosted** — deploy `worker/yahoo-proxy.js` as a Cloudflare Worker and either
  route it at `yourdomain.com/yh/*` and `yourdomain.com/symdir/*`, or host it
  separately and pass its origin:

```ts
createStockPaperAdapter({
  baseUrl: "https://yahoo-proxy.example.workers.dev/yh",
  symDirBase: "https://yahoo-proxy.example.workers.dev/symdir",
})
```

In a Vite build, set `VITE_PROXY_ORIGIN` to that origin instead — `Root.tsx`
passes both URLs to the adapter and adds the origin to the CSP. The GitHub Pages
fork uses this via repository variable `PROXY_ORIGIN`; see `DEPLOYMENT.md`.

```sh
npx wrangler deploy examples/yahoo-stocks-adapter/worker/yahoo-proxy.js \
  --name yahoo-proxy --compatibility-date 2026-01-01
```

## Universe

The full US equity/ETF directory — roughly 11,000 symbols — is downloaded on
first run from Nasdaq Trader's public text files:

- `nasdaqlisted.txt` — Nasdaq-listed issues
- `otherlisted.txt` — NYSE / NYSE American / ARCA / Cboe issues

The adapter fetches them through the same-origin `/symdir/*` proxy, filters out
test issues, warrants, rights, units and preferred shares, and converts
class-share dots to Yahoo dashes (`BRK.B` → `BRK-B`). The parsed directory is
cached in `localStorage` for 7 days, so later loads are instant. The 16 liquid
core names remain as a fallback if the directory cannot be reached: AAPL, MSFT,
NVDA, AMZN, GOOGL, META, TSLA, AMD, AVGO, NFLX, JPM, SPY, QQQ, COIN, PLTR, IWM.

You can narrow it at runtime with
`createStockPaperAdapter({ symbols: ["AAPL", "SPY"] })`. Every symbol must be a
valid Yahoo ticker (class shares use a dash: `BRK-B`, not `BRK.B`).

The watchlist and symbol picker cap the rows they paint (~200 and 20–50
respectively), so the full directory never stalls the UI. The picker leads with
familiar names when its search box is empty and shows a "keep typing" hint once
a query has more matches than it displays.

Symbols carry `category: "STOCKS"` or `"ETFS"`, which turns on:

- the 09:30–16:00 New York session breaks on intraday charts
- 2-decimal price formatting
- 25% margin (`marginPercent: 25`), i.e. 4x intraday buying power

## Timeframes

| Chart | Source | History available |
| --- | --- | --- |
| 1m | Yahoo `1m` | 7 days |
| 5m / 15m / 30m | Yahoo `5m` / `15m` / `30m` | ~60 days |
| 1h | Yahoo `60m` | ~2 years |
| 4h | folded from `60m` | ~2 years |
| 1d / 1w | Yahoo `1d` / `1wk` | full |

Yahoo has no 4h interval, so hourly bars are folded into two blocks per session,
aligned to the 09:30 open (09:30–13:30 and 13:30–16:00 New York). Buckets are
aligned per session rather than to a UTC boundary, so the split stays correct
across daylight-saving changes.

When you scroll past the available history the adapter returns an empty window
instead of erroring, and the chart stops paging.

## Live updates

One poll per symbol returns the day's 1-minute bars. From that single response
the feed emits:

- a **tick** for the last price (bid/ask are the price ± half a cent)
- a **candle** update for the open bar of every timeframe, aggregated locally

Polling follows interest, not the whole directory: the chart's focused symbol
every 10s, other "hot" symbols (favourites and recently viewed) every 60s, one
request at a time. The terminal reports the focused symbol through
`setSymbolInterest`, and the paper engine registers favourites through
`registerSymbols`. On a `429` the whole poller pauses for 60s and the connection
dot goes amber.

## Real and simulated

| | |
| --- | --- |
| Prices, candles, volume | real Yahoo data, **delayed** (typically ~15 min for US equities) |
| Orders, positions, P&L | simulated by the in-browser paper engine, $100,000 start |
| Bid/ask | derived from the last price, not a real book |

This is a research and paper-trading setup. Do not point it at real money.

## Tests

```sh
npx vitest run src/__tests__/yahoo-stocks-adapter.test.ts
```
