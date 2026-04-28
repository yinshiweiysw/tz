import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadFundLiveAnalysisSnapshot,
  persistFundLiveAnalysisSnapshot,
  resolveFundAnalyzerProviderAttempts,
  runFundLiveAnalysis
} from "./fund_live_analyzer.mjs";

test("resolveFundAnalyzerProviderAttempts follows GLM then DeepSeek chain", () => {
  const attempts = resolveFundAnalyzerProviderAttempts({
    providerDefaults: { brainProfile: "fast" },
    providerChain: {
      primary: { provider: "glm", deepThinkModel: "glm-5.1" },
      fallback: [{ provider: "deepseek", deepThinkModel: "deepseek-v4-pro" }]
    }
  });

  assert.deepEqual(
    attempts.map((item) => [item.provider, item.model]),
    [
      ["glm", "glm-5.1"],
      ["deepseek", "deepseek-v4-pro"]
    ]
  );
});

test("runFundLiveAnalysis calls provider with fund context and persists snapshot", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "fund-live-analysis-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);
  await writeFile(path.join(portfolioRoot, "state", "portfolio_state.json"), JSON.stringify({
    account_id: "main",
    snapshot_date: "2026-04-24",
    positions: [
      {
        code: "023764",
        name: "华夏恒生互联网科技业ETF联接(QDII)D",
        amount: 72000,
        daily_pnl: -600,
        holding_pnl: -15000,
        confirmation_state: "normal_lag",
        status: "active"
      }
    ],
    summary: {
      total_portfolio_assets_cny: 500000,
      trade_available_cash_cny: 10000
    }
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "config", "asset_master.json"), JSON.stringify({
    buckets: { TACTICAL: { label: "战术刺客", target: 0.06 } },
    assets: [{ symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", bucket: "TACTICAL" }]
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "config", "fund_factor_profiles.json"), JSON.stringify({
    profiles: {
      "023764": {
        primaryFactor: "CHINA_INTERNET",
        proxySymbols: ["KWEB"],
        region: "HK",
        confidence: 0.82
      }
    }
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "data", "trading_advice_snapshot.json"), JSON.stringify({
    generatedAt: "2026-04-24T10:00:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    provider: "glm",
    bucketSuggestions: [
      { bucket: "TACTICAL", bucketLabel: "战术刺客", rating: "HOLD", verdict: "维持", confidence: 0.7, proxySymbols: ["KWEB"] }
    ],
    fundSuggestions: []
  }, null, 2));

  const fetchCalls = [];
  const snapshot = await runFundLiveAnalysis({
    portfolioRoot,
    accountId: "main",
    mode: "live",
    limit: 1,
    bridgeConfig: {
      providerChain: {
        primary: { provider: "glm", deepThinkModel: "glm-5.1", backendUrl: "https://api.z.ai/api/paas/v4/" }
      }
    },
    env: { ZHIPU_API_KEY: "test-key" },
    fetchFn: async (url, options) => {
      fetchCalls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "downgrade_watch",
                  verdictLabel: "降级观察",
                  riskLevel: "high",
                  headline: "亏损较深，先降级观察。",
                  reasons: ["持有亏损较深", "同类高波"],
                  watchPoints: ["看 KWEB 是否继续走弱"],
                  actionBoundary: "只读复核，不构成订单。",
                  confidence: 0.71
                })
              }
            }
          ]
        })
      };
    },
    now: new Date("2026-04-24T10:30:00+08:00")
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.brainMode, "fund_live_analysis");
  assert.equal(snapshot.summary.coverageLabel, "1/1");
  assert.equal(snapshot.summary.providerLabel, "glm");
  assert.match(snapshot.portfolioConclusion.oneLine, /基金级 live 主脑/);
  assert.equal(snapshot.portfolioConclusion.coverageLabel, "1/1");
  assert.equal(snapshot.analyses[0].fundCode, "023764");
  assert.equal(snapshot.analyses[0].verdict, "downgrade_watch");
  assert.deepEqual(fetchCalls[0].body.thinking, { type: "disabled" });
  assert.match(fetchCalls[0].body.messages[1].content, /华夏恒生互联网/);
  assert.match(fetchCalls[0].body.messages[1].content, /KWEB/);

  await persistFundLiveAnalysisSnapshot({ portfolioRoot, snapshot });
  const loaded = await loadFundLiveAnalysisSnapshot({ portfolioRoot });
  assert.equal(loaded.analyses[0].headline, "亏损较深，先降级观察。");
});

test("runFundLiveAnalysis routes all-fund prompts by research profile template", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "fund-live-template-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);
  await writeFile(path.join(portfolioRoot, "state", "portfolio_state.json"), JSON.stringify({
    account_id: "main",
    snapshot_date: "2026-04-24",
    positions: [
      {
        code: "017204",
        name: "华宝海外科技股票(QDII-FOF-LOF)C",
        amount: 12000,
        daily_pnl: -120,
        holding_pnl: -1800,
        confirmation_state: "normal_lag",
        category: "海外科技/QDII",
        status: "active"
      },
      {
        code: "025162",
        name: "国泰大宗商品(QDII-LOF)D",
        amount: 9000,
        daily_pnl: 30,
        holding_pnl: -600,
        confirmation_state: "normal_lag",
        category: "大宗商品/QDII",
        status: "active"
      }
    ],
    summary: {
      total_portfolio_assets_cny: 100000,
      trade_available_cash_cny: 5000
    }
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "config", "asset_master.json"), JSON.stringify({
    buckets: {
      GLB_MOM: { label: "全球动量", target: 0.12 },
      HEDGE: { label: "对冲卫星", target: 0.05 }
    },
    assets: [
      { symbol: "017204", name: "华宝海外科技股票(QDII-LOF)C", bucket: "GLB_MOM", market: "US" },
      { symbol: "025162", name: "国泰大宗商品(QDII-LOF)D", bucket: "HEDGE", market: "GLB" }
    ]
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "config", "fund_factor_profiles.json"), JSON.stringify({
    profiles: {
      "017204": { primaryFactor: "US_TECH", primaryFactorLabel: "美股科技", proxySymbols: ["QQQ"], region: "US" },
      "025162": { primaryFactor: "GOLD", primaryFactorLabel: "黄金/商品", proxySymbols: ["GLD"], region: "GLB" }
    }
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "config", "fund_research_profiles.json"), JSON.stringify({
    asOf: "2026-04-28",
    profiles: {
      "017204": {
        fundName: "华宝海外科技股票(QDII-LOF)C",
        fundCompany: "华宝基金",
        fundType: "QDII-普通股票",
        analysisTemplate: "qdii_active_fund",
        manager: { name: "周晶,杨洋,赵启元" },
        holdingLookthroughStatus: "latest_quarter_holdings",
        holdingsAsOf: "2023-09-30",
        topHoldings: [{ name: "英伟达", weightPct: 0.08, asOf: "2023-09-30" }]
      },
      "025162": {
        fundName: "国泰大宗商品(QDII-LOF)D",
        fundCompany: "国泰基金",
        fundType: "QDII-商品",
        analysisTemplate: "qdii_commodity_fund",
        manager: { name: "朱丹" },
        holdingLookthroughStatus: "theme_only"
      }
    }
  }, null, 2));
  await writeFile(path.join(portfolioRoot, "data", "trading_advice_snapshot.json"), JSON.stringify({
    generatedAt: "2026-04-24T10:00:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    provider: "glm",
    bucketSuggestions: [
      { bucket: "GLB_MOM", bucketLabel: "全球动量", rating: "HOLD", verdict: "维持", confidence: 0.7, proxySymbols: ["QQQ"] },
      { bucket: "HEDGE", bucketLabel: "对冲卫星", rating: "HOLD", verdict: "维持", confidence: 0.7, proxySymbols: ["GLD"] }
    ],
    fundSuggestions: []
  }, null, 2));

  const prompts = [];
  const snapshot = await runFundLiveAnalysis({
    portfolioRoot,
    accountId: "main",
    mode: "live",
    scope: "all",
    limit: 2,
    bridgeConfig: {
      providerChain: {
        primary: { provider: "glm", deepThinkModel: "glm-5.1", backendUrl: "https://api.z.ai/api/paas/v4/" }
      }
    },
    env: { ZHIPU_API_KEY: "test-key" },
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      prompts.push(body.messages[1].content);
      return {
        ok: true,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "needs_manual_review",
                  verdictLabel: "人工复核",
                  riskLevel: "medium",
                  headline: "按基金类型完成分流分析。",
                  reasons: ["模板分流"],
                  watchPoints: ["继续观察"],
                  actionBoundary: "只读复核，不构成订单。",
                  confidence: 0.95
                })
              }
            }
          ]
        })
      };
    },
    now: new Date("2026-04-24T10:30:00+08:00")
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.count, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts.join("\n"), /QDII\/主动\/主题/);
  assert.match(prompts.join("\n"), /QDII\/商品/);
  assert.match(prompts.join("\n"), /资料完整度/);
  assert.match(prompts.join("\n"), /周晶,杨洋,赵启元|朱丹/);
  assert.match(prompts.join("\n"), /华宝海外科技股票\(QDII-LOF\)C/);
  assert.doesNotMatch(prompts.join("\n"), /华宝海外科技股票\(QDII-FOF-LOF\)C/);
  const staleAnalysis = snapshot.analyses.find((item) => item.fundCode === "017204");
  assert.equal(staleAnalysis.researchQualityGuardrail.status, "stale");
  assert.equal(staleAnalysis.confidence, 0.62);
  assert.match(staleAnalysis.uncertainty.join(" "), /资料完整度限制/);
});
