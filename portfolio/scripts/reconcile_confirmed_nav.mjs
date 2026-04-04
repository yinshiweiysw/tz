import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { getFundQuotes } from "../../market-mcp/src/providers/fund.js";
import { resolveAccountId, resolvePortfolioRoot, buildPortfolioPath } from "./lib/account_root.mjs";
import { buildDualLedgerPaths, materializePortfolioRoot } from "./lib/portfolio_state_materializer.mjs";
import { reconcileRawSnapshotWithConfirmedQuotes } from "./lib/confirmed_nav_reconciler.mjs";
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

export async function runConfirmedNavReconcile(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const paths = buildDualLedgerPaths(portfolioRoot);
  const watchlistPath = buildPortfolioPath(portfolioRoot, "fund-watchlist.json");
  const assetMasterPath = buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
  const [rawSnapshot, watchlist, assetMaster] = await Promise.all([
    readJson(paths.latestRawPath),
    readJson(watchlistPath),
    readJson(assetMasterPath).catch(() => null)
  ]);
  const enabledCodes = collectEnabledFundCodes({ rawSnapshot, watchlist });
  const quotes = await getFundQuotes(enabledCodes);
  const result = reconcileRawSnapshotWithConfirmedQuotes({
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
  await materializePortfolioRoot({
    portfolioRoot,
    accountId,
    referenceDate: result.rawSnapshot.snapshot_date,
    seedMissing: true
  });
  const refreshResult = await runRefreshAccountSidecars({
    portfolioRoot,
    user: accountId,
    date: result.rawSnapshot.snapshot_date
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
