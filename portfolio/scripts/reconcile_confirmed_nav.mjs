import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { getFundQuotes } from "../../market-mcp/src/providers/fund.js";
import { resolveAccountId, resolvePortfolioRoot, buildPortfolioPath } from "./lib/account_root.mjs";
import { buildDualLedgerPaths, materializePortfolioRoot } from "./lib/portfolio_state_materializer.mjs";
import { reconcileRawSnapshotWithConfirmedQuotes } from "./lib/confirmed_nav_reconciler.mjs";
import { writeNightlyConfirmedNavStatus } from "./lib/nightly_confirmed_nav_status.mjs";
import { runRefreshAccountSidecars } from "./refresh_account_sidecars.mjs";

function parseArgs(argv) {
  const result = {
    user: "",
    portfolioRoot: "",
    date: ""
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

  return result;
}

function normalizeCode(value) {
  return String(value ?? "").trim();
}

export function collectEnabledFundCodes({ rawSnapshot = null, watchlist = null } = {}) {
  const watchlistItems = Array.isArray(watchlist?.watchlist) ? watchlist.watchlist : [];
  const activeOtcPositions = Array.isArray(rawSnapshot?.positions)
    ? rawSnapshot.positions.filter((position) => {
        const executionType = String(position?.execution_type ?? "OTC").toUpperCase();
        const status = String(position?.status ?? "active").trim();
        return executionType !== "EXCHANGE" && status === "active";
      })
    : [];

  return [
    ...new Set(
      [
        ...watchlistItems.map((item) => normalizeCode(item?.code)),
        ...activeOtcPositions.map((position) =>
          normalizeCode(position?.code ?? position?.symbol ?? position?.fund_code)
        )
      ].filter(Boolean)
    )
  ].sort((left, right) => left.localeCompare(right));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runConfirmedNavReconcile(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const paths = buildDualLedgerPaths(portfolioRoot);
  const watchlistPath = buildPortfolioPath(portfolioRoot, "fund-watchlist.json");
  const assetMasterPath = buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
  const readJsonFile = deps.readJson ?? readJson;
  const fetchFundQuotes = deps.getFundQuotes ?? getFundQuotes;
  const reconcileSnapshot =
    deps.reconcileRawSnapshotWithConfirmedQuotes ?? reconcileRawSnapshotWithConfirmedQuotes;
  const materializeRoot = deps.materializePortfolioRoot ?? materializePortfolioRoot;
  const refreshSidecars = deps.runRefreshAccountSidecars ?? runRefreshAccountSidecars;
  const writeConfirmedStatus =
    deps.writeNightlyConfirmedNavStatus ?? writeNightlyConfirmedNavStatus;
  const [rawSnapshot, watchlist, assetMaster] = await Promise.all([
    readJsonFile(paths.latestRawPath),
    readJsonFile(watchlistPath),
    readJsonFile(assetMasterPath).catch(() => null)
  ]);
  const enabledCodes = collectEnabledFundCodes({ rawSnapshot, watchlist });
  const quotes = await fetchFundQuotes(enabledCodes);
  const result = reconcileSnapshot({
    rawSnapshot,
    quotes,
    asOfDate: String(rawOptions.date ?? "").trim() || rawSnapshot?.snapshot_date || "",
    watchlistConfig: watchlist,
    assetMaster
  });

  await writeFile(paths.latestRawPath, `${JSON.stringify(result.rawSnapshot, null, 2)}\n`, "utf8");
  if (result.watchlistConfig) {
    await writeFile(watchlistPath, `${JSON.stringify(result.watchlistConfig, null, 2)}\n`, "utf8");
  }
  await materializeRoot({
    portfolioRoot,
    accountId,
    referenceDate: result.rawSnapshot.snapshot_date,
    seedMissing: true
  });
  const lateMissingFundCount = Number(result.stats?.lateMissingFundCount ?? 0);
  const sourceMissingFundCount = Number(result.stats?.sourceMissingFundCount ?? 0);
  const hardFailureCount = lateMissingFundCount + sourceMissingFundCount;
  await writeConfirmedStatus(
    {
      generatedAt: new Date().toISOString(),
      runType: "reconcile_confirmed_nav",
      targetDate: result.rawSnapshot.snapshot_date,
      accounts: [
        {
          accountId,
          portfolioRoot,
          success: hardFailureCount === 0,
          snapshotDate: result.rawSnapshot.snapshot_date,
          stats: result.stats ?? null,
          updatedWatchlist: Boolean(result.watchlistConfig),
          runType: "reconcile_confirmed_nav",
          finishedAt: new Date().toISOString(),
          error:
            hardFailureCount === 0
              ? null
              : `stale_confirmed_quotes_pending:${(result.stats?.stalePositions ?? [])
                  .map((item) => item?.code)
                  .filter(Boolean)
                  .join(",")}`
        }
      ],
      successCount: hardFailureCount === 0 ? 1 : 0,
      failureCount: hardFailureCount === 0 ? 0 : 1
    },
    { portfolioRoot }
  );
  const refreshResult = await refreshSidecars({
    portfolioRoot,
    user: accountId,
    date: result.rawSnapshot.snapshot_date,
    scopes: "live_funds_snapshot"
  });

  return {
    accountId,
    portfolioRoot,
    snapshotDate: result.rawSnapshot.snapshot_date,
    stats: result.stats,
    updatedWatchlist: Boolean(result.watchlistConfig),
    refreshResult
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  const payload = await runConfirmedNavReconcile(options);
  console.log(JSON.stringify(payload, null, 2));
}
