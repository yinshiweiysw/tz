import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStrategyDecisionContract,
  deriveBucketPolicy
} from "./strategy_decision_contract.mjs";

test("deriveBucketPolicy captures gap-driven action bias and notes", () => {
  const bucket = {
    bucketKey: "A_CORE",
    label: "A股核心",
    weightPct: 9.53,
    targetPct: 22,
    gapAmountCny: 53827
  };

  const policy = deriveBucketPolicy(bucket);

  assert.equal(policy.bucketKey, "A_CORE");
  assert.equal(policy.actionBias, "add_on_strength_with_limits");
  assert.equal(policy.maxAddTodayCny, 15000);
  assert.equal(policy.forbiddenActions.length, 0);
});

test("buildStrategyDecisionContract projects regime and guardrails", () => {
  const payload = buildStrategyDecisionContract({
    runtimeContext: {
      accountId: "main",
      generatedAt: "2026-04-08T06:30:00.000Z",
      bucketView: [
        {
          bucketKey: "Tactical",
          label: "战术",
          amount: 72057,
          weightPct: 17.53,
          targetPct: 6,
          gapAmountCny: -11000
        }
      ],
      systemState: {
        blockedReason: null
      }
    },
    tradePlan: {
      summary: {
        maxTotalBuyTodayCny: 18000
      }
    },
    signals: {
      market_regime: "risk_on_rebound"
    }
  });

  assert.equal(payload.regime.marketRegime, "risk_on_rebound");
  assert.equal(payload.executionGuardrails.maxTotalBuyTodayCny, 18000);
  assert.equal(payload.bucketPolicies.length, 1);
  assert.equal(payload.bucketPolicies[0].bucketKey, "Tactical");
});

test("buildStrategyDecisionContract exposes position facts and cash semantics from runtime context", () => {
  const payload = buildStrategyDecisionContract({
    runtimeContext: {
      accountId: "main",
      generatedAt: "2026-04-08T06:30:00.000Z",
      snapshotDate: "2026-04-08",
      meta: {
        dataFreshnessSummary: "ready"
      },
      portfolio: {
        settledCashCny: 52436.16,
        tradeAvailableCashCny: 50000,
        cashLikeFundAssetsCny: 105251.47,
        liquiditySleeveAssetsCny: 105251.47
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          bucketKey: "A_CORE",
          category: "A股宽基",
          units: 10000,
          amount: 21120.55,
          observableAmount: 21680.19,
          costBasis: 21000,
          holdingPnl: 120.55,
          observableHoldingPnl: 680.19,
          quoteMode: "intraday_valuation",
          quoteDate: "2026-04-08",
          confirmationState: "confirmed"
        }
      ],
      systemState: {
        confirmedNavState: "confirmed",
        blockedReason: null
      }
    }
  });

  assert.equal(payload.cashSemantics.settledCashCny, 52436.16);
  assert.equal(payload.freshness.snapshotDate, "2026-04-08");
  assert.equal(payload.positionFacts.length, 1);
  assert.equal(payload.positionFacts[0].code, "007339");
  assert.equal(payload.positionFacts[0].units, 10000);
  assert.equal(payload.positionFacts[0].costBasisCny, 21000);
  assert.equal(payload.positionFacts[0].canonicalAmountCny, 21120.55);
  assert.equal(payload.positionFacts[0].observableAmountCny, 21680.19);
  assert.equal(payload.positionFacts[0].amountCny, 21680.19);
  assert.equal(payload.positionFacts[0].holdingPnlCny, 680.19);
  assert.equal(payload.positionFacts[0].decisionValueSource, "observable");
  assert.equal(payload.positionFacts[0].quoteMode, "intraday_valuation");
});

test("buildStrategyDecisionContract falls back to canonical values when observable values are unavailable", () => {
  const payload = buildStrategyDecisionContract({
    runtimeContext: {
      positions: [
        {
          name: "博时标普500ETF联接(QDII)C",
          code: "006075",
          bucketKey: "GLB_MOM",
          category: "美股指数/QDII",
          units: 214.55912077,
          amount: 1017.79,
          observableAmount: null,
          costBasis: 1000,
          holdingPnl: 17.79,
          observableHoldingPnl: null,
          quoteMode: "confirmed_nav",
          quoteDate: "2026-04-07",
          confirmationState: "normal_lag"
        }
      ]
    }
  });

  assert.equal(payload.positionFacts[0].amountCny, 1017.79);
  assert.equal(payload.positionFacts[0].holdingPnlCny, 17.79);
  assert.equal(payload.positionFacts[0].decisionValueSource, "canonical");
  assert.equal(payload.positionFacts[0].quoteMode, "confirmed_nav");
});

test("buildStrategyDecisionContract emits degraded_observe_only instead of unknown freeze when data is stale but not risk-blocked", () => {
  const payload = buildStrategyDecisionContract({
    runtimeContext: {
      accountId: "main",
      generatedAt: "2026-04-08T06:30:00.000Z",
      snapshotDate: "2026-04-08",
      meta: {
        dataFreshnessSummary: "degraded"
      },
      bucketView: [
        {
          bucketKey: "A_CORE",
          label: "A股核心",
          amount: 41152.21,
          weightPct: 9.53,
          targetPct: 22,
          gapAmountCny: 53827
        }
      ],
      systemState: {
        confirmedNavState: "partially_confirmed_normal_lag",
        blockedReason: null,
        staleDependencies: ["research_brain"],
        researchReadiness: {
          analysis_allowed: true,
          trading_allowed: false,
          reasons: ["新闻覆盖不足"]
        }
      }
    },
    tradePlan: {
      summary: {
        maxTotalBuyTodayCny: 18000
      }
    },
    signals: {}
  });

  assert.equal(payload.decisionReadiness, "degraded_observe_only");
  assert.equal(payload.regime.tradePermission, "degraded_observe_only");
  assert.equal(payload.regime.overallStance, "observe_only");
  assert.equal(payload.regime.marketRegime, "observe_only");
  assert.deepEqual(payload.decisionReasons, ["新闻覆盖不足"]);
  assert.equal(payload.positionValueMode, "observable_preferred_with_canonical_fallback");
  assert.equal(payload.bucketPolicies[0].currentWeightPct, 9.53);
  assert.equal(payload.bucketPolicies[0].source, "runtime_bucket_view");
});

test("buildStrategyDecisionContract treats analysis degradation with soft tradability blocks as degraded_observe_only, not blocked", () => {
  const payload = buildStrategyDecisionContract({
    runtimeContext: {
      accountId: "main",
      generatedAt: "2026-04-08T11:26:27.761Z",
      snapshotDate: "2026-04-08",
      meta: {
        dataFreshnessSummary: "ready"
      },
      bucketView: [
        {
          bucketKey: "A_CORE",
          label: "A股核心",
          weightPct: 15.16,
          targetPct: 22,
          gapAmountCny: 26600
        }
      ],
      systemState: {
        blockedReason: "tradability_sections_blocked",
        confirmedNavState: "partially_confirmed_normal_lag",
        staleDependencies: [],
        researchReadiness: {
          level: "analysis_degraded",
          analysis_allowed: true,
          trading_allowed: false,
          reasons: ["tradability_sections_blocked"]
        }
      }
    }
  });

  assert.equal(payload.decisionReadiness, "degraded_observe_only");
  assert.equal(payload.regime.tradePermission, "degraded_observe_only");
  assert.equal(payload.regime.overallStance, "observe_only");
  assert.deepEqual(payload.decisionReasons, ["tradability_sections_blocked"]);
  assert.equal(payload.bucketPolicies[0].currentWeightPct, 15.16);
});
