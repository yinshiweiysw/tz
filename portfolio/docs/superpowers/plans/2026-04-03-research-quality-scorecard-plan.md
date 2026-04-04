# Research Quality Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert morning/noon/close session memory into a rolling research quality scorecard and hit-rate summary, then surface the results in the daily brief.

**Architecture:** Add one pure scoring module that evaluates session-memory chains per trade date, one generator script that writes `report_quality_scorecard.json` and `analysis_hit_rate.json`, then let `generate_daily_brief.mjs` read those files and render a concise review section. The scoring contract stays independent from trading logic and uses only persisted session-memory records.

**Tech Stack:** Node.js ES modules, node:test, JSON artifacts, existing report context/path helpers.

---

### Task 1: Add failing tests for scorecard contract and path wiring

**Files:**
- Create: `portfolio/scripts/lib/report_quality_scorecard.test.mjs`
- Modify: `portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test("buildReportQualityScorecard scores validation, attribution, and next-day bias", () => {
  assert.equal(scorecard.daily_records[0].morning_to_noon.status, "hit");
  assert.equal(scorecard.daily_records[0].next_day_bias.status, "pending");
});

test("buildAnalyticsPaths exposes report quality scorecard paths", () => {
  assert.equal(paths.reportQualityScorecardPath, "/tmp/pf/data/report_quality_scorecard.json");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test portfolio/scripts/lib/report_quality_scorecard.test.mjs portfolio/scripts/lib/report_context.test.mjs`

Expected: FAIL because the scorecard module and paths do not exist yet.

### Task 2: Implement scorecard and generator

**Files:**
- Create: `portfolio/scripts/lib/report_quality_scorecard.mjs`
- Create: `portfolio/scripts/generate_report_quality_scorecard.mjs`
- Modify: `portfolio/scripts/lib/report_context.mjs`

- [ ] **Step 1: Write minimal implementation to satisfy the first scorecard test**

```js
export function buildReportQualityScorecard() {
  return {
    daily_records: [],
    rolling_summary: {}
  };
}
```

- [ ] **Step 2: Run the scorecard tests to verify they still fail on behavior**

Run: `node --test portfolio/scripts/lib/report_quality_scorecard.test.mjs`

Expected: FAIL on expected statuses and aggregation fields.

- [ ] **Step 3: Implement scoring logic and generator output**

```js
const scorecard = buildReportQualityScorecard(memory);
await writeFile(reportQualityScorecardPath, JSON.stringify(scorecard, null, 2));
await writeFile(analysisHitRatePath, JSON.stringify(scorecard.hit_rate_summary, null, 2));
```

- [ ] **Step 4: Run focused tests and generator smoke test**

Run: `node --test portfolio/scripts/lib/report_quality_scorecard.test.mjs portfolio/scripts/lib/report_context.test.mjs`

Run: `node portfolio/scripts/generate_report_quality_scorecard.mjs --date 2026-04-03`

Expected: PASS, and both JSON files are written.

### Task 3: Surface scorecard in the daily brief

**Files:**
- Modify: `portfolio/scripts/generate_daily_brief.mjs`
- Modify: `portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Add failing test for daily brief consumption**

```js
assert.match(dailyBriefSource, /reportQualityScorecardPath/);
assert.match(dailyBriefSource, /研究质量回看/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test portfolio/scripts/lib/report_context.test.mjs`

Expected: FAIL because daily brief does not reference the scorecard yet.

- [ ] **Step 3: Implement minimal rendering**

```js
const scorecardLines = buildResearchQualityReviewLines(scorecard, hitRateSummary);
lines.splice(insertIndex, 0, "## 研究质量回看", "", ...scorecardLines, "");
```

- [ ] **Step 4: Re-run tests and real brief generation**

Run: `node --test portfolio/scripts/lib/report_context.test.mjs portfolio/scripts/lib/report_quality_scorecard.test.mjs`

Run: `node portfolio/scripts/generate_daily_brief.mjs --date 2026-04-03 --refresh auto`

Expected: PASS, and the generated daily brief includes the new scorecard section.

### Task 4: Verify end-to-end outputs

**Files:**
- Modify: none expected beyond prior tasks

- [ ] **Step 1: Run the complete targeted suite**

Run: `node --test portfolio/scripts/lib/report_quality_scorecard.test.mjs portfolio/scripts/lib/report_context.test.mjs portfolio/scripts/lib/report_session_memory.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run generators in sequence**

Run: `node portfolio/scripts/generate_report_quality_scorecard.mjs --date 2026-04-03`

Run: `node portfolio/scripts/generate_daily_brief.mjs --date 2026-04-03 --refresh auto`

Expected: `report_quality_scorecard.json`, `analysis_hit_rate.json`, and the updated brief are all generated without errors.
