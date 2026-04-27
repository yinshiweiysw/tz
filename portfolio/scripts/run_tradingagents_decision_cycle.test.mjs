import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { runTradingAgentsDecisionCycle } from "./run_tradingagents_decision_cycle.mjs";

test("runTradingAgentsDecisionCycle falls back to fixture and persists decision snapshot when live call fails", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-decision-cycle-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-24",
        positions: [],
        summary: {
          trade_available_cash_cny: 5000,
          total_portfolio_assets_cny: 5000
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A 股核心" },
          GLB_MOM: { label: "全球动量" },
          TACTICAL: { label: "战术" }
        },
        assets: [
          { symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" },
          { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" },
          { symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", bucket: "TACTICAL" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runTradingAgentsDecisionCycle(
    {
      portfolioRoot,
      user: "main",
      mode: "live"
    },
    {
      env: { DEEPSEEK_API_KEY: "test-key" },
      runBridge: async () => {
        throw new Error("deepseek exploded");
      }
    }
  );

  const decisionSnapshot = JSON.parse(await readFile(result.decisionSnapshotPath, "utf8"));
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));

  assert.equal(result.mode, "fallback_fixture");
  assert.equal(decisionSnapshot.mode, "fallback_fixture");
  assert.equal(decisionSnapshot.diagnostics.providerError, "deepseek exploded");
  assert.equal(decisionSnapshot.status, "observe_only");
  assert.equal(manifest.canonical_entrypoints.latest_trading_decision_snapshot, result.decisionSnapshotPath);
});

test("runTradingAgentsDecisionCycle refreshes market lake before live bridge and exposes refresh diagnostics", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-decision-cycle-refresh-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: { market_lake_db: "/shared/market_lake.db" } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-24",
        positions: [],
        summary: {
          trade_available_cash_cny: 5000,
          total_portfolio_assets_cny: 5000
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A 股核心" },
          GLB_MOM: { label: "全球动量" },
          TACTICAL: { label: "战术" }
        },
        assets: [
          { symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" },
          { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" },
          { symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", bucket: "TACTICAL" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const callOrder = [];
  const result = await runTradingAgentsDecisionCycle(
    {
      portfolioRoot,
      user: "main",
      mode: "live"
    },
    {
      env: { DEEPSEEK_API_KEY: "test-key" },
      refreshMarketLake: async (options) => {
        callOrder.push(["refresh", options.symbols, options.marketLakeDbPath]);
        return {
          status: "refreshed",
          triggered: true,
          requestedRefreshSymbols: ["QQQ", "SOXX"],
          remainingStaleSymbols: []
        };
      },
      runBridge: async () => {
        callOrder.push(["bridge"]);
        return {
          rawSnapshot: {
            generatedAt: "2026-04-24T09:30:00+08:00",
            asOf: "2026-04-24",
            mode: "live",
            source: "TradingAgents",
            provider: "deepseek",
            calls: [
              {
                symbol: "QQQ",
                rating: "OVERWEIGHT",
                confidence: 0.7,
                thesis: "成长继续占优",
                riskJudge: "允许有限进攻",
                investmentJudge: "偏增配全球动量"
              }
            ]
          },
          adviceSnapshot: {
            generatedAt: "2026-04-24T09:30:00+08:00",
            asOf: "2026-04-24",
            accountId: "main",
            mode: "live",
            source: "TradingAgents",
            provider: "deepseek",
            status: "advisory_only",
            freshnessLabel: "fresh",
            ageHours: 0.2,
            rawCallCount: 1,
            bucketSuggestions: [
              {
                bucket: "GLB_MOM",
                bucketLabel: "全球动量",
                rating: "OVERWEIGHT",
                verdict: "偏增配",
                confidence: 0.7,
                proxySymbols: ["QQQ"],
                reasonSummary: "成长代理继续走强",
                risks: [],
                riskJudge: "允许有限进攻",
                investmentJudge: "偏增配全球动量",
                signalCount: 1
              }
            ],
            fundSuggestions: [
              {
                bucket: "GLB_MOM",
                fundCode: "019118",
                fundName: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
                rating: "OVERWEIGHT",
                verdict: "偏增配",
                confidence: 0.7,
                proxySymbols: ["QQQ"],
                reasonSummary: "成长代理继续走强"
              }
            ],
            blockedSuggestions: []
          },
          rawSnapshotPath: path.join(portfolioRoot, "data", "tradingagents_raw_snapshot.json"),
          adviceSnapshotPath: path.join(portfolioRoot, "data", "trading_advice_snapshot.json")
        };
      }
    }
  );

  assert.deepEqual(callOrder[0], ["refresh", ["ASHR", "QQQ", "SOXX", "KWEB", "ARKK"], "/shared/market_lake.db"]);
  assert.deepEqual(callOrder[1], ["bridge"]);
  assert.equal(result.decisionSnapshot.diagnostics.marketDataRefreshStatus, "refreshed");
  assert.equal(result.decisionSnapshot.diagnostics.marketDataRefreshTriggered, true);
  assert.deepEqual(result.decisionSnapshot.diagnostics.marketDataRefresh.requestedRefreshSymbols, ["QQQ", "SOXX"]);
});

test("runTradingAgentsDecisionCycle skips market refresh and bridge when live provider key is missing", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-decision-cycle-missing-key-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: { market_lake_db: "/shared/market_lake.db" } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-24",
        positions: [],
        summary: {
          trade_available_cash_cny: 5000,
          total_portfolio_assets_cny: 5000
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A 股核心" },
          GLB_MOM: { label: "全球动量" },
          TACTICAL: { label: "战术" }
        },
        assets: [
          { symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" },
          { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" },
          { symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", bucket: "TACTICAL" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const calls = [];
  const result = await runTradingAgentsDecisionCycle(
    {
      portfolioRoot,
      user: "main",
      mode: "live"
    },
    {
      env: {},
      refreshMarketLake: async () => {
        calls.push("refresh");
        throw new Error("refresh should not run when provider key is missing");
      },
      runBridge: async () => {
        calls.push("bridge");
        throw new Error("bridge should not run when provider key is missing");
      }
    }
  );

  assert.deepEqual(calls, []);
  assert.equal(result.mode, "fallback_fixture");
  assert.equal(result.decisionSnapshot.diagnostics.providerError, "Missing required API key: DEEPSEEK_API_KEY");
  assert.equal(result.decisionSnapshot.diagnostics.marketDataRefreshStatus, "skipped_missing_provider_key");
  assert.equal(result.decisionSnapshot.diagnostics.marketDataRefreshTriggered, false);
});

test("runTradingAgentsDecisionCycle returns compact provider diagnostics when live bridge connection fails", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-decision-cycle-connection-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-24",
        positions: [],
        summary: {
          trade_available_cash_cny: 5000,
          total_portfolio_assets_cny: 5000
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A 股核心" },
          GLB_MOM: { label: "全球动量" },
          TACTICAL: { label: "战术" }
        },
        assets: [
          { symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" },
          { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" },
          { symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", bucket: "TACTICAL" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runTradingAgentsDecisionCycle(
    {
      portfolioRoot,
      user: "main",
      mode: "live"
    },
    {
      env: { DEEPSEEK_API_KEY: "test-key" },
      runBridge: async () => {
        throw new Error(
          "Traceback ... httpcore.RemoteProtocolError: Server disconnected without sending a response ... openai.APIConnectionError: Connection error."
        );
      }
    }
  );

  const rawSnapshot = JSON.parse(await readFile(result.rawSnapshotPath, "utf8"));

  assert.equal(result.diagnostics.providerError, "provider_connection_error:deepseek");
  assert.equal(result.decisionSnapshot.diagnostics.providerError, "provider_connection_error:deepseek");
  assert.equal(rawSnapshot.fallbackReason, "provider_connection_error:deepseek");
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /Traceback/);
});
