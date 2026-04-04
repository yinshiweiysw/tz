# Unified Research Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one shared rendering contract for research-brain-driven sections so morning/noon/close market pulses, market brief, and daily brief stay aligned on event driver, flow radar, and China/HK flow validation.

**Architecture:** Extend the existing research rendering helper into a higher-level module renderer that can emit normalized section blocks from `research_brain` and `cn_market_snapshot`. Downstream report scripts will stop assembling these sections ad hoc and instead consume the shared blocks with only small session-specific inclusion rules.

**Tech Stack:** Node.js ESM, `node:test`, existing report generators under `portfolio/scripts`

---

### Task 1: Lock the Shared Rendering Contract with Tests

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`

- [ ] **Step 1: Write the failing renderer contract tests**

```javascript
test("buildResearchFlowValidationLines renders northbound and southbound validation together", () => {
  const lines = buildResearchFlowValidationLines({
    sections: {
      northbound_flow: {
        latest_summary_net_buy_100m_cny: -23.4,
        latest_intraday_net_inflow_100m_cny: -11.2
      },
      southbound_flow: {
        latest_date: "2026-04-02",
        latest_summary_net_buy_100m_hkd: 198.28,
        latest_intraday_time: "16:10",
        latest_intraday_net_inflow_100m_hkd: 198.28
      }
    }
  });

  assert.ok(lines.some((line) => line.includes("北向")));
  assert.ok(lines.some((line) => line.includes("南向")));
});

test("buildUnifiedResearchSections returns the shared research headings in stable order", () => {
  const sections = buildUnifiedResearchSections({
    researchBrain: {
      event_driver: { status: "active_market_driver", primary_driver: "中东地缘升级推动油价再定价" },
      flow_macro_radar: { liquidity_regime: "neutral", confidence: 0.85, summary: "流动性中性，需等待更清晰信号。" },
      actionable_decision: { desk_conclusion: { trade_permission: "allowed", one_sentence_order: "允许围绕现有组合做选择性进攻。" } }
    },
    cnMarketSnapshot: {
      sections: {
        southbound_flow: { latest_date: "2026-04-02", latest_summary_net_buy_100m_hkd: 198.28 }
      }
    },
    researchGuardLines: ["- 决策状态：ready。"]
  });

  assert.deepEqual(
    sections.map((item) => item.heading),
    [
      "## Institutional Research Readiness",
      "## Active Market Driver",
      "## Flow & Macro Radar",
      "## China / HK Flow Validation",
      "## Desk Action Conclusion"
    ]
  );
});
```

- [ ] **Step 2: Run the renderer tests and verify they fail**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
Expected: FAIL with missing `buildResearchFlowValidationLines` and/or `buildUnifiedResearchSections`

- [ ] **Step 3: Add the minimal shared renderer implementation**

```javascript
export function buildResearchFlowValidationLines(cnMarketSnapshot = {}) {
  // Read northbound_flow and southbound_flow from cnMarketSnapshot.sections
  // Render both channels with stable fallback wording
}

export function buildUnifiedResearchSections({
  researchBrain = {},
  cnMarketSnapshot = {},
  researchGuardLines = []
} = {}) {
  return [
    { heading: "## Institutional Research Readiness", lines: researchGuardLines },
    { heading: "## Active Market Driver", lines: buildResearchDriverLines(researchBrain.event_driver) },
    { heading: "## Flow & Macro Radar", lines: buildResearchFlowRadarLines(researchBrain.flow_macro_radar) },
    { heading: "## China / HK Flow Validation", lines: buildResearchFlowValidationLines(cnMarketSnapshot) },
    { heading: "## Desk Action Conclusion", lines: buildResearchActionDecisionLines(researchBrain.actionable_decision) }
  ];
}
```

- [ ] **Step 4: Run the renderer tests and verify they pass**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs
git commit -m "feat: add unified research render helpers"
```

### Task 2: Rewire Market Brief and Market Pulses to the Shared Sections

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Write the failing integration tests for report source usage**

```javascript
test("market reports render the shared China / HK Flow Validation heading", async () => {
  const marketBriefSource = await readFile(
    "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs",
    "utf8"
  );
  const marketPulseSource = await readFile(
    "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs",
    "utf8"
  );

  assert.match(marketBriefSource, /buildUnifiedResearchSections/);
  assert.match(marketPulseSource, /buildUnifiedResearchSections/);
});
```

- [ ] **Step 2: Run the report integration tests and verify they fail**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
Expected: FAIL because the scripts still compose research headings manually

- [ ] **Step 3: Replace manual research heading assembly with shared section expansion**

```javascript
const researchSections = buildUnifiedResearchSections({
  researchBrain: activeResearchBrain,
  cnMarketSnapshot,
  researchGuardLines
});

const researchSectionLines = flattenResearchSections(researchSections);
```

- [ ] **Step 4: Run the report integration tests and verify they pass**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs
git commit -m "refactor: unify research rendering in market reports"
```

### Task 3: Connect Daily Brief to the Same Research Contract

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`

- [ ] **Step 1: Write the failing daily-brief-focused renderer test**

```javascript
test("flattenResearchSections can be reused by daily brief without duplicating section logic", () => {
  const lines = flattenResearchSections([
    { heading: "## Active Market Driver", lines: ["- 主线：中东地缘升级推动油价再定价"] },
    { heading: "## China / HK Flow Validation", lines: ["- 南向资金：2026-04-02 净买额 +198.28 亿元"] }
  ]);

  assert.ok(lines.includes("## Active Market Driver"));
  assert.ok(lines.includes("## China / HK Flow Validation"));
});
```

- [ ] **Step 2: Run the renderer tests and verify they fail**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
Expected: FAIL with missing `flattenResearchSections`

- [ ] **Step 3: Reuse the shared research section flattener in daily brief**

```javascript
const sharedResearchLines = flattenResearchSections(
  buildUnifiedResearchSections({
    researchBrain: payloads.researchBrain,
    cnMarketSnapshot,
    researchGuardLines: []
  }),
  { includeHeadings: ["## Active Market Driver", "## Flow & Macro Radar", "## China / HK Flow Validation"] }
);
```

- [ ] **Step 4: Run the renderer tests and targeted report tests**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs
git commit -m "refactor: reuse research rendering in daily brief"
```

### Task 4: Verify End-to-End Output for Morning, Noon, Close, and Daily Reports

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/state-manifest.json` (only if generated outputs update canonical latest paths)
- Test: `/Users/yinshiwei/codex/tz/portfolio/market_briefs/2026-04-03-market.md`
- Test: `/Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-03-morning.md`
- Test: `/Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-03-noon.md`
- Test: `/Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-03-close.md`
- Test: `/Users/yinshiwei/codex/tz/portfolio/daily_briefs/2026-04-03-brief.md`

- [ ] **Step 1: Run the full relevant automated test suite**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`
Expected: PASS

- [ ] **Step 2: Regenerate all four report entrypoints**

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --user main --refresh auto`

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session morning --refresh auto`

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session noon --refresh auto`

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session close --refresh auto`

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs --user main --date 2026-04-03`

Expected: exit 0, and generated markdown files contain aligned research sections

- [ ] **Step 3: Verify rendered headings and Southbound consistency**

Run: `rg -n "## Active Market Driver|## Flow & Macro Radar|## China / HK Flow Validation|南向资金" /Users/yinshiwei/codex/tz/portfolio/market_briefs/2026-04-03-market.md /Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-03-morning.md /Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-03-noon.md /Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-03-close.md /Users/yinshiwei/codex/tz/portfolio/daily_briefs/2026-04-03-brief.md`

Expected: every targeted output contains aligned research sections; Southbound wording is no longer isolated to a single report

- [ ] **Step 4: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts /Users/yinshiwei/codex/tz/portfolio/market_briefs /Users/yinshiwei/codex/tz/portfolio/market_pulses /Users/yinshiwei/codex/tz/portfolio/daily_briefs /Users/yinshiwei/codex/tz/portfolio/state-manifest.json
git commit -m "feat: align briefs and pulses to unified research contract"
```
