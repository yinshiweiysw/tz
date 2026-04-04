# Funds Dashboard Session State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the funds dashboard use product-aware session states (`盘中估值 / 收盘参考 / 确认净值`) and ensure only confirmed NAV is allowed to update accounting snapshots.

**Architecture:** Add a small session-policy helper that maps OTC funds to close-time behavior, then refactor the existing quote-mode helper to return an explicit display state. Keep rendering and summary aggregation on top of that display state, but hard-stop persistence unless confirmed NAV is ready for the snapshot date.

**Tech Stack:** Node.js ESM, existing portfolio dashboard scripts, Node built-in test runner.

---

### Task 1: Lock Market Session Policy With Tests

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_market_session_policy.test.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_market_session_policy.mjs`

- [ ] **Step 1: Write failing tests for domestic, gold, and Hong Kong close policies**
- [ ] **Step 2: Run `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_market_session_policy.test.mjs` and verify failure**
- [ ] **Step 3: Implement the minimal session-policy helper**
- [ ] **Step 4: Re-run the policy tests and verify green**

### Task 2: Refactor Quote Mode Into Explicit Session States

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.mjs`

- [ ] **Step 1: Add failing tests for `live_estimate`, `close_reference`, and `confirmed_nav`**
- [ ] **Step 2: Run `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs` and confirm failure**
- [ ] **Step 3: Implement the new session-state-aware mode resolution and labels**
- [ ] **Step 4: Re-run the quote-mode tests and verify green**

### Task 3: Update Dashboard Rows And Summary Semantics

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`

- [ ] **Step 1: Add failing dashboard tests for close-reference rows and summary output**
- [ ] **Step 2: Run `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs` and confirm failure**
- [ ] **Step 3: Pass asset/session metadata into row building and render `盘中估值 / 收盘参考 / 确认净值` correctly**
- [ ] **Step 4: Re-run the dashboard tests and verify green**

### Task 4: Enforce Confirmed-Only Writeback

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`

- [ ] **Step 1: Add failing tests showing that non-confirmed payloads do not advance the ledger snapshot**
- [ ] **Step 2: Run the focused writeback tests and confirm failure**
- [ ] **Step 3: Restrict writeback so only confirmed payloads can persist accounting fields**
- [ ] **Step 4: Re-run the focused tests and verify green**

### Task 5: Verification

**Files:**
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_market_session_policy.test.mjs`
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs`
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`

- [ ] **Step 1: Run the targeted test pack**
- [ ] **Step 2: Inspect one live payload sample to confirm session labels and summary fields**
- [ ] **Step 3: Summarize the remaining gaps, if any, around product-specific gold close mappings**
