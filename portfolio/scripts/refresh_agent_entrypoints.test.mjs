import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgentEntrypointRefresh } from "./refresh_agent_entrypoints.mjs";
import { runAgentRuntimeContextBuild } from "./build_agent_runtime_context.mjs";
import { runStrategyDecisionContractBuild } from "./build_strategy_decision_contract.mjs";
import { runBootstrapAgentContextBuild } from "./bootstrap_agent_context.mjs";

test("runAgentEntrypointRefresh rebuilds runtime context before strategy decision contract", async () => {
  const calls = [];
  const result = await runAgentEntrypointRefresh(
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
  assert.equal(result.runtimeContextPath, "/tmp/demo/data/agent_runtime_context.json");
  assert.equal(
    result.strategyDecisionContractPath,
    "/tmp/demo/data/strategy_decision_contract.json"
  );
});

test("runAgentEntrypointRefresh builds consistent bootstrap runtime and strategy artifacts", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "agent-entry-e2e-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "signals"), { recursive: true })
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
        snapshot_date: "2026-04-08",
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
            code: "016482",
            confirmed_units: 52361.94895592,
            amount: 70000,
            holding_cost_basis_cny: 69880,
            holding_pnl: 120,
            bucket: "CASH",
            category: "债券",
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
    path.join(portfolioRoot, "data", "dashboard_state.json"),
    `${JSON.stringify(
      {
        presentation: {
          summary: {
            displayDailyPnl: 88.5
          },
          bucketSummary: []
        },
        rows: [
          {
            name: "兴全恒信债券C",
            code: "016482",
            amount: 70088.5,
            holdingPnl: 208.5,
            quoteMode: "intraday_valuation",
            quoteDate: "2026-04-08"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "research_brain.json"),
    `${JSON.stringify(
      {
        top_headlines: [{ source: "财新", title: "示例头条" }]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "trade_plan_v4.json"),
    `${JSON.stringify({ summary: { maxTotalBuyTodayCny: 18000 } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "signals", "regime_router_signals.json"),
    `${JSON.stringify({ market_regime: "risk_on_rebound" }, null, 2)}\n`,
    "utf8"
  );

  const health = {
    state: "ready",
    accountId: "main",
    portfolioRoot,
    snapshotDate: "2026-04-08",
    accountingState: "snapshot_fresh_for_accounting",
    confirmedNavState: "confirmed_nav_ready",
    reasons: []
  };

  const result = await runAgentEntrypointRefresh(
    { portfolioRoot, user: "main" },
    {
      runRuntimeContextBuild: (options) =>
        runAgentRuntimeContextBuild(options, {
          buildHealth: async () => health
        }),
      runStrategyDecisionContractBuild,
      runBootstrapAgentContextBuild: (options) =>
        runBootstrapAgentContextBuild(options, {
          buildHealth: async () => health
        })
    }
  );

  const runtime = JSON.parse(await readFile(result.runtimeContextPath, "utf8"));
  const contract = JSON.parse(await readFile(result.strategyDecisionContractPath, "utf8"));
  const bootstrap = JSON.parse(await readFile(result.bootstrapAgentContextPath, "utf8"));

  assert.equal(runtime.accountId, "main");
  assert.equal(contract.accountId, "main");
  assert.equal(bootstrap.accountId, "main");
  assert.equal(contract.cashSemantics.tradeAvailableCashCny, 120000);
  assert.equal(contract.positionFacts[0].amountCny, 70088.5);
  assert.equal(contract.positionFacts[0].decisionValueSource, "observable");
  assert.equal(bootstrap.entrypointIntegrity.accountIdsAligned, true);
  assert.equal(bootstrap.entrypointIntegrity.cashSemanticsAligned, true);
  assert.equal(bootstrap.entrypointIntegrity.positionFactsAligned, true);
  assert.equal(
    bootstrap.canonicalEntrypoints.agent_runtime_context,
    result.runtimeContextPath
  );
  assert.equal(
    bootstrap.canonicalEntrypoints.strategy_decision_contract,
    result.strategyDecisionContractPath
  );
});
