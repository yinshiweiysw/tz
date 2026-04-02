import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { ensureReportContext } from "./lib/report_context.mjs";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[token.slice(2)] = "";
      continue;
    }

    result[token.slice(2)] = next;
    index += 1;
  }

  return result;
}

const options = parseArgs(args);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);

const reportContext = await ensureReportContext({
  portfolioRoot,
  options: {
    ...options,
    refresh: options.refresh ?? "auto"
  },
  includePerformanceAttribution: true
});

const { freshness, refresh, paths } = reportContext;

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      mode: refresh.mode,
      triggered: refresh.triggered,
      refreshedTargets: refresh.refreshedTargets,
      skippedTargets: refresh.skippedTargets,
      errorCount: refresh.errors.length,
      staleKeys: freshness.staleKeys,
      missingKeys: freshness.missingKeys,
      degradedKeys: freshness.degradedKeys,
      hasBlockingQualityIssues: freshness.hasBlockingQualityIssues,
      riskDashboardPath: paths.riskDashboardPath,
      tradePlanJsonPath: paths.tradePlanJsonPath
    },
    null,
    2
  )
);
