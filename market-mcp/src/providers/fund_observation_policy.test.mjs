import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFundObservation,
  inferFundTypeHint
} from "./fund_observation_policy.mjs";

test("inferFundTypeHint marks ETF feeder and index funds as index_like", () => {
  assert.equal(inferFundTypeHint({ name: "易方达沪深300ETF联接C" }), "index_like");
  assert.equal(inferFundTypeHint({ name: "华夏港股通央企红利ETF联接A" }), "index_like");
  assert.equal(inferFundTypeHint({ name: "兴全恒信债券C" }), "bond_like");
  assert.equal(inferFundTypeHint({ name: "招商量化精选股票A" }), "active_like");
});

test("classifyFundObservation downgrades mirrored index estimates to confirmed_only", () => {
  const result = classifyFundObservation({
    name: "易方达沪深300ETF联接C",
    primaryQuote: {
      netValueDate: "2026-04-07",
      netValue: 1.766,
      growthRate: 0
    },
    legacyQuote: {
      netValueDate: "2026-04-03",
      netValue: 1.766,
      valuation: 1.766,
      valuationChangePercent: 0,
      valuationTime: "2026-04-07 15:00"
    }
  });

  assert.equal(result.fundTypeHint, "index_like");
  assert.equal(result.observationKind, "confirmed_only");
  assert.equal(result.confirmedNav, 1.766);
  assert.equal(result.confirmedNavDate, "2026-04-07");
  assert.equal(result.intradayValuation, null);
  assert.equal(result.intradayChangePercent, null);
  assert.equal(result.compatibility.valuation, null);
  assert.equal(result.compatibility.valuationChangePercent, null);
  assert.equal(result.sourceDiagnostics.legacy.isMirroredConfirmedNav, true);
});

test("classifyFundObservation preserves trusted active-fund estimates", () => {
  const result = classifyFundObservation({
    name: "招商量化精选股票A",
    primaryQuote: {
      netValueDate: "2026-04-07",
      netValue: 3.5001,
      growthRate: 0.67
    },
    legacyQuote: {
      netValueDate: "2026-04-03",
      netValue: 3.4767,
      valuation: 3.5074,
      valuationChangePercent: 0.88,
      valuationTime: "2026-04-07 15:00"
    }
  });

  assert.equal(result.fundTypeHint, "active_like");
  assert.equal(result.observationKind, "intraday_estimate");
  assert.equal(result.confirmedNav, 3.5001);
  assert.equal(result.intradayValuation, 3.5074);
  assert.equal(result.intradayChangePercent, 0.88);
  assert.equal(result.compatibility.valuation, 3.5074);
  assert.equal(result.compatibility.valuationChangePercent, 0.88);
  assert.equal(result.sourceDiagnostics.legacy.isMirroredConfirmedNav, false);
});

test("characterization: exact-match zero-change index estimates stay on confirmed_only semantics", () => {
  const result = classifyFundObservation({
    name: "华夏纳斯达克100ETF发起式联接(QDII)A",
    primaryQuote: {
      netValueDate: "2026-04-07",
      netValue: 1.1234,
      growthRate: 0
    },
    secondaryEstimate: {
      source: "secondary",
      valuation: 1.1234,
      valuationChangePercent: 0,
      valuationTime: "2026-04-07 14:30"
    }
  });

  assert.equal(result.observationKind, "confirmed_only");
  assert.equal(result.intradayValuation, null);
  assert.equal(result.sourceDiagnostics.legacy.isMirroredConfirmedNav, true);
});
