import { describe, expect, it, vi } from "vitest";
import {
  aggregateBars,
  buildChartUrl,
  createStockFeed,
  parseChartPayload,
  toYahooTicker,
} from "../../examples/yahoo-stocks-adapter/yahoo-stocks-adapter";

const HOUR = 3_600;
const DAY = 86_400;

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1) {
  return { time, open, high, low, close, volume };
}

const CHART = {
  chart: {
    result: [
      {
        meta: { regularMarketPrice: 342.56, chartPreviousClose: 340.1, symbol: "AAPL" },
        timestamp: [1_700_000_000, 1_700_000_060, 1_700_000_120],
        indicators: {
          quote: [
            {
              open: [340, null, 341],
              high: [341, null, 343],
              low: [339, null, 340],
              close: [340.5, null, 342.5],
              volume: [1000, null, 1200],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe("yahoo symbol mapping", () => {
  it("accepts known tickers and refuses anything else", () => {
    expect(toYahooTicker("AAPL")).toBe("AAPL");
    expect(toYahooTicker("BTCUSD")).toBeNull();
  });

  it("serves equities with stock metadata", async () => {
    const feed = createStockFeed({ symbols: ["AAPL", "SPY"] });
    const symbols = await feed.getSymbols();
    expect(symbols.map((s) => s.name)).toEqual(["AAPL", "SPY"]);
    for (const s of symbols) {
      expect(s.category).toBe("STOCKS");
      expect(s.tickSize).toBe(0.01);
      expect(s.tradingHoursStart).toBe("09:30");
    }
  });
});

describe("buildChartUrl", () => {
  const now = 1_700_000_000_000;

  it("passes the paging window through in seconds", () => {
    const fromMs = now - 30 * DAY * 1000; // within Yahoo's ~59-day 15m history
    const toMs = now;
    const url = buildChartUrl(
      { symbol: "AAPL", timeframe: "15m", fromMs, toMs },
      "/yh",
      now,
    )!;
    expect(url).toContain("/yh/v8/finance/chart/AAPL");
    expect(url).toContain(`period1=${Math.floor(fromMs / 1000)}`);
    expect(url).toContain(`period2=${Math.ceil(toMs / 1000)}`);
    expect(url).toContain("interval=15m");
    expect(url).toContain("includePrePost=false");
  });

  it("asks for 60m bars when the chart wants 4h, and folds them later", () => {
    const url = buildChartUrl({ symbol: "AAPL", timeframe: "4h" }, "/yh", now)!;
    expect(url).toContain("interval=60m");
  });

  it("clamps to the history Yahoo still serves", () => {
    // 1m history only reaches back 7 days, however far the caller asks.
    const url = buildChartUrl(
      { symbol: "AAPL", timeframe: "1m", fromMs: now - 400 * DAY * 1000, toMs: now },
      "/yh",
      now,
    )!;
    const period1 = Number(new URL(url, "https://x.test").searchParams.get("period1"));
    expect(now / 1000 - period1).toBeLessThanOrEqual(7 * DAY + 1);
  });

  it("returns null for unknown symbols, timeframes and empty windows", () => {
    expect(buildChartUrl({ symbol: "NOPE", timeframe: "1m" }, "/yh", now)).toBeNull();
    expect(buildChartUrl({ symbol: "AAPL", timeframe: "7s" }, "/yh", now)).toBeNull();
    expect(
      buildChartUrl({ symbol: "AAPL", timeframe: "1d", fromMs: now, toMs: now - 1000 }, "/yh", now),
    ).toBeNull();
  });
});

describe("parseChartPayload", () => {
  it("drops gap rows instead of emitting NaN candles", () => {
    const parsed = parseChartPayload(CHART);
    expect(parsed.candles).toHaveLength(2);
    expect(parsed.candles.map((c) => c.time)).toEqual([1_700_000_000, 1_700_000_120]);
    expect(parsed.meta.regularMarketPrice).toBe(342.56);
  });

  it("survives an empty response", () => {
    expect(parseChartPayload({ chart: { result: null } }).candles).toEqual([]);
  });
});

describe("aggregateBars", () => {
  it("folds hourly bars into two session blocks, summing volume", () => {
    const open = 1_699_000_000; // arbitrary session open, inside a single trading day
    const hourly = [
      bar(open, 100, 102, 99, 101, 10),
      bar(open + HOUR, 101, 103, 100, 102, 20),
      bar(open + 2 * HOUR, 102, 104, 101, 103, 30),
      bar(open + 3 * HOUR, 103, 105, 102, 104, 40),
      bar(open + 4 * HOUR, 104, 106, 103, 105, 50),
      bar(open + 5 * HOUR, 105, 107, 104, 106, 60),
    ];

    const folded = aggregateBars(hourly, 4 * HOUR);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toEqual({
      time: open,
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 100,
    });
    expect(folded[1]).toMatchObject({ time: open + 4 * HOUR, open: 104, close: 106, volume: 110 });
  });

  it("restarts the bucket grid on a new session", () => {
    const day1 = bar(1_700_000_000, 100, 101, 99, 100, 1);
    const day2 = bar(1_700_000_000 + DAY, 200, 201, 199, 200, 1);
    const folded = aggregateBars([day1, day2], 4 * HOUR);
    expect(folded.map((c) => c.time)).toEqual([day1.time, day2.time]);
  });
});

describe("createStockFeed", () => {
  it("maps chart JSON into candles through the injected fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => CHART,
    }) as unknown as typeof fetch;

    const feed = createStockFeed({ symbols: ["AAPL"], fetchImpl });
    const candles = await feed.getCandles({ symbol: "AAPL", timeframe: "1d", limit: 2 });

    expect(candles).toHaveLength(2);
    expect(candles[1]?.close).toBe(342.5);
  });

  it("surfaces a rate-limit failure instead of pretending the market is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    }) as unknown as typeof fetch;

    const feed = createStockFeed({ symbols: ["AAPL"], fetchImpl });
    await expect(feed.getCandles({ symbol: "AAPL", timeframe: "1d" })).rejects.toThrow(/429/);
  });

  it("answers a quote from the chart metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => CHART,
    }) as unknown as typeof fetch;

    const feed = createStockFeed({ symbols: ["AAPL"], fetchImpl });
    const quote = await feed.getQuote?.("AAPL");
    expect(quote?.bid).toBeCloseTo(342.555, 3);
    expect(quote?.ask).toBeCloseTo(342.565, 3);
  });
});
