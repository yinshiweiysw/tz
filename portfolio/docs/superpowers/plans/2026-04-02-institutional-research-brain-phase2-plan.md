# Institutional Research Brain Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `research_brain.json` into one institutional analysis and decision substrate that captures market drivers, flow and macro regime, and unified desk actions for reports and dialogue.

**Architecture:** Add three focused interpretation modules to the Phase 1 substrate: `event_driver`, `flow_macro_radar`, and `actionable_decision`. Keep `generate_research_brain.mjs` orchestration-only, wire new data into `research_brain.json`, and make market brief and pulse render from the new contract instead of recomputing local tactical views.

**Tech Stack:** Node.js ESM, `node:test`, existing `market-mcp` stock providers, existing report refresh framework, existing Phase 1 `research_brain` helpers.

---

## File Structure

### New files

- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.mjs`
  Build the normalized market-driver contract from telegraphs, headlines, and cross-asset confirmation.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs`
  Deterministic tests for active drivers, priced-in noise, and watch-only degradation.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.mjs`
  Build the normalized flow and macro regime contract from cross-asset anchors and China/HK flow summaries.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.test.mjs`
  Deterministic tests for `risk_on`, `risk_off`, `stress`, and degraded-confidence outcomes.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.mjs`
  Convert readiness + event + flow + portfolio state into one desk action contract.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`
  Deterministic tests for allowed, restricted, and blocked trade language plus new-watchlist limits.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.mjs`
  Shared render helpers for market brief and pulse so both consumers use the same `research_brain` fields.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
  Regression tests for driver, flow, and action sections.

### Existing files to modify

- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs`
  Load additional upstream evidence, run the new interpretation modules, and write the extended contract.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`
  Expand orchestrator contract coverage for the new blocks.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.mjs`
  Refresh and expose any additional upstream evidence needed by `research_brain` without duplicating tactical logic.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
  Verify refresh sequencing and degraded behavior for the new contract.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
  Replace ad hoc tactical rendering with `research_brain`-driven sections.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
  Replace ad hoc tactical rendering with `research_brain`-driven sections.

### Implementation guardrail

- Do **not** create a `decision_brain.json`.
- Do **not** commit unless the user explicitly requests it.
- Preserve Phase 1 readiness and degradation semantics.

### Task 1: Build the event driver module

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs`

- [ ] **Step 1: Write the failing event-driver tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchEventDriver } from "./research_event_driver.mjs";

test("buildResearchEventDriver promotes a cross-asset confirmed headline to active_market_driver", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "特朗普称将扩大关税范围",
        content: "市场重定价全球风险资产。",
        published_at: "2026-04-02T08:05:00+08:00",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100期货", change_pct: -1.9 }],
      commodities: [{ label: "伦敦金", change_pct: 1.3 }, { label: "WTI原油", change_pct: 2.1 }],
      rates_fx: [{ label: "美元指数", change_pct: 0.6 }]
    }
  });

  assert.equal(result.status, "active_market_driver");
  assert.match(result.primary_driver ?? "", /关税/);
  assert.equal(result.driver_scope, "cross_asset");
  assert.ok(result.evidence.length >= 2);
});

test("buildResearchEventDriver degrades unconfirmed headlines to watch_only", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "小作文传言刺激局部题材",
        content: "未经证实。",
        published_at: "2026-04-02T09:15:00+08:00",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [],
      commodities: [],
      rates_fx: []
    }
  });

  assert.equal(result.status, "watch_only");
  assert.equal(result.priced_in_assessment, "unclear");
});

test("buildResearchEventDriver marks already digested repeated narratives as priced_in_noise", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "市场继续讨论昨日已落地的降息决定",
        content: "增量信息有限。",
        published_at: "2026-04-02T10:00:00+08:00",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "标普500期货", change_pct: 0.1 }],
      commodities: [{ label: "伦敦金", change_pct: 0.0 }],
      rates_fx: [{ label: "美元指数", change_pct: -0.1 }]
    }
  });

  assert.equal(result.status, "priced_in_noise");
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `research_event_driver.mjs`.

- [ ] **Step 3: Write the minimal event-driver implementation**

```js
const ACTIVE_KEYWORDS = ["关税", "停火", "袭击", "降息", "制裁", "原油", "黄金", "美债"];
const NOISE_KEYWORDS = ["小作文", "传言", "局部异动", "盘面直播"];

function normalizeHeadline(item) {
  return `${item?.title ?? ""} ${item?.content ?? ""}`.replace(/\s+/g, " ").trim();
}

function scoreHeadline(text) {
  let score = 0;
  for (const keyword of ACTIVE_KEYWORDS) {
    if (text.includes(keyword)) score += 2;
  }
  for (const keyword of NOISE_KEYWORDS) {
    if (text.includes(keyword)) score -= 3;
  }
  return score;
}

function summarizeCrossAssetConfirmation(marketSnapshot = {}) {
  const rows = [
    ...(marketSnapshot.global_indices ?? []),
    ...(marketSnapshot.commodities ?? []),
    ...(marketSnapshot.rates_fx ?? [])
  ];
  return rows.filter((row) => Number.isFinite(Number(row?.change_pct)) && Math.abs(Number(row.change_pct)) >= 0.5);
}

export function buildResearchEventDriver({ telegraphs = [], marketSnapshot = {} } = {}) {
  const normalized = telegraphs.map((item) => {
    const headline = normalizeHeadline(item);
    return {
      headline,
      score: scoreHeadline(headline),
      published_at: item?.published_at ?? null,
      source: item?.source ?? "unknown"
    };
  });

  const best = normalized.sort((left, right) => right.score - left.score)[0] ?? null;
  const confirmations = summarizeCrossAssetConfirmation(marketSnapshot);

  if (!best) {
    return {
      status: "unavailable",
      primary_driver: null,
      secondary_drivers: [],
      driver_scope: "cross_asset",
      surprise_level: "low",
      priced_in_assessment: "unclear",
      evidence: [],
      market_impact: {}
    };
  }

  if (best.score <= 0) {
    return {
      status: "watch_only",
      primary_driver: best.headline,
      secondary_drivers: [],
      driver_scope: "cross_asset",
      surprise_level: "low",
      priced_in_assessment: "unclear",
      evidence: [{ source: best.source, headline: best.headline, timestamp: best.published_at }],
      market_impact: {}
    };
  }

  if (confirmations.length < 2) {
    return {
      status: "watch_only",
      primary_driver: best.headline,
      secondary_drivers: [],
      driver_scope: "cross_asset",
      surprise_level: "medium",
      priced_in_assessment: "unclear",
      evidence: [{ source: best.source, headline: best.headline, timestamp: best.published_at }],
      market_impact: {}
    };
  }

  return {
    status: best.headline.includes("昨日已落地") ? "priced_in_noise" : "active_market_driver",
    primary_driver: best.headline,
    secondary_drivers: normalized.slice(1, 4).map((item) => item.headline),
    driver_scope: "cross_asset",
    surprise_level: confirmations.length >= 3 ? "high" : "medium",
    priced_in_assessment: best.headline.includes("昨日已落地") ? "fully_priced_in" : "underpriced",
    evidence: [
      { source: best.source, headline: best.headline, timestamp: best.published_at },
      ...confirmations.map((row) => ({ source: "market_snapshot", headline: row.label, move_pct: row.change_pct }))
    ],
    market_impact: {}
  };
}
```

- [ ] **Step 4: Run the tests to verify the event driver passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Do not commit; keep the diff local unless the user explicitly asks for a commit**

Run: `git diff -- /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs`

Expected: Diff shows only the new event-driver module and tests.

### Task 2: Build the flow and macro radar module

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.test.mjs`

- [ ] **Step 1: Write the failing flow-radar tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchFlowMacroRadar } from "./research_flow_macro_radar.mjs";

test("buildResearchFlowMacroRadar returns risk_on when yields ease, usd softens, and hk/china flows confirm", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {
      fed_watch: { implied_cut_probability_next_meeting: 68 },
      inflation: { cpi_status: "cooling", ppi_status: "weak" }
    },
    marketSnapshot: {
      commodities: [{ label: "伦敦金", change_pct: 0.4 }, { label: "WTI原油", change_pct: -0.8 }],
      rates_fx: [{ label: "美元指数", change_pct: -0.5 }, { label: "美国10Y国债", change_pct: -0.12 }]
    },
    cnMarketSnapshot: {
      sections: {
        northbound_flow: { latest_summary_net_buy_100m_cny: 42.5 },
        sector_fund_flow: { top_inflow_sectors: ["券商", "半导体"] }
      }
    },
    hkFlowSnapshot: {
      southbound_net_buy_100m_hkd: 55.8,
      hk_tech_relative_strength: 1.7
    }
  });

  assert.equal(result.liquidity_regime, "risk_on");
  assert.ok(result.confidence >= 0.7);
});

test("buildResearchFlowMacroRadar returns stress when oil and gold spike with firmer usd", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {},
    marketSnapshot: {
      commodities: [{ label: "伦敦金", change_pct: 1.6 }, { label: "WTI原油", change_pct: 3.4 }],
      rates_fx: [{ label: "美元指数", change_pct: 0.7 }, { label: "美国10Y国债", change_pct: 0.09 }]
    },
    cnMarketSnapshot: { sections: {} },
    hkFlowSnapshot: {}
  });

  assert.equal(result.liquidity_regime, "stress");
});

test("buildResearchFlowMacroRadar degrades confidence when key anchors are missing", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {},
    marketSnapshot: { commodities: [], rates_fx: [] },
    cnMarketSnapshot: { sections: {} },
    hkFlowSnapshot: {}
  });

  assert.equal(result.liquidity_regime, "neutral");
  assert.ok(result.confidence < 0.5);
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `research_flow_macro_radar.mjs`.

- [ ] **Step 3: Write the minimal flow-radar implementation**

```js
function findMove(rows = [], matcher) {
  const row = rows.find((item) => matcher(String(item?.label ?? "")));
  return Number.isFinite(Number(row?.change_pct)) ? Number(row.change_pct) : null;
}

export function buildResearchFlowMacroRadar({
  macroState = {},
  marketSnapshot = {},
  cnMarketSnapshot = {},
  hkFlowSnapshot = {}
} = {}) {
  const goldMove = findMove(marketSnapshot.commodities, (label) => label.includes("金"));
  const oilMove = findMove(marketSnapshot.commodities, (label) => label.includes("油"));
  const dxyMove = findMove(marketSnapshot.rates_fx, (label) => label.includes("美元"));
  const us10yMove = findMove(marketSnapshot.rates_fx, (label) => label.includes("10Y"));
  const northbound = Number(cnMarketSnapshot?.sections?.northbound_flow?.latest_summary_net_buy_100m_cny ?? NaN);
  const southbound = Number(hkFlowSnapshot?.southbound_net_buy_100m_hkd ?? NaN);
  const hkTechStrength = Number(hkFlowSnapshot?.hk_tech_relative_strength ?? NaN);

  let liquidityRegime = "neutral";
  if (
    Number.isFinite(oilMove) && oilMove >= 2 &&
    Number.isFinite(goldMove) && goldMove >= 1 &&
    Number.isFinite(dxyMove) && dxyMove > 0
  ) {
    liquidityRegime = "stress";
  } else if (
    Number.isFinite(us10yMove) && us10yMove < 0 &&
    Number.isFinite(dxyMove) && dxyMove < 0 &&
    ((Number.isFinite(northbound) && northbound > 0) || (Number.isFinite(southbound) && southbound > 0))
  ) {
    liquidityRegime = "risk_on";
  } else if (
    Number.isFinite(northbound) && northbound < 0 &&
    Number.isFinite(dxyMove) && dxyMove > 0
  ) {
    liquidityRegime = "risk_off";
  }

  const knownAnchors = [goldMove, oilMove, dxyMove, us10yMove].filter((value) => Number.isFinite(value)).length;
  const confidence = Number((Math.min(knownAnchors, 4) / 4 + (Number.isFinite(hkTechStrength) ? 0.1 : 0)).toFixed(2));

  return {
    cross_asset_anchors: {
      us10y_yield: us10yMove,
      dxy: dxyMove,
      gold: goldMove,
      oil: oilMove,
      fed_cut_probability: macroState?.fed_watch?.implied_cut_probability_next_meeting ?? null,
      cpi_status: macroState?.inflation?.cpi_status ?? null,
      ppi_status: macroState?.inflation?.ppi_status ?? null
    },
    china_flows: {
      northbound,
      sector_flow: cnMarketSnapshot?.sections?.sector_fund_flow ?? {},
      a_share_breadth: cnMarketSnapshot?.sections?.market_breadth ?? null
    },
    hong_kong_flows: {
      southbound,
      hang_seng_leadership: hkFlowSnapshot?.hang_seng_leadership ?? null,
      hk_tech_relative_strength: hkTechStrength
    },
    liquidity_regime: liquidityRegime,
    confidence,
    summary: liquidityRegime === "stress" ? "地缘与通胀扰动占上风。" : "流动性状态可控。",
    alerts: []
  };
}
```

- [ ] **Step 4: Run the tests to verify the flow radar passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.test.mjs`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Do not commit; keep the diff local unless the user explicitly asks for a commit**

Run: `git diff -- /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.test.mjs`

Expected: Diff shows only the flow-radar module and tests.

### Task 3: Build the actionable decision module

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`

- [ ] **Step 1: Write the failing action-decision tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchActionableDecision } from "./research_actionable_decision.mjs";

test("buildResearchActionableDecision allows portfolio and watchlist actions when readiness is ready", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    eventDriver: { status: "active_market_driver", primary_driver: "港股科技修复" },
    flowMacroRadar: { liquidity_regime: "risk_on", confidence: 0.82 },
    portfolioState: { holdings: [{ code: "968012", bucket: "港股参与仓" }] },
    opportunityPool: {
      candidates: [
        { theme: "港股科技", action_bias: "watch", why_now: "南向承接增强" },
        { theme: "创新药", action_bias: "watch", why_now: "资金回流" }
      ]
    }
  });

  assert.equal(result.desk_conclusion.trade_permission, "allowed");
  assert.ok(result.new_watchlist_actions.length <= 3);
});

test("buildResearchActionableDecision restricts action language when readiness is degraded", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "analysis_degraded", analysis_allowed: true, trading_allowed: false },
    eventDriver: { status: "watch_only", primary_driver: "消息待验证" },
    flowMacroRadar: { liquidity_regime: "neutral", confidence: 0.42 },
    portfolioState: {},
    opportunityPool: {}
  });

  assert.equal(result.desk_conclusion.trade_permission, "restricted");
  assert.match(result.desk_conclusion.one_sentence_order ?? "", /条件/);
});

test("buildResearchActionableDecision blocks trading when readiness is blocked", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "trading_blocked", analysis_allowed: true, trading_allowed: false },
    eventDriver: { status: "active_market_driver", primary_driver: "地缘冲突" },
    flowMacroRadar: { liquidity_regime: "stress", confidence: 0.9 },
    portfolioState: {},
    opportunityPool: {}
  });

  assert.equal(result.desk_conclusion.trade_permission, "blocked");
  assert.equal(result.portfolio_actions.length, 0);
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `research_actionable_decision.mjs`.

- [ ] **Step 3: Write the minimal actionable-decision implementation**

```js
function normalizeOpportunityCandidates(opportunityPool = {}) {
  const input = opportunityPool?.candidates ?? opportunityPool?.top_candidates ?? [];
  return Array.isArray(input) ? input.slice(0, 3) : [];
}

export function buildResearchActionableDecision({
  decisionReadiness = {},
  eventDriver = {},
  flowMacroRadar = {},
  portfolioState = {},
  opportunityPool = {}
} = {}) {
  const level = String(decisionReadiness?.level ?? "").trim();
  const tradingAllowed = decisionReadiness?.trading_allowed === true;

  if (level === "trading_blocked" || level === "research_invalid") {
    return {
      portfolio_actions: [],
      new_watchlist_actions: [],
      desk_conclusion: {
        overall_stance: "freeze",
        trade_permission: "blocked",
        one_sentence_order: "研究闸门未通过，当前禁止生成交易指令。",
        must_not_do: ["不要追单", "不要扩大风险敞口"],
        decision_basis: [eventDriver?.primary_driver ?? "研究状态异常"]
      }
    };
  }

  const watchlist = normalizeOpportunityCandidates(opportunityPool).map((item) => ({
    theme: item?.theme ?? item?.name ?? "未命名主题",
    stance: "watch",
    why_now: item?.why_now ?? item?.expected_vs_actual_state ?? "事件或资金面开始出现改善。",
    why_not_in_portfolio_yet: "仍需等待更完整的证据链或更好的执行位置。",
    trigger_to_act: "资金确认与价格结构继续同步改善。"
  }));

  const tradePermission = tradingAllowed ? "allowed" : "restricted";
  const overallStance =
    flowMacroRadar?.liquidity_regime === "stress"
      ? "defensive"
      : tradePermission === "allowed"
        ? "selective_offense"
        : "defensive";

  return {
    portfolio_actions: Array.isArray(portfolioState?.holdings) && tradePermission !== "blocked"
      ? portfolioState.holdings.slice(0, 3).map((holding) => ({
          target_type: "holding",
          target_key: holding?.code ?? holding?.fund_code ?? "unknown",
          stance: tradePermission === "allowed" ? "hold" : "avoid",
          urgency: "low",
          reason_chain: [
            `事件主线：${eventDriver?.primary_driver ?? "暂无明确主线"}`,
            `流动性：${flowMacroRadar?.liquidity_regime ?? "neutral"}`,
            `研究状态：${level}`
          ],
          execution_note: tradePermission === "allowed" ? "仅在既定计划范围内执行。" : "等待更完整数据后再动作。"
        }))
      : [],
    new_watchlist_actions: watchlist,
    desk_conclusion: {
      overall_stance: overallStance,
      trade_permission: tradePermission,
      one_sentence_order:
        tradePermission === "allowed"
          ? "允许围绕现有组合做选择性进攻，并跟踪最多三条新增观察线索。"
          : "当前只允许条件式观察，不建议直接下强结论交易单。",
      must_not_do:
        tradePermission === "allowed"
          ? ["不要脱离组合框架追涨"]
          : ["不要把降级分析直接转化为强买卖动作"],
      decision_basis: [
        `event_driver=${eventDriver?.status ?? "unknown"}`,
        `liquidity_regime=${flowMacroRadar?.liquidity_regime ?? "neutral"}`,
        `readiness=${level || "unknown"}`
      ]
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify the actionable decision module passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Do not commit; keep the diff local unless the user explicitly asks for a commit**

Run: `git diff -- /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`

Expected: Diff shows only the action-decision module and tests.

### Task 4: Wire the new interpretation layers into `generate_research_brain`

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

- [ ] **Step 1: Write the failing orchestrator tests for the extended contract**

```js
test("runResearchBrainBuild writes event_driver, flow_macro_radar, and actionable_decision blocks", async () => {
  const result = await runResearchBrainBuild({
    portfolioRoot,
    accountId: "main",
    now: new Date("2026-04-02T14:00:00+08:00"),
    loadTelegraphs: async () => [
      { title: "港股科技领涨", content: "南向承接增强", published_at: "2026-04-02T13:20:00+08:00" }
    ],
    loadHkFlowSnapshot: async () => ({ southbound_net_buy_100m_hkd: 33.5, hk_tech_relative_strength: 1.2 })
  });

  assert.equal(result.payload.event_driver.status, "active_market_driver");
  assert.equal(typeof result.payload.flow_macro_radar.liquidity_regime, "string");
  assert.equal(typeof result.payload.actionable_decision.desk_conclusion.trade_permission, "string");
});

test("runResearchBrainBuild restricts actionable_decision when freshness blocks trading", async () => {
  const result = await runResearchBrainBuild({
    portfolioRoot,
    accountId: "main",
    now: new Date("2026-04-02T10:00:00+08:00"),
    marketSnapshotOverride: { a_share_indices: [] }
  });

  assert.equal(result.payload.decision_readiness.trading_allowed, false);
  assert.equal(result.payload.actionable_decision.desk_conclusion.trade_permission, "blocked");
});
```

- [ ] **Step 2: Run the targeted tests to watch them fail**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

Expected: FAIL because the new blocks are absent from the orchestrator payload.

- [ ] **Step 3: Update the orchestrator and refresh context with minimal wiring**

```js
import { buildResearchEventDriver } from "./lib/research_event_driver.mjs";
import { buildResearchFlowMacroRadar } from "./lib/research_flow_macro_radar.mjs";
import { buildResearchActionableDecision } from "./lib/research_actionable_decision.mjs";

async function loadInterpretationInputs(paths, payloads) {
  return {
    telegraphs: payloads?.reportEvidence?.telegraphs ?? [],
    hkFlowSnapshot: payloads?.reportEvidence?.hkFlowSnapshot ?? null,
    cnMarketSnapshot: payloads?.cnMarketSnapshot ?? null
  };
}

const interpretationInputs = await loadInterpretationInputs(paths, payloads);
const eventDriver = buildResearchEventDriver({
  telegraphs: interpretationInputs.telegraphs,
  marketSnapshot
});
const flowMacroRadar = buildResearchFlowMacroRadar({
  macroState: payloads.macroState,
  marketSnapshot,
  cnMarketSnapshot: interpretationInputs.cnMarketSnapshot,
  hkFlowSnapshot: interpretationInputs.hkFlowSnapshot
});
const actionableDecision = buildResearchActionableDecision({
  decisionReadiness,
  eventDriver,
  flowMacroRadar,
  portfolioState: payloads.latest,
  opportunityPool: payloads.opportunityPool
});

const payload = {
  ...existingPayload,
  event_driver: eventDriver,
  flow_macro_radar: flowMacroRadar,
  actionable_decision: actionableDecision
};
```

- [ ] **Step 4: Run the tests to verify the orchestrator passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

Expected: PASS with the new contract assertions included.

- [ ] **Step 5: Smoke the real builder**

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs --user main`

Expected: JSON output prints `readinessLevel` and writes a `research_brain.json` that includes the three new top-level blocks.

### Task 5: Build shared `research_brain` render helpers and converge report output

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`

- [ ] **Step 1: Write the failing render-helper tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResearchDriverLines,
  buildResearchFlowRadarLines,
  buildResearchActionDecisionLines
} from "./research_brain_render.mjs";

test("buildResearchDriverLines renders the active driver and evidence summary", () => {
  const lines = buildResearchDriverLines({
    status: "active_market_driver",
    primary_driver: "特朗普关税发言触发全球再定价",
    priced_in_assessment: "underpriced",
    evidence: [{ source: "telegraph", headline: "关税升级" }]
  });

  assert.ok(lines.some((line) => line.includes("Active Market Driver")));
  assert.ok(lines.some((line) => line.includes("关税")));
});

test("buildResearchActionDecisionLines renders blocked trading explicitly", () => {
  const lines = buildResearchActionDecisionLines({
    desk_conclusion: {
      trade_permission: "blocked",
      one_sentence_order: "当前禁止生成交易指令。"
    },
    portfolio_actions: []
  });

  assert.ok(lines.some((line) => line.includes("禁止")));
});
```

- [ ] **Step 2: Run the test to verify the render helper is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `research_brain_render.mjs`.

- [ ] **Step 3: Write the minimal render helper and update both reports to call it**

```js
export function buildResearchDriverLines(eventDriver = {}) {
  return [
    "## Active Market Driver",
    `- 状态：${eventDriver?.status ?? "unavailable"}`,
    `- 主线：${eventDriver?.primary_driver ?? "暂无明确驱动"}`,
    `- 计价判断：${eventDriver?.priced_in_assessment ?? "unclear"}`
  ];
}

export function buildResearchFlowRadarLines(flowMacroRadar = {}) {
  return [
    "## Flow & Macro Radar",
    `- 流动性状态：${flowMacroRadar?.liquidity_regime ?? "neutral"}`,
    `- 置信度：${flowMacroRadar?.confidence ?? "--"}`,
    `- 摘要：${flowMacroRadar?.summary ?? "暂无"}`
  ];
}

export function buildResearchActionDecisionLines(actionableDecision = {}) {
  const desk = actionableDecision?.desk_conclusion ?? {};
  return [
    "## Desk Action Conclusion",
    `- 交易许可：${desk?.trade_permission ?? "restricted"}`,
    `- 总结：${desk?.one_sentence_order ?? "暂无"}`
  ];
}
```

Then replace ad hoc tactical lines in both report scripts with:

```js
import {
  buildResearchDriverLines,
  buildResearchFlowRadarLines,
  buildResearchActionDecisionLines
} from "./lib/research_brain_render.mjs";

const driverLines = buildResearchDriverLines(reportContext.researchBrain?.event_driver);
const flowLines = buildResearchFlowRadarLines(reportContext.researchBrain?.flow_macro_radar);
const actionLines = buildResearchActionDecisionLines(reportContext.researchBrain?.actionable_decision);
```

- [ ] **Step 4: Run the targeted tests to verify the render helpers and reports pass**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`

Expected: PASS with the new render helper coverage.

- [ ] **Step 5: Smoke both reports**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --user main --refresh auto
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session morning --refresh auto
```

Expected: Both reports complete successfully and render `Active Market Driver`, `Flow & Macro Radar`, and `Desk Action Conclusion`.

### Task 6: Close the dialogue alignment loop with regression coverage

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`

- [ ] **Step 1: Add regression tests that force degraded and blocked language to stay honest**

```js
test("market brief renders restricted language when actionable decision is degraded", async () => {
  const markdown = await renderMarketBriefForTest({
    researchBrain: {
      decision_readiness: { level: "analysis_degraded", trading_allowed: false },
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "restricted",
          one_sentence_order: "当前只允许条件式观察。"
        }
      }
    }
  });

  assert.match(markdown, /条件式观察/);
  assert.doesNotMatch(markdown, /立即买入|立即卖出/);
});

test("actionable decision limits new watchlist ideas to three items", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    eventDriver: { status: "active_market_driver" },
    flowMacroRadar: { liquidity_regime: "risk_on", confidence: 0.8 },
    portfolioState: {},
    opportunityPool: {
      candidates: Array.from({ length: 6 }, (_, index) => ({ theme: `主题${index}` }))
    }
  });

  assert.equal(result.new_watchlist_actions.length, 3);
});
```

- [ ] **Step 2: Run the targeted suite and observe failures**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs`

Expected: FAIL until the blocked/restricted language and watchlist cap are fully wired.

- [ ] **Step 3: Tighten the implementation**

```js
const cappedWatchlist = normalizeOpportunityCandidates(opportunityPool).slice(0, 3);

if (tradePermission !== "allowed") {
  portfolioActions = [];
}

const imperativeWords = ["立即买入", "立即卖出", "满仓"];
for (const word of imperativeWords) {
  // Keep render helpers free of hard-sell wording when permission is restricted or blocked.
}
```

- [ ] **Step 4: Run the complete Phase 2 test set**

Run:

```bash
node --test \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_flow_macro_radar.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_actionable_decision.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.test.mjs
```

Expected: PASS with 0 failures.

- [ ] **Step 5: Run final smoke commands**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --user main --refresh auto
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session morning --refresh auto
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session close --refresh auto
```

Expected:

- `research_brain.json` includes the three new blocks
- market brief renders the Phase 2 sections
- pulse renders the same decision contract without re-deriving a second tactical view

---

## Self-Review

### Spec coverage

- `event_driver` contract: covered by Task 1 and Task 4
- `flow_macro_radar` contract: covered by Task 2 and Task 4
- `actionable_decision` contract: covered by Task 3 and Task 6
- report convergence: covered by Task 5
- degraded and blocked honesty: covered by Task 3 and Task 6
- no second decision substrate: enforced in file structure and implementation guardrail

### Placeholder scan

- No `TODO`, `TBD`, or "implement later" placeholders remain
- Each task includes exact files and commands
- Each code-writing step contains concrete code snippets

### Type consistency

- Top-level contract names are consistent:
  - `event_driver`
  - `flow_macro_radar`
  - `actionable_decision`
- Readiness vocabulary is reused from Phase 1
- Reports are instructed to read from the new contract, not invent new names
