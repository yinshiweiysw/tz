import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFundNativeContext,
  buildFundNativeContextsFromDecision
} from "./fund_native_context.mjs";

const baseFund = {
  fundCode: "019736",
  fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
  bucket: "GLB_MOM",
  bucketLabel: "全球动量",
  amountCny: 12345.67,
  holdingPnl: -456.78,
  dayPnl: 12.34,
  confirmationState: "normal_lag",
  tradeStance: "observe",
  factorProfile: {
    primaryFactor: "US_TECH",
    primaryFactorLabel: "美股科技",
    secondaryFactors: ["US_SEMI"],
    proxySymbols: ["QQQ"]
  },
  researchProfile: {
    fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
    analysisTemplate: "qdii_index_fund",
    fundCompany: "宝盈基金",
    manager: "张三",
    fundSize: "2.3亿元",
    fees: "申购费0.12%",
    lookthrough: {
      status: "ready",
      topHoldings: [{ name: "NVIDIA", weightPct: 8.1 }]
    }
  },
  researchProfileQuality: {
    status: "ready",
    oneLine: "资料已同步 / 经理已同步 / 重仓已穿透"
  },
  deepDiveTrigger: {
    level: "high",
    reasons: ["loss_widening"],
    reasonLabels: ["高波亏损仓"]
  }
};

const decision = {
  status: "risk_watch",
  riskLight: "green",
  marketDataTierLabel: "前收参考 · 非实时",
  bucketActions: [
    {
      bucket: "GLB_MOM",
      verdict: "observe_only",
      rating: "HOLD",
      confidence: 0.62,
      reasonSummary: "美股科技维持观察",
      proxySymbols: ["QQQ"]
    }
  ],
  fundAnalyses: [baseFund],
  portfolioAnalysis: {
    exposureSummary: [{ bucket: "GLB_MOM", weightPct: 20, targetPct: 18 }],
    factorExposureSummary: [{ factor: "US_TECH", weightPct: 18, exposureCny: 50000 }],
    deepDiveCandidates: [baseFund]
  }
};

test("buildFundNativeContext maps a deep-dive fund into fund-native target context", () => {
  const context = buildFundNativeContext({ candidate: baseFund, decisionSnapshot: decision });

  assert.equal(context.targetType, "fund");
  assert.equal(context.targetId, "fund:019736");
  assert.equal(context.fundCode, "019736");
  assert.equal(context.fundTemplate, "qdii_index_fund");
  assert.equal(context.holding.amountCny, 12345.67);
  assert.equal(context.factorContext.primaryFactor, "US_TECH");
  assert.equal(context.marketContext.bucket, "GLB_MOM");
  assert.equal(context.marketContext.bucketVerdict, "observe_only");
  assert.equal(context.guardrails.reviewOnly, true);
  assert.equal(context.guardrails.canWriteLedger, false);
  assert.equal(context.guardrails.canGenerateOrder, false);
  assert.ok(context.promptContext.includes("宝盈纳斯达克100"));
  assert.ok(context.promptContext.includes("QDII/指数"));
});

test("buildFundNativeContextsFromDecision returns deep-dive candidates by default", () => {
  const contexts = buildFundNativeContextsFromDecision({ decisionSnapshot: decision, scope: "deep_dive", limit: 4 });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].targetId, "fund:019736");
});
