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
