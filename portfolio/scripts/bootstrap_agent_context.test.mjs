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
        systemState: {
          researchReadiness: {
            level: "ready"
          }
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
  await writeFile(
    path.join(portfolioRoot, "data", "trading_decision_snapshot.json"),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-08T06:32:00.000Z",
        asOf: "2026-04-08",
        mode: "live",
        provider: "glm",
        status: "limited_execute",
        riskLight: "green"
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
  assert.deepEqual(context.productSurface, ["基金面板", "交易主脑", "市场/专题"]);
  assert.equal(context.intentRouting["打开基金面板"].primaryScript.endsWith("open_funds_live_dashboard.mjs"), true);
  assert.equal(context.intentRouting["刷新基金状态"].primaryScript.endsWith("refresh_account_sidecars.mjs"), true);
  assert.equal(context.intentRouting["记录基金交易"].primaryScript.endsWith("record_manual_fund_trades.mjs"), true);
  assert.equal(context.intentRouting["生成交易建议"].primaryScript.endsWith("run_tradingagents_decision_cycle.mjs"), true);
  assert.equal(context.intentRouting["今天该不该交易"].primaryScript.endsWith("run_tradingagents_decision_cycle.mjs"), true);
  assert.equal(context.intentRouting["打开市场专题"].routePath, "/market");
  assert.deepEqual(Object.keys(context.intentRouting), [
    "打开基金面板",
    "刷新基金状态",
    "记录基金交易",
    "生成交易建议",
    "今天该不该交易",
    "给我执行清单",
    "看看风险灯",
    "查看主链决策",
    "打开市场专题"
  ]);
  assert.deepEqual(context.bootstrapReadOrder, [
    "state-manifest.json",
    "data/agent_bootstrap_context.json",
    "state/portfolio_state.json",
    "data/trading_decision_snapshot.json",
    "data/trading_advice_snapshot.json"
  ]);
  assert.equal(
    context.intentRouting["生成交易建议"].requiredReads.includes("config/tradingagents_bridge.json"),
    true
  );
  assert.equal(
    context.intentRouting["打开基金面板"].requiredReads.includes("data/dashboard_state.json"),
    true
  );
  assert.equal(
    context.intentRouting["刷新基金状态"].requiredReads.includes("data/nightly_confirmed_nav_status.json"),
    true
  );
  assert.equal(context.entrypointIntegrity.accountIdsAligned, true);
  assert.equal(context.entrypointIntegrity.cashSemanticsAligned, true);
  assert.equal(context.entrypointIntegrity.positionFactsAligned, true);
  assert.equal(context.entrypointIntegrity.runtimePositionCount, 1);
  assert.equal(context.entrypointIntegrity.contractPositionFactCount, 1);
  assert.equal(context.analysisReadiness, "ready");
  assert.equal(context.decisionReadiness, "limited_execute");
  assert.equal(context.newsCoverageReadiness, "ok");
  assert.equal(context.eventWatchReadiness, "ready");
  assert.equal(context.upcomingHighImpactEventCount, 2);
  assert.equal(context.nextHighImpactEvent?.eventId, "cn-cpi-2026-04");
  assert.equal(context.portfolioFactsVersion, 1);
  assert.equal(context.tradingDecision.status, "limited_execute");
  assert.equal(context.tradingDecision.provider, "glm");
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
