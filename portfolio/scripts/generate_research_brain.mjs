import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  defaultPortfolioRoot,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import { buildAnalyticsPaths } from "./lib/report_context.mjs";
import { buildResearchCoverageGuard } from "./lib/research_coverage_guard.mjs";
import { deriveResearchDecisionReadiness } from "./lib/research_decision_readiness.mjs";
import {
  buildDriverExpectationMatrix,
  buildMarketFlowMatrix,
  buildResearchDataQualityMatrix,
  deriveResearchSectionConfidence
} from "./lib/research_data_quality.mjs";
import { buildResearchEventDriver } from "./lib/research_event_driver.mjs";
import { buildResearchGoldFactorModel } from "./lib/research_gold_factor_model.mjs";
import { aggregateResearchNews } from "./lib/research_news_aggregator.mjs";
import { buildResearchFreshnessGuard } from "./lib/research_freshness_guard.mjs";
import { buildResearchFlowMacroRadar } from "./lib/research_flow_macro_radar.mjs";
import { getComparableChangePercent } from "./lib/market_schedule_guard.mjs";
import { buildResearchMarketSnapshot } from "./lib/research_market_snapshot.mjs";
import { classifyResearchSession } from "./lib/research_session.mjs";
import { buildResearchSnapshot } from "./lib/research_snapshot_builder.mjs";
import { buildResearchActionableDecision } from "./lib/research_actionable_decision.mjs";

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

function normalizeNow(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (value !== undefined && value !== null) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function resolveExplicitAccountInput(rawOptions = {}) {
  const explicitAccount = rawOptions?.user ?? rawOptions?.account;
  if (typeof explicitAccount === "boolean") {
    throw new Error("Missing required --user <account_id>.");
  }

  return String(explicitAccount ?? "").trim();
}

function collectMarketRows(marketSnapshot) {
  return [
    ...(Array.isArray(marketSnapshot?.a_share_indices) ? marketSnapshot.a_share_indices : []),
    ...(Array.isArray(marketSnapshot?.hong_kong_indices) ? marketSnapshot.hong_kong_indices : []),
    ...(Array.isArray(marketSnapshot?.global_indices) ? marketSnapshot.global_indices : []),
    ...(Array.isArray(marketSnapshot?.commodities) ? marketSnapshot.commodities : []),
    ...(Array.isArray(marketSnapshot?.rates_fx) ? marketSnapshot.rates_fx : [])
  ];
}

function collectDomesticMarketRows(marketSnapshot) {
  return Array.isArray(marketSnapshot?.a_share_indices) ? marketSnapshot.a_share_indices : [];
}

function extractLatestValidTimestamp(values = []) {
  const timestamps = values
    .map((value) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
    })
    .filter((value) => value !== null)
    .sort((left, right) => right - left);

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(timestamps[0]).toISOString();
}

function hasValidTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime());
}

function extractRequiredDomesticTimestamp(rows = []) {
  if (rows.length === 0) {
    return null;
  }

  const hasMissingLiveTimestamp = rows.some(
    (row) => row?.fetch_status === "ok" && !hasValidTimestamp(row?.quote_time)
  );
  if (hasMissingLiveTimestamp) {
    return null;
  }

  return extractLatestValidTimestamp(rows.map((row) => row?.quote_time ?? null));
}

function extractPayloadEffectiveTimestamp(payload) {
  return extractLatestValidTimestamp([
    payload?.generated_at,
    payload?.updatedAt,
    payload?.as_of,
    payload?.snapshot_date
  ]);
}

function buildFreshnessDependencies({ payloads, marketSnapshot, sessionInfo }) {
  const liveSnapshotRequired = sessionInfo?.policy?.requiresLiveDomesticSnapshot === true;
  const marketRows = liveSnapshotRequired
    ? collectDomesticMarketRows(marketSnapshot)
    : collectMarketRows(marketSnapshot);
  const marketEffectiveTimestamp = liveSnapshotRequired
    ? extractRequiredDomesticTimestamp(marketRows)
    : extractLatestValidTimestamp(marketRows.map((row) => row?.quote_time ?? null));

  return [
    {
      key: "portfolio_state",
      label: "Portfolio State",
      required: true,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.latest),
      trade_date: payloads.latest?.snapshot_date ?? null,
      max_lag_hours: 48
    },
    {
      key: "risk_dashboard",
      label: "Risk Dashboard",
      required: true,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.riskDashboard),
      trade_date: payloads.riskDashboard?.as_of ?? null,
      max_lag_hours: 36
    },
    {
      key: "market_snapshot",
      label: "Market Snapshot",
      required: true,
      effective_timestamp: marketEffectiveTimestamp,
      trade_date: sessionInfo?.tradeDate ?? null,
      max_lag_hours: liveSnapshotRequired ? 2 : 20
    },
    {
      key: "macro_state",
      label: "Macro State",
      required: true,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.macroState),
      trade_date: payloads.macroState?.as_of ?? null,
      max_lag_hours: 72
    },
    {
      key: "macro_radar",
      label: "Macro Radar",
      required: true,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.macroRadar),
      trade_date: payloads.macroRadar?.as_of ?? null,
      max_lag_hours: 120
    },
    {
      key: "regime_router_signals",
      label: "Regime Router Signals",
      required: true,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.regimeSignals),
      trade_date: payloads.regimeSignals?.as_of ?? null,
      max_lag_hours: 48
    },
    {
      key: "opportunity_pool",
      label: "Opportunity Pool",
      required: false,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.opportunityPool),
      trade_date: payloads.opportunityPool?.as_of ?? null,
      max_lag_hours: 48
    },
    {
      key: "performance_attribution",
      label: "Performance Attribution",
      required: false,
      effective_timestamp: extractPayloadEffectiveTimestamp(payloads.performanceAttribution),
      trade_date: payloads.performanceAttribution?.as_of ?? payloads.performanceAttribution?.snapshot_date ?? null,
      max_lag_hours: 48
    }
  ];
}

function normalizeMarketSnapshotForCoverage({ marketSnapshot, payloads }) {
  const globalRiskRows = [
    ...(Array.isArray(marketSnapshot?.global_indices) ? marketSnapshot.global_indices : []),
    ...(Array.isArray(marketSnapshot?.commodities) ? marketSnapshot.commodities : []),
    ...(Array.isArray(marketSnapshot?.rates_fx) ? marketSnapshot.rates_fx : [])
  ];
  const hasMacroState = Boolean(payloads?.macroState);

  return {
    a_share: { rows: Array.isArray(marketSnapshot?.a_share_indices) ? marketSnapshot.a_share_indices : [] },
    hong_kong: {
      rows: Array.isArray(marketSnapshot?.hong_kong_indices) ? marketSnapshot.hong_kong_indices : []
    },
    global_risk: { rows: globalRiskRows },
    macro_anchors: {
      rows: [
        {
          fetch_status: hasMacroState ? "ok" : "missing"
        }
      ]
    }
  };
}

function normalizeResearchSnapshotForCoverage(researchSnapshot) {
  return {
    portfolio_state: {
      fetch_status: researchSnapshot?.portfolio_state?.available ? "ok" : "missing"
    },
    risk_state: {
      fetch_status: researchSnapshot?.risk_dashboard?.available ? "ok" : "missing"
    }
  };
}

function buildSessionConstraints(sessionInfo) {
  const policy = sessionInfo?.policy ?? {};

  return [
    { key: "market_session", value: sessionInfo?.session ?? "unknown" },
    { key: "requires_live_domestic_snapshot", value: policy.requiresLiveDomesticSnapshot === true },
    { key: "accept_previous_close_for_domestic", value: policy.acceptPreviousCloseForDomestic === true },
    { key: "domestic_trade_date_must_match", value: policy.domesticTradeDateMustMatch === true },
    { key: "requires_overnight_risk_proxies", value: policy.requiresOvernightRiskProxies === true }
  ];
}

function findSnapshotMove(rows = [], matcher) {
  const row = rows.find((item) => matcher(String(item?.label ?? "")));
  return getComparableChangePercent(row);
}

function deriveHkFlowSnapshot({ marketSnapshot = {}, cnMarketSnapshot = {} } = {}) {
  const hsiMove = findSnapshotMove(marketSnapshot.hong_kong_indices ?? [], (label) => label.includes("恒生指数"));
  const hstechMove = findSnapshotMove(marketSnapshot.hong_kong_indices ?? [], (label) => label.includes("恒生科技"));
  const relativeStrength =
    Number.isFinite(hsiMove) && Number.isFinite(hstechMove)
      ? Number((hstechMove - hsiMove).toFixed(2))
      : null;

  let leadership = "mixed";
  if (Number.isFinite(relativeStrength)) {
    if (relativeStrength >= 0.3) {
      leadership = "hk_tech_leads";
    } else if (relativeStrength <= -0.3) {
      leadership = "broad_hk_leads";
    }
  }

  return {
    southbound_net_buy_100m_hkd:
      cnMarketSnapshot?.sections?.southbound_flow?.latest_summary_net_buy_100m_hkd ?? null,
    hk_tech_relative_strength: relativeStrength,
    hang_seng_leadership: leadership
  };
}

async function loadPayloads(paths) {
  const preferredLatest = await readJsonOrNull(paths.latestPath);
  const latest = preferredLatest ?? (await readJsonOrNull(paths.latestCompatPath));

  const [
    cnMarketSnapshot,
    riskDashboard,
    macroState,
    macroRadar,
    regimeSignals,
    opportunityPool,
    performanceAttribution
  ] = await Promise.all([
    readJsonOrNull(paths.cnMarketSnapshotPath),
    readJsonOrNull(paths.riskDashboardPath),
    readJsonOrNull(paths.macroStatePath),
    readJsonOrNull(paths.macroRadarPath),
    readJsonOrNull(paths.regimeSignalsPath),
    readJsonOrNull(paths.opportunityPoolJsonPath),
    readJsonOrNull(paths.performanceAttributionPath)
  ]);

  return {
    latest,
    cnMarketSnapshot,
    riskDashboard,
    macroState,
    macroRadar,
    regimeSignals,
    opportunityPool,
    performanceAttribution
  };
}

async function writeJsonArtifact(filePath, payload) {
  if (!filePath) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function runResearchBrainBuild(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const now = normalizeNow(rawOptions.now);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = (await readJsonOrNull(manifestPath)) ?? {};
  const explicitAccount = resolveExplicitAccountInput(rawOptions);
  const accountId = explicitAccount || String(manifest?.account_id ?? "").trim() || resolveAccountId(rawOptions);
  const sharedManifestPath = buildPortfolioPath(defaultPortfolioRoot, "state-manifest.json");
  const sharedManifest =
    portfolioRoot === defaultPortfolioRoot ? manifest : await readJsonOrNull(sharedManifestPath);
  const paths = buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest);
  const payloads = await loadPayloads(paths);

  const sessionInfo = classifyResearchSession(now);
  const sessionContext = {
    ...sessionInfo,
    session_constraints: buildSessionConstraints(sessionInfo)
  };
  const researchSnapshot = buildResearchSnapshot({ payloads });
  const marketSnapshot = await buildResearchMarketSnapshot({
    quoteFetcher: rawOptions.quoteFetcher,
    macroStateFallback: payloads.macroState,
    now
  });
  const newsAggregation = await aggregateResearchNews({
    now,
    sourceIds: rawOptions.newsSourceIds,
    sourceLoaders: rawOptions.sourceLoaders
  });
  const freshnessGuard = buildResearchFreshnessGuard({
    now,
    sessionInfo: sessionContext,
    dependencies: buildFreshnessDependencies({
      payloads,
      marketSnapshot,
      sessionInfo: sessionInfo
    })
  });
  const coverageGuard = buildResearchCoverageGuard({
    marketSnapshot: normalizeMarketSnapshotForCoverage({
      marketSnapshot,
      payloads
    }),
    researchSnapshot: normalizeResearchSnapshotForCoverage(researchSnapshot)
  });
  const hkFlowSnapshot =
    rawOptions.hkFlowSnapshot ??
    deriveHkFlowSnapshot({
      marketSnapshot,
      cnMarketSnapshot: payloads.cnMarketSnapshot
    });
  const eventDriver = buildResearchEventDriver({
    stories: newsAggregation.stories,
    marketSnapshot
  });
  const goldFactorModel = buildResearchGoldFactorModel({
    marketSnapshot,
    eventDriver
  });
  const flowMacroRadar = buildResearchFlowMacroRadar({
    macroState: payloads.macroState,
    macroRadar: payloads.macroRadar,
    marketSnapshot,
    cnMarketSnapshot: payloads.cnMarketSnapshot,
    hkFlowSnapshot
  });
  const marketDataQuality = buildResearchDataQualityMatrix({
    tradeDate: sessionInfo.tradeDate,
    session: sessionInfo.session,
    cnMarketSnapshot: payloads.cnMarketSnapshot,
    marketSnapshot
  });
  const decisionReadiness = deriveResearchDecisionReadiness({
    sessionInfo: sessionContext,
    freshnessGuard,
    coverageGuard,
    marketDataQuality
  });
  const actionableDecision = buildResearchActionableDecision({
    decisionReadiness,
    eventDriver,
    flowMacroRadar,
    portfolioState: payloads.latest,
    opportunityPool: payloads.opportunityPool
  });
  const sectionConfidence = deriveResearchSectionConfidence({
    decisionReadiness,
    eventDriver,
    flowMacroRadar,
    marketDataQuality
  });
  const driverExpectationMatrix = buildDriverExpectationMatrix({
    eventDriver,
    sessionInfo,
    marketDataQuality
  });
  const marketFlowMatrix = buildMarketFlowMatrix({
    flowMacroRadar,
    sessionInfo,
    marketDataQuality
  });
  const dataQualityFlags = Array.isArray(marketDataQuality?.flags) ? marketDataQuality.flags : [];
  const blockedReason =
    decisionReadiness?.trading_allowed === false
      ? (Array.isArray(decisionReadiness?.reasons) ? decisionReadiness.reasons.filter(Boolean).join("；") : "") || null
      : (marketDataQuality?.blocked_reasons ?? []).find(Boolean) ?? null;
  const generatedAt = now.toISOString();

  const output = {
    generated_at: generatedAt,
    account_id: accountId,
    meta: {
      account_id: accountId,
      portfolio_root: portfolioRoot,
      generated_at: generatedAt,
      market_session: sessionInfo.session,
      trade_date: sessionInfo.tradeDate,
      data_cutoff_time: sessionInfo.shanghaiClock,
      shanghai_clock: sessionInfo.shanghaiClock,
      schema_version: 1,
      policy: sessionInfo.policy
    },
    sources: {
      manifest: manifestPath,
      portfolio_state: paths.latestPath,
      latest_compat: paths.latestCompatPath,
      cn_market_snapshot: paths.cnMarketSnapshotPath,
      risk_dashboard: paths.riskDashboardPath,
      macro_state: paths.macroStatePath,
      macro_radar: paths.macroRadarPath,
      regime_router_signals: paths.regimeSignalsPath,
      opportunity_pool: paths.opportunityPoolJsonPath,
      performance_attribution: paths.performanceAttributionPath
    },
    research_snapshot: researchSnapshot,
    market_snapshot: marketSnapshot,
    freshness_guard: freshnessGuard,
    coverage_guard: coverageGuard,
    decision_readiness: decisionReadiness,
    section_confidence: sectionConfidence,
    data_quality_flags: dataQualityFlags,
    blocked_reason: blockedReason,
    event_driver: eventDriver,
    gold_factor_model: goldFactorModel,
    news_source_health: newsAggregation.sourceHealth,
    news_coverage: newsAggregation.coverage,
    news_story_count: newsAggregation.stories.length,
    top_headlines: newsAggregation.topHeadlines,
    analysis_mode: newsAggregation.analysisMode,
    analysis_degraded_reason: newsAggregation.degradedReason,
    flow_macro_radar: flowMacroRadar,
    market_data_quality: marketDataQuality,
    driver_expectation_matrix: driverExpectationMatrix,
    market_flow_matrix: marketFlowMatrix,
    actionable_decision: actionableDecision
  };

  const outputPath =
    rawOptions.output ??
    manifest?.canonical_entrypoints?.latest_research_brain ??
    buildPortfolioPath(portfolioRoot, "data", "research_brain.json");
  await writeJsonArtifact(outputPath, output);
  await writeJsonArtifact(paths.marketDataQualityPath, {
    generated_at: generatedAt,
    account_id: accountId,
    ...marketDataQuality
  });
  await writeJsonArtifact(paths.marketFlowMatrixPath, {
    generated_at: generatedAt,
    account_id: accountId,
    ...marketFlowMatrix
  });
  await writeJsonArtifact(paths.driverExpectationMatrixPath, {
    generated_at: generatedAt,
    account_id: accountId,
    ...driverExpectationMatrix
  });

  return {
    outputPath,
    output
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runResearchBrainBuild(parseArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify({
      accountId: result.output.account_id,
      outputPath: result.outputPath,
      marketSession: result.output.meta.market_session,
      readinessLevel: result.output.decision_readiness.level
    })
  );
}
