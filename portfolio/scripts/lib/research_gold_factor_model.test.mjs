import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchGoldFactorModel } from "./research_gold_factor_model.mjs";

test("buildResearchGoldFactorModel prefers usd and real-rate easing when gold rises with a weaker dollar and softer oil", () => {
  const result = buildResearchGoldFactorModel({
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100", pct_change: 0.04 }],
      commodities: [{ label: "COMEX黄金", pct_change: 2.11 }, { label: "WTI原油", pct_change: -15.42 }],
      rates_fx: [{ label: "美元指数", pct_change: -1.63 }]
    },
    eventDriver: {
      primary_driver: "中东停火预期升温",
      status: "active_market_driver"
    }
  });

  assert.equal(result.dominantGoldDriver, "usd_liquidity_tailwind");
  assert.equal(result.goldRegime, "macro_liquidity_bid");
  assert.equal(result.secondaryGoldDrivers.includes("geopolitics_residual_bid"), true);
});

test("buildResearchGoldFactorModel detects liquidity squeeze when gold and equities fall while dollar rises", () => {
  const result = buildResearchGoldFactorModel({
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100", pct_change: -3.4 }],
      commodities: [{ label: "COMEX黄金", pct_change: -1.8 }],
      rates_fx: [{ label: "美元指数", pct_change: 1.2 }]
    },
    eventDriver: {
      primary_driver: "流动性收缩",
      status: "active_market_driver"
    }
  });

  assert.equal(result.dominantGoldDriver, "liquidity_deleveraging");
  assert.equal(result.goldActionBias, "avoid_chasing_dip");
});

test("buildResearchGoldFactorModel recognizes oil-crash risk-on rebound instead of pure defensive gold bidding", () => {
  const result = buildResearchGoldFactorModel({
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100期货", pct_change: 3.16 }, { label: "恒生科技", pct_change: 4.57 }],
      commodities: [{ label: "伦敦金", pct_change: 2.37 }, { label: "WTI原油", pct_change: -15.64 }],
      rates_fx: [{ label: "美元指数", pct_change: -1.2 }]
    },
    eventDriver: {
      primary_driver: "美伊两周停火推动风险偏好修复",
      driver_type: "geopolitics",
      status: "active_market_driver"
    }
  });

  assert.equal(result.dominantGoldDriver, "usd_liquidity_tailwind");
  assert.equal(result.secondaryGoldDrivers.includes("oil_disinflation_real_rate_relief"), true);
  assert.equal(result.secondaryGoldDrivers.includes("risk_on_without_gold_breakdown"), true);
});
