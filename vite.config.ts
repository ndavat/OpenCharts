import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { buildCsp, buildHeadersFile, extraConnectFromEnv } from "./src/hyperliquid/compliance/csp.ts";

/**
 * Production-only security headers. The strict CSP is injected as a <meta> tag
 * (so it also applies on hosts that cannot set headers) and a matching
 * dist/_headers is written. Dev is untouched: the dev server needs inline
 * scripts and a websocket for HMR, which a strict CSP would break.
 */
function securityHeaders(): Plugin {
  let csp = "";
  let headersFile = "";
  let outDir = "";
  return {
    name: "openbroker-security-headers",
    apply: "build",
    configResolved(config) {
      const env = loadEnv(config.mode, config.root, ["VITE_"]);
      const opts = {
        extraConnect: extraConnectFromEnv(env),
        allowTradingView: env.VITE_CSP_ALLOW_TRADINGVIEW === "1",
      };
      csp = buildCsp(opts);
      headersFile = buildHeadersFile(opts);
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml() {
      return [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" },
      ];
    },
    closeBundle() {
      // Same policy plus header-only directives; replaces the static public/_headers copy.
      if (fs.existsSync(outDir)) fs.writeFileSync(path.join(outDir, "_headers"), headersFile);
    },
  };
}

/**
 * Yahoo Finance rejects requests without a browser User-Agent (it answers 429),
 * and it sends no CORS headers, so the equities adapter talks to `/yh` on this
 * origin and the dev/preview servers forward it. A hosted build needs the same
 * route - see examples/yahoo-stocks-adapter/worker/yahoo-proxy.js.
 */
const YAHOO_PROXY = {
  "/yh": {
    target: "https://query1.finance.yahoo.com",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/yh/, ""),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "application/json",
    },
  },
  // Nasdaq Trader's pipe-delimited symbol directory: every listed US stock and
  // ETF. Fetched once a week by the stocks adapter.
  "/symdir": {
    target: "https://www.nasdaqtrader.com",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/symdir/, ""),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
  },
};

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, so the demo workflow sets
  // BASE_PATH. Local builds and self-hosting stay at the domain root.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), securityHeaders()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@propsim/types": path.resolve(__dirname, "./src/vendor/types.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/react-router") ||
              id.includes("/@radix-ui/") ||
              id.includes("/@tanstack/") ||
              id.includes("/zustand/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("/lucide-react/")) {
              return "vendor-icons";
            }
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      ...YAHOO_PROXY,
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: { ...YAHOO_PROXY },
  },
});
