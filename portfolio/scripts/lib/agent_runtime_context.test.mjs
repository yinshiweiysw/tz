import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAgentRuntimeContextPayload } from "./agent_runtime_context.mjs";
import { runAgentRuntimeContextBuild } from "../build_agent_runtime_context.mjs";

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
      gold_factor_model: { goldRegime: "liquidity_repricing" },
      coverage_guard: { overall_status: "ok" }
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
  assert.equal(payload.marketContext.newsCoverageReadiness, "ok");
  assert.equal(payload.systemState.confirmedNavState, "partially_confirmed_normal_lag");
});

test("buildAgentRuntimeContextPayload exposes canonical and observable fund fields separately", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      snapshot_date: "2026-04-08",
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          confirmed_units: 10000,
          holding_cost_basis_cny: 21000,
          bucket: "A_CORE",
          category: "A股宽基"
        }
      ]
    },
    dashboardState: {
      rows: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          amount: 21680.19,
          holdingPnl: 680.19,
          quoteMode: "intraday_valuation",
          quoteDate: "2026-04-08"
        }
      ]
    }
  });

  assert.equal(payload.positions[0].units, 10000);
  assert.equal(payload.positions[0].costBasis, 21000);
  assert.equal(payload.positions[0].observableAmount, 21680.19);
  assert.equal(payload.positions[0].observableHoldingPnl, 680.19);
  assert.equal(payload.positions[0].quoteMode, "intraday_valuation");
});

test("buildAgentRuntimeContextPayload keeps units null when canonical units are unavailable", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      positions: [
        {
          name: "未知份额基金",
          code: "000001",
          holding_cost_basis_cny: 3000
        }
      ]
    },
    dashboardState: {
      rows: [
        {
          code: "000001",
          amount: 3030.99,
          holdingPnl: 30.99,
          quoteMode: "intraday_valuation"
        }
      ]
    }
  });

  assert.equal(payload.positions[0].units, null);
  assert.equal(payload.positions[0].observableAmount, 3030.99);
});

test("buildAgentRuntimeContextPayload derives canonical amount from units and confirmed nav when stored amount is stale", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          confirmed_units: 11891.28539071,
          last_confirmed_nav: 1.766,
          amount: 99999,
          holding_cost_basis_cny: 21000,
          holding_pnl: 88888,
          bucket: "A_CORE",
          category: "A股宽基"
        }
      ]
    },
    dashboardState: {
      rows: [
        {
          code: "007339",
          amount: 21579.12,
          holdingPnl: 579.12,
          quoteMode: "intraday_valuation",
          quoteDate: "2026-04-08"
        }
      ]
    }
  });

  assert.equal(payload.positions[0].canonicalAmount, 21000.01);
  assert.equal(payload.positions[0].canonicalHoldingPnl, 0.01);
  assert.equal(payload.positions[0].holdingPnl, 0.01);
  assert.equal(payload.positions[0].observableAmount, 21579.12);
});

test("buildAgentRuntimeContextPayload normalizes dashboard bucket groups into runtime bucket view", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      summary: {
        total_portfolio_assets_cny: 445000,
        total_fund_assets: 285000,
        settled_cash_cny: 160000,
        trade_available_cash_cny: 120000
      },
      positions: []
    },
    dashboardState: {
      bucketGroups: [
        {
          bucketKey: "A_CORE",
          label: "A股核心",
          currentAmount: 41152.21,
          currentPct: 9.53,
          targetPct: 22,
          gapAmountCny: 53827
        }
      ]
    }
  });

  assert.equal(payload.bucketView[0].bucketKey, "A_CORE");
  assert.equal(payload.bucketView[0].amount, 41152.21);
  assert.equal(payload.bucketView[0].weightPct, 9.53);
  assert.equal(payload.bucketView[0].gapAmountCny, 53827);
});

test("buildAgentRuntimeContextPayload falls back to bucketGroups when presentation bucketSummary is empty", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      summary: {
        total_portfolio_assets_cny: 431720.08
      },
      positions: []
    },
    dashboardState: {
      presentation: {
        bucketSummary: []
      },
      bucketGroups: [
        {
          bucketKey: "HEDGE",
          bucketLabel: "黄金",
          currentAmount: 54365.49,
          currentPct: 13.98,
          targetPct: 12
        }
      ]
    }
  });

  assert.equal(payload.bucketView[0].bucketKey, "HEDGE");
  assert.equal(payload.bucketView[0].amount, 54365.49);
  assert.equal(payload.bucketView[0].weightPct, 13.98);
  assert.equal(payload.bucketView[0].targetPct, 12);
  assert.equal(payload.bucketView[0].gapAmountCny, -8548.06);
});

test("buildAgentRuntimeContextPayload prefers row confirmation state over stale stored position confirmation state", () => {
  const payload = buildAgentRuntimeContextPayload({
    accountId: "main",
    portfolioState: {
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          confirmation_state: "confirmed",
          bucket: "A_CORE"
        }
      ]
    },
    dashboardState: {
      rows: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          confirmationState: "normal_lag"
        }
      ]
    }
  });

  assert.equal(payload.positions[0].confirmationState, "normal_lag");
});

test("runAgentRuntimeContextBuild writes runtime context and paints manifest entries", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-"));
  const stateDir = path.join(tmpRoot, "state");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(stateDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const portfolioState = {
    snapshot_date: "2026-04-08",
    summary: {
      total_portfolio_assets_cny: 1000,
      total_fund_assets: 600,
      settled_cash_cny: 400,
      trade_available_cash_cny: 350,
      cash_like_fund_assets_cny: 100,
      liquidity_sleeve_assets_cny: 100,
      unrealized_holding_profit_cny: 10
    },
    positions: [
      {
        name: "测试基金",
        code: "000001",
        amount: 400,
        holding_cost_basis_cny: 380,
        holding_pnl: 20,
        holding_pnl_rate_pct: 5,
        bucket: "A_CORE",
        category: "A股宽基"
      }
    ]
  };

  await writeFile(path.join(stateDir, "portfolio_state.json"), JSON.stringify(portfolioState, null, 2), "utf8");
  await writeFile(path.join(tmpRoot, "state-manifest.json"), JSON.stringify({ canonical_entrypoints: {} }, null, 2), "utf8");
  await writeFile(
    path.join(dataDir, "dashboard_state.json"),
    JSON.stringify({ presentation: { summary: { displayDailyPnl: 100 }, bucketSummary: [] }, rows: [] }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "research_brain.json"),
    JSON.stringify({ top_headlines: [{ source: "测试", title: "头条" }] }, null, 2),
    "utf8"
  );

  const { outputPath, payload } = await runAgentRuntimeContextBuild(
    { portfolioRoot: tmpRoot },
    {
      buildHealth: async () => ({ state: "ready", confirmedNavState: "confirmed" })
    }
  );

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.portfolio.settledCashCny, 400);
  assert.equal(written.marketContext.topHeadlines[0].source, "测试");
  assert.equal(payload.portfolio.settledCashCny, 400);

  const manifest = JSON.parse(await readFile(path.join(tmpRoot, "state-manifest.json"), "utf8"));
  assert.equal(manifest.canonical_entrypoints.agent_runtime_context, outputPath);
  assert.equal(
    manifest.canonical_entrypoints.agent_runtime_context_builder,
    path.join(tmpRoot, "scripts", "build_agent_runtime_context.mjs")
  );
});
