import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  defaultPortfolioRoot,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { buildAnalysisHitRateSummary, buildReportQualityScorecard } from "./lib/report_quality_scorecard.mjs";
import { buildAnalyticsPaths } from "./lib/report_context.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./lib/atomic_json_state.mjs";

function parseArgs(argv) {
  const result = {};

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

function resolveDate(dateArg) {
  if (dateArg) {
    return String(dateArg);
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function readJsonOrNull(filePath) {
  return readJsonOrDefault(filePath, null);
}

export async function runReportQualityScorecardBuild(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = (await readJsonOrNull(manifestPath)) ?? {};
  const sharedManifestPath = buildPortfolioPath(defaultPortfolioRoot, "state-manifest.json");
  const sharedManifest =
    portfolioRoot === defaultPortfolioRoot ? manifest : await readJsonOrNull(sharedManifestPath);
  const paths = buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest);
  const sessionMemory = (await readJsonOrNull(paths.reportSessionMemoryPath)) ?? {};
  const asOfDate = resolveDate(rawOptions.date);
  const windowSize = Math.max(1, Number(rawOptions.window ?? rawOptions.windowSize) || 20);

  const scorecard = buildReportQualityScorecard(sessionMemory, {
    asOfDate,
    windowSize
  });
  const hitRateSummary = buildAnalysisHitRateSummary(scorecard);

  await writeJsonAtomic(paths.reportQualityScorecardPath, {
    account_id: accountId,
    portfolio_root: portfolioRoot,
    ...scorecard
  });
  await writeJsonAtomic(paths.analysisHitRatePath, {
    account_id: accountId,
    portfolio_root: portfolioRoot,
    generated_at: new Date().toISOString(),
    ...hitRateSummary
  });

  return {
    accountId,
    portfolioRoot,
    reportQualityScorecardPath: paths.reportQualityScorecardPath,
    analysisHitRatePath: paths.analysisHitRatePath,
    scorecard,
    hitRateSummary
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runReportQualityScorecardBuild(parseArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify(
      {
        accountId: result.accountId,
        reportQualityScorecardPath: result.reportQualityScorecardPath,
        analysisHitRatePath: result.analysisHitRatePath,
        recordCount: result.scorecard.record_count,
        nextDayBiasHitRate: result.hitRateSummary.next_day_bias.hit_rate_pct
      },
      null,
      2
    )
  );
}
