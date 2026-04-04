# Dialogue Analysis Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared dialogue analysis contract helper so conversational market analysis uses the same driver, flow, and action contract as reports without introducing a new persisted JSON layer.

**Architecture:** Add a focused helper under `portfolio/scripts/lib` that composes existing structured state (`research_brain`, `cn_market_snapshot`, `opportunity_pool`, `speculative_plan`, `trade_plan_v4`) into one normalized in-memory contract. Reuse shared report render helpers rather than inventing another wording stack, then update operating documentation so future sessions know to route dialogue analysis through this helper first.

**Tech Stack:** Node.js ESM, `node:test`, existing report/trade helper modules, Markdown protocol docs

---

### Task 1: Lock the Dialogue Contract Shape with Failing Tests

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`

- [ ] **Step 1: Write the failing contract tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import { buildDialogueAnalysisContract } from "./dialogue_analysis_contract.mjs";

test("buildDialogueAnalysisContract reuses the shared research sections and exposes flow validation", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      generated_at: "2026-04-03T00:10:00+08:00",
      decision_readiness: { level: "ready" },
      event_driver: {
        primary_driver: "中东地缘升级推动油价再定价",
        priced_in_assessment: "underpriced"
      },
      flow_macro_radar: {
        liquidity_regime: "neutral",
        summary: "流动性中性，需等待更清晰信号。"
      },
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "allowed",
          one_sentence_order: "允许围绕现有组合做选择性进攻。",
          must_not_do: ["不要脱离组合框架追涨"]
        },
        portfolio_actions: [{ target_key: "007339", stance: "hold", execution_note: "仅在既定计划范围内执行。" }],
        new_watchlist_actions: [{ theme: "红利低波", stance: "watch", why_now: "利差仍有吸引力。" }]
      }
    },
    cnMarketSnapshot: {
      sections: {
        southbound_flow: {
          latest_date: "2026-04-02",
          latest_summary_net_buy_100m_hkd: 198.28,
          latest_intraday_time: "16:10",
          latest_intraday_net_inflow_100m_hkd: 198.28
        }
      }
    }
  });

  assert.equal(contract.market_core.active_driver, "中东地缘升级推动油价再定价");
  assert.equal(contract.market_core.southbound_net_buy_100m_hkd, 198.28);
  assert.ok(contract.shared_research_sections.some((section) => section.heading === "## China / HK Flow Validation"));
  assert.ok(contract.dialogue_cues.opening_brief.includes("中东地缘升级推动油价再定价"));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
Expected: FAIL with module/file not found or missing export

- [ ] **Step 3: Implement the minimal helper**

```javascript
export function buildDialogueAnalysisContract({
  researchBrain = {},
  cnMarketSnapshot = {},
  opportunityPool = {},
  speculativePlan = {},
  tradePlan = {}
} = {}) {
  return {
    meta: {},
    market_core: {},
    portfolio_actions: [],
    watchlist_actions: [],
    opportunity_candidates: [],
    speculative_overlay: {},
    trade_plan_summary: {},
    shared_research_sections: [],
    dialogue_cues: {}
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs
git commit -m "feat: add dialogue analysis contract helper"
```

### Task 2: Reuse Existing Research and Trade Helpers Inside the Contract

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`

- [ ] **Step 1: Expand the tests for speculative and trade-plan summaries**

```javascript
test("buildDialogueAnalysisContract summarizes speculative overlay and first trade focus", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      actionable_decision: { desk_conclusion: { trade_permission: "allowed", one_sentence_order: "允许围绕现有组合做选择性进攻。" } }
    },
    speculativePlan: {
      instructions: []
    },
    tradePlan: {
      summary: {
        actionable_trade_count: 2,
        gross_buy_cny: 5000,
        gross_sell_cny: 3000
      },
      trades: [{ symbol: "007339", execution_action: "Buy", planned_trade_amount_cny: 5000 }]
    }
  });

  assert.equal(contract.speculative_overlay.instruction_count, 0);
  assert.equal(contract.trade_plan_summary.actionable_trade_count, 2);
  assert.ok(contract.dialogue_cues.analyst_focus.some((line) => line.includes("007339")));
});
```

- [ ] **Step 2: Run the tests and verify they fail for missing fields**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
Expected: FAIL on `speculative_overlay` / `trade_plan_summary` assertions

- [ ] **Step 3: Implement reuse of shared helpers**

```javascript
import { buildUnifiedResearchSections } from "./research_brain_render.mjs";
import { extractSpeculativeConclusionLines } from "./dual_trade_plan_render.mjs";

// normalize top opportunity candidates
// normalize speculative overlay
// normalize trade plan summary and first actionable trade
// derive dialogue cues from the same desk conclusion and shared sections
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs
git commit -m "feat: compose dialogue contract from shared research brain"
```

### Task 3: Update the Operating Protocol So Future Sessions Use the Contract

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md`
- Test: `/Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md`

- [ ] **Step 1: Add protocol language for dialogue analysis routing**

```markdown
13. 若用户询问“分析当前行情 / 今天是否可以买卖 / A股港股黄金怎么看”，先用 `portfolio/scripts/lib/dialogue_analysis_contract.mjs` 从 `research_brain + cn_market_snapshot + opportunity_pool + speculative_plan + trade_plan` 组装对话分析合同，再结合当下需要的实时行情补充结论。
```

- [ ] **Step 2: Verify the protocol contains the new routing rule**

Run: `rg -n "dialogue_analysis_contract|分析当前行情|可以买卖" /Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md`
Expected: one or more matches showing the new rule

- [ ] **Step 3: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md
git commit -m "docs: route dialogue analysis through shared contract"
```

### Task 4: End-to-End Verification

**Files:**
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Run the full relevant test suite**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
Expected: PASS

- [ ] **Step 2: Smoke the helper against real current data**

Run:

```bash
node -e "import('./portfolio/scripts/lib/dialogue_analysis_contract.mjs').then(async ({ buildDialogueAnalysisContract }) => { \
const fs = await import('node:fs/promises'); \
const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8')); \
const contract = buildDialogueAnalysisContract({ \
researchBrain: await read('./portfolio/data/research_brain.json'), \
cnMarketSnapshot: await read('./portfolio/cn_market_snapshots/2026-04-03-cn-snapshot.json'), \
opportunityPool: await read('./portfolio/data/opportunity_pool.json'), \
speculativePlan: await read('./portfolio/data/speculative_plan.json'), \
tradePlan: await read('./portfolio/data/trade_plan_v4.json') \
}); \
console.log(JSON.stringify({ opening: contract.dialogue_cues.opening_brief, southbound: contract.market_core.southbound_net_buy_100m_hkd, tradePermission: contract.meta.trade_permission }, null, 2)); })"
```

Expected: prints a coherent opening brief plus Southbound and trade permission fields

- [ ] **Step 3: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dialogue_analysis_contract.test.mjs /Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md
git commit -m "feat: unify dialogue analysis with research contract"
```
