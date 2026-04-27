import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  buildTradingAdviceSnapshot,
  loadTradingAgentsBridgeConfig,
  loadTradingAgentsRawFixture,
  persistTradingAdviceArtifacts
} from "./tradingagents_bridge.mjs";

const bridgeConfigPath = "/Users/yinshiwei/codex/tz-main-simplified/portfolio/config/tradingagents_bridge.json";

test("buildTradingAdviceSnapshot maps TradingAgents ratings into bucket and fund advice", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  assert.equal(bridgeConfig.providerDefaults.llmProvider, "deepseek");
  assert.equal(bridgeConfig.providerDefaults.deepThinkModel, "deepseek-v4-flash");
  assert.equal(bridgeConfig.providerDefaults.quickThinkModel, "deepseek-v4-flash");
  const rawSnapshot = await loadTradingAgentsRawFixture();
  const assetMaster = {
    buckets: {
      A_CORE: { label: "A 股核心" },
      GLB_MOM: { label: "全球动量" },
      TACTICAL: { label: "战术" }
    },
    assets: [
      { symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" },
      { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" },
      { symbol: "023764", name: "测试战术基金", bucket: "TACTICAL" }
    ]
  };

  const advice = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(advice.mode, "fixture");
  assert.equal(advice.source, "TradingAgents");
  assert.equal(advice.status, "advisory_only");
  assert.equal(advice.bucketSuggestions.length, 3);
  assert.equal(advice.bucketSuggestions.find((item) => item.bucket === "GLB_MOM")?.verdict, "偏增配");
  assert.match(advice.bucketSuggestions.find((item) => item.bucket === "GLB_MOM")?.riskJudge ?? "", /允许有限进攻|可以有限进攻/);
  assert.equal(advice.bucketSuggestions.find((item) => item.bucket === "TACTICAL")?.verdict, "减配");
  assert.equal(advice.fundSuggestions.find((item) => item.fundCode === "019118")?.verdict, "偏增配");
  assert.equal(advice.blockedSuggestions.length, 0);
});

test("buildTradingAdviceSnapshot blocks unmapped proxy symbols and does not fabricate fund suggestions", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const advice = await buildTradingAdviceSnapshot({
    rawSnapshot: {
      generatedAt: "2026-04-24T09:30:00+08:00",
      asOf: "2026-04-24",
      mode: "fixture",
      source: "TradingAgents",
      calls: [
        {
          symbol: "UNMAPPED",
          rating: "BUY",
          confidence: 0.9,
          thesis: "Unknown symbol"
        }
      ]
    },
    assetMaster: {
      buckets: {},
      assets: []
    },
    bridgeConfig,
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(advice.status, "blocked");
  assert.equal(advice.bucketSuggestions.length, 0);
  assert.equal(advice.fundSuggestions.length, 0);
  assert.equal(advice.blockedSuggestions[0]?.reason, "proxy_symbol_unmapped");
});

test("buildTradingAdviceSnapshot calibrates TradingAgents neutral default confidence from rating strength", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const advice = await buildTradingAdviceSnapshot({
    rawSnapshot: {
      generatedAt: "2026-04-24T09:30:00+08:00",
      asOf: "2026-04-24",
      mode: "live",
      source: "TradingAgents",
      calls: [
        {
          symbol: "ASHR",
          rating: "SELL",
          confidence: 0.5,
          confidenceSource: "tradingagents_rating_default",
          thesis: "原大脑只返回评级，wrapper 给出中性默认置信度"
        }
      ]
    },
    assetMaster: {
      buckets: {
        A_CORE: { label: "A 股核心" }
      },
      assets: [{ symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" }]
    },
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(advice.bucketSuggestions[0]?.rating, "SELL");
  assert.equal(advice.bucketSuggestions[0]?.confidence, 0.66);
  assert.equal(advice.bucketSuggestions[0]?.confidenceSource, "rating_default");
  assert.equal(advice.fundSuggestions[0]?.confidence, 0.66);
});

test("buildTradingAdviceSnapshot preserves explicit model confidence when marked as model sourced", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const advice = await buildTradingAdviceSnapshot({
    rawSnapshot: {
      generatedAt: "2026-04-24T09:30:00+08:00",
      asOf: "2026-04-24",
      mode: "live",
      source: "TradingAgents",
      calls: [
        {
          symbol: "ASHR",
          rating: "SELL",
          confidence: 0.5,
          confidenceSource: "model",
          thesis: "模型明确给出低置信度"
        }
      ]
    },
    assetMaster: {
      buckets: {
        A_CORE: { label: "A 股核心" }
      },
      assets: [{ symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" }]
    },
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(advice.bucketSuggestions[0]?.confidence, 0.5);
  assert.equal(advice.bucketSuggestions[0]?.confidenceSource, "model");
});

test("persistTradingAdviceArtifacts writes raw/advice snapshots and manifest pointers", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "tradingagents-bridge-"));
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        buckets: {
          GLB_MOM: { label: "全球动量" }
        },
        assets: [
          { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const result = await persistTradingAdviceArtifacts({
    portfolioRoot,
    accountId: "main",
    rawSnapshot: {
      generatedAt: "2026-04-24T09:30:00+08:00",
      asOf: "2026-04-24",
      mode: "fixture",
      source: "TradingAgents",
      calls: [
        {
          symbol: "QQQ",
          rating: "OVERWEIGHT",
          confidence: 0.72,
          thesis: "Tech leadership persists"
        }
      ]
    },
    bridgeConfig,
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const rawPersisted = JSON.parse(await readFile(result.rawSnapshotPath, "utf8"));
  const advicePersisted = JSON.parse(await readFile(result.adviceSnapshotPath, "utf8"));
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));

  assert.equal(rawPersisted.calls[0].symbol, "QQQ");
  assert.equal(advicePersisted.fundSuggestions[0].fundCode, "019118");
  assert.equal(manifest.canonical_entrypoints.latest_tradingagents_raw_snapshot, result.rawSnapshotPath);
  assert.equal(manifest.canonical_entrypoints.latest_trading_advice_snapshot, result.adviceSnapshotPath);
});
