# Report State Concurrency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden report-side shared state so same-day market reports stop drifting when session memory, research brain, or manifest pointers are stale or concurrently rewritten.

**Architecture:** Keep the current report pipeline, but tighten the state boundaries. First, make `report_session_memory` writes merge-safe and atomically persisted. Second, make `daily_brief` prefer fresh same-day derived artifacts over stale persisted scorecards and ignore previous-day trade-plan pointers when generating same-day conclusions.

**Tech Stack:** Node.js ESM, `node:test`, JSON sidecar files, filesystem atomic rename semantics.

---

### Task 1: Guard `daily_brief` against stale derived artifacts

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.blocking.test.mjs`

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run `node --test portfolio/scripts/generate_daily_brief.blocking.test.mjs` and confirm failure**
- [ ] **Step 3: Add pure helpers for scorecard freshness selection and same-day trade-plan candidate ordering**
- [ ] **Step 4: Re-run `node --test portfolio/scripts/generate_daily_brief.blocking.test.mjs` and confirm pass**

### Task 2: Make `report_session_memory` writes merge-safe

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_session_memory.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_session_memory.test.mjs`

- [ ] **Step 1: Write failing tests for merge-before-write / atomic write behavior**
- [ ] **Step 2: Run `node --test portfolio/scripts/lib/report_session_memory.test.mjs` and confirm failure**
- [ ] **Step 3: Implement write-path re-read, merge, and temp-file atomic replace**
- [ ] **Step 4: Re-run `node --test portfolio/scripts/lib/report_session_memory.test.mjs` and confirm pass**

### Task 3: Re-verify close-session report isolation

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Keep close-form reports bound to close-scoped research context**
- [ ] **Step 2: Run `node --test portfolio/scripts/lib/report_context.test.mjs` and confirm pass**
- [ ] **Step 3: Regenerate same-day `market_brief` / `daily_brief` and inspect produced `research_brain.<date>.close.json`**

### Task 4: Full regression + next risk handoff

**Files:**
- Verify only

- [ ] **Step 1: Run the focused full regression set for report-state files**
- [ ] **Step 2: Regenerate live report artifacts for `2026-04-03`**
- [ ] **Step 3: Summarize remaining manifest concurrency risks without expanding scope in this pass**
