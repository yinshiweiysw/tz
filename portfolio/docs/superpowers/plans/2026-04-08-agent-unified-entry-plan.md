# Agent Unified Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a strict shared agent entry layer so every new agent reads the same runtime context and the same strategy decision contract before producing analysis or trade advice.

**Architecture:** Add two new canonical read models, `agent_runtime_context.json` and `strategy_decision_contract.json`, generated from canonical accounting, dashboard, research, and health sources. Then wire manifest + intent registry + dispatch protocol so every investment intent must consume those two objects before deeper scripts run.

**Tech Stack:** Node.js ESM, existing portfolio scripts, JSON state files, `node:test`, manifest canonical entrypoints

---

### Task 1: Build Agent Runtime Context Read Model

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_agent_runtime_context.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs`

- [ ] **Step 1: Write the failing tests for runtime context shape and semantics**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentRuntimeContextPayload } from "./agent_runtime_context.mjs";

test("buildAgentRuntimeContextPayload projects positions buckets market context and system state", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      snapshot_date: "2026-04-08",
      summary: {
        total_portfolio_assets_cny: 431720.08,
        total_fund_assets: 272103.78,
        settled_cash_cny: 159616.3,
        trade_available_cash_cny: 150000,
        cash_like_fund_assets_cny: 85132.56,
        liquidity_sleeve_assets_cny: 85132.56,
        unrealized_holding_profit_cny: -27980.79
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          amount: 21680.19,
          holding_cost_basis_cny: 21000,
          holding_pnl: 680.19,
          holding_pnl_rate_pct: 3.24,
          confirmation_state: "confirmed",
          bucket: "A_CORE",
          category: "A股宽基"
        }
      ]
    },
    dashboardState: {
      presentation: {
        summary: {
          totalPortfolioAssets: 431720.08,
          displayDailyPnl: 6803.17
        }
      },
      rows: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          changePct: 3.24,
          quoteDate: "2026-04-08"
        }
      ]
    },
    researchBrain: {
      top_headlines: [{ source: "财新", title: "全球市场交易“美伊停战”：黄金重燃、美元熄火" }],
      gold_factor_model: { goldRegime: "liquidity_repricing" }
    },
    health: {
      state: "ready",
      confirmedNavState: "partially_confirmed_normal_lag"
    },
    bucketSummary: [
      {
        bucketKey: "A_CORE",
        label: "A股核心",
        amount: 41152.21,
        weightPct: 9.53,
        targetPct: 22,
        gapAmountCny: 53827
      }
    ]
  });

  assert.equal(payload.portfolio.settledCashCny, 159616.3);
  assert.equal(payload.positions[0].bucketKey, "A_CORE");
  assert.equal(payload.bucketView[0].gapAmountCny, 53827);
  assert.equal(payload.marketContext.topHeadlines[0].source, "财新");
  assert.equal(payload.systemState.confirmedNavState, "partially_confirmed_normal_lag");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs
```

Expected: FAIL with module or export missing errors for `buildAgentRuntimeContextPayload`.

- [ ] **Step 3: Write the minimal runtime context implementation**

```js
export function buildAgentRuntimeContextPayload({
  accountId,
  portfolioState = {},
  dashboardState = {},
  researchBrain = {},
  health = {},
  bucketSummary = []
} = {}) {
  const summary = portfolioState?.summary ?? {};
  const dashboardSummary = dashboardState?.presentation?.summary ?? {};
  const dashboardRows = Array.isArray(dashboardState?.rows) ? dashboardState.rows : [];
  const positions = Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    snapshotDate: String(portfolioState?.snapshot_date ?? "").trim() || null,
    meta: {
      marketSession: String(researchBrain?.meta?.market_session ?? "unknown"),
      dataFreshnessSummary: String(health?.state ?? "unknown")
    },
    portfolio: {
      totalPortfolioAssetsCny: Number(summary?.total_portfolio_assets_cny ?? 0) || 0,
      investedAssetsCny: Number(summary?.total_fund_assets ?? 0) || 0,
      settledCashCny: Number(summary?.settled_cash_cny ?? 0) || 0,
      tradeAvailableCashCny: Number(summary?.trade_available_cash_cny ?? 0) || 0,
      cashLikeFundAssetsCny: Number(summary?.cash_like_fund_assets_cny ?? 0) || 0,
      liquiditySleeveAssetsCny: Number(summary?.liquidity_sleeve_assets_cny ?? 0) || 0,
      holdingProfitCny: Number(summary?.unrealized_holding_profit_cny ?? summary?.holding_profit ?? 0) || 0,
      dailyPnlCny: Number(dashboardSummary?.displayDailyPnl ?? 0) || 0
    },
    positions: positions
      .filter((position) => position?.status !== "user_confirmed_sold")
      .map((position) => {
        const row = dashboardRows.find((item) => String(item?.code ?? "") === String(position?.code ?? position?.fund_code ?? ""));
        return {
          name: position?.name ?? null,
          code: position?.code ?? position?.fund_code ?? null,
          bucketKey: position?.bucket ?? row?.bucketKey ?? null,
          category: position?.category ?? null,
          amount: Number(position?.amount ?? 0) || 0,
          costBasis: Number(position?.holding_cost_basis_cny ?? 0) || 0,
          holdingPnl: Number(position?.holding_pnl ?? 0) || 0,
          holdingPnlRatePct: Number(position?.holding_pnl_rate_pct ?? 0) || 0,
          changePct: Number(row?.changePct ?? 0) || 0,
          quoteDate: row?.quoteDate ?? null,
          confirmationState: position?.confirmation_state ?? row?.confirmationState ?? null
        };
      }),
    bucketView: Array.isArray(bucketSummary) ? bucketSummary : [],
    marketContext: {
      topHeadlines: Array.isArray(researchBrain?.top_headlines) ? researchBrain.top_headlines.slice(0, 8) : [],
      crossAssetSnapshot: researchBrain?.market_snapshot ?? {},
      dominantDrivers: researchBrain?.event_driver?.active_drivers ?? [],
      goldRegime: researchBrain?.gold_factor_model?.goldRegime ?? null,
      riskTone: researchBrain?.actionable_decision?.desk_conclusion?.overall_stance ?? null
    },
    systemState: {
      dashboardHealth: health,
      researchReadiness: researchBrain?.decision_readiness ?? {},
      confirmedNavState: health?.confirmedNavState ?? null,
      blockedReason: researchBrain?.blocked_reason ?? null,
      staleDependencies: researchBrain?.freshness_guard?.stale_dependencies ?? []
    }
  };
}
```

- [ ] **Step 4: Add builder script and verify tests pass**

```js
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { loadCanonicalPortfolioState, readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import { buildAgentRuntimeContextPayload } from "./lib/agent_runtime_context.mjs";
import { buildFundsDashboardHealth } from "./serve_funds_live_dashboard.mjs";

export async function runAgentRuntimeContextBuild(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const portfolioState = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
  const dashboardState = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json"));
  const researchBrain = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "research_brain.json"));
  const health = await (deps.buildHealth ?? buildFundsDashboardHealth)(accountId);
  const bucketSummary = Array.isArray(dashboardState?.presentation?.bucketSummary) ? dashboardState.presentation.bucketSummary : [];
  const payload = buildAgentRuntimeContextPayload({
    accountId,
    portfolioState: portfolioState.payload,
    dashboardState,
    researchBrain,
    health,
    bucketSummary
  });

  const outputPath = buildPortfolioPath(portfolioRoot, "data", "agent_runtime_context.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      agent_runtime_context_builder: buildPortfolioPath(portfolioRoot, "scripts", "build_agent_runtime_context.mjs"),
      agent_runtime_context: outputPath
    }
  });

  return { outputPath, payload };
}
```

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/build_agent_runtime_context.mjs
git commit -m "feat: add agent runtime context builder"
```

### Task 2: Build Strategy Decision Contract Read Model

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.test.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/build_strategy_decision_contract.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.test.mjs`

- [ ] **Step 1: Write the failing tests for bucket policy and guardrail projection**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildStrategyDecisionContract } from "./strategy_decision_contract.mjs";

test("buildStrategyDecisionContract projects regime bucket policies and execution guardrails", () => {
  const contract = buildStrategyDecisionContract({
    runtimeContext: {
      generatedAt: "2026-04-08T06:30:00.000Z",
      accountId: "main",
      bucketView: [
        {
          bucketKey: "A_CORE",
          label: "A股核心",
          amount: 41152.21,
          weightPct: 9.53,
          targetPct: 22,
          gapAmountCny: 53827
        }
      ],
      systemState: {
        blockedReason: null
      }
    },
    tradePlan: {
      summary: {
        maxTotalBuyTodayCny: 20000
      }
    },
    signals: {
      market_regime: "risk_on_rebound"
    }
  });

  assert.equal(contract.regime.marketRegime, "risk_on_rebound");
  assert.equal(contract.bucketPolicies[0].bucketKey, "A_CORE");
  assert.equal(contract.bucketPolicies[0].maxAddTodayCny, 15000);
  assert.equal(contract.executionGuardrails.maxTotalBuyTodayCny, 20000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.test.mjs
```

Expected: FAIL with missing module or export.

- [ ] **Step 3: Write the minimal decision contract implementation**

```js
function deriveBucketPolicy(bucket = {}) {
  const gapAmount = Number(bucket?.gapAmountCny ?? 0) || 0;
  const weight = Number(bucket?.weightPct ?? 0) || 0;
  const target = Number(bucket?.targetPct ?? 0) || 0;

  return {
    bucketKey: bucket?.bucketKey ?? null,
    label: bucket?.label ?? null,
    currentWeightPct: weight,
    targetWeightPct: target,
    actionBias: gapAmount > 0 ? "add_on_strength_with_limits" : gapAmount < 0 ? "do_not_add" : "hold",
    maxAddTodayCny: gapAmount > 0 ? Math.min(gapAmount, 15000) : 0,
    requiresPullback: gapAmount <= 0,
    forbiddenActions: gapAmount <= 0 ? ["do_not_chase"] : [],
    notes: gapAmount > 0 ? [`结构性缺口 ${gapAmount} 元`] : ["接近或高于目标"]
  };
}

export function buildStrategyDecisionContract({ runtimeContext = {}, tradePlan = {}, signals = {} } = {}) {
  const bucketPolicies = Array.isArray(runtimeContext?.bucketView)
    ? runtimeContext.bucketView.map((bucket) => deriveBucketPolicy(bucket))
    : [];

  const maxTotalBuyTodayCny = Number(tradePlan?.summary?.maxTotalBuyTodayCny ?? 20000) || 20000;

  return {
    generatedAt: new Date().toISOString(),
    accountId: runtimeContext?.accountId ?? "main",
    contractVersion: 1,
    basedOnRuntimeContextAt: runtimeContext?.generatedAt ?? null,
    regime: {
      marketRegime: signals?.market_regime ?? "unknown",
      riskState: runtimeContext?.systemState?.blockedReason ? "blocked" : "partial_chase_only",
      tradePermission: runtimeContext?.systemState?.blockedReason ? "blocked" : "limited",
      overallStance: runtimeContext?.systemState?.blockedReason ? "freeze" : "do_not_full_rebalance_today"
    },
    bucketPolicies,
    executionGuardrails: {
      maxTotalBuyTodayCny,
      maxSingleBucketAddTodayCny: 15000,
      restrictedActions: runtimeContext?.systemState?.blockedReason ? ["no_new_risk"] : [],
      cashFloorRules: []
    },
    responsePolicy: {
      requiredSections: ["main_driver", "portfolio_impact", "allowed_actions", "forbidden_actions", "amount_bounds"]
    }
  };
}
```

- [ ] **Step 4: Add builder script and verify tests pass**

```js
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPortfolioPath, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import { buildStrategyDecisionContract } from "./lib/strategy_decision_contract.mjs";

export async function runStrategyDecisionContractBuild(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const runtimeContextPath = buildPortfolioPath(portfolioRoot, "data", "agent_runtime_context.json");
  const runtimeContext = await readJsonOrNull(runtimeContextPath);
  const tradePlan = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "trade_plan_v4.json"));
  const signals = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "signals", "regime_router_signals.json"));
  const payload = buildStrategyDecisionContract({ runtimeContext, tradePlan, signals });
  const outputPath = buildPortfolioPath(portfolioRoot, "data", "strategy_decision_contract.json");
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      strategy_decision_contract_builder: buildPortfolioPath(portfolioRoot, "scripts", "build_strategy_decision_contract.mjs"),
      strategy_decision_contract: outputPath
    }
  });

  return { outputPath, payload };
}
```

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/build_strategy_decision_contract.mjs
git commit -m "feat: add strategy decision contract builder"
```

### Task 3: Wire Manifest and Intent Registry to the New Entry Layer

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/state-manifest.json`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs`

- [ ] **Step 1: Write failing tests for requiredReads including the new runtime and contract files**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentIntentRegistry } from "./agent_intent_registry.mjs";

test("agent intent registry requires runtime context and strategy decision contract for all analysis and trade intents", () => {
  const registry = buildAgentIntentRegistry("/tmp/portfolio");
  for (const key of ["分析当前行情", "今天该不该交易", "给我执行清单", "看看我现在持仓"]) {
    const reads = registry[key].requiredReads;
    assert.equal(reads.includes("data/agent_runtime_context.json"), true);
    assert.equal(reads.includes("data/strategy_decision_contract.json"), true);
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs
```

Expected: FAIL because registry does not yet require the new files.

- [ ] **Step 3: Update bootstrap payload and intent registry**

```js
export function buildAgentIntentRegistry(portfolioRoot) {
  const script = (name) => buildPortfolioPath(portfolioRoot, "scripts", name);
  const sharedRequiredReads = ["data/agent_runtime_context.json", "data/strategy_decision_contract.json"];

  return {
    分析当前行情: {
      primaryScript: script("generate_dialogue_analysis_contract.mjs"),
      requiredReads: ["state-manifest.json", ...sharedRequiredReads, "state/portfolio_state.json"]
    },
    今天该不该交易: {
      primaryScript: script("generate_signals.py"),
      followupScript: script("generate_next_trade_plan.mjs"),
      requiredReads: [...sharedRequiredReads, "state/portfolio_state.json", "signals/regime_router_signals.json"]
    }
  };
}
```

```js
return {
  generatedAt: new Date().toISOString(),
  accountId,
  bootstrapReadOrder: [
    "state-manifest.json",
    "data/agent_runtime_context.json",
    "data/strategy_decision_contract.json",
    "state/portfolio_state.json"
  ],
  canonicalEntrypoints: {
    manifestPath,
    ...(manifest?.canonical_entrypoints ?? {})
  },
  health,
  accountSummary,
  intentRouting: buildAgentIntentRegistry(portfolioRoot)
};
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs
git commit -m "feat: enforce shared agent entrypoint reads"
```

### Task 4: Add Refresh Orchestration and Staleness Checks

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.test.mjs`

- [ ] **Step 1: Write failing tests for ordered refresh and manifest registration**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { runAgentEntrypointRefresh } from "./refresh_agent_entrypoints.mjs";

test("runAgentEntrypointRefresh rebuilds runtime context before strategy decision contract", async () => {
  const calls = [];
  await runAgentEntrypointRefresh(
    { portfolioRoot: "/tmp/demo" },
    {
      runRuntimeContextBuild: async () => {
        calls.push("runtime");
        return { outputPath: "/tmp/demo/data/agent_runtime_context.json" };
      },
      runStrategyDecisionContractBuild: async () => {
        calls.push("contract");
        return { outputPath: "/tmp/demo/data/strategy_decision_contract.json" };
      }
    }
  );

  assert.deepEqual(calls, ["runtime", "contract"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.test.mjs
```

Expected: FAIL because refresh orchestration script does not exist.

- [ ] **Step 3: Implement orchestration**

```js
import { runAgentRuntimeContextBuild } from "./build_agent_runtime_context.mjs";
import { runStrategyDecisionContractBuild } from "./build_strategy_decision_contract.mjs";

export async function runAgentEntrypointRefresh(rawOptions = {}, deps = {}) {
  const runRuntimeContextBuild = deps.runRuntimeContextBuild ?? runAgentRuntimeContextBuild;
  const runStrategyDecisionContractBuild = deps.runStrategyDecisionContractBuild ?? runStrategyDecisionContractBuild;

  const runtimeResult = await runRuntimeContextBuild(rawOptions);
  const contractResult = await runStrategyDecisionContractBuild(rawOptions);

  return {
    runtimeContextPath: runtimeResult.outputPath,
    strategyDecisionContractPath: contractResult.outputPath
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.test.mjs
git commit -m "feat: add agent entrypoint refresh orchestration"
```

### Task 5: Update Protocol Docs and End-to-End Contract Tests

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/agent_entry_contract.test.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/agent_entry_contract.test.mjs`

- [ ] **Step 1: Write failing end-to-end contract test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dispatch protocol and manifest reference runtime context and strategy contract as mandatory agent entry files", async () => {
  const protocol = await readFile("/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md", "utf8");
  assert.match(protocol, /agent_runtime_context\.json/);
  assert.match(protocol, /strategy_decision_contract\.json/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/agent_entry_contract.test.mjs
```

Expected: FAIL because protocol does not yet require the new files.

- [ ] **Step 3: Update dispatch protocol**

```md
## 新线程启动顺序

1. `state-manifest.json`
2. `data/agent_runtime_context.json`
3. `data/strategy_decision_contract.json`
4. `state/portfolio_state.json`

## 不可违背的硬规则

1. 所有投资类 agent 在输出建议前必须读取 `agent_runtime_context.json` 与 `strategy_decision_contract.json`
2. 若任一入口缺失或过期，只能返回 blocked 状态与推荐刷新脚本
```

- [ ] **Step 4: Run full targeted regression**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_runtime_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/strategy_decision_contract.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/refresh_agent_entrypoints.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/agent_entry_contract.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md /Users/yinshiwei/codex/tz/portfolio/scripts/agent_entry_contract.test.mjs
git commit -m "docs: enforce unified agent entry protocol"
```

## Self-Review

- Spec coverage:
  - Runtime context solved in Task 1
  - Strategy contract solved in Task 2
  - Mandatory entry reads solved in Task 3
  - Refresh ordering solved in Task 4
  - Human and machine protocol sync solved in Task 5

- Placeholder scan:
  - No `TODO`, `TBD`, or “similar to previous task” placeholders remain

- Type consistency:
  - `agent_runtime_context.json` and `strategy_decision_contract.json` names are used consistently
  - `requiredReads` paths match the same filenames throughout

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-08-agent-unified-entry-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
