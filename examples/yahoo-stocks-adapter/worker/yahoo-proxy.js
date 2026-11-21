/**
 * Proxy for a hosted build of the stocks adapter.
 *
 * The adapter calls two same-origin routes because neither upstream sends CORS
 * headers:
 *
 *   /yh/v8/finance/chart/...        -> query1.finance.yahoo.com  (price data)
 *   /symdir/dynamic/SymDir/*.txt   -> www.nasdaqtrader.com      (symbol directory)
 *
 * Deploy on the same hostname (route `terminal.example.com/*`) or anywhere else
 * and point the adapter's `baseUrl` / `symDirBase` at it - the CORS header
 * below covers the second case.
 *
 *   npx wrangler deploy yahoo-proxy.js --name yahoo-proxy \
 *     --compatibility-date 2026-01-01
 *
 * Both upstreams answer 429 without a browser User-Agent. `cf.cacheTtl` keeps
 * repeat requests off their back: 15s for quotes, a week for the directory.
 */

const YAHOO = "https://query1.finance.yahoo.com";
const NASDAQ_TRADER = "https://www.nasdaqtrader.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    let upstreamUrl;
    let cacheTtl;
    let contentType = "application/json;charset=utf-8";

    if (url.pathname.startsWith("/yh/")) {
      upstreamUrl = YAHOO + url.pathname.slice(3) + url.search;
      cacheTtl = 15;
    } else if (url.pathname.startsWith("/symdir/")) {
      upstreamUrl = NASDAQ_TRADER + url.pathname.slice(7) + url.search;
      cacheTtl = 604800;
      contentType = "text/plain;charset=utf-8";
    } else {
      return json({ error: "Not found" }, 404);
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        cf: { cacheTtl, cacheEverything: true },
      });
    } catch (err) {
      return json({ error: `Upstream fetch failed: ${String(err)}` }, 502);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": contentType,
        "cache-control": upstream.ok ? `public, max-age=${cacheTtl}` : "no-store",
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
