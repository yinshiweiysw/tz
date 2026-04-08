import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFundConfirmation,
  summarizeFundConfirmationStates
} from "./fund_confirmation_policy.mjs";

test("classifyFundConfirmation keeps US QDII on previous CN trading day in normal_lag state", () => {
  const result = classifyFundConfirmation({
    targetDate: "2026-04-02",
    confirmedNavDate: "2026-04-01",
    asset: {
      symbol: "006075",
      market: "US",
      category: "美股指数/QDII",
      name: "博时标普500ETF联接(QDII)C"
    }
  });

  assert.equal(result.state, "normal_lag");
  assert.equal(result.expectedConfirmedDate, "2026-04-01");
  assert.equal(result.confirmedNavDate, "2026-04-01");
});

test("classifyFundConfirmation treats QDII holiday-stretched lag as normal_lag when previous CN trading day is older", () => {
  const result = classifyFundConfirmation({
    targetDate: "2026-04-07",
    confirmedNavDate: "2026-04-03",
    asset: {
      symbol: "006075",
      market: "US",
      category: "美股指数/QDII",
      name: "博时标普500ETF联接(QDII)C"
    }
  });

  assert.equal(result.state, "normal_lag");
  assert.equal(result.expectedConfirmedDate, "2026-04-03");
  assert.equal(result.confirmedNavDate, "2026-04-03");
});

test("classifyFundConfirmation marks Hong Kong holiday carry-over as holiday_delay", () => {
  const result = classifyFundConfirmation({
    targetDate: "2026-04-03",
    confirmedNavDate: "2026-04-02",
    asset: {
      symbol: "021142",
      market: "CN",
      category: "港股红利",
      name: "华夏港股通央企红利ETF联接A"
    }
  });

  assert.equal(result.state, "holiday_delay");
  assert.equal(result.expectedConfirmedDate, "2026-04-02");
});

test("classifyFundConfirmation marks domestic funds with old confirmed nav as late_missing", () => {
  const result = classifyFundConfirmation({
    targetDate: "2026-04-02",
    confirmedNavDate: "2026-04-01",
    asset: {
      symbol: "007339",
      market: "CN",
      category: "A股宽基",
      name: "易方达沪深300ETF联接C"
    }
  });

  assert.equal(result.state, "late_missing");
  assert.equal(result.expectedConfirmedDate, "2026-04-02");
});

test("classifyFundConfirmation treats domestic holiday carry-over as holiday_delay", () => {
  const result = classifyFundConfirmation({
    targetDate: "2026-04-06",
    confirmedNavDate: "2026-04-03",
    asset: {
      symbol: "007339",
      market: "CN",
      category: "A股宽基",
      name: "易方达沪深300ETF联接C"
    }
  });

  assert.equal(result.state, "holiday_delay");
  assert.equal(result.expectedConfirmedDate, "2026-04-03");
});

test("summarizeFundConfirmationStates reports coverage and lag counts", () => {
  const summary = summarizeFundConfirmationStates([
    { confirmationState: "confirmed" },
    { confirmationState: "normal_lag" },
    { confirmationState: "holiday_delay" },
    { confirmationState: "late_missing" },
    { confirmationState: "source_missing" }
  ]);

  assert.deepEqual(summary, {
    totalFundCount: 5,
    confirmedFundCount: 1,
    normalLagFundCount: 1,
    holidayDelayFundCount: 1,
    lateMissingFundCount: 1,
    sourceMissingFundCount: 1,
    confirmationCoveragePct: 60
  });
});
