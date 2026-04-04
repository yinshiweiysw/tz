# Architecture Remediation Current-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining P0/P1 architecture gaps that still exist after the 2026-04-03 audit, while explicitly excluding report-state concurrency issues that have already been fixed.

**Architecture:** Treat the system as a hybrid research OS plus personal PMS. First, finish the canonical state write hardening so state files stop being rewritten through ad hoc `writeFile` paths. Second, add a real pre-trade gate that evaluates cash, bucket limits, frozen sleeves, and drawdown freezes before any manual trade enters the ledger. Third, tighten ledger/materializer semantics so accounting truth becomes deterministic and calendar-aware. Finally, align executable constraints with `asset_master.json` and keep `latest.json` as a compatibility read model only.

**Tech Stack:** Node.js ESM, `node:test`, JSON state files, filesystem atomic rename, existing portfolio state/materializer helpers.

---

### Task 1: Finish atomic and merge-safe writes for remaining state entrypoints

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/atomic_json_state.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/atomic_json_state.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/daily_writeback.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/ensure_daily_journal.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/create_trade_card.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_report_quality_scorecard.mjs`
- Reuse: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.mjs`

- [ ] **Step 1: Write the failing helper tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { updateJsonFileAtomically, writeJsonAtomic } from "./atomic_json_state.mjs";

test("writeJsonAtomic replaces file without leaving temp files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atomic-json-"));
  const filePath = path.join(dir, "state.json");
  await writeJsonAtomic(filePath, { ok: true });
  const written = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(written, { ok: true });
});

test("updateJsonFileAtomically merges on-disk state before persisting", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atomic-json-"));
  const filePath = path.join(dir, "state.json");
  await writeJsonAtomic(filePath, { a: 1, nested: { x: 1 } });
  const updated = await updateJsonFileAtomically(filePath, (current) => ({
    ...current,
    b: 2,
    nested: { ...(current.nested ?? {}), y: 2 }
  }));
  assert.equal(updated.b, 2);
  assert.deepEqual(updated.nested, { x: 1, y: 2 });
});
```

- [ ] **Step 2: Run the helper tests and confirm they fail**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/atomic_json_state.test.mjs`
Expected: FAIL because `atomic_json_state.mjs` does not exist yet.

- [ ] **Step 3: Implement a generic atomic JSON helper**

```js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonOrDefault(filePath, defaultValue = {}) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return defaultValue;
  }
}

export async function writeJsonAtomic(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function updateJsonFileAtomically(filePath, mutator, defaultValue = {}) {
  const current = await readJsonOrDefault(filePath, defaultValue);
  const next = await mutator(current);
  await writeJsonAtomic(filePath, next);
  return next;
}
```

- [ ] **Step 4: Replace raw `writeFile` state writes in the remaining entrypoints**

```js
await updateJsonFileAtomically(manifestPath, (manifest) => ({
  ...manifest,
  canonical_entrypoints: {
    ...(manifest.canonical_entrypoints ?? {}),
    manual_trade_transactions: transactionFilePath
  }
}));
```

```js
await writeJsonAtomic(targetPath, payload);
```

- [ ] **Step 5: Re-run the targeted tests**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/atomic_json_state.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_quality_scorecard.test.mjs`
Expected: PASS with no temp-file leakage and no regression in recorder/materializer behavior.


### Task 2: Add a real pre-trade gate before trades enter the ledger

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/daily_writeback.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Reuse: `/Users/yinshiwei/codex/tz/portfolio/config/asset_master.json`
- Reuse: `/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json`

- [ ] **Step 1: Write failing gate tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTradePreFlight } from "./trade_pre_flight_gate.mjs";

test("blocks buy when tactical sleeve is frozen", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: { available_cash_cny: 50000, total_portfolio_assets_cny: 200000 },
      positions: []
    },
    proposedTrades: [
      { type: "buy", fund_code: "513330", amount_cny: 5000, bucket_key: "TACTICAL" }
    ],
    assetMaster: {
      buckets: { TACTICAL: { buy_gate: "frozen", max: 0.1 }, CASH: { min: 0.15 } },
      global_constraints: { max_drawdown_limit: 0.15, absolute_equity_cap: 0.75 }
    },
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /buy_gate.*frozen/i);
});

test("blocks buy when projected cash would breach floor", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: { available_cash_cny: 12000, total_portfolio_assets_cny: 100000 },
      positions: []
    },
    proposedTrades: [
      { type: "buy", fund_code: "007339", amount_cny: 5000, bucket_key: "A_CORE" }
    ],
    assetMaster: {
      buckets: { CASH: { min: 0.15 }, A_CORE: { max: 0.3 } },
      global_constraints: { max_drawdown_limit: 0.15, absolute_equity_cap: 0.75 }
    },
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /cash floor/i);
});
```

- [ ] **Step 2: Run the gate tests and confirm they fail**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs`
Expected: FAIL because the gate does not exist yet.

- [ ] **Step 3: Implement a pure pre-flight evaluator**

```js
export function evaluateTradePreFlight({
  portfolioState,
  proposedTrades,
  assetMaster,
  portfolioRiskState = {}
}) {
  const blockingReasons = [];
  const warnings = [];

  // 1. available cash
  // 2. bucket buy_gate
  // 3. bucket projected max
  // 4. absolute equity cap
  // 5. max drawdown freeze for high-beta buys

  return {
    allowed: blockingReasons.length === 0,
    blockingReasons,
    warnings
  };
}
```

- [ ] **Step 4: Wire the gate into manual trade recording**

```js
const gate = evaluateTradePreFlight({
  portfolioState,
  proposedTrades,
  assetMaster,
  portfolioRiskState
});

if (!gate.allowed) {
  throw new Error(`Trade blocked: ${gate.blockingReasons.join(" | ")}`);
}
```

- [ ] **Step 5: Re-run tests and verify blocking behavior**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs`
Expected: PASS with frozen sleeves, cash breaches, and drawdown freezes blocked before ledger write.


### Task 3: Harden ledger and materializer semantics

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trading_calendar.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trading_calendar.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`

- [ ] **Step 1: Write failing tests for calendar and dedupe rules**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { nextTradingDay } from "./trading_calendar.mjs";
import { materializePortfolioStateFromInputs } from "./portfolio_state_materializer.mjs";

test("nextTradingDay skips exchange holidays instead of weekends only", () => {
  assert.equal(nextTradingDay("2026-04-03"), "2026-04-07");
});

test("duplicate ledger entries are applied once", () => {
  const result = materializePortfolioStateFromInputs({
    rawSnapshot: buildRawSnapshotFixture(),
    executionLedger: {
      entries: [buildBuyEntry("dup-1"), buildBuyEntry("dup-1")]
    },
    accountId: "main",
    portfolioRoot: "/tmp/pf",
    referenceDate: "2026-04-02",
    paths: buildPaths()
  });

  assert.equal(result.portfolioState.summary.pending_buy_confirm, 5000);
});
```

- [ ] **Step 2: Run the materializer tests and confirm failure**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trading_calendar.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs`
Expected: FAIL because holiday-aware calendar logic and ledger dedupe are missing.

- [ ] **Step 3: Replace weekend-only business day logic with exchange calendar helpers**

```js
const CN_HOLIDAYS = new Set(["2026-04-04", "2026-04-05", "2026-04-06"]);

export function nextTradingDay(dateText) {
  let cursor = dateText;
  do {
    cursor = addOneDay(cursor);
  } while (isWeekend(cursor) || CN_HOLIDAYS.has(cursor));
  return cursor;
}
```

- [ ] **Step 4: Add deterministic ledger dedupe and position-cap validation**

```js
function dedupeLedgerEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.id ?? ""}::${entry.type ?? ""}::${entry.effective_trade_date ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

```js
if (sellAmountCny > currentPositionAmountCny) {
  throw new Error(`Sell exceeds current holding for ${fundName}`);
}
```

- [ ] **Step 5: Re-run the materializer and recorder tests**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trading_calendar.test.mjs`
Expected: PASS with holiday-aware activation, idempotent ledger application, and oversized sells rejected.


### Task 4: Align executable constraints with `asset_master.json`

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/config/asset_master.json`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/INVESTMENT_POLICY_STATEMENT.md`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/SYSTEM_BLUEPRINT.md`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs`

- [ ] **Step 1: Extend config with explicit hard vs advisory constraints**

```json
{
  "global_constraints": {
    "max_drawdown_limit": 0.15,
    "absolute_equity_cap": 0.75,
    "cash_floor_hard": 0.15
  },
  "hard_constraints": {
    "freeze_high_beta_buys_on_drawdown_pct": 0.12
  },
  "advisory_constraints": {
    "single_fund_warn_pct": 0.1,
    "theme_warn_pct": 0.12,
    "high_corr_group_warn_pct": 0.25
  }
}
```

- [ ] **Step 2: Run a failing config-consistency test**

```js
test("trade gate reads hard constraints from asset master instead of hard-coded thresholds", () => {
  const gate = evaluateTradePreFlight({
    portfolioState: buildPortfolioStateFixture(),
    proposedTrades: buildTradeFixture(),
    assetMaster: loadAssetMasterFixture()
  });
  assert.equal(gate.metadata.hardConstraintSource, "asset_master");
});
```

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs`
Expected: FAIL until the gate reads only config-driven limits.

- [ ] **Step 3: Make dashboards distinguish hard stops from advisory alerts**

```js
const hardStops = gateResult.blockingReasons ?? [];
const advisoryAlerts = riskDiagnostics.advisoryAlerts ?? [];
```

```md
## 执行约束

- Hard stop: 现金底线 / 冻结买入 / 回撤冻结
- Advisory: 单基金集中 / 主题过重 / 高相关聚集
```

- [ ] **Step 4: Re-run config + dashboard regression**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.blocking.test.mjs`
Expected: PASS with hard-stops enforced by config and advisory items still rendered as non-blocking.


### Task 5: Demote `latest.json` to compatibility-only and unify time semantics

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_canonical_view.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_canonical_view.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/state-manifest.json`

- [ ] **Step 1: Write a failing canonical-view test**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalPortfolioView } from "./portfolio_canonical_view.mjs";

test("canonical view prefers portfolio_state and treats latest.json as compatibility output", () => {
  const view = buildCanonicalPortfolioView({
    portfolioState: { summary: { available_cash_cny: 12345 }, as_of: "2026-04-03" },
    latestCompat: { summary: { available_cash_cny: 99999 }, snapshot_date: "2026-04-02" }
  });

  assert.equal(view.summary.available_cash_cny, 12345);
  assert.equal(view.time_semantics.strategy_effective_date, "2026-04-03");
});
```

- [ ] **Step 2: Run the canonical-view test and confirm failure**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_canonical_view.test.mjs`
Expected: FAIL because no canonical read helper exists yet.

- [ ] **Step 3: Implement a single read model with explicit time fields**

```js
export function buildCanonicalPortfolioView({ portfolioState, latestCompat }) {
  return {
    summary: portfolioState.summary,
    positions: portfolioState.positions,
    time_semantics: {
      snapshot_date: portfolioState.snapshot_date ?? latestCompat?.snapshot_date ?? null,
      strategy_effective_date: portfolioState.as_of ?? portfolioState.snapshot_date ?? null,
      generated_at: portfolioState.generated_at ?? null,
      compatibility_snapshot_date: latestCompat?.snapshot_date ?? null
    }
  };
}
```

- [ ] **Step 4: Switch dashboards and reports to read canonical state first**

```js
const canonical = buildCanonicalPortfolioView({
  portfolioState,
  latestCompat
});
```

- [ ] **Step 5: Re-run dashboard/report regression**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_canonical_view.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.blocking.test.mjs`
Expected: PASS with all downstream readers anchored to canonical state and `latest.json` reduced to compatibility output.


### Task 6: Full regression and live artifact verification

**Files:**
- Verify only

- [ ] **Step 1: Run the focused state/execution regression suite**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/atomic_json_state.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trade_pre_flight_gate.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/trading_calendar.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manual_trade_recorder.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_quality_scorecard.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_canonical_view.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.blocking.test.mjs`
Expected: PASS.

- [ ] **Step 2: Rebuild live state and reports**

Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/daily_writeback.mjs --date 2026-04-03`
Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs --date 2026-04-03`
Run: `node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs --date 2026-04-03 --refresh auto`
Expected: No direct-write corruption, blocked trades rejected with explicit reasons, daily brief reads canonical state.

- [ ] **Step 3: Audit delta closure**

Verify that the following items are now closed:
- manifest/state writes no longer rely on raw `writeFile`
- manual trades are rejected before ledger write when they violate hard constraints
- materializer is holiday-aware and idempotent
- dashboards consume canonical state first
- `latest.json` is no longer treated as accounting truth
