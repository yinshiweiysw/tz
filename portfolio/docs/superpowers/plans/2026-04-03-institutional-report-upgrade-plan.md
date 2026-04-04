# Institutional Report Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the market analysis and reporting pipeline to institutional standards with hard data-quality gating, richer flow/expectation structures, and session-level report memory.

**Architecture:** Keep `research_brain.json` as the SSOT, add pure helper modules for data quality, expectation-gap, and session memory, then make report generators consume those normalized contracts instead of inventing local heuristics. Sidecar JSON outputs carry structured matrices so downstream reports, dialogue, and future scoring layers can reuse the same state.

**Tech Stack:** Node.js ES modules, node:test, JSON sidecar artifacts, existing report/render helpers.

---

### Task 1: Add failing tests for data-quality gating and sidecar outputs

**Files:**
- Modify: `portfolio/scripts/generate_research_brain.test.mjs`
- Modify: `portfolio/scripts/lib/research_event_driver.test.mjs`
- Modify: `portfolio/scripts/lib/research_brain_render.test.mjs`
- Modify: `portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test("runResearchBrainBuild writes market quality and expectation sidecars", async () => {
  assert.equal(typeof result.output.section_confidence.event_driver, "string");
  assert.equal(Array.isArray(result.output.data_quality_flags), true);
  assert.equal(sidecar.market_data_quality.overall_status, "degraded");
});

test("buildResearchEventDriver exposes expectation-gap fields", () => {
  assert.equal(result.driver_type, "macro_policy");
  assert.equal(typeof result.expectation_gap, "string");
  assert.equal(typeof result.actual_market_reaction, "object");
});

test("buildResearchFlowValidationLines suppresses degraded northbound data", () => {
  assert.ok(lines.some((line) => line.includes("不纳入当日资金判断")));
  assert.equal(lines.some((line) => line.includes("净买额")), false);
});

test("buildAnalyticsPaths exposes institutional sidecar paths", () => {
  assert.equal(paths.marketDataQualityPath, "/tmp/pf/data/market_data_quality.json");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test portfolio/scripts/generate_research_brain.test.mjs portfolio/scripts/lib/research_event_driver.test.mjs portfolio/scripts/lib/research_brain_render.test.mjs portfolio/scripts/lib/report_context.test.mjs`

Expected: FAIL because the sidecars, confidence fields, and degraded-flow gating do not exist yet.

### Task 2: Implement institutional data-quality and expectation matrices

**Files:**
- Create: `portfolio/scripts/lib/research_data_quality.mjs`
- Create: `portfolio/scripts/lib/research_data_quality.test.mjs`
- Modify: `portfolio/scripts/generate_research_brain.mjs`
- Modify: `portfolio/scripts/lib/research_event_driver.mjs`
- Modify: `portfolio/scripts/lib/research_flow_macro_radar.mjs`
- Modify: `portfolio/scripts/lib/research_brain_render.mjs`
- Modify: `portfolio/scripts/lib/report_context.mjs`

- [ ] **Step 1: Write focused unit tests for the new helpers**

```js
test("buildResearchDataQualityMatrix marks stale zeroed northbound flow as degraded", () => {
  assert.equal(result.sections.northbound_flow.status, "degraded");
  assert.equal(result.sections.northbound_flow.tradability_relevance, "blocked");
});
```

- [ ] **Step 2: Run the new helper test to verify it fails**

Run: `node --test portfolio/scripts/lib/research_data_quality.test.mjs`

Expected: FAIL with module/function missing.

- [ ] **Step 3: Write the minimal implementation**

```js
export function buildResearchDataQualityMatrix({ tradeDate, cnMarketSnapshot, marketSnapshot }) {
  return {
    overall_status: "ok",
    sections: {
      northbound_flow: { status: "ok" }
    }
  };
}
```

- [ ] **Step 4: Expand the implementation and wire it into research brain**

```js
const marketDataQuality = buildResearchDataQualityMatrix({...});
const driverExpectationMatrix = buildDriverExpectationMatrix(eventDriver, sessionInfo);
const marketFlowMatrix = buildMarketFlowMatrix(flowMacroRadar, marketDataQuality);
```

- [ ] **Step 5: Run the targeted test suite and make it pass**

Run: `node --test portfolio/scripts/lib/research_data_quality.test.mjs portfolio/scripts/generate_research_brain.test.mjs portfolio/scripts/lib/research_event_driver.test.mjs portfolio/scripts/lib/research_brain_render.test.mjs portfolio/scripts/lib/report_context.test.mjs`

Expected: PASS.

### Task 3: Add session memory and report inheritance

**Files:**
- Create: `portfolio/scripts/lib/report_session_memory.mjs`
- Create: `portfolio/scripts/lib/report_session_memory.test.mjs`
- Modify: `portfolio/scripts/generate_market_pulse.mjs`
- Modify: `portfolio/scripts/generate_market_brief.mjs`
- Modify: `portfolio/scripts/generate_daily_brief.mjs`

- [ ] **Step 1: Write failing tests for morning/noon/close inheritance and denoising**

```js
test("session memory carries morning hypothesis into noon validation and close attribution", () => {
  assert.equal(memory.days["2026-04-03"].morning.core_hypothesis, "...");
  assert.ok(noonLines.some((line) => line.includes("午间验证")));
});
```

- [ ] **Step 2: Run the session-memory tests to verify they fail**

Run: `node --test portfolio/scripts/lib/report_session_memory.test.mjs`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement minimal session memory helper**

```js
export function updateReportSessionMemory(existing, input) {
  return { ...existing, days: { ...existing.days, [input.tradeDate]: { ...input } } };
}
```

- [ ] **Step 4: Wire session memory into market pulse, market brief, and daily brief**

```js
const sessionMemory = await readJsonOrNull(paths.reportSessionMemoryPath);
const updatedMemory = updateReportSessionMemory(sessionMemory, payload);
const inheritanceLines = buildReportSessionInheritanceLines(updatedMemory, context);
```

- [ ] **Step 5: Run report-focused tests and smoke-generate reports**

Run: `node --test portfolio/scripts/lib/report_session_memory.test.mjs portfolio/scripts/lib/report_context.test.mjs`

Expected: PASS.

### Task 4: Verify end-to-end report generation

**Files:**
- Modify: none expected beyond prior tasks

- [ ] **Step 1: Run the core unit suite**

Run: `node --test portfolio/scripts/generate_research_brain.test.mjs portfolio/scripts/lib/research_data_quality.test.mjs portfolio/scripts/lib/research_event_driver.test.mjs portfolio/scripts/lib/research_flow_macro_radar.test.mjs portfolio/scripts/lib/research_brain_render.test.mjs portfolio/scripts/lib/report_context.test.mjs portfolio/scripts/lib/report_session_memory.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run generators against the real workspace**

Run: `node portfolio/scripts/generate_research_brain.mjs --refresh auto`

Run: `node portfolio/scripts/generate_market_pulse.mjs --session morning --refresh auto`

Run: `node portfolio/scripts/generate_market_pulse.mjs --session noon --refresh auto`

Run: `node portfolio/scripts/generate_market_brief.mjs --refresh auto`

Run: `node portfolio/scripts/generate_daily_brief.mjs --refresh auto`

Expected: All files generate without throwing, and the rendered markdown includes degraded-flow warnings plus session inheritance lines.
