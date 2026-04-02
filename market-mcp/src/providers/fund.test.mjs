import test from "node:test";
import assert from "node:assert/strict";

import { mergeFundQuote } from "./fund.js";

test("mergeFundQuote falls back to growthRate when close-time valuation collapses to net value", () => {
  const quote = mergeFundQuote(
    "022502",
    {
      code: "022502",
      name: "国泰黄金ETF联接E",
      netValueDate: "2026-04-01",
      netValue: 3.7756,
      valuation: 3.7756,
      valuationChangePercent: 0,
      valuationTime: "2026-04-01 20:05",
      growthRate: 2.79
    },
    {
      code: "022502",
      name: "国泰黄金ETF联接E",
      netValueDate: "2026-04-01",
      netValue: 3.7756,
      valuation: 3.7756,
      valuationChangePercent: 0,
      valuationTime: "2026-04-01 20:05"
    },
    null
  );

  assert.equal(quote.valuation, 3.7756);
  assert.equal(quote.netValue, 3.7756);
  assert.equal(quote.growthRate, 2.79);
  assert.equal(quote.valuationChangePercent, 2.79);
});

test("mergeFundQuote keeps non-zero realtime valuation change when it exists", () => {
  const quote = mergeFundQuote(
    "007339",
    {
      code: "007339",
      name: "易方达沪深300ETF联接C",
      netValueDate: "2026-04-01",
      netValue: 1.0333,
      valuation: 1.0364,
      valuationChangePercent: 0.3,
      valuationTime: "2026-04-01 14:55",
      growthRate: 0.12
    },
    {
      code: "007339",
      name: "易方达沪深300ETF联接C",
      netValueDate: "2026-04-01",
      netValue: 1.0333,
      valuation: 1.0364,
      valuationChangePercent: 0.3,
      valuationTime: "2026-04-01 14:55"
    },
    null
  );

  assert.equal(quote.valuationChangePercent, 0.3);
});

test("mergeFundQuote prefers growthRate when late close snapshot keeps tiny residual estimate drift", () => {
  const quote = mergeFundQuote(
    "022502",
    {
      code: "022502",
      name: "国泰黄金ETF联接E",
      netValueDate: "2026-04-01",
      netValue: 3.7756,
      valuation: 3.776,
      valuationChangePercent: 0.01,
      valuationTime: "2026-04-01 20:50",
      growthRate: 2.79
    },
    {
      code: "022502",
      name: "国泰黄金ETF联接E",
      netValueDate: "2026-04-01",
      netValue: 3.7756,
      valuation: 3.776,
      valuationChangePercent: 0.01,
      valuationTime: "2026-04-01 20:50"
    },
    null
  );

  assert.equal(quote.valuationChangePercent, 2.79);
});
