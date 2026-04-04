# Repo Hygiene And Nightly NAV Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the repository code-only by removing local runtime/account artifacts from version control, and finish the confirmed-NAV nightly closure so all portfolio accounts auto-reconcile after close with self-heal support.

**Architecture:** Split the work into two bounded tracks. Track A hardens repository hygiene by expanding ignore rules and untracking generated/local account state while preserving source, templates, examples, and documentation. Track B adds a dedicated nightly batch runner plus a status helper library that the funds dashboard can consult to trigger one-shot self-heal reconcile when confirmed NAV settlement is missing.

**Tech Stack:** Git, Node.js ESM scripts, existing portfolio dual-ledger materializer, Node built-in test runner.

---

### Task 1: Repository Hygiene Boundary

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/.gitignore`
- Modify: git index entries under `/Users/yinshiwei/codex/tz/portfolio/**`, `/Users/yinshiwei/codex/tz/portfolio_users/**`, `/Users/yinshiwei/codex/tz/tmp_trade_guard_test/**`

- [ ] Expand ignore rules for databases, runtime snapshots, account ledgers, logs, generated reports, cache folders, and embedded git metadata backups.
- [ ] Remove already-tracked local/runtime files from the git index with `git rm --cached`, keeping files on disk.
- [ ] Preserve source code, templates, specs, plans, examples, and config files.

### Task 2: Confirmed NAV Nightly Batch Runner

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/run_nightly_confirmed_nav.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/account_root.mjs`

- [ ] Write failing tests for status-file semantics, stale detection, and self-heal gating.
- [ ] Add shared status helper functions for reading/writing nightly reconcile status and checking whether self-heal should run.
- [ ] Add account discovery helper for `main` plus valid `portfolio_users/*` directories.
- [ ] Refactor single-account reconcile script to export a reusable function while preserving CLI behavior.
- [ ] Implement a nightly batch runner that iterates accounts, isolates per-account failure, writes aggregate status JSON, and supports `runType` metadata.

### Task 3: Dashboard Self-Heal Integration

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`

- [ ] Hook the dashboard read path so `/api/live-funds` checks nightly reconcile freshness before building payload.
- [ ] Trigger at most one in-flight self-heal batch per process when morning reads detect missing prior-night confirmed NAV.
- [ ] Surface reconcile status in the API payload so UI/debugging can tell whether data is confirmed NAV, temporary live valuation, or self-heal failed/running.

### Task 4: Verification And Automation Handoff

**Files:**
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs`
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.mjs`
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/run_nightly_confirmed_nav.mjs`
- Verify: git status in `/Users/yinshiwei/codex/tz`

- [ ] Run the new status tests with `node --test`.
- [ ] Run the nightly batch runner against the current workspace and inspect the written status file.
- [ ] Verify the dashboard server still starts or the payload builder still executes without regressions.
- [ ] Summarize the cleanup set and prepare 22:30 / 23:15 automation suggestions for the user.
