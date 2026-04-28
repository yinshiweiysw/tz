import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";

import {
  buildLiveRawSnapshotFromSymbolCache,
  inspectTradingAgentsSymbolCacheCoverage,
  runTradingAgentsBridge,
  resolveTradingAgentsMarketLakeDbPath,
  runLiveRawSnapshot
} from "./run_tradingagents_bridge.mjs";

test("resolveTradingAgentsMarketLakeDbPath prefers canonical manifest path", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-market-lake-"));
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          market_lake_db: "/shared/market_lake.db"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const resolved = await resolveTradingAgentsMarketLakeDbPath(portfolioRoot);
  assert.equal(resolved, "/shared/market_lake.db");
});

test("runLiveRawSnapshot forwards market lake path to the TradingAgents python runner", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-live-env-"));
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  let received = null;
  const rawSnapshot = runLiveRawSnapshot({
    tradeDate: "2026-04-24",
    symbols: ["QQQ"],
    marketLakeDbPath: "/shared/market_lake.db",
    portfolioRoot,
    providerDefaults: {
      requestTimeoutSeconds: 55,
      requestMaxRetries: 4,
      selectedAnalysts: ["market"],
      brainProfile: "fast",
      maxTokens: 777,
      temperature: 0.1,
      thinkingType: "disabled",
      marketDataToolMaxRows: 66,
      indicatorToolMaxLookbackDays: 11,
      invokeMaxAttempts: 5,
      invokeBackoffSeconds: 9,
      invokeMaxBackoffSeconds: 50,
      invokeIntervalSeconds: 7,
      symbolMaxAttempts: 3,
      symbolBackoffSeconds: 21,
      symbolMaxBackoffSeconds: 75,
      symbolIntervalSeconds: 6,
      symbolWallTimeoutSeconds: 88,
      symbolCacheTtlHours: 14,
      allowStaleSymbolCacheOnError: 0,
      fastContextMaxChars: 6000,
      maxDebateRounds: 0,
      maxRiskDiscussRounds: 0,
      maxRecurLimit: 60,
      processTimeoutMs: 123456
    },
    spawnSyncFn(command, args, options) {
      received = { command, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          generatedAt: "2026-04-24T02:00:00.000Z",
          asOf: "2026-04-24",
          mode: "live",
          source: "TradingAgents",
          calls: []
        }),
        stderr: "[tradingagents_diagnostic] path=/tmp/ta-diag/live.json\n"
      };
    }
  });

  assert.equal(rawSnapshot.asOf, "2026-04-24");
  assert.equal(rawSnapshot.brainProfile, "fast");
  assert.equal(rawSnapshot.runtimeConfig.brainProfile, "fast");
  assert.equal(rawSnapshot.runtimeDiagnostics.brainProfile, "fast");
  assert.equal(rawSnapshot.runtimeDiagnostics.runDiagnosticPath, "/tmp/ta-diag/live.json");
  assert.equal(received?.args.filter((item) => item === "QQQ").length, 1);
  assert.equal(received?.options?.env?.TRADINGAGENTS_MARKET_LAKE_DB, "/shared/market_lake.db");
  assert.equal(received?.options?.env?.PORTFOLIO_ROOT, portfolioRoot);
  assert.equal(received?.options?.env?.LANGCHAIN_OPENAI_TCP_KEEPALIVE, "0");
  assert.equal(received?.options?.timeout, 123456);
  assert.ok(received?.args.includes("--request-timeout-seconds"));
  assert.ok(received?.args.includes("55"));
  assert.ok(received?.args.includes("--request-max-retries"));
  assert.ok(received?.args.includes("4"));
  assert.ok(received?.args.includes("--selected-analysts"));
  assert.ok(received?.args.includes("market"));
  assert.ok(received?.args.includes("--max-tokens"));
  assert.ok(received?.args.includes("777"));
  assert.ok(received?.args.includes("--temperature"));
  assert.ok(received?.args.includes("0.1"));
  assert.ok(received?.args.includes("--thinking-type"));
  assert.ok(received?.args.includes("disabled"));
  assert.ok(received?.args.includes("--market-data-tool-max-rows"));
  assert.ok(received?.args.includes("66"));
  assert.ok(received?.args.includes("--indicator-tool-max-lookback-days"));
  assert.ok(received?.args.includes("11"));
  assert.ok(received?.args.includes("--invoke-max-attempts"));
  assert.ok(received?.args.includes("5"));
  assert.ok(received?.args.includes("--symbol-max-attempts"));
  assert.ok(received?.args.includes("3"));
  assert.ok(received?.args.includes("--invoke-interval-seconds"));
  assert.ok(received?.args.includes("7"));
  assert.ok(received?.args.includes("--symbol-interval-seconds"));
  assert.ok(received?.args.includes("6"));
  assert.ok(received?.args.includes("--symbol-wall-timeout-seconds"));
  assert.ok(received?.args.includes("88"));
  assert.ok(received?.args.includes("--symbol-cache-ttl-hours"));
  assert.ok(received?.args.includes("14"));
  assert.ok(received?.args.includes("--allow-stale-symbol-cache-on-error"));
  assert.ok(received?.args.includes("0"));
  assert.ok(received?.args.includes("--brain-profile"));
  assert.ok(received?.args.includes("fast"));
  assert.ok(received?.args.includes("--fast-context-max-chars"));
  assert.ok(received?.args.includes("6000"));
  assert.ok(received?.args.includes("--max-debate-rounds"));
  assert.ok(received?.args.includes("--max-risk-discuss-rounds"));
  assert.ok(received?.args.includes("--max-recur-limit"));
  assert.ok(received?.args.includes("--diagnostics-dir"));
  assert.ok(received?.args.includes("60"));
});

test("runLiveRawSnapshot surfaces process timeout as a readable error", () => {
  assert.throws(
    () =>
      runLiveRawSnapshot({
        tradeDate: "2026-04-24",
        symbols: ["QQQ"],
        providerDefaults: {
          processTimeoutMs: 3210
        },
        spawnSyncFn() {
          const error = new Error("spawn timed out");
          error.code = "ETIMEDOUT";
          return {
            status: null,
            stdout: "",
            stderr: "",
            error
          };
        }
      }),
    /timed out after 3210ms/
  );
});

test("inspectTradingAgentsSymbolCacheCoverage finds fresh and missing symbols", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-symbol-cache-"));
  const cacheDir = path.join(
    portfolioRoot,
    "data",
    "tradingagents_symbol_cache",
    "2026-04-24",
    "glm",
    "glm-5.1",
    "glm-5",
    "fast"
  );
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, "QQQ.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        asOf: "2026-04-24",
        call: {
          symbol: "QQQ",
          rating: "BUY"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const coverage = await inspectTradingAgentsSymbolCacheCoverage({
    symbols: ["QQQ", "SOXX"],
    tradeDate: "2026-04-24",
    providerDefaults: {
      llmProvider: "glm",
      deepThinkModel: "glm-5.1",
      quickThinkModel: "glm-5",
      brainProfile: "fast",
      symbolCacheTtlHours: 18
    },
    portfolioRoot,
    now: new Date()
  });

  assert.deepEqual(coverage.freshSymbols, ["QQQ"]);
  assert.deepEqual(coverage.missingSymbols, ["SOXX"]);
  assert.equal(coverage.fullyFresh, false);
});

test("runTradingAgentsBridge reuses fully fresh symbol cache without spawning python", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-bridge-cache-only-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify({ buckets: {}, assets: [] }, null, 2)}\n`,
    "utf8"
  );

  const cacheDir = path.join(
    portfolioRoot,
    "data",
    "tradingagents_symbol_cache",
    "2026-04-24",
    "glm",
    "glm-5.1",
    "glm-5",
    "fast"
  );
  await mkdir(cacheDir, { recursive: true });

  for (const symbol of ["ASHR", "QQQ", "SOXX", "KWEB", "ARKK"]) {
    await writeFile(
      path.join(cacheDir, `${symbol}.json`),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          asOf: "2026-04-24",
          call: {
            symbol,
            rating: "HOLD",
            confidence: 0.5,
            thesis: `${symbol} thesis`,
            runtimeDiagnostics: {
              symbolAttempts: 1
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  const result = await runTradingAgentsBridge({
    portfolioRoot,
    user: "main",
    mode: "live",
    tradeDate: "2026-04-24"
  });

  const rawPersisted = JSON.parse(await readFile(result.rawSnapshotPath, "utf8"));
  assert.equal(result.mode, "live");
  assert.equal(rawPersisted.runtimeDiagnostics.cacheOnlyBridge, true);
  assert.equal(rawPersisted.runtimeDiagnostics.cacheHits, 5);
  assert.equal(rawPersisted.calls.length, 5);
});

test("runTradingAgentsBridge cache-only mode refuses to spawn full live graph when cache is incomplete", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-bridge-cache-incomplete-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify({ buckets: {}, assets: [] }, null, 2)}\n`,
    "utf8"
  );

  await assert.rejects(
    () =>
      runTradingAgentsBridge({
        portfolioRoot,
        user: "main",
        mode: "live",
        tradeDate: "2026-04-24",
        "cache-only": "1"
      }),
    /tradingagents_symbol_cache_incomplete/
  );
});
