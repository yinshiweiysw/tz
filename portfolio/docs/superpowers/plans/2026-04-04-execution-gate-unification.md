# Execution Gate Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual trade recording obey the same research permission contract as reports, while clarifying manifest semantics so canonical state remains `portfolio_state.json` and `latest.json` is only a compatibility view.

**Architecture:** Add one narrow composition layer above `trade_pre_flight_gate` instead of merging research logic into the structural gate. Then wire the manual trade CLI to that unified execution decision and normalize manifest/state helpers so new code prefers `portfolio_state + latest_compat_view` over the legacy `latest_snapshot` label.

**Tech Stack:** Node.js ESM, node:test, existing portfolio scripts and JSON state contracts

---

## File Map

- Create: `portfolio/scripts/lib/execution_permission_gate.mjs`
- Create: `portfolio/scripts/lib/execution_permission_gate.test.mjs`
- Modify: `portfolio/scripts/record_manual_fund_trades.mjs`
- Modify: `portfolio/scripts/record_manual_fund_trades.test.mjs`
- Modify: `portfolio/scripts/lib/portfolio_state_view.mjs`
- Modify: `portfolio/scripts/lib/manifest_state.mjs`
- Modify: `portfolio/scripts/lib/manifest_state.test.mjs`
- Modify: `portfolio/state-manifest.json`

## Task 1: Create a Unified Execution Permission Helper

**Files:**
- Create: `portfolio/scripts/lib/execution_permission_gate.mjs`
- Create: `portfolio/scripts/lib/execution_permission_gate.test.mjs`

- [ ] **Step 1: Write the failing tests for research-permission composition**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExecutionPermission } from "./execution_permission_gate.mjs";

test("blocked research permission rejects buy even when structural gate passes", () => {
  const result = evaluateExecutionPermission({
    structuralGate: { allowed: true, blockingReasons: [], warnings: [] },
    researchDecision: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "blocked",
          one_sentence_order: "研究闸门未通过，当前禁止生成交易指令。"
        }
      }
    },
    proposedTrades: [{ type: "buy", fund_code: "007339", amount_cny: 1000 }]
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /research/i);
});

test("restricted research permission allows sell-only de-risking", () => {
  const result = evaluateExecutionPermission({
    structuralGate: { allowed: true, blockingReasons: [], warnings: [] },
    researchDecision: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "restricted"
        }
      }
    },
    proposedTrades: [{ type: "sell", fund_code: "007339", amount_cny: 1000 }]
  });

  assert.equal(result.allowed, true);
});

test("restricted research permission rejects risk-increasing buy", () => {
  const result = evaluateExecutionPermission({
    structuralGate: { allowed: true, blockingReasons: [], warnings: [] },
    researchDecision: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "restricted"
        }
      }
    },
    proposedTrades: [{ type: "buy", fund_code: "022502", amount_cny: 1000 }]
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /restricted/i);
});
```

- [ ] **Step 2: Run the focused test target to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.test.mjs
```

Expected: FAIL because the helper file does not exist yet.

- [ ] **Step 3: Implement the minimal permission combiner**

```js
function readTradePermission(researchDecision = {}) {
  return String(
    researchDecision?.actionable_decision?.desk_conclusion?.trade_permission ??
      researchDecision?.desk_conclusion?.trade_permission ??
      "restricted"
  )
    .trim()
    .toLowerCase();
}

function isRiskIncreasingTrade(trade = {}) {
  return String(trade?.type ?? "").trim().toLowerCase() === "buy";
}

export function evaluateExecutionPermission({
  structuralGate = {},
  researchDecision = {},
  proposedTrades = []
} = {}) {
  const structuralAllowed = structuralGate?.allowed === true;
  const structuralBlockingReasons = Array.isArray(structuralGate?.blockingReasons)
    ? structuralGate.blockingReasons
    : [];
  const warnings = Array.isArray(structuralGate?.warnings) ? structuralGate.warnings.slice() : [];

  if (!structuralAllowed) {
    return {
      allowed: false,
      mode: "structural_blocked",
      blockingReasons: structuralBlockingReasons,
      warnings
    };
  }

  const tradePermission = readTradePermission(researchDecision);
  if (tradePermission === "blocked") {
    return {
      allowed: false,
      mode: "research_blocked",
      blockingReasons: ["Trade blocked by research permission: blocked."],
      warnings
    };
  }

  if (tradePermission === "restricted" && proposedTrades.some(isRiskIncreasingTrade)) {
    return {
      allowed: false,
      mode: "research_restricted",
      blockingReasons: ["Trade blocked by research permission: restricted only allows de-risking actions."],
      warnings
    };
  }

  return {
    allowed: true,
    mode: tradePermission || "allowed",
    blockingReasons: [],
    warnings
  };
}
```

- [ ] **Step 4: Run the tests to verify green**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.test.mjs
git commit -m "feat: add unified execution permission gate"
```

## Task 2: Wire Manual Trade Recording to the Unified Gate

**Files:**
- Modify: `portfolio/scripts/record_manual_fund_trades.mjs`
- Modify: `portfolio/scripts/record_manual_fund_trades.test.mjs`

- [ ] **Step 1: Add failing CLI tests for blocked and restricted research states**

```js
test("record_manual_fund_trades rejects buy when research trade_permission is blocked", async () => {
  await writeJson(path.join(portfolioRoot, "data", "research_brain.json"), {
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "blocked",
        one_sentence_order: "研究闸门未通过，当前禁止生成交易指令。"
      }
    }
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
      "--portfolio-root",
      portfolioRoot,
      "--date",
      "2026-04-01",
      "--buy",
      "007339:1000",
      "--skip-merge",
      "true",
      "--skip-writeback",
      "true"
    ]),
    /research permission/i
  );
});

test("record_manual_fund_trades allows sell when research trade_permission is restricted", async () => {
  await writeJson(path.join(portfolioRoot, "data", "research_brain.json"), {
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "restricted"
      }
    }
  });

  await execFileAsync(process.execPath, [
    "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
    "--portfolio-root",
    portfolioRoot,
    "--date",
    "2026-04-01",
    "--sell",
    "000218:500",
    "--skip-merge",
    "true",
    "--skip-writeback",
    "true"
  ]);
});
```

- [ ] **Step 2: Run the CLI tests to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.test.mjs
```

Expected: FAIL because the CLI currently only evaluates `trade_pre_flight_gate`.

- [ ] **Step 3: Implement unified gate evaluation in the CLI**

```js
import { evaluateExecutionPermission } from "./lib/execution_permission_gate.mjs";

const researchBrainPath =
  manifest?.canonical_entrypoints?.latest_research_brain ??
  buildPortfolioPath(portfolioRoot, "data", "research_brain.json");
const researchBrain = await readJsonOrNull(researchBrainPath);

const executionGate = evaluateExecutionPermission({
  structuralGate: gateResult,
  researchDecision: researchBrain,
  proposedTrades
});

if (!executionGate.allowed) {
  console.error(
    `Trade blocked by unified execution gate: ${executionGate.blockingReasons.join(" | ")}`
  );
  process.exit(1);
}
```

Behavior rule for this slice:

- `buy` is risk-increasing and blocked under `restricted`
- `sell` is allowed under `restricted`
- `conversion` is blocked under `restricted` because it includes a buy leg and this slice keeps semantics conservative

- [ ] **Step 4: Run the tests to verify green**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.test.mjs
git commit -m "fix: enforce research trade permission in manual trade recording"
```

## Task 3: Clarify Manifest Semantics for Canonical State vs Compatibility View

**Files:**
- Modify: `portfolio/scripts/lib/portfolio_state_view.mjs`
- Modify: `portfolio/scripts/lib/manifest_state.mjs`
- Modify: `portfolio/scripts/lib/manifest_state.test.mjs`
- Modify: `portfolio/state-manifest.json`

- [ ] **Step 1: Add failing tests for manifest alias normalization**

```js
test("buildPortfolioStatePaths prefers latest_compat_view over latest_snapshot", async () => {
  const paths = buildPortfolioStatePaths("/tmp/demo", {
    canonical_entrypoints: {
      portfolio_state: "/tmp/demo/state/portfolio_state.json",
      latest_snapshot: "/tmp/demo/latest-old.json",
      latest_compat_view: "/tmp/demo/latest-new.json"
    }
  });

  assert.equal(paths.latestCompatPath, "/tmp/demo/latest-new.json");
});

test("updateManifestCanonicalEntrypoints keeps latest_snapshot and latest_compat_view aligned", async () => {
  const updated = await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: { canonical_entrypoints: {} },
    entries: {
      latest_compat_view: "/reports/latest.json"
    }
  });

  assert.equal(updated.canonical_entrypoints.latest_compat_view, "/reports/latest.json");
  assert.equal(updated.canonical_entrypoints.latest_snapshot, "/reports/latest.json");
});
```

- [ ] **Step 2: Run the manifest/state helper tests to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.test.mjs
```

Expected: FAIL because alias synchronization and new key preference do not exist yet.

- [ ] **Step 3: Implement the semantic tightening**

In `portfolio_state_view.mjs`:

```js
export function buildPortfolioStatePaths(portfolioRoot, manifest = null) {
  const canonical = manifest?.canonical_entrypoints ?? {};

  return {
    portfolioStatePath:
      canonical.portfolio_state ?? buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json"),
    latestCompatPath:
      canonical.latest_compat_view ??
      canonical.latest_snapshot ??
      buildPortfolioPath(portfolioRoot, "latest.json"),
    latestRawPath:
      canonical.latest_raw_snapshot ?? buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json")
  };
}
```

In `manifest_state.mjs`, normalize aliases before write:

```js
function normalizeCanonicalAliases(entries = {}) {
  const next = { ...entries };
  const latestCompat = next.latest_compat_view ?? next.latest_snapshot ?? null;
  if (latestCompat) {
    next.latest_compat_view = latestCompat;
    next.latest_snapshot = latestCompat;
  }
  return next;
}
```

Then call `normalizeCanonicalAliases(entries)` before merging.

Update the checked-in `portfolio/state-manifest.json` so:

- `latest_snapshot` remains for transition
- `latest_compat_view` is added with the same path
- `portfolio_state` remains the primary state pointer

- [ ] **Step 4: Run the tests to verify green**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_view.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.test.mjs /Users/yinshiwei/codex/tz/portfolio/state-manifest.json
git commit -m "refactor: clarify canonical manifest state semantics"
```

## Task 4: Full Verification Pass

**Files:**
- Test only: existing touched files

- [ ] **Step 1: Run focused unit and CLI tests**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/execution_permission_gate.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.test.mjs
```

Expected: PASS

- [ ] **Step 2: Run sidecar refresh smoke test**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_account_sidecars.mjs --portfolio-root /Users/yinshiwei/codex/tz/portfolio --user main --date 2026-04-03 --scopes risk_dashboard,live_funds_snapshot,research_brain,report_session_memory
```

Expected: command exits `0` and rewrites sidecars without requiring `latest.json` as a business input.

- [ ] **Step 3: Run manual trade CLI smoke check with blocked research state in a temp fixture**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.test.mjs
```

Expected: PASS, including blocked/restricted research cases.

- [ ] **Step 4: Review success criteria against the design**

Checklist:

```text
- manual trade buy blocked when research says blocked
- sell-only allowed when research says restricted
- canonical state helper still hard-fails without portfolio_state
- manifest path helper prefers latest_compat_view over latest_snapshot
```

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/docs/superpowers/specs/2026-04-04-execution-gate-unification-design.md /Users/yinshiwei/codex/tz/portfolio/docs/superpowers/plans/2026-04-04-execution-gate-unification.md
git commit -m "docs: add execution gate unification design and plan"
```
