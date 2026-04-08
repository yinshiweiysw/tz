# Funds Observation And Accounting Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the funds dashboard with a `funds`-style product model where observable asset value always follows the latest usable fund value, while accounting-confirmed state remains separate and never gets faked.

**Architecture:** Keep `portfolio_state.json` as the accounting ledger and `nightly_confirmed_nav_status.json` as the confirmation-status source, but change the dashboard row pipeline so observable amount/holding profit derive from `confirmed_units * latest displayable valuation` whenever same-day valuation is available. Today's PnL and writeback readiness stay on the existing accounting/confirmation gates.

**Tech Stack:** Node.js ESM scripts, `serve_funds_live_dashboard.mjs`, `live_dashboard_today_pnl.mjs`, Node test runner, existing Eastmoney fund quote provider.

---

## Current Finding

- The current funds dashboard still computes displayed amount primarily as `ledger amount + today pnl overlay`.
- That means same-day valuation can be visible while the row amount stays stuck at the stale ledger value when `snapshotFreshForAccounting=false`.
- The `funds` reference product instead separates:
  - previous settled amount / actual NAV
  - current estimated profit
  - later same-day actual NAV replacement
- For this project, the required product behavior is stricter:
  - observable `current amount` and `holding profit` should move with the latest usable valuation
  - accounting confirmation status must still gate writeback and confirmed-today PnL semantics

### Task 1: Add Failing Integration Tests For Observable Amount

**Files:**
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs)

- [ ] Add a failing test where:
  - `snapshot_date` is yesterday
  - the position has `confirmed_units`
  - a same-day intraday valuation exists
  - the dashboard must show updated `amount` and `holdingPnl`
  - `accountingOverlayAllowed` stays `false`
- [ ] Add a failing test that summary totals (`totalFundAssets`, `estimatedCurrentFundAssets`) follow the observable amount, not the stale ledger amount.

### Task 2: Implement Funds-Style Observable Valuation

**Files:**
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs)

- [ ] Carry row-level fields needed for observable value calculation:
  - `confirmedUnits`
  - `ledgerAmount`
  - `displayValuation`
- [ ] Change live overlay application so observable amount prefers:
  - `confirmedUnits * displayValuation` for same-day `live_estimate` or `close_reference`
  - existing ledger fallback when units or display valuation are unavailable
- [ ] Recompute observable `holdingPnl` and `holdingPnlRatePct` from the observable amount and cost basis.
- [ ] Keep `accountingOverlayAllowed`, `confirmedNavStatus`, and writeback gating unchanged.

### Task 3: Verify Regressions

**Files:**
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs) only if summary layering needs adjustment
- Test: [/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs)

- [ ] Run the focused dashboard test suite.
- [ ] Rebuild `dashboard_state.json`.
- [ ] Verify `/api/live-funds` returns updated observable amount while confirmation state remains honest.
