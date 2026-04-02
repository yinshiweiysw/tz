import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTodayPnlToBaseValue,
  deriveTodayPnlDisplay,
  resolveQuoteStatusDisplay,
  resolveValuationLabel,
  resolveDisplayedDailyChangePct,
  shouldApplyEstimatedPnlOverlay,
  summarizeTodayPnl
} from "./live_dashboard_today_pnl.mjs";

test("deriveTodayPnlDisplay hides stale quote metrics from today's pnl slots", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-01",
    today: "2026-04-02",
    confirmedChangePct: 2.73,
    confirmedDailyPnl: 26.94
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    displayedChangePct: null,
    displayedDailyPnl: null
  });
});

test("deriveTodayPnlDisplay keeps same-day quote metrics visible", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-02",
    today: "2026-04-02",
    confirmedChangePct: 2.08,
    confirmedDailyPnl: 1446.95
  });

  assert.deepEqual(displayed, {
    quoteFresh: true,
    displayedChangePct: 2.08,
    displayedDailyPnl: 1446.95
  });
});

test("resolveDisplayedDailyChangePct prefers realtime valuation change over stale growth rate", () => {
  assert.equal(
    resolveDisplayedDailyChangePct({
      valuationChangePercent: -0.5,
      growthRate: 1.62
    }),
    -0.5
  );
});

test("resolveDisplayedDailyChangePct falls back to growth rate when realtime valuation change is missing", () => {
  assert.equal(
    resolveDisplayedDailyChangePct({
      valuationChangePercent: null,
      growthRate: 4.86
    }),
    4.86
  );
});

test("resolveValuationLabel uses estimated label for fresh realtime quotes", () => {
  assert.equal(resolveValuationLabel({ quoteFresh: true }), "估算净值");
});

test("resolveValuationLabel uses confirmed label for stale close quotes", () => {
  assert.equal(resolveValuationLabel({ quoteFresh: false }), "确认净值");
});

test("resolveQuoteStatusDisplay marks same-day quote as realtime estimate", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: true,
      quoteDate: "2026-04-02",
      updateTime: "2026-04-02 10:34"
    }),
    {
      text: "实时估值",
      tone: "flat"
    }
  );
});

test("resolveQuoteStatusDisplay marks stale quote as confirmed nav with date", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteDate: "2026-03-31",
      updateTime: "2026-03-31 净值"
    }),
    {
      text: "2026-03-31净值",
      tone: "flat"
    }
  );
});

test("resolveQuoteStatusDisplay falls back to unavailable when quote is missing", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteDate: null,
      updateTime: null
    }),
    {
      text: "暂无估值",
      tone: "flat"
    }
  );
});

test("applyTodayPnlToBaseValue lifts current amount when same-day pnl is available", () => {
  assert.equal(
    applyTodayPnlToBaseValue({
      quoteDate: "2026-04-02",
      today: "2026-04-02",
      baseValue: 46724.87,
      todayPnl: 1303.62
    }),
    48028.49
  );
});

test("applyTodayPnlToBaseValue keeps base amount when quote is stale", () => {
  assert.equal(
    applyTodayPnlToBaseValue({
      quoteDate: "2026-03-31",
      today: "2026-04-02",
      baseValue: 7466.46,
      todayPnl: 9.71
    }),
    7466.46
  );
});

test("shouldApplyEstimatedPnlOverlay still overlays same-day quotes even when snapshot date already equals today", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-02", "2026-04-02", "2026-04-02"),
    true
  );
});

test("shouldApplyEstimatedPnlOverlay overlays newer quotes beyond the ledger snapshot date", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-01", "2026-04-02", "2026-04-02"),
    true
  );
});

test("shouldApplyEstimatedPnlOverlay ignores stale quotes that are not newer than ledger snapshot", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-02", "2026-04-01", "2026-04-02"),
    false
  );
});

test("summarizeTodayPnl excludes stale rows from total today pnl", () => {
  const summary = summarizeTodayPnl([
    { quoteFresh: true, estimatedPnl: 100 },
    { quoteFresh: true, estimatedPnl: -30.25 },
    { quoteFresh: false, estimatedPnl: 26.94 }
  ], 10_000);

  assert.deepEqual(summary, {
    estimatedDailyPnl: 69.75,
    estimatedDailyPnlRatePct: 0.7
  });
});

test("summarizeTodayPnl returns null summary when no same-day quotes exist", () => {
  const summary = summarizeTodayPnl([
    { quoteFresh: false, estimatedPnl: 26.94 },
    { quoteFresh: false, estimatedPnl: 9.71 }
  ], 10_000);

  assert.deepEqual(summary, {
    estimatedDailyPnl: null,
    estimatedDailyPnlRatePct: null
  });
});
