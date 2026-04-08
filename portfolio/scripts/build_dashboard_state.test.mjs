import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  buildDashboardStateFromPayload,
  runDashboardStateBuild
} from "./build_dashboard_state.mjs";

test("buildDashboardStateFromPayload separates accounting, observation, and presentation layers", () => {
  const payload = {
    generatedAt: "2026-04-07T08:00:00.000Z",
    accountId: "main",
    portfolioRoot: "/tmp/portfolio",
    snapshotDate: "2026-04-07",
    readiness: {
      state: "ready"
    },
    accountingState: "snapshot_fresh_for_accounting",
    summary: {
      totalPortfolioAssets: 445000,
      totalFundAssets: 285000,
      settledCashCny: 160000,
      tradeAvailableCashCny: 120000,
      cashLikeFundAssetsCny: 85000,
      liquiditySleeveAssetsCny: 85000,
      accountingDailyPnl: 1200,
      observationDailyPnl: 1300,
      displayDailyPnl: 1200
    },
    configuration: {
      activeProfile: "B_offensive_growth_v1"
    },
    bucketGroups: [
      {
        bucketKey: "A_CORE"
      }
    ],
    rows: [
      {
        name: "易方达沪深300ETF联接C",
        amount: 21000
      }
    ],
    pendingRows: [],
    maturedPendingRows: []
  };

  const state = buildDashboardStateFromPayload(payload);

  assert.equal(state.accounting.settledCashCny, 160000);
  assert.equal(state.accounting.tradeAvailableCashCny, 120000);
  assert.equal(state.accounting.cashLikeFundAssetsCny, 85000);
  assert.equal(state.observation.dailyPnlCny, 1300);
  assert.equal(state.presentation.summary.totalPortfolioAssets, 445000);
  assert.equal(state.summary.totalPortfolioAssets, 445000);
  assert.equal(state.rows.length, 1);
});

test("runDashboardStateBuild writes dashboard_state.json and updates manifest pointers", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );

  const result = await runDashboardStateBuild(
    {
      portfolioRoot,
      user: "main",
      refreshMs: 15000
    },
    {
      buildPayload: async () => ({
        generatedAt: "2026-04-07T08:00:00.000Z",
        accountId: "main",
        portfolioRoot,
        snapshotDate: "2026-04-07",
        readiness: { state: "ready" },
        accountingState: "snapshot_fresh_for_accounting",
        summary: {
          totalPortfolioAssets: 445000,
          settledCashCny: 160000,
          tradeAvailableCashCny: 120000,
          cashLikeFundAssetsCny: 85000,
          liquiditySleeveAssetsCny: 85000,
          accountingDailyPnl: 1000,
          observationDailyPnl: 1100,
          displayDailyPnl: 1000
        },
        configuration: {},
        bucketGroups: [],
        rows: [],
        pendingRows: [],
        maturedPendingRows: []
      })
    }
  );

  const persisted = JSON.parse(await readFile(path.join(portfolioRoot, "data", "dashboard_state.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));

  assert.equal(result.outputPath, path.join(portfolioRoot, "data", "dashboard_state.json"));
  assert.equal(persisted.accounting.settledCashCny, 160000);
  assert.equal(
    manifest.canonical_entrypoints.dashboard_state,
    path.join(portfolioRoot, "data", "dashboard_state.json")
  );
  assert.equal(
    manifest.canonical_entrypoints.dashboard_state_builder,
    path.join(portfolioRoot, "scripts", "build_dashboard_state.mjs")
  );
});
