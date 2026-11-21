import type {
  CandleRequest,
  ConnectionState,
  MarketDataSource,
  MarketEvent,
  OpenChartsAdapter,
  Quote,
  Unsubscribe,
} from "../../src/adapter/types.ts";
import type { Candle, Symbol } from "../../src/services/schemas.ts";

/**
 * A US-equities market-data adapter built on Yahoo Finance's public chart
 * endpoint. No API key, no account, no signup.
 *
 * The tradable universe comes from Nasdaq Trader's public symbol directory
 * (`nasdaqlisted.txt` + `otherlisted.txt`, ~6k common stocks and ~3.5k ETFs),
 * fetched once and cached in localStorage for a week. Six crypto pairs are
 * merged in alongside it. If the directory cannot be reached, the 16 core
 * names and the crypto pairs still load, so the terminal never boots empty.
 *
 * Yahoo does not send CORS headers, so the browser cannot call it directly.
 * Requests go to `/yh/...` on the same origin and are forwarded by
 *
 *   - the Vite dev server (see `server.proxy` in vite.config.ts), or
 *   - the Cloudflare Worker in ./worker/yahoo-proxy.js for a hosted build.
 *
 * Same for `/symdir/...` (Nasdaq Trader). Point `baseUrl` / `symDirBase` at the
 * proxies if they live somewhere else.
 *
 * Worth knowing before you trade off this:
 *   - Quotes are delayed (typically ~15 minutes for US equities), so this is a
 *     research and paper-trading feed, never an execution feed.
 *   - Yahoo rate-limits by IP and answers 429 if polled too hard; the poller
 *     backs off on its own, and only schedules symbols someone actually looks
 *     at — polling thousands of tickers is not possible or necessary.
 *   - Intraday history is bounded by Yahoo: 1m is 7 days, 5m/15m/30m about 60
 *     days, hourly about 2 years. Older requests come back empty rather than
 *     erroring, and the chart stops paging once a window is empty.
 */

const DAY_MS = 86_400_000;
const DEFAULT_BASE = "/yh";
const DEFAULT_SYM_DIR = "/symdir";

/** Ticker → company. The fallback universe, and the first screen of the list. */
const CORE: ReadonlyArray<readonly [ticker: string, company: string]> = [
  ["AAPL", "Apple"],
  ["MSFT", "Microsoft"],
  ["NVDA", "NVIDIA"],
  ["AMZN", "Amazon"],
  ["GOOGL", "Alphabet"],
  ["META", "Meta Platforms"],
  ["TSLA", "Tesla"],
  ["AMD", "Advanced Micro Devices"],
  ["AVGO", "Broadcom"],
  ["NFLX", "Netflix"],
  ["JPM", "JPMorgan Chase"],
  ["SPY", "SPDR S&P 500 ETF"],
  ["QQQ", "Invesco QQQ Trust"],
  ["COIN", "Coinbase"],
  ["PLTR", "Palantir"],
  ["IWM", "iShares Russell 2000 ETF"],
];

function stockSymbol(ticker: string, company: string, category = "STOCKS"): Symbol {
  return {
    id: ticker,
    name: ticker,
    displayName: company,
    // The chart's session shading keys off /stock|equit|etf/i, so this also
    // turns on the 09:30-16:00 New York session breaks.
    category,
    contractSize: 1,
    tickSize: 0.01,
    tickValue: 0.01,
    // Reg-T intraday: 25% of notional posted, i.e. 4x buying power.
    marginPercent: 25,
    maxLeverage: 4,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: "09:30",
    tradingHoursEnd: "16:00",
    isActive: true,
  };
}

export const STOCK_SYMBOLS: Symbol[] = CORE.map(([ticker, company]) => stockSymbol(ticker, company));

/**
 * Crypto pairs served by the same Yahoo chart endpoint. The terminal shows the
 * compact `BTCUSD` style name; Yahoo needs `BTC-USD`, so requests are mapped.
 */
const CRYPTO: ReadonlyArray<readonly [name: string, label: string, yahooTicker: string]> = [
  ["BTCUSD", "Bitcoin", "BTC-USD"],
  ["ETHUSD", "Ethereum", "ETH-USD"],
  ["SOLUSD", "Solana", "SOL-USD"],
  ["BNBUSD", "BNB", "BNB-USD"],
  ["XRPUSD", "XRP", "XRP-USD"],
  ["ADAUSD", "Cardano", "ADA-USD"],
];

const CRYPTO_TO_YAHOO = new Map(CRYPTO.map(([name, , yahoo]) => [name, yahoo]));
const CRYPTO_NAMES = new Set(CRYPTO.map(([name]) => name));

function cryptoSymbol(name: string, label: string): Symbol {
  return {
    ...stockSymbol(name, label, "CRYPTO"),
    // Crypto trades continuously; the 09:30–16:00 stock session breaks do not apply.
    tradingHoursStart: null,
    tradingHoursEnd: null,
  };
}

export const CRYPTO_SYMBOLS: Symbol[] = CRYPTO.map(([name, label]) => cryptoSymbol(name, label));

/** Everything available without the Nasdaq directory (fallback + first screen). */
export const BUILT_IN_SYMBOLS: Symbol[] = [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS];
const BUILT_IN_BY_NAME = new Map(BUILT_IN_SYMBOLS.map((spec) => [spec.name, spec]));

interface TimeframeSpec {
  /** Yahoo `interval` parameter. */
  interval: string;
  ms: number;
  /** Oldest bar Yahoo will serve for this interval. */
  maxLookbackMs: number;
  /** How far back to reach when a caller asks only for a bar count. */
  defaultLookbackMs: number;
}

const TIMEFRAMES: Record<string, TimeframeSpec> = {
  "1m": { interval: "1m", ms: 60_000, maxLookbackMs: 7 * DAY_MS, defaultLookbackMs: 2 * DAY_MS },
  "5m": { interval: "5m", ms: 300_000, maxLookbackMs: 59 * DAY_MS, defaultLookbackMs: 10 * DAY_MS },
  "15m": {
    interval: "15m",
    ms: 900_000,
    maxLookbackMs: 59 * DAY_MS,
    defaultLookbackMs: 20 * DAY_MS,
  },
  "30m": {
    interval: "30m",
    ms: 1_800_000,
    maxLookbackMs: 59 * DAY_MS,
    defaultLookbackMs: 30 * DAY_MS,
  },
  "1h": {
    interval: "60m",
    ms: 3_600_000,
    maxLookbackMs: 720 * DAY_MS,
    defaultLookbackMs: 120 * DAY_MS,
  },
  // Yahoo has no native 4h interval; hourly bars are folded into two blocks per
  // session (09:30-13:30 and 13:30-16:00 New York).
  "4h": {
    interval: "60m",
    ms: 14_400_000,
    maxLookbackMs: 720 * DAY_MS,
    defaultLookbackMs: 240 * DAY_MS,
  },
  "1d": {
    interval: "1d",
    ms: DAY_MS,
    maxLookbackMs: 30 * 365 * DAY_MS,
    defaultLookbackMs: 6 * 365 * DAY_MS,
  },
  "1w": {
    interval: "1wk",
    ms: 7 * DAY_MS,
    maxLookbackMs: 40 * 365 * DAY_MS,
    defaultLookbackMs: 12 * 365 * DAY_MS,
  },
};

/**
 * A market trades 6.5 hours a day, 5 days a week, so a calendar span needs to
 * be ~5.2x the bar span to yield the requested count. Round up to 6.
 */
const SESSION_PADDING = 6;

// ── Pure helpers (exported for tests) ─────────────────────

/** Translate a display symbol to the ticker Yahoo expects (crypto uses a dash). */
export function yahooTicker(symbol: string): string {
  return CRYPTO_TO_YAHOO.get(symbol) ?? symbol;
}

export function toYahooTicker(symbol: string): string | null {
  return BUILT_IN_BY_NAME.has(symbol) ? yahooTicker(symbol) : null;
}

export function buildChartUrl(
  request: CandleRequest,
  baseUrl = DEFAULT_BASE,
  nowMs = Date.now(),
  isKnown: (symbol: string) => boolean = (symbol) => BUILT_IN_BY_NAME.has(symbol),
): string | null {
  const spec = TIMEFRAMES[request.timeframe];
  if (!spec || !request.symbol || !isKnown(request.symbol)) return null;

  const earliest = nowMs - spec.maxLookbackMs;
  const spanMs = spec.ms * (request.limit ?? 0) * (spec.ms < DAY_MS ? SESSION_PADDING : 1.5);
  const from = Math.max(
    request.fromMs ?? (spanMs > 0 ? nowMs - spanMs : nowMs - spec.defaultLookbackMs),
    earliest,
  );
  const to = request.toMs ?? nowMs;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;

  const params = new URLSearchParams({
    period1: String(Math.floor(from / 1000)),
    period2: String(Math.ceil(to / 1000)),
    interval: spec.interval,
    includePrePost: "false",
  });
  return `${baseUrl}/v8/finance/chart/${encodeURIComponent(yahooTicker(request.symbol))}?${params.toString()}`;
}

interface YahooMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  shortName?: string;
}

interface YahooChartResult {
  meta?: YahooMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: { code?: string; description?: string } | null;
  };
}

export interface ParsedChart {
  candles: Candle[];
  meta: YahooMeta;
}

export function parseChartPayload(payload: unknown): ParsedChart {
  const body = payload as YahooChartResponse;
  const result = body?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const times = result?.timestamp ?? [];
  const candles: Candle[] = [];

  if (quote && times.length > 0) {
    for (let i = 0; i < times.length; i += 1) {
      const close = quote.close?.[i];
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const time = times[i];
      if (close == null || open == null || high == null || low == null || time == null) continue;
      candles.push({
        time,
        open,
        high,
        low,
        close,
        volume: quote.volume?.[i] ?? 0,
      });
    }
  }

  return { candles, meta: result?.meta ?? {} };
}

/**
 * Fold bars into fixed buckets aligned to each trading session's first bar, so
 * a 4h bar is 09:30-13:30 New York whether or not daylight saving is in force.
 */
export function aggregateBars(candles: Candle[], bucketSec: number): Candle[] {
  const out: Candle[] = [];
  let day = Number.NaN;
  let sessionStart = 0;

  for (const candle of candles) {
    const dayKey = Math.floor(candle.time / 86_400);
    if (dayKey !== day) {
      day = dayKey;
      sessionStart = candle.time;
    }
    const bucket =
      sessionStart + Math.floor(Math.max(0, candle.time - sessionStart) / bucketSec) * bucketSec;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      last.volume += candle.volume;
    } else {
      out.push({ ...candle, time: bucket });
    }
  }

  return out;
}

/** Bars after the fold, trimmed to the caller's window and bar count. */
function shapeSeries(candles: Candle[], request: CandleRequest): Candle[] {
  let series = request.timeframe === "4h" ? aggregateBars(candles, 14_400) : candles;
  if (request.fromMs != null) {
    const fromSec = Math.floor(request.fromMs / 1000);
    series = series.filter((c) => c.time >= fromSec);
  }
  if (request.toMs != null) {
    const toSec = Math.ceil(request.toMs / 1000);
    series = series.filter((c) => c.time < toSec);
  }
  if (request.limit != null && request.limit > 0) {
    series = series.slice(Math.max(0, series.length - request.limit));
  }
  return series;
}

// ── Symbol directory ──────────────────────────────────────

const UNIVERSE_CACHE_KEY = "opencharts.stock-universe.v1";
const UNIVERSE_TTL_MS = 7 * DAY_MS;

/** Names that are listed securities but not common stock worth charting. */
const NOT_COMMON = /warrant|right(s)?\b|\bunits?\b|preferred|depositary shares|%|notes due|debenture|when.issued/i;

export interface DirectoryRow {
  ticker: string;
  name: string;
  isEtf: boolean;
}

/** `nasdaqlisted.txt`: Symbol|Security Name|Market Category|Test Issue|...|ETF|NextShares */
export function parseNasdaqListed(text: string): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("|");
    if (cols.length < 8) continue; // header, footer, blank
    const [ticker, name, , testIssue, , , etf] = cols;
    if (!ticker || !name || ticker === "Symbol" || testIssue !== "N") continue;
    const clean = ticker.trim();
    if (!clean || !/^[A-Z]{1,5}$/.test(clean)) continue;
    rows.push({ ticker: clean, name: name.trim(), isEtf: etf === "Y" });
  }
  return rows;
}

/** `otherlisted.txt`: ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|...|Test Issue|NASDAQ Symbol */
export function parseOtherListed(text: string): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("|");
    if (cols.length < 8) continue;
    const [actSymbol, name, , , etf, , testIssue] = cols;
    if (!actSymbol || !name || actSymbol === "ACT Symbol" || testIssue !== "N") continue;
    // Yahoo spells class shares with a dash: BRK.B -> BRK-B.
    const clean = actSymbol.trim().replace(/\./g, "-");
    if (!clean || !/^[A-Z]{1,5}(-[A-Z])?$/.test(clean)) continue;
    rows.push({ ticker: clean, name: name.trim(), isEtf: etf === "Y" });
  }
  return rows;
}

/** Common stock + ETFs, de-duplicated, with the junk filtered out. */
export function toUniverse(rows: readonly DirectoryRow[]): Symbol[] {
  const seen = new Set<string>();
  const out: Symbol[] = [];
  for (const row of rows) {
    if (seen.has(row.ticker)) continue;
    if (!row.isEtf && NOT_COMMON.test(row.name)) continue;
    seen.add(row.ticker);
    out.push(stockSymbol(row.ticker, row.name, row.isEtf ? "ETFS" : "STOCKS"));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Nasdaq directory has no crypto rows; append our fixed pairs to every universe. */
function withCrypto(symbols: readonly Symbol[]): Symbol[] {
  const seen = new Set(symbols.map((spec) => spec.name));
  return [...symbols, ...CRYPTO_SYMBOLS.filter((spec) => !seen.has(spec.name))];
}

interface CachedUniverse {
  at: number;
  symbols: Array<{ t: string; n: string; e: boolean }>;
}

function readUniverseCache(): Symbol[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(UNIVERSE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUniverse;
    if (!parsed?.at || Date.now() - parsed.at > UNIVERSE_TTL_MS) return null;
    if (!Array.isArray(parsed.symbols) || parsed.symbols.length === 0) return null;
    return withCrypto(parsed.symbols.map((row) => stockSymbol(row.t, row.n, row.e ? "ETFS" : "STOCKS")));
  } catch {
    return null;
  }
}

function writeUniverseCache(symbols: Symbol[]): void {
  try {
    const payload: CachedUniverse = {
      at: Date.now(),
      // Crypto is re-added by withCrypto on read, keeping its 24/7 metadata.
      symbols: symbols
        .filter((s) => !CRYPTO_NAMES.has(s.name))
        .map((s) => ({
          t: s.name,
          n: s.displayName ?? s.name,
          e: s.category === "ETFS",
        })),
    };
    globalThis.localStorage?.setItem(UNIVERSE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or private mode: the directory just gets fetched again next boot.
  }
}

/**
 * The full US listing directory. Cached for a week because the file only
 * changes when companies list or delist; throws if neither the cache nor the
 * network can supply it, and the caller falls back to the core names.
 */
export async function loadStockUniverse(options: {
  fetchImpl?: typeof fetch;
  symDirBase?: string;
} = {}): Promise<Symbol[]> {
  const cached = readUniverseCache();
  if (cached) return cached;

  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = options.symDirBase ?? DEFAULT_SYM_DIR;
  const [nasdaq, other] = await Promise.all([
    doFetch(`${base}/dynamic/SymDir/nasdaqlisted.txt`),
    doFetch(`${base}/dynamic/SymDir/otherlisted.txt`),
  ]);
  if (!nasdaq.ok || !other.ok) {
    throw new Error(`Symbol directory failed: ${nasdaq.status}/${other.status}`);
  }

  const rows = [
    ...parseNasdaqListed(await nasdaq.text()),
    ...parseOtherListed(await other.text()),
  ];
  const symbols = withCrypto(toUniverse(rows));
  if (symbols.length === 0) throw new Error("Symbol directory was empty");
  writeUniverseCache(symbols);
  return symbols;
}

// ── Feed ──────────────────────────────────────────────────

const LIVE_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;

interface Snapshot {
  /** Today's 1-minute bars, oldest first. */
  candles: Candle[];
  price: number;
  previousClose: number | null;
}

export interface StockFeedOptions {
  /** Restrict the universe to these tickers and skip the directory. */
  symbols?: string[];
  /** Inject a universe outright (tests). */
  universe?: Symbol[];
  /** Skip the Nasdaq Trader directory and use `universe`/`symbols`/the core list. */
  offline?: boolean;
  /** Origin of the Yahoo proxy. Defaults to the same-origin `/yh`. */
  baseUrl?: string;
  /** Origin of the Nasdaq Trader directory proxy. Defaults to `/symdir`. */
  symDirBase?: string;
  fetchImpl?: typeof fetch;
  /** Poll cadence for symbols the terminal reports as on screen. */
  hotIntervalMs?: number;
  /** Poll cadence for symbols viewed recently. Everything else is polled on demand. */
  coldIntervalMs?: number;
  now?: () => number;
}

export interface StockFeed extends MarketDataSource {
  /** Fan out one extra poll, e.g. right after the user clicks a watchlist row. */
  refresh(symbol?: string): void;
}

export function createStockFeed(options: StockFeedOptions = {}): StockFeed {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  const symDirBase = options.symDirBase ?? DEFAULT_SYM_DIR;
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const clock = options.now ?? Date.now;
  const hotIntervalMs = options.hotIntervalMs ?? 10_000;
  const coldIntervalMs = options.coldIntervalMs ?? 60_000;

  let specs: Symbol[] = options.universe ?? buildInitialUniverse(options);
  let byName = new Map(specs.map((spec) => [spec.name, spec]));
  let names = specs.map((spec) => spec.name);
  let universeSettled = options.offline === true || options.universe != null || options.symbols != null;

  const handlers = new Set<(event: MarketEvent) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const snapshots = new Map<string, { at: number; snapshot: Snapshot }>();
  const inflight = new Map<string, Promise<Snapshot>>();
  /** Only symbols someone is looking at are scheduled; the rest are fetched on demand. */
  const scheduled = new Map<string, number>();

  let state: ConnectionState = "disconnected";
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let backoffUntil = 0;
  let hot = new Set<string>([names[0] ?? ""]);
  const recent = new Set<string>();

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error("[yahoo-stocks] connection listener threw", err);
      }
    }
  };

  const emit = (event: MarketEvent) => {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error("[yahoo-stocks] subscriber threw", err);
      }
    }
  };

  const install = (next: Symbol[]) => {
    specs = next;
    byName = new Map(next.map((spec) => [spec.name, spec]));
    names = next.map((spec) => spec.name);
  };

  const ensureUniverse = async (): Promise<Symbol[]> => {
    if (universeSettled) return specs;
    universeSettled = true;
    try {
      const loaded = await loadStockUniverse({ fetchImpl: doFetch, symDirBase });
      if (loaded.length > 0) install(loaded);
    } catch (err) {
      console.warn("[yahoo-stocks] symbol directory unavailable; using the core list", err);
    }
    return specs;
  };

  const fetchSnapshot = async (symbol: string, maxAgeMs = 2_000): Promise<Snapshot> => {
    const cached = snapshots.get(symbol);
    if (cached && clock() - cached.at < maxAgeMs) return cached.snapshot;

    const pending = inflight.get(symbol);
    if (pending) return pending;

    const params = new URLSearchParams({
      period1: String(Math.floor((clock() - 2 * DAY_MS) / 1000)),
      period2: String(Math.ceil(clock() / 1000)),
      interval: "1m",
      includePrePost: "false",
    });
    const url = `${baseUrl}/v8/finance/chart/${encodeURIComponent(yahooTicker(symbol))}?${params.toString()}`;

    const task = (async (): Promise<Snapshot> => {
      const response = await doFetch(url);
      if (!response.ok) {
        throw new Error(`Yahoo chart ${symbol} failed: ${response.status} ${response.statusText}`);
      }
      const parsed = parseChartPayload(await response.json());
      const price = parsed.meta.regularMarketPrice ?? parsed.candles.at(-1)?.close ?? 0;
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Yahoo chart ${symbol} returned no price`);
      }
      const snapshot: Snapshot = {
        candles: parsed.candles,
        price,
        previousClose: parsed.meta.chartPreviousClose ?? parsed.meta.previousClose ?? null,
      };
      snapshots.set(symbol, { at: clock(), snapshot });
      return snapshot;
    })();

    inflight.set(symbol, task);
    try {
      return await task;
    } finally {
      inflight.delete(symbol);
    }
  };

  /**
   * One poll = one tick + the current bar of every timeframe, all built from
   * the same 1-minute series. Aggregating locally keeps the request count at
   * one per symbol per poll no matter how many charts are open.
   */
  const publishSnapshot = (symbol: string, snapshot: Snapshot) => {
    const now = clock();
    emit({
      type: "tick",
      symbol,
      bid: snapshot.price - 0.005,
      ask: snapshot.price + 0.005,
      timestamp: now,
    });

    const lastCandle = snapshot.candles.at(-1);
    if (!lastCandle) return;
    const sessionDay = Math.floor(lastCandle.time / 86_400);
    const today = snapshot.candles.filter((c) => Math.floor(c.time / 86_400) === sessionDay);

    for (const timeframe of LIVE_TIMEFRAMES) {
      const bucketSec = timeframe === "1d" ? 86_400 : TIMEFRAMES[timeframe]!.ms / 1000;
      const bar = aggregateBars(today, bucketSec).at(-1);
      if (!bar) continue;
      emit({
        type: "candle",
        symbol,
        timeframe,
        // Fold the latest price into the open bucket so the bar tracks the tick.
        open: bar.open,
        high: Math.max(bar.high, snapshot.price),
        low: Math.min(bar.low, snapshot.price),
        close: snapshot.price,
        volume: bar.volume,
        timestamp: bar.time * 1000,
      });
    }
  };

  const pollOne = async (symbol: string) => {
    try {
      const snapshot = await fetchSnapshot(symbol, 0);
      publishSnapshot(symbol, snapshot);
      backoffUntil = 0;
      setState("connected");
    } catch (err) {
      console.warn("[yahoo-stocks] poll failed", symbol, err);
      // Yahoo rate-limits by IP. Pause the poller rather than hammering it.
      backoffUntil = clock() + 60_000;
      setState("reconnecting");
    } finally {
      if (hot.has(symbol)) scheduled.set(symbol, clock() + hotIntervalMs);
      else if (recent.has(symbol)) scheduled.set(symbol, clock() + coldIntervalMs);
      else scheduled.delete(symbol);
    }
  };

  const tick = () => {
    if (busy) return;
    const now = clock();
    if (now < backoffUntil) return;

    let due: string | null = null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [symbol, at] of scheduled) {
      if (at <= now && at < earliest) {
        earliest = at;
        due = symbol;
      }
    }
    if (!due) return;

    busy = true;
    void pollOne(due).finally(() => {
      busy = false;
    });
  };

  return {
    getSymbols: () => ensureUniverse(),

    getCandles: async (request: CandleRequest): Promise<Candle[]> => {
      await ensureUniverse();
      const url = buildChartUrl(request, baseUrl, clock(), (symbol) => byName.has(symbol));
      if (!url) return [];
      const response = await doFetch(url);
      if (!response.ok) {
        throw new Error(`Yahoo chart ${request.symbol} failed: ${response.status} ${response.statusText}`);
      }
      const parsed = parseChartPayload(await response.json());
      return shapeSeries(parsed.candles, request);
    },

    getQuote: async (symbol: string): Promise<Quote | null> => {
      await ensureUniverse();
      if (!byName.has(symbol)) return null;
      try {
        const snapshot = await fetchSnapshot(symbol);
        return {
          symbol,
          bid: snapshot.price - 0.005,
          ask: snapshot.price + 0.005,
          timestamp: clock(),
        };
      } catch {
        return null;
      }
    },

    subscribe: (handler: (event: MarketEvent) => void): Unsubscribe => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    connect: () => {
      if (timer) return;
      setState("connecting");
      // Prime only what is on screen. The other ~11,000 listings get a price
      // when someone opens them - polling the directory would be 150 req/s.
      for (const symbol of hot) scheduled.set(symbol, 0);
      for (const symbol of recent) scheduled.set(symbol, clock() + 1_000);
      timer = setInterval(tick, 1_000);
      void Promise.resolve().then(tick);
    },

    disconnect: () => {
      if (timer) clearInterval(timer);
      timer = null;
      busy = false;
      scheduled.clear();
      setState("disconnected");
    },

    onConnectionChange: (listener) => {
      stateListeners.add(listener);
      listener(state);
      return () => {
        stateListeners.delete(listener);
      };
    },

    getConnectionState: () => state,

    setSymbolInterest: (symbols: string[]) => {
      for (const symbol of hot) {
        recent.add(symbol);
        if (recent.size > 12) {
          const oldest = recent.values().next().value;
          if (oldest !== undefined) recent.delete(oldest);
        }
      }
      hot = new Set(symbols.filter((symbol) => byName.has(symbol)));
      for (const symbol of hot) scheduled.set(symbol, 0);
      for (const symbol of recent) {
        if (!hot.has(symbol) && !scheduled.has(symbol)) scheduled.set(symbol, clock() + 1_000);
      }
    },

    refresh: (symbol?: string) => {
      if (symbol) scheduled.set(symbol, 0);
      else for (const name of hot) scheduled.set(name, 0);
    },
  };
}

function buildInitialUniverse(options: StockFeedOptions): Symbol[] {
  if (options.symbols) {
    return options.symbols.map(
      (symbol) => BUILT_IN_BY_NAME.get(symbol) ?? stockSymbol(symbol, symbol),
    );
  }
  return BUILT_IN_SYMBOLS;
}

/**
 * The Yahoo feed with the bundled paper-trading engine behind it.
 *
 * The engine needs a price to mark positions and trigger resting orders, so
 * every tick is forwarded. Its whole universe is registered up front, otherwise
 * it would reject an order for AAPL as an unknown symbol.
 */
export async function createStockPaperAdapter(
  options: StockFeedOptions = {},
): Promise<OpenChartsAdapter> {
  const [{ createDemoAdapter }, engine] = await Promise.all([
    import("../../src/adapter/demo.ts"),
    import("../../src/services/demo/engine.ts"),
  ]);

  const marketData = createStockFeed(options);
  const paper = createDemoAdapter();

  engine.registerSymbols(await marketData.getSymbols());
  marketData.subscribe((event) => {
    if (event.type !== "tick") return;
    engine.mark(event.symbol, (event.bid + event.ask) / 2);
  });

  return {
    name: "yahoo-stocks-paper",
    marketData,
    trading: paper.trading,
    storage: paper.storage,
  };
}
