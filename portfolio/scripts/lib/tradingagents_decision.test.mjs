import test from "node:test";
import assert from "node:assert/strict";

import { loadTradingAgentsBridgeConfig, buildTradingAdviceSnapshot, loadTradingAgentsRawFixture } from "./tradingagents_bridge.mjs";
import { applyMarketProxyQuotesToDecisionSnapshot, buildFundDeepDiveTrigger, buildNextSignalMemory, buildTradingDecisionSnapshot } from "./tradingagents_decision.mjs";
import { resolveFundFactorProfile } from "./fund_factor_attribution.mjs";

const bridgeConfigPath = "/Users/yinshiwei/codex/tz-main-simplified/portfolio/config/tradingagents_bridge.json";

const baseAssetMaster = {
  buckets: {
    A_CORE: { label: "A 股核心", target: 0.22 },
    GLB_MOM: { label: "全球动量", target: 0.14 },
    TACTICAL: { label: "战术", target: 0.06 },
    HEDGE: { label: "对冲", target: 0.12 },
    INCOME: { label: "收益", target: 0.12 },
    CASH: { label: "CASH", target: 0.34 }
  },
  cash_sweeper: {
    min_trade_amount_cny: 1000
  },
  assets: [
    { symbol: "007339", name: "易方达沪深300ETF联接C", bucket: "A_CORE" },
    { symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", bucket: "GLB_MOM" },
    { symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", bucket: "TACTICAL" }
  ]
};

test("buildTradingDecisionSnapshot emits limited_execute for fresh live buy candidates", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "glm",
    calls: [
      {
        symbol: "QQQ",
        rating: "OVERWEIGHT",
        confidence: 0.72,
        thesis: "成长主线仍强",
        risks: ["利率波动"],
        riskJudge: "允许有限进攻",
        investmentJudge: "偏增配全球动量"
      },
      {
        symbol: "SOXX",
        rating: "BUY",
        confidence: 0.68,
        thesis: "半导体景气度高",
        risks: ["估值抬升"],
        riskJudge: "可以有限进攻",
        investmentJudge: "优先科技成长"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 20000,
        total_portfolio_assets_cny: 50000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-23T09:30:00+08:00",
          asOf: "2026-04-23",
          bucket: "GLB_MOM",
          rating: "OVERWEIGHT",
          direction: "buy",
          confidence: 0.7,
          provider: "glm",
          mode: "live"
        }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "limited_execute");
  assert.equal(decision.riskLight, "green");
  assert.equal(decision.executionChecklist.realActions.length, 1);
  assert.equal(decision.executionChecklist.realActions[0].fundCode, "019118");
  assert.equal(decision.executionChecklist.realActions[0].stance, "buy");
  assert.deepEqual(decision.executionChecklist.realActions[0].suggestedAmountRangeCny, {
    min: 1000,
    max: 5000
  });
  assert.equal(decision.executionChecklist.realActions[0].executionIntent, "review_only");
  assert.equal(decision.bucketVerdicts.find((item) => item.bucket === "GLB_MOM")?.executionState, "real");
  assert.equal(decision.bucketActions.find((item) => item.bucket === "GLB_MOM")?.actionLevel, "real_candidate");
});

test("buildTradingDecisionSnapshot downgrades low-confidence sell signal to risk_watch", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "glm",
    calls: [
      {
        symbol: "ARKK",
        rating: "UNDERWEIGHT",
        confidence: 0.61,
        thesis: "高波动主题赔率不足",
        risks: ["回撤扩大"],
        riskJudge: "宜收缩战术仓位",
        investmentJudge: "不主动扩张"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        {
          code: "023764",
          symbol: "023764",
          name: "华夏恒生互联网科技业ETF联接(QDII)D",
          amount: 69414.58,
          status: "active"
        }
      ],
      summary: {
        trade_available_cash_cny: 1000,
        total_portfolio_assets_cny: 70414.58
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "risk_watch");
  assert.equal(decision.riskLight, "yellow");
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.equal(decision.bucketActions.find((item) => item.bucket === "TACTICAL")?.executionState, "risk_watch");
  assert.match(decision.executionChecklist.observeLine[0]?.note ?? "", /信号置信度未过执行阈值/);
  assert.deepEqual(decision.executionChecklist.observeLine[0]?.reasons, ["confidence_below_action_threshold"]);
  assert.equal(decision.observationGroups.directionObservations.some((item) => item.bucket === "TACTICAL"), true);
  assert.equal(typeof decision.fundAnalyses[0]?.statusOneLine, "string");
});

test("buildTradingDecisionSnapshot keeps weekend previous-close SELL 0.5 as risk_watch with no real fund actions", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-26T12:00:00+08:00",
    asOf: "2026-04-26",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      { symbol: "ASHR", rating: "SELL", confidence: 0.5, thesis: "A股风险回报不足" },
      { symbol: "QQQ", rating: "SELL", confidence: 0.5, thesis: "美股科技超买" },
      { symbol: "SOXX", rating: "SELL", confidence: 0.5, thesis: "半导体超买" },
      { symbol: "KWEB", rating: "SELL", confidence: 0.5, thesis: "港股互联网动能不足" },
      { symbol: "ARKK", rating: "SELL", confidence: 0.5, thesis: "高波动主题需降风险" }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-26T20:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-25",
      positions: [
        { code: "007339", symbol: "007339", name: "易方达沪深300ETF联接C", amount: 30000, status: "active" },
        { code: "019118", symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", amount: 10000, status: "active" },
        { code: "023764", symbol: "023764", name: "华夏恒生互联网科技业ETF联接(QDII)D", amount: 70000, status: "active" }
      ],
      summary: {
        trade_available_cash_cny: 44000,
        total_portfolio_assets_cny: 487000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      marketDataRefresh: {
        freshnessBefore: [
          { symbol: "ASHR", status: "fresh", latestDate: "2026-04-24" },
          { symbol: "QQQ", status: "fresh", latestDate: "2026-04-24" }
        ]
      }
    },
    now: new Date("2026-04-26T20:00:00+08:00")
  });

  assert.equal(decision.status, "risk_watch");
  assert.equal(decision.decisionContext.tradingCalendarState, "weekend");
  assert.equal(decision.decisionContext.marketDataTier, "reference_close");
  assert.equal(decision.decisionContext.marketDataTierLabel, "前收参考 · 非实时");
  assert.equal(decision.decisionContext.marketDataAsOf, "2026-04-24");
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.equal(decision.bucketActions.filter((item) => item.executionState === "risk_watch").length, 3);
});

test("buildTradingDecisionSnapshot treats fresh previous-close proxy data as actionable reference", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "QQQ",
        rating: "BUY",
        confidence: 0.72,
        thesis: "美股成长趋势继续占优"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 10000,
        total_portfolio_assets_cny: 10000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      marketDataRefresh: {
        freshnessBefore: [
          { symbol: "QQQ", status: "fresh", latestDate: "2026-04-23" }
        ]
      }
    },
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-23T09:30:00+08:00",
          asOf: "2026-04-23",
          bucket: "GLB_MOM",
          rating: "BUY",
          direction: "buy",
          confidence: 0.7,
          provider: "deepseek",
          mode: "live"
        }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.decisionContext.marketDataTier, "reference_close");
  assert.equal(decision.decisionContext.marketDataTierLabel, "前收参考 · 非实时");
  assert.equal(decision.status, "limited_execute");
  assert.equal(decision.executionChecklist.realActions.length, 1);
  assert.equal(decision.executionChecklist.realActions[0].fundCode, "019118");
});

test("buildTradingDecisionSnapshot can execute calibrated rating-default confidence after signal continuity", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "ASHR",
        rating: "SELL",
        confidence: 0.5,
        confidenceSource: "tradingagents_rating_default",
        thesis: "TradingAgents 原大脑输出强卖出评级，但没有模型置信度字段"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        { code: "007339", symbol: "007339", name: "易方达沪深300ETF联接C", amount: 30000, status: "active" }
      ],
      summary: {
        trade_available_cash_cny: 10000,
        total_portfolio_assets_cny: 40000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      marketDataRefresh: {
        freshnessBefore: [
          { symbol: "ASHR", status: "fresh", latestDate: "2026-04-23" }
        ]
      }
    },
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-23T09:30:00+08:00",
          asOf: "2026-04-23",
          bucket: "A_CORE",
          rating: "SELL",
          direction: "sell",
          confidence: 0.66,
          provider: "deepseek",
          mode: "live"
        }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(adviceSnapshot.bucketSuggestions[0]?.confidenceSource, "rating_default");
  assert.equal(decision.status, "reduce_risk");
  assert.equal(decision.executionChecklist.realActions.length, 1);
  assert.equal(decision.executionChecklist.realActions[0]?.confidenceSource, "rating_default");
  assert.deepEqual(decision.executionChecklist.realActions[0]?.suggestedAmountRangeCny, {
    min: 1500,
    max: 7500
  });
  assert.deepEqual(decision.executionChecklist.realActions[0]?.sizingWarnings, []);
});

test("buildTradingDecisionSnapshot emits conservative sell review range when bucket is not above target", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "ASHR",
        rating: "SELL",
        confidence: 0.72,
        thesis: "A股风险回报不足"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        { code: "007339", symbol: "007339", name: "易方达沪深300ETF联接C", amount: 10000, status: "active" }
      ],
      summary: {
        trade_available_cash_cny: 1000,
        total_portfolio_assets_cny: 100000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    signalMemory: {
      entries: [
        { bucket: "A_CORE", direction: "sell", rating: "SELL", confidence: 0.7, provider: "deepseek", mode: "live" }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "reduce_risk");
  assert.equal(decision.executionChecklist.realActions.length, 1);
  assert.deepEqual(decision.executionChecklist.realActions[0]?.suggestedAmountRangeCny, {
    min: 1000,
    max: 1000
  });
  assert.deepEqual(decision.executionChecklist.realActions[0]?.sizingWarnings, ["bucket_not_above_target"]);
});

test("buildTradingDecisionSnapshot downgrades buy candidates to observe when bucket target gap is unavailable", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "QQQ",
        rating: "BUY",
        confidence: 0.72,
        thesis: "美股成长趋势继续占优"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        { code: "019118", symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", amount: 20000, status: "active" }
      ],
      summary: {
        trade_available_cash_cny: 10000,
        total_portfolio_assets_cny: 100000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    signalMemory: {
      entries: [
        { bucket: "GLB_MOM", direction: "buy", rating: "BUY", confidence: 0.7, provider: "deepseek", mode: "live" }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "risk_watch");
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.equal(decision.bucketActions.find((item) => item.bucket === "GLB_MOM")?.executionState, "risk_watch");
  assert.deepEqual(decision.executionChecklist.observeLine[0]?.reasons, [
    "bucket_not_below_target",
    "below_min_trade_amount"
  ]);
  assert.match(decision.morningBrief.headline, /有方向信号|不生成真实动作/);
  assert.match(decision.morningBrief.actionExplanation, /为什么没有真实动作/);
  assert.equal(Array.isArray(decision.morningBrief.watchFocus), true);
  assert.equal(decision.observationGroups.directionObservations.some((item) => item.bucket === "GLB_MOM"), true);
  assert.deepEqual(decision.observationGroups.actionConstraints[0]?.reasons, [
    "bucket_not_below_target",
    "below_min_trade_amount"
  ]);
  assert.match(decision.observationGroups.actionConstraints[0]?.oneLine ?? "", /未低于目标|最小交易额/);
});

test("buildTradingDecisionSnapshot keeps missing proxy data in risk_watch", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "QQQ",
        rating: "BUY",
        confidence: 0.72,
        thesis: "美股成长趋势继续占优"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 10000,
        total_portfolio_assets_cny: 10000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      marketDataRefresh: {
        freshnessBefore: [
          { symbol: "QQQ", status: "missing", latestDate: null }
        ]
      }
    },
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-23T09:30:00+08:00",
          asOf: "2026-04-23",
          bucket: "GLB_MOM",
          rating: "BUY",
          direction: "buy",
          confidence: 0.7,
          provider: "deepseek",
          mode: "live"
        }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.decisionContext.marketDataTier, "missing");
  assert.equal(decision.decisionContext.marketDataTierLabel, "行情缺失");
  assert.equal(decision.status, "risk_watch");
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.match(decision.executionChecklist.observeLine[0]?.note ?? "", /行情缺失/);
});

test("buildTradingDecisionSnapshot resolves trading calendar from raw as-of instead of current wall clock", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-26T12:00:00+08:00",
    asOf: "2026-04-26",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [{ symbol: "QQQ", rating: "SELL", confidence: 0.5, thesis: "周末缓存信号" }]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-27T09:30:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-27",
      positions: [
        { code: "019118", symbol: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", amount: 10000, status: "active" }
      ],
      summary: {
        trade_available_cash_cny: 1000,
        total_portfolio_assets_cny: 11000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-27T09:30:00+08:00")
  });

  assert.equal(decision.decisionContext.calendarAsOf, "2026-04-26");
  assert.equal(decision.decisionContext.tradingCalendarState, "weekend");
  assert.equal(decision.status, "risk_watch");
  assert.equal(decision.executionChecklist.realActions.length, 0);
});

test("buildTradingDecisionSnapshot emits one real sell candidate per bucket after continuity and confidence pass", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const assetMaster = {
    ...baseAssetMaster,
    assets: [
      ...baseAssetMaster.assets,
      { symbol: "001917", name: "招商量化精选股票A", bucket: "A_CORE" }
    ]
  };
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "ASHR",
        rating: "SELL",
        confidence: 0.72,
        thesis: "A股风险回报不足",
        risks: ["回撤风险"]
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        { code: "007339", symbol: "007339", name: "易方达沪深300ETF联接C", amount: 30000, status: "active" },
        { code: "001917", symbol: "001917", name: "招商量化精选股票A", amount: 50000, status: "active" }
      ],
      summary: {
        trade_available_cash_cny: 1000,
        total_portfolio_assets_cny: 81000
      }
    },
    assetMaster,
    bridgeConfig,
    accountId: "main",
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-23T09:30:00+08:00",
          asOf: "2026-04-23",
          bucket: "A_CORE",
          rating: "SELL",
          direction: "sell",
          confidence: 0.7,
          provider: "deepseek",
          mode: "live"
        }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "reduce_risk");
  assert.equal(decision.executionChecklist.realActions.length, 1);
  assert.equal(decision.executionChecklist.realActions[0].fundCode, "001917");
  assert.equal(decision.bucketActions[0].candidateFunds.length, 2);
});

test("buildTradingDecisionSnapshot cools down recently flipped bucket directions", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "QQQ",
        rating: "BUY",
        confidence: 0.8,
        thesis: "成长反弹"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 10000,
        total_portfolio_assets_cny: 10000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    signalMemory: {
      entries: [
        { bucket: "GLB_MOM", direction: "sell", rating: "SELL", generatedAt: "2026-04-23T09:30:00+08:00" },
        { bucket: "GLB_MOM", direction: "buy", rating: "BUY", generatedAt: "2026-04-23T13:30:00+08:00" }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "observe_only");
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.equal(decision.bucketActions[0].executionState, "observe");
  assert.match(decision.executionChecklist.observeLine[0]?.note ?? "", /方向刚反转/);
  assert.deepEqual(decision.executionChecklist.observeLine[0]?.reasons, ["direction_flip_cooldown"]);
});

test("buildNextSignalMemory replaces same as-of bucket provider entries instead of inflating streak", () => {
  const memory = buildNextSignalMemory({
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-24T09:00:00+08:00",
          asOf: "2026-04-24",
          bucket: "GLB_MOM",
          rating: "BUY",
          direction: "buy",
          confidence: 0.7,
          provider: "deepseek",
          mode: "live"
        }
      ]
    },
    bucketActions: [
      {
        bucket: "GLB_MOM",
        rating: "SELL",
        direction: "sell",
        confidence: 0.8
      }
    ],
    rawSnapshot: {
      asOf: "2026-04-24",
      provider: "deepseek",
      mode: "live"
    },
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].rating, "SELL");
  assert.equal(memory.entries[0].direction, "sell");
});

test("buildTradingDecisionSnapshot keeps fallback fixture in observe_only and surfaces provider diagnostics", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = await loadTradingAgentsRawFixture();
  rawSnapshot.mode = "fallback_fixture";
  rawSnapshot.provider = "glm";
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 12000,
        total_portfolio_assets_cny: 12000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      liveRequested: true,
      fallbackReason: "live_call_failed_using_fixture",
      providerError: "glm unavailable"
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.status, "observe_only");
  assert.equal(decision.providerUsed, "fallback_fixture");
  assert.equal(decision.providerMode, "fallback_fixture");
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.equal(decision.diagnostics.providerError, "glm unavailable");
  assert.match(decision.decisionSummary, /glm live 调用失败/);
});

test("buildTradingDecisionSnapshot adds per-fund and portfolio analyses from local holdings", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const factorProfilesConfig = {
    asOf: "2026-04-28",
    profiles: {
      "007339": {
        primaryFactor: "CN_BROAD",
        secondaryFactors: [],
        proxySymbols: ["ASHR"],
        region: "CN",
        confidence: 0.82
      },
      "023764": {
        fundName: "华夏恒生互联网科技业ETF联接(QDII)D",
        primaryFactor: "CHINA_INTERNET",
        secondaryFactors: ["TACTICAL_HIGH_BETA"],
        proxySymbols: ["KWEB"],
        region: "HK",
        confidence: 0.82
      }
    }
  };
  const researchProfilesConfig = {
    asOf: "2026-04-28",
    profiles: {
      "007339": {
        fundName: "易方达沪深300ETF联接C",
        fundCompany: "易方达基金",
        fundType: "ETF联接基金",
        underlyingIndexOrTheme: "沪深300",
        holdingLookthroughStatus: "latest_quarter_holdings",
        holdingsAsOf: "2026-03-31",
        managerName: "测试经理",
        topHoldings: [{ name: "贵州茅台", weightPct: 5.1, asOf: "2026-03-31" }]
      },
      "023764": {
        fundName: "华夏恒生互联网科技业ETF联接(QDII)D",
        fundCompany: "华夏基金",
        fundType: "ETF联接基金/QDII",
        underlyingIndexOrTheme: "恒生互联网科技业",
        holdingLookthroughStatus: "theme_only",
        topIndustries: ["港股互联网"],
        profileOneLine: "QDII ETF联接 · 港股互联网高波"
      }
    }
  };
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    calls: [
      {
        symbol: "ASHR",
        rating: "SELL",
        confidence: 0.72,
        thesis: "A股风险回报不足"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        {
          code: "007339",
          symbol: "007339",
          name: "易方达沪深300ETF联接C",
          amount: 30000,
          daily_pnl: -120,
          holding_pnl: 800,
          confirmation_state: "normal_lag",
          status: "active",
          bucket: "CN_CORE"
        },
        {
          name: "华夏恒生互联网科技业ETF联接(QDII)D",
          amount: 12000,
          daily_pnl: 30,
          holding_pnl: -1400,
          confirmation_state: "holiday_delay",
          status: "active"
        }
      ],
      summary: {
        trade_available_cash_cny: 1000,
        total_portfolio_assets_cny: 100000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    factorProfilesConfig,
    researchProfilesConfig,
    accountId: "main",
    signalMemory: {
      entries: [
        { bucket: "A_CORE", direction: "sell", rating: "SELL", confidence: 0.7, provider: "deepseek", mode: "live" }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.fundAnalyses.length, 2);
  assert.equal(decision.fundAnalyses[0].fundCode, "007339");
  assert.equal(decision.fundAnalyses[0].bucket, "A_CORE");
  assert.equal(decision.fundAnalyses[0].dayPnl, -120);
  assert.match(decision.fundAnalyses[0].tradeStance, /减配|观察|复核/);
  assert.equal(decision.fundAnalyses[0].factorProfile.primaryFactor, "CN_BROAD");
  assert.equal(decision.fundAnalyses[0].factorContribution.factor, "CN_BROAD");
  assert.match(decision.fundAnalyses[0].factorOneLine, /A股宽基/);
  assert.equal(typeof decision.fundAnalyses[0].statusOneLine, "string");
  assert.match(decision.fundAnalyses[0].statusOneLine, /深看|观察|维持|复核|动作/);
  assert.equal(decision.fundAnalyses[0].researchProfileQuality.status, "ready");
  assert.match(decision.fundAnalyses[0].researchProfileQuality.tagLabels.join(" "), /资料已同步/);
  assert.match(decision.fundAnalyses[0].researchProfileQuality.tagLabels.join(" "), /经理已同步/);
  assert.match(decision.fundAnalyses[0].researchProfileQuality.tagLabels.join(" "), /重仓已穿透/);
  assert.equal(decision.fundAnalyses[1].fundCode, "023764");
  assert.equal(decision.fundAnalyses[1].bucket, "TACTICAL");
  assert.equal(decision.fundAnalyses[1].factorProfile.primaryFactor, "CHINA_INTERNET");
  assert.equal(decision.fundAnalyses[1].researchProfile.fundType, "ETF联接基金/QDII");
  assert.equal(decision.fundAnalyses[1].researchProfile.lookthrough.status, "theme_only");
  assert.equal(decision.fundAnalyses[1].researchProfileQuality.status, "partial");
  assert.match(decision.fundAnalyses[1].researchProfileQuality.tagLabels.join(" "), /仅主题穿透/);
  assert.deepEqual(decision.fundAnalyses[1].factorProfile.proxySymbols, ["KWEB"]);
  assert.equal(decision.fundAnalyses[1].deepDiveTrigger.needed, true);
  assert.match(decision.fundAnalyses[1].statusOneLine, /深看/);
  assert.match(decision.fundAnalyses[1].deepDiveTrigger.reasons.join(","), /large_holding_drawdown/);
  assert.match(decision.portfolioAnalysis.oneLine, /全组合 2 只基金/);
  assert.equal(Array.isArray(decision.portfolioAnalysis.exposureSummary), true);
  assert.equal(Array.isArray(decision.portfolioAnalysis.factorExposureSummary), true);
  assert.equal(
    decision.portfolioAnalysis.factorExposureSummary.reduce((sum, item) => sum + item.exposureCny, 0),
    42000
  );
  assert.deepEqual(
    decision.portfolioAnalysis.factorExposureSummary.map((item) => item.factor),
    ["CN_BROAD", "CHINA_INTERNET"]
  );
  assert.equal(decision.portfolioAnalysis.dominantFactors[0].factor, "CN_BROAD");
  assert.match(decision.portfolioAnalysis.factorRiskNotes.join(" "), /最大因子暴露|今日主要拖累/);
  assert.equal(Array.isArray(decision.portfolioAnalysis.deepDiveCandidates), true);
  assert.equal(Array.isArray(decision.portfolioAnalysis.peerGroupSummary), true);
  assert.equal(decision.deepDiveCandidates.length > 0, true);
  assert.equal(Array.isArray(decision.portfolioAnalysis.deepDiveAnalyses), true);
  assert.equal(Array.isArray(decision.deepDiveAnalyses), true);
  assert.equal(decision.fundTradingAgentsAdapter.status, "ready");
  assert.equal(decision.fundTradingAgentsAdapter.adapterMode, "context_only");
  assert.equal(decision.fundTradingAgentsAdapter.contexts.length, decision.deepDiveCandidates.length);
  assert.match(decision.fundTradingAgentsAdapter.contexts[0].prompt, /请作为基金交易分析师分析/);
  assert.match(decision.fundTradingAgentsAdapter.contexts[0].prompt, /基金资料/);
  assert.equal(typeof decision.fundTradingAgentsAdapter.contexts[0].researchProfile?.lookthrough?.status, "string");
  assert.equal(Array.isArray(decision.fundTradingAgentsAdapter.contexts[0].analysisQuestions), true);
  assert.match(decision.deepDiveCandidates[0].deepDiveAnalysis.headline, /必须看|可选看/);
  assert.match(decision.deepDiveCandidates[0].deepDiveAnalysis.plainOneLine, /不是自动卖出指令|先看|单独处理/);
  assert.match(decision.deepDiveCandidates[0].deepDiveAnalysis.plainWhy, /简单说|单独拎出来/);
  assert.match(decision.deepDiveCandidates[0].deepDiveAnalysis.plainGuardrail, /不代表今天买入或卖出/);
  assert.match(decision.deepDiveAnalyses[0].factorRead, /A股宽基|中概/);
  assert.equal(Array.isArray(decision.deepDiveAnalyses[0].nextChecks), true);
});

test("buildTradingDecisionSnapshot groups duplicate factor funds and selects a representative", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const assetMaster = {
    ...baseAssetMaster,
    assets: [
      ...baseAssetMaster.assets,
      { symbol: "019736", name: "宝盈纳斯达克100指数发起(QDII)A人民币", bucket: "GLB_MOM" }
    ]
  };
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "glm",
    calls: [
      {
        symbol: "QQQ",
        rating: "HOLD",
        confidence: 0.7,
        thesis: "纳指维持观察"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });
  const factorProfilesConfig = {
    profiles: {
      "019118": { primaryFactor: "US_TECH", primaryFactorLabel: "美股科技", proxySymbols: ["QQQ"], region: "US" },
      "019736": { primaryFactor: "US_TECH", primaryFactorLabel: "美股科技", proxySymbols: ["QQQ"], region: "US" }
    }
  };
  const researchProfilesConfig = {
    asOf: "2026-04-28",
    profiles: {
      "019118": {
        fundName: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
        fundCompany: "景顺长城基金",
        fundType: "指数型-海外股票",
        holdingLookthroughStatus: "theme_only",
        managerName: "测试经理"
      },
      "019736": {
        fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
        fundCompany: "宝盈基金",
        fundType: "指数型-海外股票",
        holdingLookthroughStatus: "latest_quarter_holdings",
        holdingsAsOf: "2026-03-31",
        managerName: "蔡丹",
        topHoldings: [{ name: "英伟达", weightPct: 8.2, asOf: "2026-03-31" }]
      }
    }
  };
  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      positions: [
        { code: "019118", name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E", amount: 16000, daily_pnl: -20, holding_pnl: 600, status: "active" },
        { code: "019736", name: "宝盈纳斯达克100指数发起(QDII)A人民币", amount: 9000, daily_pnl: -60, holding_pnl: -1200, status: "active" }
      ],
      summary: {
        total_portfolio_assets_cny: 100000,
        trade_available_cash_cny: 5000
      }
    },
    assetMaster,
    bridgeConfig,
    factorProfilesConfig,
    researchProfilesConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.portfolioAnalysis.peerGroupSummary.length, 1);
  assert.equal(decision.portfolioAnalysis.peerGroupSummary[0].groupKey, "US_TECH");
  assert.equal(decision.portfolioAnalysis.peerGroupSummary[0].count, 2);
  assert.equal(decision.portfolioAnalysis.peerGroupSummary[0].representative.fundCode, "019736");
  assert.match(decision.portfolioAnalysis.peerGroupSummary[0].oneLine, /代表基金/);
});

test("resolveFundFactorProfile falls back to bucket and category inference when config is missing", () => {
  const inferred = resolveFundFactorProfile({
    fundCode: "099999",
    fundName: "测试创业板成长主题基金",
    bucket: "TACTICAL",
    position: {
      category: "创业板指数",
      market: "CN"
    },
    assetMaster: baseAssetMaster,
    factorProfilesConfig: {}
  });

  assert.equal(inferred.primaryFactor, "CN_GROWTH");
  assert.equal(inferred.source, "bucket_category_inferred");
  assert.equal(inferred.confidence, 0.45);
  assert.equal(inferred.primaryFactorLabel, "A股成长");
});

test("buildFundDeepDiveTrigger flags drawdown and concentration without calling LLM", () => {
  const trigger = buildFundDeepDiveTrigger({
    fundAnalysis: {
      fundCode: "023764",
      fundName: "华夏恒生互联网科技业ETF联接(QDII)D",
      amountCny: 72000,
      weightPct: 14.5,
      dayPnl: -200,
      holdingPnl: -16000,
      confirmationState: "holiday_delay",
      tradeStance: "维持观察"
    },
    factorProfile: {
      primaryFactor: "CHINA_INTERNET",
      primaryFactorLabel: "中概/港股互联网"
    }
  });

  assert.equal(trigger.needed, true);
  assert.equal(trigger.level, "high");
  assert.match(trigger.reasons.join(","), /large_holding_drawdown/);
  assert.match(trigger.reasons.join(","), /position_concentration/);
  assert.match(trigger.reasons.join(","), /high_beta_factor/);
});

test("buildFundDeepDiveTrigger does not flag bond cash just because the sleeve is large", () => {
  const trigger = buildFundDeepDiveTrigger({
    fundAnalysis: {
      fundCode: "016482",
      fundName: "兴全恒信债券C",
      bucket: "CASH",
      amountCny: 90000,
      weightPct: 18.3,
      dayPnl: -10,
      holdingPnl: 39500,
      confirmationState: "holiday_delay",
      tradeStance: "防守维持"
    },
    factorProfile: {
      primaryFactor: "BOND_CASH",
      primaryFactorLabel: "短债/现金替代"
    }
  });

  assert.equal(trigger.needed, false);
  assert.equal(trigger.assetClass, "bond_cash");
  assert.doesNotMatch(trigger.reasons.join(","), /position_concentration/);
});

test("buildFundDeepDiveTrigger still flags abnormal bond cash drawdown", () => {
  const trigger = buildFundDeepDiveTrigger({
    fundAnalysis: {
      fundCode: "099998",
      fundName: "测试短债基金",
      bucket: "CASH",
      amountCny: 50000,
      weightPct: 10,
      dayPnl: -50,
      holdingPnl: -1200,
      confirmationState: "confirmed",
      tradeStance: "防守维持"
    },
    factorProfile: {
      primaryFactor: "BOND_CASH",
      primaryFactorLabel: "短债/现金替代"
    }
  });

  assert.equal(trigger.needed, true);
  assert.match(trigger.reasons.join(","), /bond_cash_abnormal_drawdown/);
});

test("buildTradingDecisionSnapshot normalizes provider rate limit tracebacks into compact diagnostics", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = await loadTradingAgentsRawFixture();
  rawSnapshot.mode = "fallback_fixture";
  rawSnapshot.provider = "glm";
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 12000,
        total_portfolio_assets_cny: 12000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      liveRequested: true,
      fallbackReason: "live_call_failed_using_fixture",
      providerError:
        "Traceback ... openai.RateLimitError: Error code: 429 - {'error': {'code': '1302', 'message': 'Rate limit reached for requests'}}"
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.diagnostics.providerError, "provider_rate_limited:glm");
  assert.match(decision.decisionSummary, /provider_rate_limited:glm/);
  assert.doesNotMatch(decision.decisionSummary, /Traceback/);
});

test("buildTradingDecisionSnapshot normalizes provider connection tracebacks into compact diagnostics", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = await loadTradingAgentsRawFixture();
  rawSnapshot.mode = "fallback_fixture";
  rawSnapshot.provider = "glm";
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 12000,
        total_portfolio_assets_cny: 12000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      liveRequested: true,
      fallbackReason: "live_call_failed_using_fixture",
      providerError:
        "Traceback ... httpcore.RemoteProtocolError: Server disconnected without sending a response ... openai.APIConnectionError: Connection error."
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.diagnostics.providerError, "provider_connection_error:glm");
  assert.match(decision.decisionSummary, /provider_connection_error:glm/);
  assert.doesNotMatch(decision.decisionSummary, /Traceback/);
});

test("buildTradingDecisionSnapshot normalizes provider timeouts into compact diagnostics", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = await loadTradingAgentsRawFixture();
  rawSnapshot.mode = "fallback_fixture";
  rawSnapshot.provider = "glm";
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 12000,
        total_portfolio_assets_cny: 12000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      liveRequested: true,
      fallbackReason: "live_call_failed_using_fixture",
      providerError: "openai.APITimeoutError: Request timed out."
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.diagnostics.providerError, "provider_timeout:glm");
  assert.match(decision.decisionSummary, /provider_timeout:glm/);
});

test("buildTradingDecisionSnapshot adds fund-only one-line summaries and keeps raw evidence by reference", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "glm",
    calls: [
      {
        symbol: "ARKK",
        rating: "SELL",
        confidence: 0.72,
        thesis: "## 最终决策\n立即在当前价位市价卖出，开盘清仓，并设置止损线和限价单。",
        risks: ["高波动主题回撤扩大"],
        riskJudge: "需要降低战术仓位",
        investmentJudge: "减配战术"
      }
    ]
  };
  const adviceSnapshot = await buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [
        {
          code: "023764",
          symbol: "023764",
          name: "华夏恒生互联网科技业ETF联接(QDII)D",
          amount: 70000,
          status: "active"
        }
      ],
      summary: {
        trade_available_cash_cny: 3000,
        total_portfolio_assets_cny: 100000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      marketProxyQuotes: {
        generatedAt: "2026-04-24T10:00:00+08:00",
        quotes: [{ symbol: "ARKK", price: 50, pctChange: -2.1, quoteTime: "2026-04-24 10:00:00", quoteTier: "live" }]
      }
    },
    signalMemory: {
      entries: [
        {
          generatedAt: "2026-04-23T09:30:00+08:00",
          asOf: "2026-04-23",
          bucket: "TACTICAL",
          rating: "SELL",
          direction: "sell",
          confidence: 0.7,
          provider: "glm",
          mode: "live"
        }
      ]
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  const action = decision.executionChecklist.realActions[0];
  assert.ok(action);
  assert.equal(action.rawEvidenceRef, "reasonSummary");
  assert.equal(Array.isArray(action.evidenceDigest), true);
  assert.match(action.actionOneLine, /不构成订单/);
  assert.match(action.riskOneLine, /不等同于全卖/);
  assert.doesNotMatch(action.fundReasonOneLine, /市价|清仓|止损|开盘|做空|期权|卖出|减仓|立即|限价单|下单/);
});

test("buildTradingDecisionSnapshot lets proxy quote snapshot override market data tier and exposes provider runtime", async () => {
  const bridgeConfig = await loadTradingAgentsBridgeConfig(bridgeConfigPath);
  const rawSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    runtimeConfig: {
      brainProfile: "fast"
    },
    calls: []
  };
  const adviceSnapshot = {
    generatedAt: "2026-04-24T09:30:00+08:00",
    asOf: "2026-04-24",
    accountId: "main",
    mode: "live",
    source: "TradingAgents",
    provider: "deepseek",
    bucketSuggestions: [],
    fundSuggestions: [],
    blockedSuggestions: []
  };

  const decision = await buildTradingDecisionSnapshot({
    rawSnapshot,
    adviceSnapshot,
    portfolioState: {
      account_id: "main",
      snapshot_date: "2026-04-24",
      positions: [],
      summary: {
        trade_available_cash_cny: 3000,
        total_portfolio_assets_cny: 100000
      }
    },
    assetMaster: baseAssetMaster,
    bridgeConfig,
    accountId: "main",
    diagnostics: {
      providerRuntime: {
        providerUsed: "deepseek",
        providerMode: "fallback_provider",
        providerFallbackReason: "provider_rate_limited:glm",
        providerAttempted: [
          { provider: "glm", status: "failed", error: "provider_rate_limited:glm" },
          { provider: "deepseek", status: "success", error: null }
        ]
      },
      marketProxyQuotes: {
        generatedAt: "2026-04-24T10:00:00+08:00",
        quotes: [
          { symbol: "QQQ", price: 420, pctChange: 1.2, quoteTime: "2026-04-24 10:00:00", quoteTier: "delayed" }
        ]
      }
    },
    now: new Date("2026-04-24T10:00:00+08:00")
  });

  assert.equal(decision.providerUsed, "deepseek");
  assert.equal(decision.providerMode, "fallback_provider");
  assert.equal(decision.providerFallbackReason, "provider_rate_limited:glm");
  assert.equal(decision.brainProfile, "fast");
  assert.equal(decision.providerRuntime.brainProfile, "fast");
  assert.equal(decision.decisionContext.marketDataTier, "delayed");
  assert.equal(decision.decisionContext.marketDataTierLabel, "延迟行情");
  assert.equal(decision.marketProxyQuotes.quotes[0].quoteTier, "delayed");
});

test("applyMarketProxyQuotesToDecisionSnapshot backfills one-line summaries on persisted actions", () => {
  const snapshot = applyMarketProxyQuotesToDecisionSnapshot(
    {
      mode: "live",
      provider: "deepseek",
      executionChecklist: {
        realActions: [
          {
            bucket: "A_CORE",
            bucketLabel: "A股核心",
            stance: "sell",
            actionLabel: "减配候选",
            reasonSummary: "立即在当前价位市价卖出，开盘清仓，设置限价单。",
            fundReasonOneLine: "立即市价卖出并开盘清仓。",
            suggestedAmountRangeCny: { min: 1000, max: 2000 },
            sizingWarnings: []
          }
        ]
      }
    },
    {
      quotes: [{ symbol: "ASHR", quoteTier: "reference_close", quoteTime: "2026-04-24" }]
    }
  );

  const action = snapshot.executionChecklist.realActions[0];
  assert.equal(snapshot.providerUsed, "deepseek");
  assert.equal(snapshot.providerMode, "live");
  assert.equal(snapshot.marketDataTier, "reference_close");
  assert.equal(snapshot.marketDataTierLabel, "前收参考 · 非实时");
  assert.match(action.actionOneLine, /不构成订单/);
  assert.doesNotMatch(action.fundReasonOneLine, /市价|清仓|止损|开盘|做空|期权|卖出|减仓|立即|限价单|下单/);
});
