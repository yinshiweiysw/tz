import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  buildAgentBootstrapContext,
  runBootstrapAgentContextBuild
} from "./bootstrap_agent_context.mjs";

test("buildAgentBootstrapContext exposes canonical routes, health, and separated cash semantics", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "agent-bootstrap-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          portfolio_state: path.join(portfolioRoot, "state", "portfolio_state.json"),
          latest_snapshot: path.join(portfolioRoot, "latest.json")
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        summary: {
          total_portfolio_assets_cny: 445000,
          total_fund_assets: 285000,
          settled_cash_cny: 160000,
          trade_available_cash_cny: 120000,
          cash_like_fund_assets_cny: 85000,
          liquidity_sleeve_assets_cny: 85000
        },
        positions: [
          {
            name: "兴全恒信债券C",
            amount: 70000,
            execution_type: "OTC",
            status: "active"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify({ bucket_order: [], buckets: {}, assets: [] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "agent_runtime_context.json"),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-08T06:30:00.000Z",
        accountId: "main",
        snapshotDate: "2026-04-07",
        meta: {
          dataFreshnessSummary: "ready"
        },
        marketContext: {
          newsCoverageReadiness: "ok",
          eventWatch: {
            readiness: "ready",
            upcomingHighImpactEventCount: 2,
            nextHighImpactEvent: {
              eventId: "cn-cpi-2026-04",
              title: "China CPI/PPI",
              scheduledAt: "2026-04-10T09:30:00+08:00"
            }
          }
        },
        portfolio: {
          settledCashCny: 160000,
          tradeAvailableCashCny: 120000,
          cashLikeFundAssetsCny: 85000,
          liquiditySleeveAssetsCny: 85000
        },
        positions: [
          {
            code: "016482",
            amount: 70000,
            observableAmount: 70000
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "strategy_decision_contract.json"),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-08T06:31:00.000Z",
        accountId: "main",
        freshness: {
          snapshotDate: "2026-04-07",
          runtimeDataFreshness: "ready",
          confirmedNavState: "partially_confirmed_normal_lag"
        },
        cashSemantics: {
          settledCashCny: 160000,
          tradeAvailableCashCny: 120000,
          cashLikeFundAssetsCny: 85000,
          liquiditySleeveAssetsCny: 85000
        },
        positionFacts: [
          {
            code: "016482",
            amountCny: 70000
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const context = await buildAgentBootstrapContext(
    {
      portfolioRoot,
      user: "main"
    },
    {
      buildHealth: async () => ({
        state: "ready",
        accountId: "main",
        portfolioRoot,
        snapshotDate: "2026-04-07",
        accountingState: "snapshot_fresh_for_accounting",
        confirmedNavState: "partially_confirmed_normal_lag",
        reasons: []
      })
    }
  );

  assert.equal(context.accountId, "main");
  assert.equal(context.health.state, "ready");
  assert.equal(context.accountSummary.settledCashCny, 160000);
  assert.equal(context.accountSummary.tradeAvailableCashCny, 120000);
  assert.equal(context.accountSummary.cashLikeFundAssetsCny, 85000);
  assert.equal(context.accountSummary.liquiditySleeveAssetsCny, 85000);
  assert.equal(context.intentRouting["分析当前行情"].primaryScript.endsWith("generate_dialogue_analysis_contract.mjs"), true);
  assert.equal(context.intentRouting["分析当前行情"].requiresExternalNewsRefresh, true);
  assert.equal(context.intentRouting["分析当前行情"].minimumNewsSources, 2);
  assert.equal(context.intentRouting["给我执行清单"].primaryScript.endsWith("trade_generator.py"), true);
  assert.equal(context.intentRouting["看看我现在持仓"].primaryScript.endsWith("generate_risk_dashboard.mjs"), true);
  assert.equal(context.intentRouting["打开基金面板"].primaryScript.endsWith("open_funds_live_dashboard.mjs"), true);
  assert.equal(context.intentRouting["做回测"].primaryScript.endsWith("run_portfolio_backtest.py"), true);
  assert.equal(context.intentRouting["收盘后生成日报"].primaryScript.endsWith("generate_market_pulse.mjs"), true);
  assert.deepEqual(Object.keys(context.intentRouting), [
    "分析当前行情",
    "今天该不该交易",
    "给我执行清单",
    "我刚买了/卖了/转换了",
    "看看我现在持仓",
    "打开基金面板",
    "基金面板为什么不对",
    "刷新市场数据",
    "做回测",
    "收盘后生成日报"
  ]);
  assert.deepEqual(context.bootstrapReadOrder, [
    "state-manifest.json",
    "data/agent_bootstrap_context.json",
    "state/portfolio_state.json"
  ]);
  assert.equal(
    context.intentRouting["分析当前行情"].requiredReads.includes("data/agent_runtime_context.json"),
    true
  );
  assert.equal(
    context.intentRouting["分析当前行情"].requiredReads.includes(
      "data/strategy_decision_contract.json"
    ),
    true
  );
  assert.equal(
    context.intentRouting["分析当前行情"].requiredReads.includes(
      "data/high_impact_event_calendar.json"
    ),
    true
  );
  assert.equal(context.entrypointIntegrity.accountIdsAligned, true);
  assert.equal(context.entrypointIntegrity.cashSemanticsAligned, true);
  assert.equal(context.entrypointIntegrity.positionFactsAligned, true);
  assert.equal(context.entrypointIntegrity.runtimePositionCount, 1);
  assert.equal(context.entrypointIntegrity.contractPositionFactCount, 1);
  assert.equal(context.analysisReadiness, "ready");
  assert.equal(context.decisionReadiness, "ready");
  assert.equal(context.newsCoverageReadiness, "ok");
  assert.equal(context.eventWatchReadiness, "ready");
  assert.equal(context.upcomingHighImpactEventCount, 2);
  assert.equal(context.nextHighImpactEvent?.eventId, "cn-cpi-2026-04");
  assert.equal(context.portfolioFactsVersion, 1);
  assert.equal(context.entrypointIntegrity.runtimeGeneratedAt, "2026-04-08T06:30:00.000Z");
  assert.equal(
    context.entrypointIntegrity.strategyDecisionContractGeneratedAt,
    "2026-04-08T06:31:00.000Z"
  );
});

test("runBootstrapAgentContextBuild writes agent_bootstrap_context.json and updates manifest pointers", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "agent-bootstrap-write-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        summary: {},
        positions: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify({ bucket_order: [], buckets: {}, assets: [] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "agent_runtime_context.json"),
    `${JSON.stringify({ generatedAt: "2026-04-08T06:30:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "strategy_decision_contract.json"),
    `${JSON.stringify({ generatedAt: "2026-04-08T06:31:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const result = await runBootstrapAgentContextBuild(
    {
      portfolioRoot,
      user: "main"
    },
    {
      buildHealth: async () => ({
        state: "degraded",
        accountId: "main",
        portfolioRoot,
        snapshotDate: "2026-04-07",
        accountingState: "snapshot_fresh_for_accounting",
        confirmedNavState: "confirmed_nav_ready",
        reasons: ["watchlist missing"]
      })
    }
  );

  const persisted = JSON.parse(
    await readFile(path.join(portfolioRoot, "data", "agent_bootstrap_context.json"), "utf8")
  );
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));

  assert.equal(result.outputPath, path.join(portfolioRoot, "data", "agent_bootstrap_context.json"));
  assert.equal(persisted.health.state, "degraded");
  assert.equal(
    manifest.canonical_entrypoints.latest_agent_bootstrap_context,
    path.join(portfolioRoot, "data", "agent_bootstrap_context.json")
  );
  assert.equal(
    manifest.canonical_entrypoints.agent_bootstrap_context_script,
    path.join(portfolioRoot, "scripts", "bootstrap_agent_context.mjs")
  );
});

test("buildAgentBootstrapContext exposes change guardrails for agents", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "agent-bootstrap-clause-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        summary: {},
        positions: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify({ bucket_order: [], buckets: {}, assets: [] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "agent_runtime_context.json"),
    `${JSON.stringify({ generatedAt: "2026-04-08T06:30:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "strategy_decision_contract.json"),
    `${JSON.stringify({ generatedAt: "2026-04-08T06:31:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const result = await runBootstrapAgentContextBuild(
    {
      portfolioRoot,
      user: "main"
    },
    {
      buildHealth: async () => ({
        state: "ready",
        accountId: "main",
        portfolioRoot,
        snapshotDate: "2026-04-07",
        accountingState: "snapshot_fresh_for_accounting",
        confirmedNavState: "confirmed_nav_ready",
        reasons: []
      })
    }
  );

  const { payload } = result;
  assert.equal(payload.changeGuardrails?.required, true);
  assert.deepEqual(payload.changeGuardrails?.checklist ?? [], [
    "change_layer",
    "canonical_inputs",
    "affected_modules",
    "impact_decision",
    "write_boundary_check",
    "required_regressions"
  ]);
  assert.equal(payload.changeGuardrails?.policy?.impactAssessmentBeforeImplementation, true);
  assert.equal(payload.changeGuardrails?.policy?.regressionBeforeCompletion, true);
  assert.equal(payload.changeGuardrails?.policy?.noSilentFeatureRemoval, true);
});
