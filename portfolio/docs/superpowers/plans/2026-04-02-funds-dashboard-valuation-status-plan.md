# Funds Dashboard Valuation Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the funds dashboard so after-hours fund quotes are classified correctly and same-day published NAV is no longer mislabeled as live estimation.

**Architecture:** Keep the existing dashboard pipeline, but add a small quote-mode classifier in the dashboard pnl helper module. Route overlay, labels, and status rendering through that classifier instead of the current `quoteDate == today` shortcut.

**Tech Stack:** Node.js, ES modules, `node:test`, server-rendered dashboard HTML in `serve_funds_live_dashboard.mjs`

---

### Task 1: Add failing tests for quote mode and overlay gating

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add tests covering:

```javascript
test("deriveTodayPnlDisplay treats same-day close-like update as non-live", () => {
  const displayed = deriveTodayPnlDisplay({
    quoteDate: "2026-04-02",
    today: "2026-04-02",
    updateTime: "2026-04-02 净值",
    confirmedChangePct: -1,
    confirmedDailyPnl: -286.83
  });

  assert.deepEqual(displayed, {
    quoteFresh: false,
    quoteMode: "today_close",
    displayedChangePct: -1,
    displayedDailyPnl: -286.83
  });
});
```

```javascript
test("shouldApplyEstimatedPnlOverlay keeps same-day close-like rows in current-day pnl", () => {
  assert.equal(
    shouldApplyEstimatedPnlOverlay("2026-04-02", "2026-04-02", "2026-04-02", "2026-04-02 净值"),
    true
  );
});
```

```javascript
test("resolveQuoteStatusDisplay reports today_close as 今日净值", () => {
  assert.deepEqual(
    resolveQuoteStatusDisplay({
      quoteFresh: false,
      quoteMode: "today_close",
      quoteDate: "2026-04-02",
      updateTime: "2026-04-02 净值"
    }),
    {
      text: "今日净值",
      tone: "flat"
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs
```

Expected: FAIL because the helper functions do not yet understand `updateTime` / `quoteMode`.

### Task 2: Implement minimal quote-mode classification

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.mjs`

- [ ] **Step 1: Write minimal implementation**

Add a small classifier that derives mode from `quoteDate`, `today`, and `updateTime`, then thread it through:

- `deriveTodayPnlDisplay`
- `resolveValuationLabel`
- `resolveQuoteStatusDisplay`
- `applyTodayPnlToBaseValue`
- `shouldApplyEstimatedPnlOverlay`
- `summarizeTodayPnl`

- [ ] **Step 2: Run test to verify it passes**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs
```

Expected: PASS

### Task 3: Wire dashboard rows to the new quote mode

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`

- [ ] **Step 1: Write the failing integration-oriented assertion or inspect payload behavior**

Use the helper-returned mode in row construction so each row carries:

- `quoteMode`
- corrected `quoteFresh`
- corrected live-estimate labeling and current-day overlay eligibility

- [ ] **Step 2: Implement minimal integration changes**

Update row building and rendering so:

- close-like same-day rows show `当日净值` / `今日净值`
- only `live_estimate` rows are labeled as live estimates, while `today_close` rows still participate in current-day amount and pnl

- [ ] **Step 3: Guard drift diagnostics**

Restrict drift diagnostics to valid positive valuation/net-value pairs, and only for estimate-like rows.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dashboard_accounting_summary.test.mjs
```

Expected: PASS

### Task 4: Verify the live payload behavior

**Files:**
- Modify: none

- [ ] **Step 1: Regenerate or reload the live snapshot**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs --port 8766
```

Then inspect:

```bash
sed -n '1,220p' /Users/yinshiwei/codex/tz/portfolio/data/live_funds_snapshot.json
```

Expected:

- same-day `...净值` rows are not marked as `quoteFresh: true`
- summary and rows distinguish current-day NAV from live-estimate status
- drift diagnostics no longer produce `-100%` artifacts from unusable valuation fields
