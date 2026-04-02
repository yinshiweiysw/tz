import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpeculativeInstruction,
  computeSpeculativeBudget,
  detectSpeculativeExposure,
  deriveSpeculativeTrigger
} from "./speculative_engine.mjs";

test("deriveSpeculativeTrigger returns manual_override when manual theme provided", () => {
  const trigger = deriveSpeculativeTrigger({
    candidate: {
      theme_name: "港股互联网",
      valuation_regime_primary: "overvalued",
      left_side_regime: "neutral"
    },
    options: {
      manualTheme: "港股互联网"
    }
  });

  assert.equal(trigger.trigger_source, "manual_override");
  assert.equal(trigger.theme_name, "港股互联网");
});

test("deriveSpeculativeTrigger returns event_dislocation when event theme provided", () => {
  const trigger = deriveSpeculativeTrigger({
    candidate: {
      theme_name: "黄金",
      valuation_regime_primary: "fair_valued",
      left_side_regime: "neutral"
    },
    options: {
      eventTheme: "黄金"
    }
  });

  assert.equal(trigger.trigger_source, "event_dislocation");
  assert.equal(trigger.theme_name, "黄金");
});

test("deriveSpeculativeTrigger returns valuation_momentum_exhaustion on bottom divergence with undervaluation", () => {
  const trigger = deriveSpeculativeTrigger({
    candidate: {
      theme_name: "港股互联网",
      valuation_regime_primary: "undervalued",
      left_side_regime: "bottom_divergence"
    }
  });

  assert.equal(trigger.trigger_source, "valuation_momentum_exhaustion");
});

test("deriveSpeculativeTrigger returns null when no trigger condition matched", () => {
  const trigger = deriveSpeculativeTrigger({
    candidate: {
      theme_name: "A股核心",
      valuation_regime_primary: "overvalued",
      left_side_regime: "neutral"
    }
  });

  assert.equal(trigger, null);
});

test("computeSpeculativeBudget caps by max_pct and derives suggested amount from first step", () => {
  const budget = computeSpeculativeBudget({
    totalAssetsCny: 500000,
    currentSpeculativeExposureCny: 10000,
    sleeveConfig: {
      maxPct: 0.15,
      scaleInSteps: [0.25, 0.35, 0.4]
    }
  });

  assert.equal(budget.sleeve_cap_cny, 75000);
  assert.equal(budget.available_budget_cny, 65000);
  assert.equal(budget.suggested_amount_cny, 16250);
});

test("computeSpeculativeBudget clamps max_pct at 0.15 even if config is higher", () => {
  const budget = computeSpeculativeBudget({
    totalAssetsCny: 100000,
    currentSpeculativeExposureCny: 0,
    sleeveConfig: {
      maxPct: 0.4,
      scaleInSteps: [0.5]
    }
  });

  assert.equal(budget.max_pct, 0.15);
  assert.equal(budget.sleeve_cap_cny, 15000);
  assert.equal(budget.suggested_amount_cny, 7500);
});

test("buildSpeculativeInstruction returns normalized trade instruction block", () => {
  const instruction = buildSpeculativeInstruction({
    asOf: "2026-04-01",
    candidate: {
      theme_name: "港股互联网",
      tradable_proxies: [{ symbol: "513330", name: "华夏恒生互联网科技业ETF(QDII)" }]
    },
    trigger: {
      trigger_source: "event_dislocation",
      trigger_reason: "突发事件导致风险资产被动错杀"
    },
    budget: {
      suggested_amount_cny: 3000,
      available_budget_cny: 5000,
      sleeve_cap_cny: 15000,
      current_speculative_exposure_cny: 10000,
      remaining_after_trade_cny: 2000,
      max_pct: 0.15
    },
    sleeveConfig: {
      defaultExit: "反弹分批止盈"
    }
  });

  assert.equal(instruction.system, "left_speculative_sleeve");
  assert.equal(instruction.trigger_source, "event_dislocation");
  assert.equal(instruction.exit_rule, "反弹分批止盈");
  assert.equal(instruction.invalidation, "若触发逻辑被证伪或波动继续恶化则取消执行并复盘。");
  assert.equal(instruction.suggested_amount_cny, 3000);
  assert.equal(instruction.theme_name, "港股互联网");
});

test("deriveSpeculativeTrigger does not trigger manual_override for too-short theme tokens", () => {
  const trigger = deriveSpeculativeTrigger({
    candidate: {
      theme_name: "港股互联网",
      tradable_proxies: [{ symbol: "513330", name: "华夏恒生互联网科技业ETF(QDII)" }]
    },
    options: {
      manualTheme: "港"
    }
  });

  assert.equal(trigger, null);
});

test("deriveSpeculativeTrigger supports exact 6-digit code match for manual_override", () => {
  const trigger = deriveSpeculativeTrigger({
    candidate: {
      theme_name: "港股互联网",
      tradable_proxies: [{ symbol: "513330", name: "华夏恒生互联网科技业ETF(QDII)" }]
    },
    options: {
      manualTheme: "513330"
    }
  });

  assert.equal(trigger?.trigger_source, "manual_override");
});

test("detectSpeculativeExposure recognizes ACTIVE variants and tags arrays", () => {
  const detected = detectSpeculativeExposure({
    positions: [
      {
        status: "ACTIVE",
        amount: 1800,
        strategy_tags: ["left_speculative", "mean_reversion"]
      },
      {
        status: "active_live",
        amount: 2200,
        tags: ["speculative_sleeve"]
      },
      {
        status: "running",
        amount: 5000,
        bucket: "A_CORE"
      }
    ]
  });

  assert.equal(detected.amount, 4000);
});
