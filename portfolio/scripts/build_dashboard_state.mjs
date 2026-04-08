import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { buildLivePayload } from "./serve_funds_live_dashboard.mjs";

function parseArgs(argv) {
  const result = {
    refreshMs: 30000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  result.refreshMs = Math.max(5000, Number(result.refreshMs) || 30000);
  return result;
}

export function buildDashboardStateFromPayload(payload = {}) {
  const summary = payload?.summary ?? {};
  const presentation = {
    summary,
    configuration: payload?.configuration ?? {},
    bucketGroups: Array.isArray(payload?.bucketGroups) ? payload.bucketGroups : [],
    rows: Array.isArray(payload?.rows) ? payload.rows : [],
    pendingRows: Array.isArray(payload?.pendingRows) ? payload.pendingRows : [],
    maturedPendingRows: Array.isArray(payload?.maturedPendingRows) ? payload.maturedPendingRows : []
  };

  return {
    generatedAt: payload?.generatedAt ?? new Date().toISOString(),
    accountId: payload?.accountId ?? null,
    portfolioRoot: payload?.portfolioRoot ?? null,
    snapshotDate: payload?.snapshotDate ?? null,
    readiness: payload?.readiness ?? null,
    accountingState: payload?.accountingState ?? null,
    accounting: {
      totalPortfolioAssets: summary?.totalPortfolioAssets ?? null,
      totalFundAssets: summary?.totalFundAssets ?? null,
      settledCashCny: summary?.settledCashCny ?? summary?.availableCashCny ?? null,
      tradeAvailableCashCny:
        summary?.tradeAvailableCashCny ?? summary?.settledCashCny ?? summary?.availableCashCny ?? null,
      cashLikeFundAssetsCny: summary?.cashLikeFundAssetsCny ?? null,
      liquiditySleeveAssetsCny: summary?.liquiditySleeveAssetsCny ?? null,
      holdingProfit: summary?.holdingProfit ?? null,
      dailyPnlCny: summary?.accountingDailyPnl ?? summary?.estimatedDailyPnl ?? null
    },
    observation: {
      dailyPnlCny: summary?.observationDailyPnl ?? null,
      displayDailyPnlCny: summary?.displayDailyPnl ?? null,
      displayDailyPnlRatePct: summary?.displayDailyPnlRatePct ?? null,
      latestQuoteTime: summary?.latestQuoteTime ?? null,
      currentFundCount: summary?.currentFundCount ?? null,
      freshFundCount: summary?.freshFundCount ?? null,
      estimatedDailyPnlMode: summary?.estimatedDailyPnlMode ?? null
    },
    presentation,
    summary,
    configuration: presentation.configuration,
    bucketGroups: presentation.bucketGroups,
    rows: presentation.rows,
    pendingRows: presentation.pendingRows,
    maturedPendingRows: presentation.maturedPendingRows
  };
}

export async function runDashboardStateBuild(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const refreshMs = Math.max(5000, Number(rawOptions?.refreshMs ?? rawOptions?.["refresh-ms"]) || 30000);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const outputPath = buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json");
  const compatSnapshotPath = buildPortfolioPath(portfolioRoot, "data", "live_funds_snapshot.json");
  const buildPayload = deps.buildPayload ?? buildLivePayload;
  const payload = await buildPayload(refreshMs, accountId);
  const dashboardState = buildDashboardStateFromPayload(payload);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(dashboardState, null, 2)}\n`, "utf8");
  await writeFile(compatSnapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      dashboard_state_builder: buildPortfolioPath(portfolioRoot, "scripts", "build_dashboard_state.mjs"),
      dashboard_state: outputPath,
      latest_live_funds_snapshot: compatSnapshotPath
    }
  });

  return {
    accountId,
    portfolioRoot,
    outputPath,
    compatSnapshotPath,
    payload: dashboardState
  };
}

async function main() {
  const result = await runDashboardStateBuild(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          error: String(error?.message ?? error)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}
