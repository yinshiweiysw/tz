import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { refreshMarketProxyQuotes, loadMarketProxyQuoteSnapshot } from "./market_proxy_quotes.mjs";

async function createPortfolioRoot(prefix = "market-proxy-quotes-") {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  return portfolioRoot;
}

test("refreshMarketProxyQuotes writes live same-day quote snapshot", async () => {
  const portfolioRoot = await createPortfolioRoot();
  const now = new Date("2026-04-24T10:10:00+08:00");

  const snapshot = await refreshMarketProxyQuotes({
    portfolioRoot,
    symbols: ["QQQ"],
    now,
    quoteFetcher: async () => ({
      latestPrice: 420.12,
      changePercent: 1.23,
      quoteTime: "2026-04-24 10:09:00",
      source: "test_quote"
    })
  });
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.coverage.live, 1);
  assert.equal(snapshot.quotes[0].quoteTier, "live");
  assert.equal(manifest.canonical_entrypoints.latest_market_proxy_quote_snapshot.endsWith("market_proxy_quote_snapshot.json"), true);
});

test("refreshMarketProxyQuotes falls back to market lake reference close when quote fetch fails", async () => {
  const portfolioRoot = await createPortfolioRoot();
  const dbPath = path.join(portfolioRoot, "data", "market_lake.db");
  await writeFile(dbPath, "", "utf8");
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: { market_lake_db: dbPath } }, null, 2)}\n`,
    "utf8"
  );

  const snapshot = await refreshMarketProxyQuotes({
    portfolioRoot,
    symbols: ["QQQ"],
    now: new Date("2026-04-27T10:10:00+08:00"),
    quoteFetcher: async () => {
      throw new Error("quote source timeout");
    },
    spawnSyncFn: () => ({
      status: 0,
      stdout: JSON.stringify([{ symbol: "QQQ", date: "2026-04-24", close: 421, prev_close: 420 }])
    })
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.coverage.reference_close, 1);
  assert.equal(snapshot.quotes[0].source, "market_lake_daily_prices");
  assert.equal(snapshot.quotes[0].quoteTier, "reference_close");
  assert.equal(snapshot.quotes[0].stalenessLabel, "previous_trading_day");
  assert.equal(snapshot.quotes[0].displayLabel, "上一交易日参考 · 非实时");
});

test("refreshMarketProxyQuotes keeps provider quotes without quoteTime as non-live reference", async () => {
  const portfolioRoot = await createPortfolioRoot();
  const snapshot = await refreshMarketProxyQuotes({
    portfolioRoot,
    symbols: ["QQQ"],
    now: new Date("2026-04-28T10:10:00+08:00"),
    quoteFetcher: async () => ({
      latestPrice: 430,
      changePercent: 0.8,
      quoteTime: null,
      source: "tencent"
    })
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.coverage.reference_close, 1);
  assert.equal(snapshot.quotes[0].quoteTier, "reference_close");
  assert.equal(snapshot.quotes[0].displayLabel, "前收参考 · 非实时");
  assert.equal(snapshot.quotes[0].source, "tencent");
});

test("refreshMarketProxyQuotes honors TTL and loadMarketProxyQuoteSnapshot reads canonical snapshot", async () => {
  const portfolioRoot = await createPortfolioRoot();
  const now = new Date("2026-04-24T10:10:00+08:00");
  await refreshMarketProxyQuotes({
    portfolioRoot,
    symbols: ["QQQ"],
    now,
    quoteFetcher: async () => ({
      latestPrice: 420.12,
      changePercent: 1.23,
      quoteTime: "2026-04-24 10:09:00"
    })
  });

  const skipped = await refreshMarketProxyQuotes({
    portfolioRoot,
    symbols: ["QQQ"],
    now: new Date("2026-04-24T10:11:00+08:00"),
    quoteFetcher: async () => {
      throw new Error("should not fetch fresh snapshot");
    }
  });
  const loaded = await loadMarketProxyQuoteSnapshot({ portfolioRoot });

  assert.equal(skipped.status, "skipped_fresh");
  assert.equal(skipped.refreshed, false);
  assert.equal(loaded.quotes[0].symbol, "QQQ");
});
