# Funds State And Signal Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the portfolio system to a coherent state where market data, signal generation, trade planning, ledger snapshots, confirmed NAV state, and the funds dashboard all agree on one trusted timeline.

**Architecture:** Fix the system in dependency order. First recover the shared `market_lake.db` and make signal/trade generation fail closed when market data is unavailable. Then harden the state chain so `latest_raw.json`, `execution_ledger.json`, `portfolio_state.json`, `latest.json`, and `nightly_confirmed_nav_status.json` stay date-consistent and auditable. Finally clean up account/bootstrap and compatibility edges so the dashboard can degrade honestly without hiding missing state.

**Tech Stack:** Python, Node.js ESM, SQLite, node:test, existing portfolio state scripts and dashboard service

---

## File Map

- Modify: `portfolio/scripts/core_data_ingestion.py`
- Modify: `portfolio/scripts/generate_signals.py`
- Modify: `portfolio/scripts/generate_next_trade_plan.mjs`
- Modify: `portfolio/scripts/reconcile_confirmed_nav.mjs`
- Modify: `portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `portfolio/scripts/merge_confirmed_trades_into_latest.mjs`
- Modify: `portfolio/scripts/refresh_account_sidecars.mjs`
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `portfolio/scripts/lib/nightly_confirmed_nav_status.mjs`
- Modify: `portfolio/scripts/lib/fund_confirmation_policy.mjs`
- Create: `portfolio/scripts/generate_signals.guardrails.test.mjs`
- Create: `portfolio/scripts/generate_next_trade_plan.guardrails.test.mjs`
- Create: `portfolio/scripts/core_data_ingestion.smoke.test.mjs`
- Create: `portfolio/scripts/state_chain_consistency.test.mjs`
- Test: `portfolio/scripts/reconcile_confirmed_nav.test.mjs`
- Test: `portfolio/scripts/merge_confirmed_trades_into_latest.test.mjs`
- Test: `portfolio/scripts/serve_funds_live_dashboard.test.mjs`
- Test: `portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Test: `portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs`
- Test: `portfolio/scripts/lib/fund_confirmation_policy.test.mjs`

## Task 1: P0 Restore `market_lake.db` And Prove The Shared Schema Exists

**Files:**
- Modify: `portfolio/scripts/core_data_ingestion.py`
- Create: `portfolio/scripts/core_data_ingestion.smoke.test.mjs`

- [ ] **Step 1: Write the failing smoke test for the shared market lake**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("core_data_ingestion creates daily_prices in market_lake.db", async () => {
  const { stdout } = await execFileAsync("python3", [
    "/Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.py",
    "--bootstrap-schema-only",
    "--db",
    "/tmp/market_lake.plan-test.db"
  ]);

  assert.match(stdout, /daily_prices/i);
});
```

- [ ] **Step 2: Run the smoke test to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.smoke.test.mjs
```

Expected: FAIL because the script does not yet expose a deterministic schema bootstrap mode and the current shared database is empty.

- [ ] **Step 3: Implement deterministic schema bootstrap and explicit post-run verification**

```python
def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS daily_prices (
            symbol TEXT NOT NULL,
            date TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            adj_close REAL,
            volume REAL,
            PRIMARY KEY (symbol, date)
        );

        CREATE TABLE IF NOT EXISTS macro_indicators (
            date TEXT PRIMARY KEY,
            pe_ttm REAL,
            cn_10y_rate REAL,
            erp_pct REAL
        );
        """
    )
```

Add a CLI flag that only bootstraps schema, and after normal ingestion print row counts for `daily_prices` and `macro_indicators`.

- [ ] **Step 4: Rebuild the shared database and verify the tables exist**

Run:

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.py --db /Users/yinshiwei/codex/tz/portfolio/data/market_lake.db
sqlite3 /Users/yinshiwei/codex/tz/portfolio/data/market_lake.db ".tables"
sqlite3 /Users/yinshiwei/codex/tz/portfolio/data/market_lake.db "SELECT COUNT(*) FROM daily_prices;"
```

Expected: `daily_prices` is present and row count is greater than zero.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.py /Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.smoke.test.mjs
git commit -m "fix: restore shared market lake schema"
```

## Task 2: P0 Make Signals And Trade Planning Fail Closed On Missing Market Data

**Files:**
- Modify: `portfolio/scripts/generate_signals.py`
- Modify: `portfolio/scripts/generate_next_trade_plan.mjs`
- Create: `portfolio/scripts/generate_signals.guardrails.test.mjs`
- Create: `portfolio/scripts/generate_next_trade_plan.guardrails.test.mjs`

- [ ] **Step 1: Write the failing tests for data-lake hard failure**

```js
test("generate_signals exits non-zero when daily_prices is missing", async () => {
  const { stderr, code } = await runPythonProcess([
    "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py",
    "--db",
    "/tmp/empty-market-lake.db"
  ]);

  assert.notEqual(code, 0);
  assert.match(stderr, /daily_prices/i);
});

test("generate_next_trade_plan refuses to emit actionable output when signals contain hard errors", async () => {
  const result = await buildNextTradePlan({
    signals: {
      generated_at: "2026-04-07T11:39:46+08:00",
      errors: [{ symbol: "007339", message: "no such table: daily_prices" }],
      signals: []
    }
  });

  assert.equal(result.summary.actionable_trade_count, 0);
  assert.equal(result.summary.plan_state, "blocked_market_data");
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.guardrails.test.mjs
```

Expected: FAIL because signal generation currently tolerates SQL failures and trade planning silently emits an empty plan.

- [ ] **Step 3: Implement hard guard rails**

```python
def validate_required_tables(connection: sqlite3.Connection) -> None:
    required = {"daily_prices"}
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    existing = {row[0] for row in rows}
    missing = required - existing
    if missing:
        raise RuntimeError(f"market_lake schema incomplete: missing {sorted(missing)}")
```

```js
function assertSignalsUsable(signalsPayload) {
  if (Array.isArray(signalsPayload?.errors) && signalsPayload.errors.length > 0) {
    throw new Error("signals_blocked_by_market_data");
  }
}
```

In `generate_next_trade_plan.mjs`, emit `summary.plan_state = "blocked_market_data"` and a top-level `blocking_reasons` array instead of pretending an empty plan is valid.

- [ ] **Step 4: Re-run signal generation and plan generation against the repaired DB**

Run:

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs
```

Expected: `regime_router_signals.json` has no `daily_prices` errors, or the process exits hard with a clear message. `trade_plan_v4.json` either contains real decisions or a blocking reason, never a silent empty success.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.guardrails.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.guardrails.test.mjs
git commit -m "fix: fail closed when market lake is unavailable"
```

## Task 3: P1 Reconcile The State Chain Into One Auditable Timeline

**Files:**
- Modify: `portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `portfolio/scripts/merge_confirmed_trades_into_latest.mjs`
- Create: `portfolio/scripts/state_chain_consistency.test.mjs`
- Test: `portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
- Test: `portfolio/scripts/merge_confirmed_trades_into_latest.test.mjs`

- [ ] **Step 1: Write the failing consistency test for date alignment**

```js
test("materialized state keeps snapshot_date and execution_ledger as_of_snapshot_date aligned", async () => {
  const state = await loadJson("/tmp/portfolio_state.json");
  const ledger = await loadJson("/tmp/execution_ledger.json");

  assert.equal(state.snapshot_date, ledger.as_of_snapshot_date);
});
```

- [ ] **Step 2: Run the consistency tests to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/state_chain_consistency.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/merge_confirmed_trades_into_latest.test.mjs
```

Expected: FAIL because the current ledger metadata still says `2026-03-30` while `portfolio_state.json` is `2026-04-03`.

- [ ] **Step 3: Update the materializer to stamp ledger metadata during every successful materialization**

```js
ledger.as_of_snapshot_date = materializedSnapshot.snapshot_date;
ledger.updated_at = nowIso();
await writeJson(paths.executionLedgerPath, ledger);
```

Also add an explicit note when `latest_raw.json` and `portfolio_state.json` intentionally differ because execution ledger overlays have been applied.

- [ ] **Step 4: Generate a stable external compatibility view**

Create or update a compatibility writer so that external OTC consumers read a filtered view:

```js
const otcActivePositions = state.positions.filter(
  (row) => row.execution_type !== "EXCHANGE" && row.status === "active"
);
```

Write that view to `latest.json` or a dedicated compatibility file, and document it in `state-manifest.json`.

- [ ] **Step 5: Re-materialize the real state and verify coherence**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/materialize_portfolio_state.mjs --portfolio-root /Users/yinshiwei/codex/tz/portfolio --date 2026-04-03
node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync("/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json","utf8"));const l=JSON.parse(fs.readFileSync("/Users/yinshiwei/codex/tz/portfolio/ledger/execution_ledger.json","utf8"));console.log({snapshot:s.snapshot_date,ledger:l.as_of_snapshot_date});'
```

Expected: snapshot dates match; compatibility output contains only the contract external consumers are supposed to see.

- [ ] **Step 6: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/merge_confirmed_trades_into_latest.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/state_chain_consistency.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/merge_confirmed_trades_into_latest.test.mjs
git commit -m "fix: align ledger metadata with materialized state"
```

## Task 4: P1 Harden Confirmed NAV And Dashboard Readiness Semantics

**Files:**
- Modify: `portfolio/scripts/reconcile_confirmed_nav.mjs`
- Modify: `portfolio/scripts/refresh_account_sidecars.mjs`
- Modify: `portfolio/scripts/lib/nightly_confirmed_nav_status.mjs`
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `portfolio/scripts/lib/fund_confirmation_policy.mjs`
- Test: `portfolio/scripts/reconcile_confirmed_nav.test.mjs`
- Test: `portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs`
- Test: `portfolio/scripts/lib/fund_confirmation_policy.test.mjs`
- Test: `portfolio/scripts/serve_funds_live_dashboard.test.mjs`

- [ ] **Step 1: Write the failing test for “ready UI, stale accounting” semantics**

```js
test("health stays ready when confirmed nav is partially normal lag and no hard failures exist", async () => {
  const payload = await buildFundsDashboardHealth("main");
  assert.equal(payload.state, "ready");
  assert.equal(payload.confirmedNavState, "partially_confirmed_normal_lag");
  assert.equal(payload.accountingState, "observation_only_stale_snapshot");
});
```

- [ ] **Step 2: Run the dashboard and confirmation tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_confirmation_policy.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: FAIL on any remaining path that still conflates “ready to display” with “fresh for accounting”.

- [ ] **Step 3: Keep `reconcile_confirmed_nav` authoritative for nightly status**

```js
await writeNightlyConfirmedNavStatus({
  generatedAt: new Date().toISOString(),
  runType: "reconcile_confirmed_nav",
  targetDate: result.rawSnapshot.snapshot_date,
  accounts: [accountRun],
  successCount,
  failureCount
}, { portfolioRoot });
```

Do not let `refresh_account_sidecars.mjs` overwrite that status with a weaker inference model.

- [ ] **Step 4: Separate dashboard readiness from accounting freshness**

Keep:

```js
state: "ready"
```

for readable accounts with valid state, but expose:

```js
accountingState: "observation_only_stale_snapshot"
confirmedNavState: "partially_confirmed_normal_lag"
```

so consumers can distinguish UI readiness from formal ledger freshness.

- [ ] **Step 5: Verify with the live API**

Run:

```bash
node - <<'NODE'
(async () => {
  const res = await fetch("http://127.0.0.1:8766/api/live-funds/health?account=main");
  console.log(await res.text());
})();
NODE
```

Expected: `state = ready`, `confirmedNavState = partially_confirmed_normal_lag`, `snapshotDate = 2026-04-03`.

- [ ] **Step 6: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_confirmation_policy.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_confirmation_policy.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs
git commit -m "fix: separate dashboard readiness from accounting freshness"
```

## Task 5: P2 Clean Up Account Bootstrap And External Consumer Edges

**Files:**
- Modify: `portfolio/scripts/bootstrap_portfolio_user.mjs`
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `portfolio/state-manifest.json` generation paths if needed
- Test: existing bootstrap and dashboard tests

- [ ] **Step 1: Add a failing test for discoverable-but-uninitialized subaccounts**

```js
test("bootstrap_portfolio_user creates minimal readable dashboard state", async () => {
  const result = await bootstrapPortfolioUser({ user: "wenge" });
  assert.equal(result.createdFiles.includes("state/portfolio_state.json"), true);
  assert.equal(result.createdFiles.includes("config/asset_master.json"), true);
});
```

- [ ] **Step 2: Run bootstrap-focused tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: FAIL or missing coverage for minimal dashboard-readability guarantees.

- [ ] **Step 3: Ensure new subaccounts get minimal readable scaffolding**

```js
await writeJson(buildPortfolioPath(userRoot, "state", "portfolio_state.json"), {
  account_id: user,
  snapshot_date: null,
  positions: [],
  pending_profit_effective_positions: [],
  summary: {}
});
```

Do the same for `config/asset_master.json` by symlink or copied reference if the account is intended to share the main asset universe.

- [ ] **Step 4: Document the compatibility contract**

In manifest notes or repo docs, state explicitly:

```text
latest_raw.json = platform/raw snapshot
execution_ledger.json = write-side overlay log
portfolio_state.json = business truth
latest.json = external OTC compatibility view
```

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs
git commit -m "fix: bootstrap readable subaccount dashboard state"
```

## Execution Order

- [ ] **P0 first:** Task 1 and Task 2
- [ ] **P1 second:** Task 3 and Task 4
- [ ] **P2 last:** Task 5

## Exit Criteria

- [ ] `sqlite3 /Users/yinshiwei/codex/tz/portfolio/data/market_lake.db ".tables"` returns `daily_prices` and `macro_indicators`
- [ ] `python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py` completes without `daily_prices` SQL errors
- [ ] `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs` never emits a silent empty plan when signal errors exist
- [ ] `portfolio/state/portfolio_state.json`, `portfolio/latest.json`, and `portfolio/ledger/execution_ledger.json` share one coherent snapshot boundary
- [ ] `http://127.0.0.1:8766/api/live-funds/health?account=main` returns `state = ready`
- [ ] `http://127.0.0.1:8766/api/live-funds?account=main` shows `estimatedDailyPnlMode = observation` only when snapshot is stale, never as a fake confirmed PnL
- [ ] `http://127.0.0.1:8766/api/live-funds?account=wenge` returns `200` with explicit blocked state, not `503`
- [ ] External OTC consumers can read the compatibility file without accidentally ingesting sold rows or exchange placeholder rows
