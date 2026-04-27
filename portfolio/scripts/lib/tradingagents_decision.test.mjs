import test from "node:test";
import assert from "node:assert/strict";

import { loadTradingAgentsBridgeConfig, buildTradingAdviceSnapshot, loadTradingAgentsRawFixture } from "./tradingagents_bridge.mjs";
import { buildNextSignalMemory, buildTradingDecisionSnapshot } from "./tradingagents_decision.mjs";

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
  assert.equal(decision.decisionContext.marketDataTierLabel, "前收参考");
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
  assert.equal(decision.decisionContext.marketDataTierLabel, "前收参考");
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
  assert.equal(decision.executionChecklist.realActions.length, 0);
  assert.equal(decision.diagnostics.providerError, "glm unavailable");
  assert.match(decision.decisionSummary, /glm live 调用失败/);
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
