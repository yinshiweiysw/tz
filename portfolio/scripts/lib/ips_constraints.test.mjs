import test from "node:test";
import assert from "node:assert/strict";

import { normalizeIpsConstraints } from "./ips_constraints.mjs";

test("normalizeIpsConstraints reads normalized decimal constraints with sensible defaults", () => {
  const constraints = normalizeIpsConstraints({
    drawdown: {
      re_evaluate_pct: 0.08,
      hard_stop_pct: 0.12
    },
    concentration: {
      single_fund_max_pct: 0.1,
      single_theme_max_pct: 0.15
    },
    rebalance_trigger_deviation_pp: 0.05
  });

  assert.equal(constraints.drawdown.reEvaluatePct, 0.08);
  assert.equal(constraints.drawdown.hardStopPct, 0.12);
  assert.equal(constraints.concentration.singleFundMaxPct, 0.1);
  assert.equal(constraints.concentration.singleThemeMaxPct, 0.15);
  assert.equal(constraints.concentration.highCorrelationMaxPct, 0.25);
  assert.equal(constraints.cashFloorPct, 0.15);
  assert.equal(constraints.rebalanceTriggerDeviationPct, 0.05);
});

test("normalizeIpsConstraints clamps invalid inputs back to defaults", () => {
  const constraints = normalizeIpsConstraints({
    drawdown: {
      re_evaluate_pct: "bad",
      hard_stop_pct: -1
    },
    concentration: {
      single_fund_max_pct: 2
    },
    cash_floor_pct: null
  });

  assert.equal(constraints.drawdown.reEvaluatePct, 0.08);
  assert.equal(constraints.drawdown.hardStopPct, 0.12);
  assert.equal(constraints.concentration.singleFundMaxPct, 0.1);
  assert.equal(constraints.cashFloorPct, 0.15);
});
