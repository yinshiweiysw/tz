import { pathToFileURL } from "node:url";

import { runConfirmedNavReconcile } from "./reconcile_confirmed_nav.mjs";
import {
  listDiscoveredPortfolioAccounts,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { writeNightlyConfirmedNavStatus } from "./lib/nightly_confirmed_nav_status.mjs";

function parseArgs(argv) {
  const result = {
    runType: "manual"
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

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function resolveNightlyBatchConfig(rawOptions = {}) {
  return {
    runType: String(
      rawOptions["run-type"] ?? rawOptions.runType ?? rawOptions.runtype ?? "manual"
    ).trim() || "manual",
    targetDate: String(rawOptions.date ?? "").trim() || formatShanghaiDate(new Date())
  };
}

async function resolveTargetAccounts(options = {}) {
  const explicitAccount = String(options.user ?? options.account ?? "").trim();
  if (explicitAccount) {
    return [
      {
        id: resolveAccountId(options),
        portfolioRoot: resolvePortfolioRoot(options)
      }
    ];
  }

  return listDiscoveredPortfolioAccounts({ includeMain: true });
}

export async function runNightlyConfirmedNavBatch(rawOptions = {}) {
  const generatedAt = new Date().toISOString();
  const { runType, targetDate } = resolveNightlyBatchConfig(rawOptions);
  const accounts = await resolveTargetAccounts(rawOptions);
  const accountResults = [];
  let fatalError = null;

  try {
    for (const account of accounts) {
      try {
        const result = await runConfirmedNavReconcile({
          portfolioRoot: account.portfolioRoot,
          user: account.id,
          date: targetDate
        });
        const fullyConfirmedForDate = result.stats?.fullyConfirmedForDate !== false;
        const lateMissingFundCount = Number(result.stats?.lateMissingFundCount ?? 0);
        const sourceMissingFundCount = Number(result.stats?.sourceMissingFundCount ?? 0);
        const hardFailureCount = lateMissingFundCount + sourceMissingFundCount;
        const stalePositions = Array.isArray(result.stats?.stalePositions)
          ? result.stats.stalePositions
          : [];
        accountResults.push({
          accountId: account.id,
          portfolioRoot: account.portfolioRoot,
          success: hardFailureCount === 0,
          snapshotDate: result.snapshotDate ?? targetDate,
          stats: result.stats ?? null,
          updatedWatchlist: Boolean(result.updatedWatchlist),
          runType,
          finishedAt: new Date().toISOString(),
          error: hardFailureCount === 0
            ? null
            : `stale_confirmed_quotes_pending:${stalePositions
                .map((item) => item?.code)
                .filter(Boolean)
                .join(",")}`
        });
      } catch (error) {
        accountResults.push({
          accountId: account.id,
          portfolioRoot: account.portfolioRoot,
          success: false,
          snapshotDate: targetDate,
          stats: null,
          updatedWatchlist: false,
          runType,
          finishedAt: new Date().toISOString(),
          error: String(error?.message ?? error)
        });
      }
    }
  } catch (error) {
    fatalError = String(error?.message ?? error);
  }

  const payload = {
    generatedAt,
    runType,
    targetDate,
    accounts: accountResults,
    successCount: accountResults.filter((item) => item.success).length,
    failureCount: accountResults.filter((item) => !item.success).length,
    ...(fatalError ? { fatalError } : {})
  };
  const statusPath = await writeNightlyConfirmedNavStatus(payload);

  return {
    ...payload,
    statusPath
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runNightlyConfirmedNavBatch(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (result.failureCount > 0 || result.fatalError) {
    process.exitCode = 1;
  }
}
