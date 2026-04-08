import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTodayPnlToBaseValue,
  deriveEstimatedPnlDisplay,
  deriveOvernightCarryDisplay,
  deriveTodayPnlDisplay,
  resolveLatestConfirmedLabel,
  resolveQuoteStatusDisplay,
  resolveValuationLabel,
  resolveDisplayedDailyChangePct,
  shouldUseConfirmedSnapshotDisplay,
  shouldApplyEstimatedPnlOverlay,
  summarizeTodayPnl
} from "./live_dashboard_today_pnl.mjs";

test("deriveEstimatedPnlDisplay shows same-day intraday estimate", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 14:36",
    now: new Date("2026-04-03T14:36:00+08:00"),
    intradayChangePct: 1.26,
    estimatedDailyPnl: 318.55,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: true,
    quoteCurrent: true,
    quoteMode: "live_estimate",
    displayedChangePct: 1.26,
    displayedDailyPnl: 318.55
  });
});

test("deriveEstimatedPnlDisplay hides stale estimates when quote date is old", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-02",
    today: "2026-04-03",
    updateTime: "2026-04-02 14:36",
    now: new Date("2026-04-03T14:36:00+08:00"),
    intradayChangePct: 1.26,
    estimatedDailyPnl: 318.55,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: false,
    quoteMode: "confirmed_nav",
    displayedChangePct: null,
    displayedDailyPnl: null
  });
});

test("deriveEstimatedPnlDisplay keeps reference-only rows visible but non-comparable for pnl overlay", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-07",
    today: "2026-04-07",
    updateTime: "2026-04-07 15:00",
    now: new Date("2026-04-07T15:02:00+08:00"),
    intradayChangePct: null,
    estimatedDailyPnl: null,
    referenceChangePct: -0.18,
    referenceDailyPnl: -18,
    observationKind: "reference_only",
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: false,
    quoteMode: "reference_only",
    displayedChangePct: -0.18,
    displayedDailyPnl: -18
  });
});

test("deriveEstimatedPnlDisplay keeps same-day domestic quotes as close reference after 15:00", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 14:58",
    now: new Date("2026-04-03T15:05:00+08:00"),
    intradayChangePct: 0.44,
    estimatedDailyPnl: 88,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: true,
    quoteMode: "close_reference",
    displayedChangePct: 0.44,
    displayedDailyPnl: 88
  });
});

test("deriveEstimatedPnlDisplay keeps gold funds live until 15:30", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 15:18",
    now: new Date("2026-04-03T15:20:00+08:00"),
    intradayChangePct: 0.51,
    estimatedDailyPnl: 51,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:30"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: true,
    quoteCurrent: true,
    quoteMode: "live_estimate",
    displayedChangePct: 0.51,
    displayedDailyPnl: 51
  });
});

test("deriveEstimatedPnlDisplay keeps Hong Kong related funds live until 16:10", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 16:05",
    now: new Date("2026-04-03T16:06:00+08:00"),
    intradayChangePct: 0.72,
    estimatedDailyPnl: 72,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "16:10"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: true,
    quoteCurrent: true,
    quoteMode: "live_estimate",
    displayedChangePct: 0.72,
    displayedDailyPnl: 72
  });
});

test("deriveEstimatedPnlDisplay hides overnight qdii carry from today's pnl", () => {
  const displayed = deriveEstimatedPnlDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 04:00",
    now: new Date("2026-04-03T13:56:00+08:00"),
    intradayChangePct: 1.44,
    estimatedDailyPnl: 152.74,
    sessionPolicy: {
      profile: "global_qdii",
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: false,
    quoteMode: "confirmed_nav",
    displayedChangePct: null,
    displayedDailyPnl: null
  });
});

test("deriveOvernightCarryDisplay extracts qdii overnight carry as pending confirmation", () => {
  const displayed = deriveOvernightCarryDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 04:00",
    now: new Date("2026-04-03T13:56:00+08:00"),
    intradayChangePct: 1.44,
    estimatedDailyPnl: 152.74,
    pendingReferenceDate: "2026-04-02",
    sessionPolicy: {
      profile: "global_qdii",
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    overnightCarryChangePct: 1.44,
    overnightCarryPnl: 152.74,
    overnightCarryLabel: "待确认收益 对应 2026-04-02",
    overnightCarryReferenceDate: "2026-04-02"
  });
});

test("deriveOvernightCarryDisplay stays empty for domestic same-day estimates", () => {
  const displayed = deriveOvernightCarryDisplay({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 13:56",
    now: new Date("2026-04-03T13:56:00+08:00"),
    intradayChangePct: -0.61,
    estimatedDailyPnl: -173.22,
    expectedConfirmedDate: "2026-04-03",
    sessionPolicy: {
      profile: "domestic",
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    overnightCarryChangePct: null,
    overnightCarryPnl: null,
    overnightCarryLabel: null,
    overnightCarryReferenceDate: null
  });
});

test("deriveTodayPnlDisplay hides stale quote metrics from today's pnl slots", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-01",
    today: "2026-04-02",
    updateTime: "2026-04-01 净值",
    confirmedChangePct: 2.73,
    confirmedDailyPnl: 26.94
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: false,
    quoteMode: "confirmed_nav",
    displayedChangePct: null,
    displayedDailyPnl: null
  });
});

test("deriveTodayPnlDisplay keeps same-day quote metrics visible", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-02",
    today: "2026-04-02",
    updateTime: "2026-04-02 10:34",
    now: new Date("2026-04-02T10:34:00+08:00"),
    confirmedChangePct: 2.08,
    confirmedDailyPnl: 1446.95,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: true,
    quoteCurrent: true,
    quoteMode: "live_estimate",
    displayedChangePct: 2.08,
    displayedDailyPnl: 1446.95
  });
});

test("deriveTodayPnlDisplay treats same-day close-like update as close reference", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-02",
    today: "2026-04-02",
    updateTime: "2026-04-02 净值",
    now: new Date("2026-04-02T15:08:00+08:00"),
    confirmedChangePct: -1,
    confirmedDailyPnl: -286.83,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: true,
    quoteMode: "close_reference",
    displayedChangePct: -1,
    displayedDailyPnl: -286.83
  });
});

test("deriveTodayPnlDisplay treats late same-day valuation snapshots as close_reference instead of live estimate", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-02",
    today: "2026-04-02",
    updateTime: "2026-04-02 22:27",
    now: new Date("2026-04-02T22:27:00+08:00"),
    confirmedChangePct: 0.83,
    confirmedDailyPnl: 380.64,
    sessionPolicy: {
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteCurrent: true,
    quoteMode: "close_reference",
    displayedChangePct: 0.83,
    displayedDailyPnl: 380.64
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
  assert.equal(resolveValuationLabel({ quoteFresh: true, quoteMode: "live_estimate" }), "盘中估值");
});

test("resolveValuationLabel uses close-reference label after market close", () => {
  assert.equal(resolveValuationLabel({ quoteFresh: false, quoteMode: "close_reference" }), "收盘参考");
});

test("resolveValuationLabel uses confirmed label for stale close quotes", () => {
  assert.equal(resolveValuationLabel({ quoteFresh: false, quoteMode: "confirmed_nav" }), "确认净值");
});

test("resolveValuationLabel uses recent-confirmed label for reference-only rows", () => {
  assert.equal(
    resolveValuationLabel({ quoteFresh: false, quoteMode: "reference_only" }),
    "最近确认净值"
  );
});

test("resolveQuoteStatusDisplay marks same-day quote as realtime estimate", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: true,
      quoteMode: "live_estimate",
      quoteDate: "2026-04-02",
      updateTime: "2026-04-02 10:34"
    }),
    {
      text: "盘中估值",
      tone: "flat"
    }
  );
});

test("resolveQuoteStatusDisplay reports close_reference as close reference", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteMode: "close_reference",
      quoteDate: "2026-04-02",
      updateTime: "2026-04-02 净值"
    }),
    {
      text: "收盘参考",
      tone: "flat"
    }
  );
});

test("resolveQuoteStatusDisplay marks stale quote as confirmed nav with date", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteMode: "confirmed_nav",
      quoteDate: "2026-03-31",
      updateTime: "2026-03-31 净值"
    }),
    {
      text: "2026-03-31净值",
      tone: "flat"
    }
  );
});

test("resolveQuoteStatusDisplay marks reference-only rows as reference change", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteMode: "reference_only",
      quoteDate: "2026-04-07",
      updateTime: "2026-04-07 15:00"
    }),
    {
      text: "参考涨跌",
      tone: "flat"
    }
  );
});

test("resolveQuoteStatusDisplay falls back to unavailable when quote is missing", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteMode: "unavailable",
      quoteDate: null,
      updateTime: null
    }),
    {
      text: "暂无估值",
      tone: "flat"
    }
  );
});

test("resolveLatestConfirmedLabel shows latest confirmed date for confirmed-nav rows", () => {
  assert.equal(
    resolveLatestConfirmedLabel({
      quoteMode: "confirmed_nav",
      confirmedNavDate: "2026-04-01"
    }),
    "最近确认 2026-04-01"
  );
});

test("resolveLatestConfirmedLabel stays empty for current-day estimate rows", () => {
  assert.equal(
    resolveLatestConfirmedLabel({
      quoteMode: "live_estimate",
      confirmedNavDate: "2026-04-01"
    }),
    null
  );
});

test("applyTodayPnlToBaseValue lifts current amount when same-day pnl is available", () => {
  assert.equal(
    applyTodayPnlToBaseValue({
      quoteDate: "2026-04-02",
      today: "2026-04-02",
      updateTime: "2026-04-02 10:34",
      now: new Date("2026-04-02T10:34:00+08:00"),
      baseValue: 46724.87,
      todayPnl: 1303.62,
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    48028.49
  );
});

test("applyTodayPnlToBaseValue keeps base amount when quote is stale", () => {
  assert.equal(
    applyTodayPnlToBaseValue({
      quoteDate: "2026-03-31",
      today: "2026-04-02",
      updateTime: "2026-03-31 净值",
      now: new Date("2026-04-02T10:34:00+08:00"),
      baseValue: 7466.46,
      todayPnl: 9.71,
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    7466.46
  );
});

test("applyTodayPnlToBaseValue also updates amount for close reference after market close", () => {
  assert.equal(
    applyTodayPnlToBaseValue({
      quoteDate: "2026-04-02",
      today: "2026-04-02",
      updateTime: "2026-04-02 净值",
      now: new Date("2026-04-02T15:08:00+08:00"),
      baseValue: 28683.23,
      todayPnl: -286.83,
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    28396.4
  );
});

test("shouldUseConfirmedSnapshotDisplay returns true when confirmed snapshot matches latest ledger date", () => {
  assert.equal(
    shouldUseConfirmedSnapshotDisplay({
      confirmedNavState: "confirmed_nav_ready",
      confirmedTargetDate: "2026-04-02",
      snapshotDate: "2026-04-02"
    }),
    true
  );
});

test("shouldUseConfirmedSnapshotDisplay returns false when confirmed snapshot date does not match", () => {
  assert.equal(
    shouldUseConfirmedSnapshotDisplay({
      confirmedNavState: "confirmed_nav_ready",
      confirmedTargetDate: "2026-04-01",
      snapshotDate: "2026-04-02"
    }),
    false
  );
});

test("shouldApplyEstimatedPnlOverlay blocks accounting overlay when snapshot date is stale even if intraday estimate exists", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-01", "2026-04-02", "2026-04-02", "2026-04-02 10:34", {
      now: new Date("2026-04-02T10:34:00+08:00"),
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    false
  );
});

test("shouldApplyEstimatedPnlOverlay keeps same-day close-reference quotes on screen after market close", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-02", "2026-04-02", "2026-04-02", "2026-04-02 净值", {
      now: new Date("2026-04-02T15:08:00+08:00"),
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    true
  );
});

test("shouldApplyEstimatedPnlOverlay keeps late same-day quotes as close reference after market close", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-02", "2026-04-02", "2026-04-02", "2026-04-02 22:27", {
      now: new Date("2026-04-02T22:27:00+08:00"),
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    true
  );
});

test("shouldApplyEstimatedPnlOverlay disables overlay when confirmed snapshot is already ready", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay(
      "2026-04-02",
      "2026-04-02",
      "2026-04-02",
      "2026-04-02 10:34",
      {
        now: new Date("2026-04-02T10:34:00+08:00"),
        sessionPolicy: {
          openTime: "09:30",
          closeTime: "15:00"
        },
        useConfirmedSnapshotDisplay: true
      }
    ),
    false
  );
});

test("shouldApplyEstimatedPnlOverlay blocks same-day close reference when ledger snapshot is older than today", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-01", "2026-04-02", "2026-04-02", "2026-04-02 净值", {
      now: new Date("2026-04-02T15:08:00+08:00"),
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    false
  );
});

test("shouldApplyEstimatedPnlOverlay never overlays reference-only rows onto accounting state", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-07", "2026-04-07", "2026-04-07", "2026-04-07 15:00", {
      now: new Date("2026-04-07T15:02:00+08:00"),
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      },
      observationKind: "reference_only"
    }),
    false
  );
});

test("shouldApplyEstimatedPnlOverlay ignores stale quotes that are not newer than ledger snapshot", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-02", "2026-04-01", "2026-04-02", "2026-04-01 净值", {
      now: new Date("2026-04-02T15:08:00+08:00"),
      sessionPolicy: {
        openTime: "09:30",
        closeTime: "15:00"
      }
    }),
    false
  );
});

test("summarizeTodayPnl excludes stale rows from total today pnl", () => {
  const summary = summarizeTodayPnl([
    { quoteFresh: true, quoteCurrent: true, estimatedPnl: 100 },
    { quoteFresh: false, quoteCurrent: true, estimatedPnl: -30.25 },
    { quoteFresh: false, quoteCurrent: false, estimatedPnl: 26.94 }
  ], 10_000);

  assert.deepEqual(summary, {
    estimatedDailyPnl: 69.75,
    estimatedDailyPnlRatePct: 0.7
  });
});

test("summarizeTodayPnl excludes rows that are not allowed to affect accounting totals", () => {
  const summary = summarizeTodayPnl([
    {
      quoteFresh: true,
      quoteCurrent: true,
      estimatedPnl: 120,
      snapshotFreshForAccounting: false,
      accountingOverlayAllowed: false
    },
    {
      quoteFresh: false,
      quoteCurrent: true,
      estimatedPnl: -30,
      snapshotFreshForAccounting: true,
      accountingOverlayAllowed: true
    }
  ], 10_000);

  assert.deepEqual(summary, {
    estimatedDailyPnl: -30,
    estimatedDailyPnlRatePct: -0.3
  });
});

test("summarizeTodayPnl returns null summary when no same-day quotes exist", () => {
  const summary = summarizeTodayPnl([
    { quoteFresh: false, quoteCurrent: false, estimatedPnl: 26.94 },
    { quoteFresh: false, quoteCurrent: false, estimatedPnl: 9.71 }
  ], 10_000);

  assert.deepEqual(summary, {
    estimatedDailyPnl: null,
    estimatedDailyPnlRatePct: null
  });
});
