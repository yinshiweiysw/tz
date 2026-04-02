import { readFile, writeFile } from "node:fs/promises";

import { getFundQuotes } from "../../market-mcp/src/providers/fund.js";
import { resolveAccountId, resolvePortfolioRoot, buildPortfolioPath } from "./lib/account_root.mjs";
import { buildDualLedgerPaths, materializePortfolioRoot } from "./lib/portfolio_state_materializer.mjs";
import { reconcileRawSnapshotWithConfirmedQuotes } from "./lib/confirmed_nav_reconciler.mjs";

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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const options = parseArgs(process.argv.slice(2));
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const paths = buildDualLedgerPaths(portfolioRoot);
const watchlistPath = buildPortfolioPath(portfolioRoot, "fund-watchlist.json");
const [rawSnapshot, watchlist] = await Promise.all([readJson(paths.latestRawPath), readJson(watchlistPath)]);
const watchlistItems = Array.isArray(watchlist?.watchlist) ? watchlist.watchlist : [];
const enabledCodes = [...new Set(watchlistItems.map((item) => String(item?.code ?? "").trim()).filter(Boolean))];
const quotes = await getFundQuotes(enabledCodes);
const result = reconcileRawSnapshotWithConfirmedQuotes({
  rawSnapshot,
  quotes,
  asOfDate: String(options.date ?? "").trim() || rawSnapshot?.snapshot_date || "",
  watchlistConfig: watchlist
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

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      snapshotDate: result.rawSnapshot.snapshot_date,
      stats: result.stats,
      updatedWatchlist: Boolean(result.watchlistConfig)
    },
    null,
    2
  )
);
