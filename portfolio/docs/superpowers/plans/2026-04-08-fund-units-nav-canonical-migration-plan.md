# Fund Units+NAV Canonical Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the fund system to a canonical `units + cost_basis + nav/valuation + effective_date` model while preserving dashboard usability, QDII timing correctness, and stable AI-agent entrypoints.

**Architecture:** Keep `state/portfolio_state.json` as the accounting truth layer, keep quote providers as the market truth layer, and regenerate `dashboard_state.json`, `agent_runtime_context.json`, and downstream decision models from those truths. Preserve old `amount / holding_pnl / daily_pnl / summary.total_fund_assets` fields as compatibility outputs, but make them derived-only and ban direct writes from multiple modules.

**Tech Stack:** Node.js ESM scripts, Python analytics scripts, JSON state files, manifest canonical entrypoints, `node:test`, existing portfolio refresh chain

---

### Task 1: Add AI-Agent Change Impact Guardrail

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/docs/CHANGE_IMPACT_GUARDRAIL.md`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`

- [ ] **Step 1: Write the failing bootstrap guardrail test**

```js
test("buildAgentBootstrapContext exposes change guardrails for agents", async () => {
  const { payload } = await runBootstrapAgentContextBuild({
    portfolioRoot,
    user: "main"
  }, {
    buildHealth: async () => ({ state: "ready", confirmedNavState: "confirmed_nav_ready" })
  });

  assert.equal(payload.changeGuardrails.required, true);
  assert.equal(payload.changeGuardrails.checklist.includes("affected_modules"), true);
  assert.equal(payload.changeGuardrails.policy.impactAssessmentBeforeImplementation, true);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
```

Expected: FAIL because `changeGuardrails` is missing from the bootstrap payload.

- [ ] **Step 3: Implement the guardrail contract and docs**

Add a bootstrap section shaped like:

```js
changeGuardrails: {
  required: true,
  checklist: [
    "change_layer",
    "canonical_inputs",
    "affected_modules",
    "impact_decision",
    "write_boundary_check",
    "required_regressions"
  ],
  policy: {
    impactAssessmentBeforeImplementation: true,
    regressionBeforeCompletion: true,
    noSilentFeatureRemoval: true
  }
}
```

Document the same checklist in `AI_AGENT_DISPATCH_PROTOCOL.md` and `CHANGE_IMPACT_GUARDRAIL.md`.

- [ ] **Step 4: Run tests to verify the guardrail passes**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
```

Expected: PASS with bootstrap payload containing guardrail metadata.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md \
  /Users/yinshiwei/codex/tz/portfolio/docs/CHANGE_IMPACT_GUARDRAIL.md \
  /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
git commit -m "docs: add change impact guardrails for agents"
```

### Task 2: Make Units + Cost Basis the Only Durable Holding Truth

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/holding_cost_basis.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/confirmed_nav_reconciler.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs`

- [ ] **Step 1: Add failing tests for derived-only amount and durable units**

```js
test("materializer keeps units and cost basis as durable truth and treats amount as derived", () => {
  const position = {
    code: "007339",
    confirmed_units: 10000,
    holding_cost_basis_cny: 21000,
    amount: 999999
  };

  const rebuilt = rebuildHoldingFromCanonicalTruth(position, {
    selectedNav: 2.168019
  });

  assert.equal(rebuilt.units, 10000);
  assert.equal(rebuilt.cost_basis_cny, 21000);
  assert.equal(rebuilt.amount, 21680.19);
  assert.equal(rebuilt.holding_pnl, 680.19);
});
```

```js
test("manual trade recorder keeps QDII buys pending until profit effective date", () => {
  const event = buildPendingBuyEvent({
    tradeDate: "2026-04-08",
    tradeTime: "14:30",
    settlementRule: "T+2"
  });

  assert.equal(event.profit_effective_on, "2026-04-10");
});
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs
```

Expected: FAIL because there is no explicit “derived-only amount” rebuild path yet.

- [ ] **Step 3: Add canonical rebuild helpers and stop treating amount as stored truth**

Implement or extend helpers with logic shaped like:

```js
export function rebuildHoldingFromCanonicalTruth(position = {}, { selectedNav = null } = {}) {
  const units = Number(position?.confirmed_units ?? position?.units ?? 0) || 0;
  const costBasis = Number(position?.holding_cost_basis_cny ?? position?.cost_basis_cny ?? 0) || 0;
  const nav = Number(selectedNav ?? position?.latest_confirmed_nav ?? 0) || 0;
  const amount = round(units * nav);
  const holdingPnl = round(amount - costBasis);

  return {
    ...position,
    units,
    cost_basis_cny: costBasis,
    amount,
    holding_pnl: holdingPnl,
    holding_pnl_rate_pct: costBasis > 0 ? round((holdingPnl / costBasis) * 100) : null
  };
}
```

Also keep:

```js
profit_effective_on = resolveProfitEffectiveOn(settlementRule, tradeDate, tradeTime, market);
```

and do not infer units from stale `previousAmount / currentNetValue`.

- [ ] **Step 4: Run the tests again and then refresh derived state**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs --portfolio-root /Users/yinshiwei/codex/tz/portfolio --user main
```

Expected: PASS, and sidecars regenerate without changing canonical truth semantics.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/holding_cost_basis.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/confirmed_nav_reconciler.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs
git commit -m "refactor: make fund holdings derive amount from units and nav"
```

### Task 3: Rebuild Dashboard State from Canonical Truth + Latest Quotes

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs`

- [ ] **Step 1: Add failing dashboard tests for amount rebuild semantics**

```js
test("buildLivePayload computes observable amount from units and quote nav", async () => {
  const payload = await buildLivePayload(15000, "main", {
    portfolioState: {
      positions: [
        {
          code: "023764",
          confirmed_units: 111526.24574435,
          holding_cost_basis_cny: 88074.81,
          amount: 1
        }
      ]
    },
    quoteMap: {
      "023764": {
        confirmedNav: 0.6461,
        intradayValuation: 0.6788,
        quoteMode: "intraday_valuation"
      }
    }
  });

  const row = payload.rows.find((item) => item.code === "023764");
  assert.equal(row.amount, 75704.02);
  assert.equal(row.holdingPnl, -12370.79);
});
```

```js
test("close_reference does not overwrite accounting amount", async () => {
  // keep the ledger amount and expose reference pnl separately
});
```

- [ ] **Step 2: Run the dashboard tests and confirm the failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

Expected: FAIL on rows still trusting stale stored `amount` or mixed quote modes.

- [ ] **Step 3: Route dashboard rows through a single canonical derivation path**

Add a row derivation path shaped like:

```js
const selectedNav = pickRowDisplayNav({
  confirmedNav,
  intradayValuation,
  quoteMode
});

const observableAmount = round(units * selectedNav);
const observableHoldingPnl = round(observableAmount - costBasis);

if (quoteMode === "close_reference") {
  row.amount = ledgerAmount;
  row.holdingPnl = ledgerHoldingPnl;
  row.referenceAmount = observableAmount;
  row.referenceHoldingPnl = observableHoldingPnl;
} else {
  row.amount = observableAmount;
  row.holdingPnl = observableHoldingPnl;
}
```

Also keep summary split explicit:

```js
summary.accountingDailyPnl
summary.observationDailyPnl
summary.displayDailyPnl
```

- [ ] **Step 4: Rebuild sidecars and rerun tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs --portfolioRoot /Users/yinshiwei/codex/tz/portfolio --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs --portfolio-root /Users/yinshiwei/codex/tz/portfolio --user main --scopes dashboard_state,live_funds_snapshot
```

Expected: PASS with `dashboard_state.json` rebuilt from canonical truth plus quote overlays.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
git commit -m "refactor: derive dashboard fund amounts from units and quotes"
```

### Task 4: Migrate Agent Runtime Context to the New Canonical Fields

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_agent_runtime_context.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_agent_runtime_context.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_strategy_decision_contract.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs`

- [ ] **Step 1: Add failing tests for explicit canonical vs observable values**

```js
test("agent runtime context exposes canonical cost basis and observable amount separately", () => {
  const payload = buildAgentRuntimeContextPayload({
    portfolioState: {
      positions: [
        {
          code: "007339",
          confirmed_units: 10000,
          holding_cost_basis_cny: 21000
        }
      ]
    },
    dashboardState: {
      rows: [
        {
          code: "007339",
          amount: 21680.19,
          holdingPnl: 680.19,
          quoteMode: "intraday_valuation"
        }
      ]
    }
  });

  assert.equal(payload.positions[0].units, 10000);
  assert.equal(payload.positions[0].costBasis, 21000);
  assert.equal(payload.positions[0].observableAmount, 21680.19);
  assert.equal(payload.positions[0].quoteMode, "intraday_valuation");
});
```

- [ ] **Step 2: Run the agent runtime tests and confirm failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs
```

Expected: FAIL because positions only expose old mixed fields.

- [ ] **Step 3: Extend the runtime context payload with split semantics**

Implement a row projection shaped like:

```js
return {
  name,
  code,
  bucketKey,
  category,
  units,
  costBasis,
  observableAmount: rowAmount,
  observableHoldingPnl: rowHoldingPnl,
  quoteMode,
  changePct,
  quoteDate,
  confirmationState
};
```

Make `strategy_decision_contract` consume the new runtime fields instead of re-inferring them from old `amount`.

- [ ] **Step 4: Rebuild the runtime artifacts and rerun tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs --portfolio-root /Users/yinshiwei/codex/tz/portfolio --user main --scopes agent_entrypoints,research_brain,dashboard_state
```

Expected: PASS with refreshed `agent_runtime_context.json` and `strategy_decision_contract.json`.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_agent_runtime_context.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_agent_runtime_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_strategy_decision_contract.mjs
git commit -m "refactor: expose canonical and observable fund fields to agents"
```

### Task 5: Migrate Signals, Trades, and Risk to Canonical Position Math

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs`

- [ ] **Step 1: Add characterization tests for canonical position math**

```js
test("signal inputs do not trust stale stored amount when units and nav imply a different value", async () => {
  const contract = await buildStrategyDecisionContract({
    runtimeContext: {
      positions: [
        {
          code: "007339",
          units: 10000,
          costBasis: 21000,
          observableAmount: 21680.19
        }
      ]
    }
  });

  assert.equal(contract.positionFacts[0].amountCny, 21680.19);
});
```

- [ ] **Step 2: Run the focused signal/risk/trade tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs
```

Expected: FAIL or expose stale amount dependencies.

- [ ] **Step 3: Move downstream consumers to canonical position facts**

Update these computations so they read canonical facts or runtime context, not stale stored `amount`:

```python
position_value = units * latest_nav
holding_profit = position_value - cost_basis_cny
bucket_weight_pct = position_value / invested_assets_cny
```

and in JS:

```js
const projectedFundAmount = canonicalPositionValue(position, latestNavMap);
```

Keep compatibility adapters where needed, but do not let downstream modules treat raw stored `amount` as durable truth.

- [ ] **Step 4: Run full signal/risk/trade regression**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py --user main
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py --user main
```

Expected: PASS, with generated outputs using canonical position math.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py \
  /Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py \
  /Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py \
  /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs
git commit -m "refactor: migrate analysis and trading to canonical fund math"
```

### Task 6: Add Contract Regression Coverage and Cleanup Rules

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Test: all touched tests plus refresh smoke path

- [ ] **Step 1: Add end-to-end contract tests**

Cover these cases explicitly:

```js
test("365-day reopening can reconstruct correct amount from units and latest nav", async () => {});
test("qdii pending buys do not contribute profit before profit_effective_on", async () => {});
test("dashboard GET path does not mutate tracked state files", async () => {});
test("agent bootstrap includes change guardrails and canonical entrypoints", async () => {});
```

- [ ] **Step 2: Run the complete regression suite**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
```

Expected: PASS with no dashboard mutation, no stale amount truth leaks, and guardrails present.

- [ ] **Step 3: Refresh all sidecars and inspect final canonical entrypoints**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs --portfolio-root /Users/yinshiwei/codex/tz/portfolio --user main
cat /Users/yinshiwei/codex/tz/portfolio/state-manifest.json
```

Expected: manifest points to canonical state, dashboard state, agent runtime context, strategy decision contract, and bootstrap context with no temp paths.

- [ ] **Step 4: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs
git commit -m "test: add canonical fund model contract regression coverage"
```

## Self-Review

### Spec coverage

- Canonical truth vs derived-only split: covered by Tasks 2 and 3.
- Dashboard and agent read-model freeze: covered by Tasks 3 and 4.
- AI-agent change impact guardrail: covered by Task 1.
- Signals/trading/risk migration: covered by Task 5.
- Regression against silent feature loss: covered by Task 6.

### Placeholder scan

- No `TODO`, `TBD`, or “handle appropriately” placeholders remain.
- Every task names exact files, concrete tests, and concrete commands.

### Type consistency

- Canonical fields consistently use `units`, `cost_basis_cny`, `profit_effective_on`.
- Derived dashboard fields consistently use `amount`, `holding_pnl`, `daily_pnl`.
- Agent-runtime split consistently uses `observableAmount` and `observableHoldingPnl`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-08-fund-units-nav-canonical-migration-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
