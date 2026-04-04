# Portfolio State Hard Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `portfolio_state.json` the only business truth, force all action memos to obey research gating, and migrate the funds dashboard to the new state contract.

**Architecture:** First lock user-facing action text behind the research decision gate so stale trade plans cannot leak executable guidance. Then remove `holdings` as a tolerated core input and migrate dashboard rendering to `positions + pending_profit_effective_positions`, preserving OTC T+1 accounting semantics end-to-end.

**Tech Stack:** Node.js ESM, node:test, existing portfolio scripts and dashboard service

---

## File Map

- Modify: `portfolio/scripts/generate_daily_brief.mjs`
- Modify: `portfolio/scripts/generate_market_brief.mjs`
- Modify: `portfolio/scripts/generate_market_pulse.mjs`
- Modify: `portfolio/scripts/lib/dual_trade_plan_render.mjs`
- Modify: `portfolio/scripts/lib/research_actionable_decision.mjs`
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Test: `portfolio/scripts/lib/dual_trade_plan_render.test.mjs`
- Test: `portfolio/scripts/lib/research_actionable_decision.test.mjs`
- Test: `portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Test: `portfolio/scripts/lib/fund_market_session_policy.test.mjs`
- Create: `portfolio/scripts/generate_daily_brief.blocking.test.mjs`
- Create: `portfolio/scripts/serve_funds_live_dashboard.test.mjs`

## Task 1: Lock Daily Brief Action Memo Behind Research Gating

**Files:**
- Modify: `portfolio/scripts/generate_daily_brief.mjs`
- Modify: `portfolio/scripts/lib/dual_trade_plan_render.mjs`
- Test: `portfolio/scripts/lib/dual_trade_plan_render.test.mjs`
- Create: `portfolio/scripts/generate_daily_brief.blocking.test.mjs`

- [ ] **Step 1: Write the failing tests for blocked action rendering**

```js
test("daily brief suppresses executable trade-plan wording when research desk is blocked", async () => {
  const markdown = buildDailyInstitutionalMemoLines({
    researchDeskConclusion: {
      trade_permission: "blocked",
      one_sentence_order: "研究闸门未通过，当前禁止生成交易指令。"
    },
    nextTradeCurrentConclusion: ["- 当前计划以“先减后买”为主。"],
    nextTradeFirstLeg: ["- 标的：招商量化精选股票A", "- 状态：可执行"],
    nextTradeSpeculativeConclusions: ["- 当前无触发的左侧博弈机会。"],
    hasBlockingQualityIssues: false
  });

  assert.equal(markdown.some((line) => line.includes("可执行")), false);
  assert.equal(markdown.some((line) => line.includes("禁止")), true);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
node --test portfolio/scripts/lib/dual_trade_plan_render.test.mjs portfolio/scripts/generate_daily_brief.blocking.test.mjs
```

Expected: FAIL because `buildDailyInstitutionalMemoLines` does not yet accept desk gating input.

- [ ] **Step 3: Implement the minimal gating-aware memo path**

```js
export function buildInstitutionalActionLines({
  thesis = "",
  expectationGap = "",
  allowedActions = [],
  blockedActions = [],
  tradePermission = null,
  blockedOrder = ""
} = {}) {
  if (tradePermission === "blocked" || tradePermission === "research_invalid") {
    return [
      `- 今日主线：${String(thesis ?? "").trim() || "当前主线存在，但研究闸门未通过。"}`,
      `- 当前预期差：${String(expectationGap ?? "").trim() || "先处理研究与数据约束，再谈执行。"}`,
      `- 允许动作：仅允许观察与记录，不生成交易指令`,
      `- 禁止动作：${blockedOrder || "研究闸门未通过，禁止生成交易指令。"}`
    ];
  }

  return [
    `- 今日主线：${thesisLine}`,
    `- 当前预期差：${expectationGapLine}`,
    `- 允许动作：${allowedLine}`,
    `- 禁止动作：${blockedLine}`
  ];
}
```

In `generate_daily_brief.mjs`, pass `researchBrain?.actionable_decision?.desk_conclusion`.

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
node --test portfolio/scripts/lib/dual_trade_plan_render.test.mjs portfolio/scripts/generate_daily_brief.blocking.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/generate_daily_brief.mjs portfolio/scripts/lib/dual_trade_plan_render.mjs portfolio/scripts/lib/dual_trade_plan_render.test.mjs portfolio/scripts/generate_daily_brief.blocking.test.mjs
git commit -m "fix: gate daily brief actions by research decision"
```

## Task 2: Apply the Same Desk Gate to Market Brief and Market Pulse

**Files:**
- Modify: `portfolio/scripts/generate_market_brief.mjs`
- Modify: `portfolio/scripts/generate_market_pulse.mjs`
- Test: existing market brief / pulse test coverage or add focused assertions if absent

- [ ] **Step 1: Add a failing assertion for blocked desk text reuse**

```js
assert.match(renderedMarkdown, /交易许可：blocked/);
assert.doesNotMatch(renderedMarkdown, /状态：可执行/);
```

- [ ] **Step 2: Run the relevant test target to verify failure**

Run:

```bash
node --test portfolio/scripts/generate_research_brain.test.mjs
```

Expected: FAIL or missing assertion coverage, showing the market outputs still tolerate conflicting action text.

- [ ] **Step 3: Implement minimal consistency changes**

Use the same `desk_conclusion.trade_permission` contract to short-circuit any executable rendering in market brief / pulse when blocked.

- [ ] **Step 4: Run the relevant tests**

Run:

```bash
node --test portfolio/scripts/generate_research_brain.test.mjs portfolio/scripts/lib/research_brain_render.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/generate_market_brief.mjs portfolio/scripts/generate_market_pulse.mjs
git commit -m "fix: align intraday reports with desk trade gating"
```

## Task 3: Remove `holdings` as a Core Decision Input

**Files:**
- Modify: `portfolio/scripts/lib/research_actionable_decision.mjs`
- Modify: any direct consumers surfaced by ripgrep during implementation
- Test: `portfolio/scripts/lib/research_actionable_decision.test.mjs`

- [ ] **Step 1: Write the failing test that rejects holdings-only input**

```js
test("buildResearchActionableDecision does not derive portfolio actions from legacy holdings only", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    portfolioState: { holdings: [{ code: "007339" }] },
    eventDriver: {},
    flowMacroRadar: {},
    opportunityPool: {}
  });

  assert.equal(result.portfolio_actions.length, 0);
});
```

- [ ] **Step 2: Run the test to verify failure**

Run:

```bash
node --test portfolio/scripts/lib/research_actionable_decision.test.mjs
```

Expected: FAIL because holdings are still accepted as fallback input.

- [ ] **Step 3: Implement the minimal contract tightening**

```js
function normalizePortfolioTargets(portfolioState = {}) {
  return Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];
}
```

If any caller still passes only `holdings`, leave it empty and let tests expose the missing migration.

- [ ] **Step 4: Run tests**

Run:

```bash
node --test portfolio/scripts/lib/research_actionable_decision.test.mjs portfolio/scripts/generate_dialogue_analysis_contract.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/lib/research_actionable_decision.mjs portfolio/scripts/lib/research_actionable_decision.test.mjs
git commit -m "refactor: require positions in research portfolio decisions"
```

## Task 4: Move Dashboard Rendering to `portfolio_state`

**Files:**
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Create: `portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Reuse: `portfolio/scripts/lib/fund_market_session_policy.mjs`

- [ ] **Step 1: Write the failing dashboard tests**

```js
test("dashboard renders pending OTC buys from pending_profit_effective_positions without adding same-day pnl", () => {
  const state = {
    positions: [],
    pending_profit_effective_positions: [
      {
        name: "易方达沪深300ETF联接C",
        amount: 4000,
        daily_pnl: 0,
        holding_pnl: 0,
        execution_type: "OTC",
        trade_date: "2026-04-03",
        profit_effective_on: "2026-04-07"
      }
    ]
  };

  const rows = buildDashboardRowsFromPortfolioState(state);
  assert.equal(rows[0].pnlStatus, "pending_profit_effective");
  assert.equal(rows[0].dailyPnl, 0);
});
```

- [ ] **Step 2: Run the dashboard test to verify failure**

Run:

```bash
node --test portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: FAIL because the dashboard service still reads mixed legacy state.

- [ ] **Step 3: Implement minimal dashboard state mapping**

Add a single adapter that accepts only:

```js
const activePositions = Array.isArray(state.positions) ? state.positions : [];
const pendingPositions = Array.isArray(state.pending_profit_effective_positions)
  ? state.pending_profit_effective_positions
  : [];
```

Generate normalized rows from these arrays and annotate pending OTC buys explicitly.

- [ ] **Step 4: Run dashboard tests**

Run:

```bash
node --test portfolio/scripts/serve_funds_live_dashboard.test.mjs portfolio/scripts/lib/fund_market_session_policy.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/serve_funds_live_dashboard.mjs portfolio/scripts/serve_funds_live_dashboard.test.mjs
git commit -m "refactor: drive funds dashboard from portfolio state"
```

## Task 5: Regression Verification and Real Generator Checks

**Files:**
- No new production files
- Use updated tests and generators

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
node --test \
  portfolio/scripts/lib/dual_trade_plan_render.test.mjs \
  portfolio/scripts/generate_daily_brief.blocking.test.mjs \
  portfolio/scripts/lib/research_actionable_decision.test.mjs \
  portfolio/scripts/lib/portfolio_state_materializer.test.mjs \
  portfolio/scripts/lib/fund_market_session_policy.test.mjs \
  portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: all PASS

- [ ] **Step 2: Regenerate the live outputs**

Run:

```bash
node portfolio/scripts/generate_research_brain.mjs --refresh auto
node portfolio/scripts/generate_market_brief.mjs --date 2026-04-03 --refresh auto
node portfolio/scripts/generate_daily_brief.mjs --date 2026-04-03 --refresh auto
```

Expected:
- no actionable trade text when desk is blocked
- no contradiction between daily brief and market brief

- [ ] **Step 3: Smoke-test the dashboard service**

Run:

```bash
node portfolio/scripts/serve_funds_live_dashboard.mjs
```

Expected: dashboard starts and renders rows from `portfolio_state.json`, including pending OTC buys if present.

- [ ] **Step 4: Review outputs manually**

Check:

- `portfolio/daily_briefs/2026-04-03-brief.md`
- `portfolio/market_briefs/2026-04-03-market.md`
- dashboard visible rows

Expected:
- blocked sessions never show "可执行"
- same-day OTC buys are marked pending, not profitable

- [ ] **Step 5: Commit**

```bash
git add portfolio/daily_briefs/2026-04-03-brief.md portfolio/market_briefs/2026-04-03-market.md
git commit -m "test: verify portfolio-state hard cut outputs"
```
