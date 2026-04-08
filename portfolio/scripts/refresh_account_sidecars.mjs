import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  defaultPortfolioRoot,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { readJsonOrDefault } from "./lib/atomic_json_state.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import {
  readNightlyConfirmedNavStatus,
  writeNightlyConfirmedNavStatus
} from "./lib/nightly_confirmed_nav_status.mjs";
import {
  buildReportSessionRecord,
  readReportSessionMemory,
  updateReportSessionMemory,
  writeReportSessionMemory
} from "./lib/report_session_memory.mjs";
import { buildAnalyticsPaths } from "./lib/report_context.mjs";
import { loadCanonicalPortfolioState } from "./lib/portfolio_state_view.mjs";
import { runReportQualityScorecardBuild } from "./generate_report_quality_scorecard.mjs";
import { runResearchBrainBuild } from "./generate_research_brain.mjs";
import { runRiskDashboardBuild } from "./generate_risk_dashboard.mjs";
import { runLiveFundsSnapshotBuild } from "./serve_funds_live_dashboard.mjs";
import { runDashboardStateBuild } from "./build_dashboard_state.mjs";
import { runAgentEntrypointRefresh } from "./refresh_agent_entrypoints.mjs";

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

function normalizeScopes(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (requested.length === 0) {
    return [
      "risk_dashboard",
      "live_funds_snapshot",
      "dashboard_state",
      "nightly_confirmed_nav_status",
      "research_brain",
      "agent_entrypoints",
      "report_session_memory",
      "report_quality_scorecard",
      "analysis_hit_rate"
    ];
  }

  const aliasMap = new Map([
    ["risk", "risk_dashboard"],
    ["risk_dashboard", "risk_dashboard"],
    ["live", "live_funds_snapshot"],
    ["live_funds_snapshot", "live_funds_snapshot"],
    ["dashboard", "dashboard_state"],
    ["dashboard_state", "dashboard_state"],
    ["nightly", "nightly_confirmed_nav_status"],
    ["nightly_confirmed_nav_status", "nightly_confirmed_nav_status"],
    ["research", "research_brain"],
    ["research_brain", "research_brain"],
    ["agent", "agent_entrypoints"],
    ["agent_entrypoints", "agent_entrypoints"],
    ["session_memory", "report_session_memory"],
    ["report_session_memory", "report_session_memory"],
    ["scorecard", "report_quality_scorecard"],
    ["report_quality_scorecard", "report_quality_scorecard"],
    ["analysis_hit_rate", "analysis_hit_rate"]
  ]);

  return [...new Set(requested.map((item) => aliasMap.get(item) ?? item))];
}

function hasScope(scopes, scope) {
  return scopes.includes(scope);
}

function deriveNightlyConfirmedNavAccountSnapshot({
  accountId,
  portfolioRoot,
  targetDate,
  portfolioState = {},
  livePayload = {}
} = {}) {
  const summary = portfolioState?.summary ?? {};
  const liveSummary = livePayload?.summary ?? {};
  const confirmedNavState = String(livePayload?.confirmedNavStatus?.state ?? "").trim();
  const lateMissingFundCount = Number(liveSummary?.lateMissingFundCount ?? 0);
  const sourceMissingFundCount = Number(liveSummary?.sourceMissingFundCount ?? 0);

  return {
    accountId,
    portfolioRoot,
    success: lateMissingFundCount + sourceMissingFundCount === 0,
    snapshotDate:
      String(targetDate ?? "").trim() ||
      String(portfolioState?.snapshot_date ?? livePayload?.snapshotDate ?? "").trim() ||
      null,
    stats: {
      updatedPositions: Array.isArray(portfolioState?.positions)
        ? portfolioState.positions.filter((item) => item?.status === "active").length
        : 0,
      migratedPositions: 0,
      totalFundAssets: Number(summary?.total_fund_assets ?? liveSummary?.totalFundAssets ?? 0),
      totalDailyPnl: Number(summary?.yesterday_profit ?? liveSummary?.estimatedDailyPnl ?? 0),
      totalHoldingPnl: Number(summary?.holding_profit ?? liveSummary?.holdingProfit ?? 0),
      fullyConfirmedForDate: confirmedNavState === "confirmed_nav_ready",
      stalePositions: [],
      totalFundCount: Array.isArray(portfolioState?.positions)
        ? portfolioState.positions.filter((item) => item?.status === "active").length
        : 0,
      confirmedFundCount: Number(liveSummary?.confirmedFundCount ?? 0),
      normalLagFundCount: Number(liveSummary?.normalLagFundCount ?? 0),
      holidayDelayFundCount: Number(liveSummary?.holidayDelayFundCount ?? 0),
      lateMissingFundCount,
      sourceMissingFundCount,
      confirmationCoveragePct: Number(liveSummary?.confirmationCoveragePct ?? 0)
    },
    updatedWatchlist: false,
    runType: "sidecar_refresh",
    finishedAt: new Date().toISOString(),
    error: null
  };
}

function mergeNightlyConfirmedNavAccountRun(statusPayload = {}, accountRun = {}) {
  const existingAccounts = Array.isArray(statusPayload?.accounts) ? statusPayload.accounts : [];
  const remainingAccounts = existingAccounts.filter(
    (item) => String(item?.accountId ?? "").trim() !== String(accountRun?.accountId ?? "").trim()
  );
  const accounts = [...remainingAccounts, accountRun].sort((left, right) =>
    String(left?.accountId ?? "").localeCompare(String(right?.accountId ?? ""))
  );

  return {
    generatedAt: new Date().toISOString(),
    runType: "sidecar_refresh",
    targetDate: accountRun?.snapshotDate ?? statusPayload?.targetDate ?? null,
    accounts,
    successCount: accounts.filter((item) => item?.success === true).length,
    failureCount: accounts.filter((item) => item?.success !== true).length
  };
}

async function upsertNightlyConfirmedNavStatusDefault({
  accountId,
  portfolioRoot,
  targetDate,
  portfolioState,
  livePayload
} = {}) {
  const statusPayload =
    (await readNightlyConfirmedNavStatus({ portfolioRoot: defaultPortfolioRoot })) ?? {};
  const accountRun = deriveNightlyConfirmedNavAccountSnapshot({
    accountId,
    portfolioRoot,
    targetDate,
    portfolioState,
    livePayload
  });
  const nextPayload = mergeNightlyConfirmedNavAccountRun(statusPayload, accountRun);
  const statusPath = await writeNightlyConfirmedNavStatus(nextPayload, {
    portfolioRoot: defaultPortfolioRoot
  });

  return {
    statusPath,
    payload: nextPayload,
    accountRun
  };
}

async function upsertReportSessionMemoryFromResearchBrain({
  reportSessionMemoryPath,
  tradeDate,
  researchBrain
} = {}) {
  const currentMemory = await readReportSessionMemory(reportSessionMemoryPath);
  const currentRecord = buildReportSessionRecord({
    tradeDate,
    session: null,
    reportType: "sidecar_refresh",
    researchBrain
  });
  const updatedMemory = updateReportSessionMemory(currentMemory, currentRecord);
  await writeReportSessionMemory(reportSessionMemoryPath, updatedMemory);
  return {
    currentRecord,
    updatedMemory
  };
}

export async function runRefreshAccountSidecars(rawOptions = {}, deps = {}) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const portfolioRoot = resolvePortfolioRoot(options);
  const accountId = resolveAccountId(options);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = (await readJsonOrDefault(manifestPath, null)) ?? {};
  const sharedManifest =
    portfolioRoot === defaultPortfolioRoot
      ? manifest
      : await readJsonOrDefault(buildPortfolioPath(defaultPortfolioRoot, "state-manifest.json"), null);
  const paths = buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest);
  const scopes = normalizeScopes(options.scopes);
  const requestedDate = String(options.date ?? "").trim() || null;
  const latestView = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
  const portfolioState = latestView.payload ?? {};
  const tradeDate =
    requestedDate ||
    String(portfolioState?.snapshot_date ?? "").trim() ||
    String(options.asOf ?? "").trim() ||
    null;

  if (!tradeDate) {
    throw new Error(`Unable to resolve trade date for sidecar refresh: ${portfolioRoot}`);
  }

  const runRiskDashboard = deps.runRiskDashboardBuild ?? runRiskDashboardBuild;
  const runLiveSnapshot = deps.runLiveFundsSnapshotBuild ?? runLiveFundsSnapshotBuild;
  const runDashboardState = deps.runDashboardStateBuild ?? runDashboardStateBuild;
  const runResearchBrain = deps.runResearchBrainBuild ?? runResearchBrainBuild;
  const runAgentEntrypoints = deps.runAgentEntrypointRefresh ?? runAgentEntrypointRefresh;
  const runReportQualityScorecard = deps.runReportQualityScorecardBuild ?? runReportQualityScorecardBuild;
  const upsertNightlyConfirmedNavStatus =
    deps.upsertNightlyConfirmedNavStatus ?? upsertNightlyConfirmedNavStatusDefault;

  const outputs = {};
  const manifestEntries = {
    sidecar_refresh_script: buildPortfolioPath(portfolioRoot, "scripts", "refresh_account_sidecars.mjs")
  };

  let liveResult = null;
  let researchBrainResult = null;

  if (hasScope(scopes, "risk_dashboard")) {
    const result = await runRiskDashboard({
      portfolioRoot,
      user: accountId,
      date: tradeDate
    });
    outputs.riskDashboardPath = result?.outputPath ?? paths.riskDashboardPath;
    manifestEntries.risk_dashboard = outputs.riskDashboardPath;
  }

  if (
    hasScope(scopes, "live_funds_snapshot") ||
    hasScope(scopes, "dashboard_state") ||
    hasScope(scopes, "nightly_confirmed_nav_status")
  ) {
    liveResult = await runLiveSnapshot({
      portfolioRoot,
      user: accountId,
      date: tradeDate
    });
    outputs.liveFundsSnapshotPath = liveResult?.outputPath ?? buildPortfolioPath(portfolioRoot, "data/live_funds_snapshot.json");
    manifestEntries.latest_live_funds_snapshot = outputs.liveFundsSnapshotPath;
  }

  if (
    hasScope(scopes, "live_funds_snapshot") ||
    hasScope(scopes, "dashboard_state") ||
    hasScope(scopes, "nightly_confirmed_nav_status")
  ) {
    const dashboardStateResult = await runDashboardState({
      portfolioRoot,
      user: accountId,
      date: tradeDate
    });
    outputs.dashboardStatePath =
      dashboardStateResult?.outputPath ?? buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json");
    manifestEntries.dashboard_state = outputs.dashboardStatePath;
    manifestEntries.dashboard_state_builder = buildPortfolioPath(
      portfolioRoot,
      "scripts",
      "build_dashboard_state.mjs"
    );
  }

  if (hasScope(scopes, "nightly_confirmed_nav_status")) {
    const statusResult = await upsertNightlyConfirmedNavStatus({
      accountId,
      portfolioRoot,
      targetDate: tradeDate,
      portfolioState,
      livePayload: liveResult?.payload ?? {}
    });
    outputs.nightlyConfirmedNavStatusPath = statusResult?.statusPath ?? null;
    if (outputs.nightlyConfirmedNavStatusPath) {
      manifestEntries.latest_nightly_confirmed_nav_status = outputs.nightlyConfirmedNavStatusPath;
    }
  }

  if (
    hasScope(scopes, "research_brain") ||
    hasScope(scopes, "report_session_memory") ||
    hasScope(scopes, "report_quality_scorecard") ||
    hasScope(scopes, "analysis_hit_rate")
  ) {
    researchBrainResult = await runResearchBrain({
      portfolioRoot,
      user: accountId,
      date: tradeDate
    });
    outputs.researchBrainPath = researchBrainResult?.outputPath ?? paths.researchBrainPath;
    manifestEntries.latest_research_brain = outputs.researchBrainPath;
  }

  if (
    researchBrainResult &&
    hasScope(scopes, "agent_entrypoints")
  ) {
    const agentEntrypointsResult = await runAgentEntrypoints({
      portfolioRoot,
      user: accountId,
      date: tradeDate
    });
    outputs.agentRuntimeContextPath = agentEntrypointsResult?.runtimeContextPath ?? null;
    outputs.strategyDecisionContractPath =
      agentEntrypointsResult?.strategyDecisionContractPath ?? null;
    outputs.agentBootstrapContextPath =
      agentEntrypointsResult?.bootstrapAgentContextPath ?? null;
    if (outputs.agentRuntimeContextPath) {
      manifestEntries.agent_runtime_context = outputs.agentRuntimeContextPath;
      manifestEntries.agent_runtime_context_builder = buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "build_agent_runtime_context.mjs"
      );
    }
    if (outputs.strategyDecisionContractPath) {
      manifestEntries.strategy_decision_contract = outputs.strategyDecisionContractPath;
      manifestEntries.strategy_decision_contract_builder = buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "build_strategy_decision_contract.mjs"
      );
    }
    if (outputs.agentBootstrapContextPath) {
      manifestEntries.latest_agent_bootstrap_context = outputs.agentBootstrapContextPath;
      manifestEntries.agent_bootstrap_context_script = buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "bootstrap_agent_context.mjs"
      );
    }
  }

  if (
    researchBrainResult &&
    (hasScope(scopes, "report_session_memory") ||
      hasScope(scopes, "report_quality_scorecard") ||
      hasScope(scopes, "analysis_hit_rate"))
  ) {
    await upsertReportSessionMemoryFromResearchBrain({
      reportSessionMemoryPath: paths.reportSessionMemoryPath,
      tradeDate,
      researchBrain: researchBrainResult.output ?? {}
    });
    outputs.reportSessionMemoryPath = paths.reportSessionMemoryPath;
    manifestEntries.latest_report_session_memory = outputs.reportSessionMemoryPath;
  }

  if (hasScope(scopes, "report_quality_scorecard") || hasScope(scopes, "analysis_hit_rate")) {
    const scorecardResult = await runReportQualityScorecard({
      portfolioRoot,
      user: accountId,
      date: tradeDate
    });
    outputs.reportQualityScorecardPath =
      scorecardResult?.reportQualityScorecardPath ?? paths.reportQualityScorecardPath;
    outputs.analysisHitRatePath =
      scorecardResult?.analysisHitRatePath ?? paths.analysisHitRatePath;
    manifestEntries.latest_report_quality_scorecard = outputs.reportQualityScorecardPath;
    manifestEntries.latest_analysis_hit_rate = outputs.analysisHitRatePath;
  }

  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: manifestEntries
  });

  return {
    accountId,
    portfolioRoot,
    tradeDate,
    scopes,
    outputs
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runRefreshAccountSidecars(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
