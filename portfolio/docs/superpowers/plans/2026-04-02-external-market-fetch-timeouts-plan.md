# External Market Fetch Timeouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request-level timeout guards to market brief / pulse external fetches so reports degrade instead of hanging.

**Architecture:** Introduce one shared report-layer helper that wraps async external fetches into structured `ok/timeout/error` results, then consume that helper inside the two report generators. Keep provider APIs unchanged and only add a small status block when degraded fetches occur.

**Tech Stack:** Node.js ESM, `node:test`, existing portfolio report scripts.

---

## File Structure

- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.mjs`
  Shared timeout wrapper + status line rendering helpers.
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.test.mjs`
  Unit tests for timeout/error/degraded rendering behavior.
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
  Replace direct external fetch calls with guarded fetches and render source-status warnings.
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
  Same guarded fetch integration for pulse generation.

### Task 1: Build the shared fetch guard

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExternalSourceStatusLines,
  runGuardedFetch
} from "./report_market_fetch_guard.mjs";

test("runGuardedFetch returns ok result for resolved fetch", async () => {
  const result = await runGuardedFetch({
    source: "quotes",
    timeoutMs: 50,
    task: async () => ({ count: 3 })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, { count: 3 });
});

test("runGuardedFetch returns timeout result for stalled fetch", async () => {
  const result = await runGuardedFetch({
    source: "telegraphs",
    timeoutMs: 10,
    task: () => new Promise(() => {})
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.match(result.message, /timed out/i);
});

test("buildExternalSourceStatusLines renders degraded source warnings only", () => {
  const lines = buildExternalSourceStatusLines([
    { source: "quotes", ok: true, status: "ok" },
    { source: "telegraphs", ok: false, status: "timeout", message: "Fetch timed out after 6000ms" }
  ]);

  assert.deepEqual(lines, [
    "## 外部行情源状态",
    "",
    "- ⚠️ telegraphs：timeout，已按降级口径生成报告（Fetch timed out after 6000ms）。"
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the minimal helper**

```js
export async function runGuardedFetch({ source, timeoutMs, task }) {
  let timer = null;

  try {
    const data = await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return { source, ok: true, status: "ok", data };
  } catch (error) {
    const message = error?.message ?? String(error);
    const status = /timed out/i.test(message) ? "timeout" : "error";
    return { source, ok: false, status, message };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the helper tests**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.test.mjs`

Expected: PASS.

### Task 2: Integrate guarded fetches into reports

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.test.mjs`

- [ ] **Step 1: Replace direct fetch calls with guarded fetches**

```js
const quoteFetches = await Promise.all(
  quoteConfigs.map((item) =>
    runGuardedFetch({
      source: `quote:${item.code}`,
      timeoutMs: 5000,
      task: () => getStockQuote(item.code)
    })
  )
);

const boardsResult = await runGuardedFetch({
  source: "boards",
  timeoutMs: 6000,
  task: () => getHotBoards({ boardType: "industry", limit: 5 })
});
```

- [ ] **Step 2: Materialize degraded fallback values from guarded results**

```js
const successfulQuotes = quoteFetches.filter((item) => item.ok).map((item) => item.data);
const boards = boardsResult.ok ? boardsResult.data : { items: [] };
```

- [ ] **Step 3: Render source-status block only when degraded**

```js
const externalStatusLines = buildExternalSourceStatusLines([
  summarizeSourceBatch("quotes", quoteFetches),
  boardsResult,
  telegraphsResult,
  hotStocksResult
]);
```

- [ ] **Step 4: Run targeted tests plus live scripts**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_market_fetch_guard.test.mjs
time node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --user main --refresh --date 2026-04-02
time node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session morning --refresh --date 2026-04-02
```

Expected:

- helper tests PASS
- both scripts exit `0`
- reports still generate
- degraded source block appears only when a source actually fails or times out
