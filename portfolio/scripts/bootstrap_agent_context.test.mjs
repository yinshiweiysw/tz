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
    `${JSON.stringify({ generatedAt: "2026-04-08T06:30:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "strategy_decision_contract.json"),
    `${JSON.stringify({ generatedAt: "2026-04-08T06:31:00.000Z" }, null, 2)}\n`,
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
    "data/agent_runtime_context.json",
    "data/strategy_decision_contract.json",
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
