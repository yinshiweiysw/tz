# Phase A Ledger Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a formal trade-lifecycle model and cash-ledger summary so OTC buy/sell/conversion flows have explicit state semantics instead of being inferred ad hoc from scattered fields.

**Architecture:** Keep the existing dual-ledger architecture (`latest_raw.json + execution_ledger.json -> portfolio_state.json`) and add a focused lifecycle helper layer. The materializer will remain the single place that interprets ledger entries into a portfolio-state cash picture, while manual trade recording will emit enough normalized metadata for that interpreter to be deterministic and testable.

**Tech Stack:** Node.js ESM, existing portfolio materializer, Node built-in test runner.

---

### Task 1: Trade Lifecycle Helper

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_lifecycle.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_lifecycle.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**
- [ ] **Step 2: Run `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_lifecycle.test.mjs` and verify the module is missing**
- [ ] **Step 3: Implement lifecycle-stage resolution for buy/sell/conversion/cancelled entries**
- [ ] **Step 4: Re-run the lifecycle tests and verify green**

### Task 2: Materializer Cash Ledger Summary

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`

- [ ] **Step 1: Write failing materializer tests for lifecycle summary and projected settled cash**
- [ ] **Step 2: Run the focused materializer tests and confirm the new assertions fail**
- [ ] **Step 3: Extend the materializer to compute `trade_lifecycle_summary` and enriched `cash_ledger` fields from the execution ledger**
- [ ] **Step 4: Re-run the materializer tests and verify green**

### Task 3: Manual Trade Recording Metadata

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs`

- [ ] **Step 1: Write failing tests for normalized lifecycle metadata on recorded buy/sell/conversion trades**
- [ ] **Step 2: Run the recorder tests and confirm the new expectations fail**
- [ ] **Step 3: Emit explicit lifecycle metadata for recorded trades without breaking existing transaction files**
- [ ] **Step 4: Re-run the recorder tests and verify green**

### Task 4: Verification

**Files:**
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_lifecycle.test.mjs`
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Verify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs`

- [ ] **Step 1: Run the full targeted test pack**
- [ ] **Step 2: Inspect one concrete materialized cash snapshot to confirm the new fields read correctly**
- [ ] **Step 3: Summarize the new lifecycle vocabulary and what remains for the next Phase A slice**
