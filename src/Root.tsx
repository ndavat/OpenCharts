import { lazy, Suspense, useEffect, useState } from "react";
import { createDemoAdapter } from "./adapter/demo.ts";
import { OpenChartsProvider } from "./adapter/provider.tsx";
import type { OpenChartsAdapter } from "./adapter/types.ts";
import { chooseAdapter } from "./adapterChoice.ts";
import { Terminal } from "./terminal/Terminal.tsx";

/**
 * The hosted app's root.
 *
 * Deliberately what an integrator would write: install an adapter, render the
 * terminal. Everything else — query cache, market-data stream, notifications,
 * error boundary — comes from `<OpenChartsProvider>`.
 *
 * Which backend runs is chosen at build time:
 *  - `VITE_ADAPTER=hyperliquid`, or no `VITE_ADAPTER` with `VITE_HL_BUILDER_ADDRESS`
 *    set: the Hyperliquid broker (live markets, real wallet, real orders).
 *  - `VITE_ADAPTER=binance`: the live-market-data example from examples/binance-adapter.
 *  - `VITE_ADAPTER=stocks`: US equities from Yahoo Finance, via examples/yahoo-stocks-adapter.
 *  - `VITE_ADAPTER=demo`, or nothing configured: the bundled demo data.
 *
 * The non-demo adapters are loaded lazily, so none of them reaches the default
 * (demo) bundle.
 */

const choice = chooseAdapter(import.meta.env);

const HyperliquidApp = lazy(() => import("./hyperliquid/ui/HyperliquidApp.tsx"));

function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
      Loading…
    </div>
  );
}

/**
 * Local dev/preview uses Vite's same-origin `/yh` and `/symdir` proxies. Static
 * hosts (GitHub Pages) have no server, so they point both routes at the bundled
 * Cloudflare Worker via VITE_PROXY_ORIGIN. See DEPLOYMENT.md.
 */
function stockFeedOptions() {
  const origin = import.meta.env.VITE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  return {
    baseUrl:
      import.meta.env.VITE_YAHOO_PROXY_URL?.trim() || (origin ? `${origin}/yh` : undefined),
    symDirBase:
      import.meta.env.VITE_SYMDIR_PROXY_URL?.trim() || (origin ? `${origin}/symdir` : undefined),
  };
}

/** Loads whichever non-demo adapter the build selected. */
function loadSelectedAdapter(): Promise<OpenChartsAdapter> {
  if (choice === "binance") {
    return import("../examples/binance-adapter/binance-adapter.ts").then((m) =>
      m.createBinancePaperAdapter(),
    );
  }
  return import("../examples/yahoo-stocks-adapter/yahoo-stocks-adapter.ts").then((m) =>
    m.createStockPaperAdapter(stockFeedOptions()),
  );
}

function MarketOrDemo() {
  const live = choice === "binance" || choice === "stocks";
  const [adapter, setAdapter] = useState<OpenChartsAdapter | null>(() =>
    live ? null : createDemoAdapter(),
  );

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    loadSelectedAdapter()
      .then((next) => {
        if (!cancelled) setAdapter(next);
      })
      .catch((err: unknown) => {
        console.error(`[opencharts] failed to load the ${choice} adapter; using the demo`, err);
        if (!cancelled) setAdapter(createDemoAdapter());
      });
    return () => {
      cancelled = true;
    };
  }, [live]);

  if (!adapter) return null;
  return (
    <OpenChartsProvider adapter={adapter}>
      <Terminal />
    </OpenChartsProvider>
  );
}

export function Root() {
  if (choice === "hyperliquid") {
    return (
      <Suspense fallback={<Loading />}>
        <HyperliquidApp />
      </Suspense>
    );
  }
  return <MarketOrDemo />;
}
