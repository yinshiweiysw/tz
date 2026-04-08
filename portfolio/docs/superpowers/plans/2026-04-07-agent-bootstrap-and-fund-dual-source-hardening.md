# Agent Bootstrap And Fund Dual-Source Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-fix the remaining agent-entry contract gaps and add a stable dual-source observation chain for fund quotes so the system can keep working when Eastmoney index-fund estimates disappear.

**Architecture:** Keep `state/portfolio_state.json` as canonical accounting state, `data/dashboard_state.json` as the only product read model, and `data/agent_bootstrap_context.json` as the only agent entry model. On quote ingestion, split `confirmed_nav`, `intraday_estimate`, and `reference_change` into separate semantics; for index funds, prefer a validated secondary estimate source, and only fall back to `confirmed NAV + reference change` when no trustworthy live estimate exists.

**Tech Stack:** Node.js ESM scripts, existing portfolio JSON state chain, market-mcp fund provider, Node test runner, Playwright smoke verification.

---

## File Map

**Create**
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs`
- ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.mjs`
- ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.test.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/docs/fund-observation-semantics.md`

**Modify**
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md`
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs`
- ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.js`
- ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs`
- ` /Users/yinshiwei/codex/tz/portfolio/data/agent_bootstrap_context.json`
- ` /Users/yinshiwei/codex/tz/portfolio/data/dashboard_state.json`

**Generated During Verification**
- ` /Users/yinshiwei/codex/tz/portfolio/risk_dashboard.json`
- ` /Users/yinshiwei/codex/tz/portfolio/data/live_funds_snapshot.json`

---

### Task 1: Freeze The Agent Intent Registry Into A Single Source Of Truth

**Files:**
- Create: ` /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs`
- Test: ` /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md`
- Test: ` /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`

- [ ] **Step 1: Write the failing tests for route coverage and protocol alignment**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentIntentRegistry } from "./agent_intent_registry.mjs";

test("agent intent registry exposes every supported top-level user intent", () => {
  const registry = buildAgentIntentRegistry("/tmp/portfolio");
  assert.deepEqual(
    Object.keys(registry),
    [
      "分析当前行情",
      "今天该不该交易",
      "给我执行清单",
      "我刚买了/卖了/转换了",
      "看看我现在持仓",
      "打开基金面板",
      "基金面板为什么不对",
      "拉最新市场数据",
      "做回测",
      "收盘后生成日报"
    ]
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
```

Expected:
- missing module `agent_intent_registry.mjs`
- or bootstrap context still missing route entries

- [ ] **Step 3: Implement a shared registry module and consume it from bootstrap**

```js
export function buildAgentIntentRegistry(portfolioRoot) {
  const script = (name) => `${portfolioRoot}/scripts/${name}`;
  return {
    分析当前行情: { primaryScript: script("generate_dialogue_analysis_contract.mjs"), requiredReads: ["state-manifest.json", "data/agent_bootstrap_context.json", "state/portfolio_state.json"] },
    今天该不该交易: { primaryScript: script("generate_signals.py"), followupScript: script("generate_next_trade_plan.mjs"), requiredReads: ["state/portfolio_state.json", "signals/regime_router_signals.json"] },
    给我执行清单: { primaryScript: script("trade_generator.py"), requiredReads: ["state/portfolio_state.json", "config/asset_master.json", "data/trade_plan_v4.json"] },
    "我刚买了/卖了/转换了": { primaryScript: script("record_manual_fund_trades.mjs"), followupScript: script("ledger_sync.py"), requiredReads: ["ledger/execution_ledger.json", "state/portfolio_state.json"] },
    "看看我现在持仓": { primaryScript: script("generate_risk_dashboard.mjs"), requiredReads: ["state/portfolio_state.json", "risk_dashboard.json"] },
    "打开基金面板": { primaryScript: script("open_funds_live_dashboard.mjs"), requiredReads: ["data/dashboard_state.json", "state/portfolio_state.json"] },
    "基金面板为什么不对": { primaryScript: script("serve_funds_live_dashboard.mjs"), followupScript: script("build_dashboard_state.mjs"), requiredReads: ["data/dashboard_state.json", "state/portfolio_state.json", "config/asset_master.json"] },
    "拉最新市场数据": { primaryScript: script("core_data_ingestion.py"), followupScript: script("generate_macro_state.py"), requiredReads: ["state-manifest.json"] },
    做回测: { primaryScript: script("run_portfolio_backtest.py"), requiredReads: ["data/market_lake.db", "config/asset_master.json"] },
    "收盘后生成日报": { primaryScript: script("generate_market_pulse.mjs"), followupScripts: [script("generate_daily_brief.mjs"), script("generate_market_brief.mjs")], requiredReads: ["state/portfolio_state.json", "data/market_lake.db"] }
  };
}
```

- [ ] **Step 4: Update the human protocol doc to explicitly state that registry and generated bootstrap must match**

```md
新增硬规则：

8. `AI_AGENT_DISPATCH_PROTOCOL.md` 与 `agent_bootstrap_context.json.intentRouting` 必须一一对应，后者为机器入口，前者为人工解释层。
9. 新增意图只能在共享 registry 中增加，禁止文档和代码各自维护一份不同版本。
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
```

Expected:
- both tests pass

---

### Task 2: Add Contract Tests So New Threads Never Regress Back To “Scan The Repo” Mode

**Files:**
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.test.mjs`

- [ ] **Step 1: Write a failing test for bootstrap completeness**

```js
test("agent bootstrap context includes every documented route and canonical health summary", async () => {
  const result = await buildAgentBootstrapContext({ portfolioRoot: fixtureRoot, user: "main" });
  assert.equal(result.health.state, "ready");
  assert.ok(result.intentRouting["打开基金面板"]);
  assert.ok(result.intentRouting["做回测"]);
  assert.ok(result.intentRouting["收盘后生成日报"]);
});
```

- [ ] **Step 2: Run the focused bootstrap tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
```

Expected:
- failure before implementation if any route is still missing

- [ ] **Step 3: Add a startup smoke assertion to the dashboard open path**

```js
test("open funds dashboard startup succeeds through health check and not just html 200", async () => {
  const health = await fetchDashboardHealth(baseUrl, "main");
  assert.equal(health.ready, true);
  assert.equal(["ready", "degraded"].includes(health.health.state), true);
});
```

- [ ] **Step 4: Re-run tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.test.mjs
```

Expected:
- green

---

### Task 3: Split Fund Quote Semantics Into Confirmed, Intraday, And Reference

**Files:**
- Create: ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.mjs`
- Test: ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.test.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.js`
- Test: ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/docs/fund-observation-semantics.md`

- [ ] **Step 1: Write failing quote-shape tests**

```js
test("mergeFundQuote returns separated confirmed, intraday, and reference semantics", () => {
  const merged = mergeFundQuote("007339", primary, legacy, history, { profile: "index_fund" });
  assert.equal(typeof merged.confirmedNavDate, "string");
  assert.equal("intradayValuation" in merged, true);
  assert.equal(merged.referenceChangePercent, -0.8);
  assert.equal(["intraday_estimate", "reference_only"].includes(merged.observationKind), true);
});
```

- [ ] **Step 2: Run the provider tests to watch them fail**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.test.mjs
```

Expected:
- quote shape mismatch
- missing policy module

- [ ] **Step 3: Implement observation policy classification**

```js
export function classifyFundObservationPolicy({ category, market, fundTypeHint, estimateAvailable }) {
  if (estimateAvailable) return { observationKind: "intraday_estimate", allowIntradayPnl: true };
  if (category === "A股宽基" || category === "QDII指数" || fundTypeHint === "index") {
    return { observationKind: "reference_only", allowIntradayPnl: false, estimatePreferred: true };
  }
  return { observationKind: "confirmed_only", allowIntradayPnl: false };
}
```

- [ ] **Step 4: Refactor provider merge output**

```js
return {
  code,
  name,
  confirmedNavDate: netValueDate,
  confirmedNav: netValue,
  intradayValuation: resolvedIntradayValuation,
  intradayValuationTime: valuationTime,
  intradayChangePercent: resolvedIntradayChangePercent,
  referenceChangePercent: resolvedReferenceChangePercent,
  referenceSource: resolvedReferenceSource,
  observationKind
};
```

- [ ] **Step 5: Document the semantics**

```md
- `confirmedNav*`: only confirmed fund NAV semantics
- `intraday*`: only true estimate semantics
- `reference*`: index/ETF/close-reference semantics for observation fallback
- `reference*` must never be written into confirmed accounting
```

- [ ] **Step 6: Re-run provider tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.test.mjs
```

Expected:
- green

---

### Task 4: Add A True Secondary Observation Source With A Validation Gate

**Files:**
- Modify: ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.js`
- Modify: ` /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs`

- [ ] **Step 1: Write a failing test that primary-source-null still yields observation data from a second provider**

```js
test("getFundQuotes falls back to independent secondary observation source when eastmoney estimate is missing", async () => {
  const quote = await getFundQuotes(["001917"], fakeProviders);
  assert.equal(quote[0].intradayValuationSource, "secondary_provider");
  assert.equal(quote[0].intradayValuation, 3.5074);
});
```

- [ ] **Step 2: Run provider tests to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs
```

Expected:
- fallback source not implemented

- [ ] **Step 3: Implement the source validation gate**

```js
function acceptSecondaryObservation(candidate) {
  return Boolean(
    candidate &&
    Number.isFinite(Number(candidate.intradayValuation)) &&
    String(candidate.intradayValuationTime ?? "").trim()
  );
}
```

- [ ] **Step 4: Wire the fallback source without making it accounting-truth**

```js
const secondaryObservationQuotes = await Promise.all(
  codes.map((code) => fetchIndependentSecondaryObservation(code))
);

const resolvedObservation =
  acceptSecondaryObservation(primaryObservation) ? primaryObservation :
  acceptSecondaryObservation(secondaryObservation) ? secondaryObservation :
  null;
```

- [ ] **Step 5: Re-run tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs
```

Expected:
- fallback tests green

**Implementation note:** this task intentionally does not hardcode a vendor in the plan. First implement a provider slot and validation contract; during implementation, accept only a provider that proves stable on these sample funds: `001917`, `016482`, `021142`. If no independent provider passes, keep the slot disabled and return `null` instead of fabricating estimates.

---

### Task 5: For Index Funds, Prefer A Validated Estimate And Gracefully Downgrade To Reference Semantics

**Files:**
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`

- [ ] **Step 1: Write a failing dashboard test for 007339-like index funds**

```js
test("index funds without a validated estimate show reference change and latest confirmed nav instead of fake intraday valuation", async () => {
  const payload = await buildLivePayload(15000, "main");
  const row = payload.rows.find((item) => item.code === "007339");
  assert.equal(row.quoteMode, "close_reference");
  assert.equal(row.intradayEstimateSuppressed, true);
  assert.equal(row.valuationDisplayMode, "latest_confirmed_nav");
});
```

- [ ] **Step 2: Run the dashboard tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

Expected:
- current payload still renders stale NAV as `valuation`
- no explicit distinction yet between “validated estimate exists” and “reference fallback”

- [ ] **Step 3: Implement explicit display fields**

```js
row.displayValuation = row.quoteMode === "close_reference" ? row.confirmedNav : row.intradayValuation;
row.displayValuationLabel = row.quoteMode === "close_reference" ? "最近确认净值" : "盘中估值";
row.displayChangePct = row.quoteMode === "close_reference" ? row.referenceChangePercent : row.intradayChangePercent;
row.intradayEstimateSuppressed = row.quoteMode === "close_reference";
```

- [ ] **Step 4: Update card rendering copy**

```js
const valuationLabel = row.displayValuationLabel ?? "确认净值";
const changeLabel = row.quoteMode === "close_reference" ? "参考涨跌" : "今日涨跌幅";
```

- [ ] **Step 5: Re-run dashboard tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

Expected:
- green

---

### Task 6: Make The Product Read Model Carry Source Diagnostics So Agents And UI Can Explain Missing Estimates

**Files:**
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: ` /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs`

- [ ] **Step 1: Write a failing test for missing-estimate explainability**

```js
test("dashboard state exposes source diagnostics when observation data is unavailable", () => {
  const state = buildDashboardStateFromPayload(payload);
  const row = state.presentation.rows.find((item) => item.code === "007339");
  assert.equal(["intraday_estimate", "reference_only", "confirmed_only"].includes(row.observationAvailability), true);
  assert.equal(typeof row.sourceDiagnostics.reason, "string");
});
```

- [ ] **Step 2: Run the tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

Expected:
- diagnostics missing

- [ ] **Step 3: Extend dashboard state**

```js
presentationRow.sourceDiagnostics = {
  primary: row.primarySourceStatus ?? null,
  secondary: row.secondarySourceStatus ?? null,
  reason:
    row.observationKind === "reference_only"
      ? "index_estimate_unavailable_fallback_to_reference"
      : row.observationKind === "intraday_estimate"
        ? "validated_estimate_source_active"
        : null
};
```

- [ ] **Step 4: Re-run tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

Expected:
- green

---

### Task 7: Rebuild Generated State And Add End-To-End Acceptance Checks

**Files:**
- Modify generated outputs only after code is green

- [ ] **Step 1: Run the full regression set**

Run:

```bash
node --test \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/state_chain_consistency.test.mjs \
  /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund.test.mjs \
  /Users/yinshiwei/codex/tz/market-mcp/src/providers/fund_observation_policy.test.mjs
```

Expected:
- all green

- [ ] **Step 2: Rebuild canonical read models**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/materialize_portfolio_state.mjs --portfolioRoot /Users/yinshiwei/codex/tz/portfolio --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs --portfolioRoot /Users/yinshiwei/codex/tz/portfolio --user main --refreshMs 15000
node /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs --portfolioRoot /Users/yinshiwei/codex/tz/portfolio --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs --portfolioRoot /Users/yinshiwei/codex/tz/portfolio --user main
```

- [ ] **Step 3: Start the real dashboard and verify the three acceptance scenarios**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.mjs --portfolioRoot /Users/yinshiwei/codex/tz/portfolio --user main --open false --restart true --port 8766
```

Acceptance:
- `agent_bootstrap_context.json` contains all 10 documented intents
- `007339` uses a validated intraday estimate if one exists; otherwise it shows `最近确认净值` plus `参考涨跌`, never fake “今日估值”
- active funds with available independent estimate still show intraday estimate

---

## Phase Order

### P0: Contract Hardening
- Task 1
- Task 2

### P1: Quote Semantics And Source Chain
- Task 3
- Task 4
- Task 5

### P2: Product Read Model And Final Acceptance
- Task 6
- Task 7

---

## Decision Gates

1. **Agent gate**
   - Do not start quote-source work until `agent_bootstrap_context.json.intentRouting` fully matches the protocol table.

2. **Secondary-source gate**
   - Do not enable any independent second source in production until it passes structured validation on:
     - `001917`
     - `016482`
     - `021142`
   - If it fails any sample, keep the provider disabled and return `null`.

3. **Index-fund gate**
   - Index funds must never render stale NAV as `今日估值`.
   - Always try the validated secondary estimate path first.
   - Only when no trustworthy estimate exists may the UI downgrade to `最近确认净值 + 参考涨跌`.

---

## Expected Outcome

After this plan lands:
- New threads and new AI-agents can enter through one machine-readable bootstrap without repo scanning.
- Protocol doc and machine bootstrap no longer drift apart.
- Funds dashboard can tolerate Eastmoney estimate gaps without misleading the user.
- Index funds use a verified secondary estimate when available, and otherwise fall back to honest `confirmed NAV + reference change`; active funds can still use a verified secondary observation source.
- The system remains lean: one accounting truth, one product read model, one agent read model.
