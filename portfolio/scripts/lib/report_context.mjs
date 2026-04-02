import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  buildPortfolioPath,
  defaultPortfolioRoot,
  resolveAccountId,
  workspaceRoot
} from "./account_root.mjs";
import { buildPortfolioStatePaths } from "./portfolio_state_view.mjs";

const execFileAsync = promisify(execFile);
const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

async function readJsonOrNull(path) {
  if (!path) {
    return null;
  }

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function shanghaiDateFromTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : shanghaiDateFormatter.format(parsed);
}

function compareDateStrings(left, right) {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  return left.localeCompare(right);
}

function parseTimestampMs(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function extractGeneratedAtMs(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return parseTimestampMs(payload.generated_at ?? payload.updatedAt ?? null);
}

function isGeneratedAfter(upstreamPayload, downstreamPayload) {
  const upstreamMs = extractGeneratedAtMs(upstreamPayload);
  const downstreamMs = extractGeneratedAtMs(downstreamPayload);

  if (upstreamMs === null) {
    return false;
  }

  if (downstreamMs === null) {
    return true;
  }

  return upstreamMs > downstreamMs;
}

function sortDateStrings(values) {
  return values
    .filter(Boolean)
    .map((value) => String(value).slice(0, 10))
    .sort((left, right) => left.localeCompare(right));
}

function extractLatestAsOf(latest) {
  return (
    String(latest?.snapshot_date ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(latest?.generated_at) ||
    shanghaiDateFromTimestamp(latest?.updatedAt) ||
    null
  );
}

function extractSignalsAsOf(signalMatrix) {
  const signalDates = sortDateStrings(
    Object.values(signalMatrix?.signals ?? {}).map((signal) => signal?.signal_date)
  );
  const signalDate = signalDates.at(-1) ?? null;
  const generatedDate = shanghaiDateFromTimestamp(signalMatrix?.generated_at);
  return compareDateStrings(signalDate, generatedDate) >= 0 ? signalDate : generatedDate;
}

function extractMacroAsOf(macroRadar) {
  const signalDates = sortDateStrings(
    Object.values(macroRadar?.dimensions ?? {}).map((dimension) => dimension?.signal_date)
  );
  const signalDate = signalDates.at(-1) ?? null;
  const generatedDate = shanghaiDateFromTimestamp(macroRadar?.generated_at);
  return compareDateStrings(signalDate, generatedDate) >= 0 ? signalDate : generatedDate;
}

function extractCnMarketSnapshotAsOf(cnMarketSnapshot) {
  return (
    String(cnMarketSnapshot?.trade_date ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(cnMarketSnapshot?.generated_at) ||
    null
  );
}

function extractMacroStateAsOf(macroState) {
  return shanghaiDateFromTimestamp(macroState?.generated_at);
}

function extractRegimeSignalsAsOf(regimeSignals) {
  const signalDates = sortDateStrings(
    Object.values(regimeSignals?.signals ?? {}).map(
      (signal) => signal?.execution_context?.price_date ?? signal?.technical_snapshot?.as_of_date
    )
  );
  const signalDate = signalDates.at(-1) ?? null;
  const generatedDate = shanghaiDateFromTimestamp(regimeSignals?.generated_at);
  return compareDateStrings(signalDate, generatedDate) >= 0 ? signalDate : generatedDate;
}

function extractTradePlanAsOf(tradePlan) {
  return (
    String(tradePlan?.plan_date ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(tradePlan?.generated_at) ||
    null
  );
}

function extractRiskAsOf(riskDashboard) {
  return (
    String(riskDashboard?.as_of ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(riskDashboard?.generated_at) ||
    null
  );
}

function extractQuantAsOf(quantMetrics) {
  return (
    String(quantMetrics?.as_of ?? "").slice(0, 10) ||
    String(quantMetrics?.portfolio_snapshot?.snapshot_date ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(quantMetrics?.generated_at) ||
    null
  );
}

function extractPerformanceAsOf(performanceAttribution) {
  return (
    String(performanceAttribution?.as_of ?? "").slice(0, 10) ||
    String(performanceAttribution?.snapshot_date ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(performanceAttribution?.generated_at) ||
    null
  );
}

function extractOpportunityPoolAsOf(opportunityPool) {
  return (
    String(opportunityPool?.as_of ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(opportunityPool?.generated_at) ||
    null
  );
}

function extractSpeculativePlanAsOf(speculativePlan) {
  return (
    String(speculativePlan?.as_of ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(speculativePlan?.generated_at) ||
    null
  );
}

function normalizeRefreshMode(options = {}) {
  const hasExplicitRefresh =
    Object.prototype.hasOwnProperty.call(options, "refresh") ||
    Object.prototype.hasOwnProperty.call(options, "refresh-mode") ||
    Object.prototype.hasOwnProperty.call(options, "refresh_mode");
  const raw = String(
    options?.refresh ?? options?.["refresh-mode"] ?? options?.refresh_mode ?? ""
  )
    .trim()
    .toLowerCase();

  if (!hasExplicitRefresh) {
    return "never";
  }

  if (["", "auto", "stale", "stale_only", "stale-only", "true", "1", "yes"].includes(raw)) {
    return "auto";
  }

  if (["force", "all"].includes(raw)) {
    return "force";
  }

  if (["never", "off", "false", "0", "no", "read", "read_only", "read-only"].includes(raw)) {
    return "never";
  }

  return "never";
}

function buildQualityIssue({
  key,
  severity = "warning",
  summary,
  refreshRecommended = false,
  blocksTrade = false
}) {
  if (!summary) {
    return null;
  }

  return {
    key,
    severity,
    summary,
    refreshRecommended,
    blocksTrade
  };
}

function detectMacroStateQuality(macroState) {
  if (!macroState) {
    return null;
  }

  const dataQuality = macroState?.data_quality ?? {};
  const staleFields = Array.isArray(dataQuality?.stale_fields) ? dataQuality.stale_fields : [];
  const errorCount = Array.isArray(dataQuality?.errors) ? dataQuality.errors.length : 0;
  const usedFallback = dataQuality?.used_previous_state_fallback === true;
  const status = String(macroState?.status ?? "").trim();

  if (!usedFallback && staleFields.length === 0 && errorCount === 0 && ["", "ok"].includes(status)) {
    return null;
  }

  const parts = [];
  if (usedFallback) {
    parts.push("使用了 previous-state fallback");
  }
  if (staleFields.length > 0) {
    parts.push(`存在 ${staleFields.length} 个 stale 字段`);
  }
  if (errorCount > 0) {
    parts.push(`存在 ${errorCount} 个错误项`);
  }
  if (status && status !== "ok") {
    parts.push(`当前状态为 ${status}`);
  }

  return buildQualityIssue({
    key: "macro_state",
    summary: parts.join("；"),
    refreshRecommended: true,
    blocksTrade: usedFallback || ["fallback_only", "error"].includes(status)
  });
}

function detectMacroRadarQuality(macroRadar) {
  if (!macroRadar) {
    return null;
  }

  const errors = Array.isArray(macroRadar?.errors) ? macroRadar.errors : [];
  const dimensions = Object.values(macroRadar?.dimensions ?? {});
  const proxyFallbacks = dimensions.filter(
    (dimension) =>
      dimension?.used_fallback === true ||
      Boolean(dimension?.fx_proxy_note) ||
      Boolean(dimension?.proxy_note)
  );

  if (errors.length === 0 && proxyFallbacks.length === 0) {
    return null;
  }

  const parts = [];
  if (errors.length > 0) {
    parts.push(`存在 ${errors.length} 个抓取/计算错误`);
  }
  if (proxyFallbacks.length > 0) {
    parts.push(`有 ${proxyFallbacks.length} 个维度使用了代理或降级口径`);
  }

  return buildQualityIssue({
    key: "macro_radar",
    summary: parts.join("；"),
    refreshRecommended: errors.length > 0,
    blocksTrade: false
  });
}

function detectRegimeSignalsQuality(regimeSignals) {
  if (!regimeSignals) {
    return null;
  }

  const errors = Array.isArray(regimeSignals?.errors) ? regimeSignals.errors : [];
  if (errors.length === 0) {
    return null;
  }

  return buildQualityIssue({
    key: "regime_router_signals",
    summary: `有 ${errors.length} 个标的未成功生成主脑路由信号`,
    refreshRecommended: false,
    blocksTrade: false
  });
}

function detectSignalsMatrixQuality(signalMatrix) {
  if (!signalMatrix) {
    return null;
  }

  const topLevelErrors = Array.isArray(signalMatrix?.errors) ? signalMatrix.errors.length : 0;
  let insufficientHistoryCount = 0;

  for (const signal of Object.values(signalMatrix?.signals ?? {})) {
    const quality = signal?.data_quality ?? {};
    const flags = Object.entries(quality).filter(
      ([key, value]) => key.startsWith("enough_history_for_") && value === false
    );
    if (flags.length > 0) {
      insufficientHistoryCount += 1;
    }
  }

  if (topLevelErrors === 0 && insufficientHistoryCount === 0) {
    return null;
  }

  const parts = [];
  if (topLevelErrors > 0) {
    parts.push(`顶层存在 ${topLevelErrors} 个错误`);
  }
  if (insufficientHistoryCount > 0) {
    parts.push(`${insufficientHistoryCount} 个标的历史长度不足`);
  }

  return buildQualityIssue({
    key: "signals_matrix",
    summary: parts.join("；"),
    refreshRecommended: topLevelErrors > 0,
    blocksTrade: false
  });
}

function buildQualityIssueMap(payloads) {
  const issues = [
    detectSignalsMatrixQuality(payloads.signalMatrix),
    detectMacroRadarQuality(payloads.macroRadar),
    detectMacroStateQuality(payloads.macroState),
    detectRegimeSignalsQuality(payloads.regimeSignals)
  ].filter(Boolean);

  return new Map(issues.map((issue) => [issue.key, issue]));
}

function buildEntry({ key, label, asOf, generatedAt, anchorDate }) {
  const status = !asOf ? "missing" : compareDateStrings(asOf, anchorDate) >= 0 ? "aligned" : "stale";
  return {
    key,
    label,
    asOf,
    generatedAt: generatedAt ?? null,
    anchorDate,
    status,
    needsRefresh: status !== "aligned"
  };
}

function buildDependencyRefreshHints(payloads = {}) {
  const hints = new Map();

  if (
    isGeneratedAfter(payloads.signalMatrix, payloads.speculativePlan) ||
    isGeneratedAfter(payloads.opportunityPool, payloads.speculativePlan)
  ) {
    hints.set("speculative_plan", "上游机会池或 L2 信号较当前博弈计划更新。");
  }

  if (
    isGeneratedAfter(payloads.latest, payloads.tradePlan) ||
    isGeneratedAfter(payloads.macroState, payloads.tradePlan) ||
    isGeneratedAfter(payloads.regimeSignals, payloads.tradePlan) ||
    isGeneratedAfter(payloads.opportunityPool, payloads.tradePlan) ||
    isGeneratedAfter(payloads.speculativePlan, payloads.tradePlan)
  ) {
    hints.set("trade_plan", "上游依赖较当前交易预案更新。");
  }

  return hints;
}

export function buildAnalyticsFreshness({ anchorDate, payloads }) {
  const qualityIssues = buildQualityIssueMap(payloads);
  const dependencyHints = buildDependencyRefreshHints(payloads);
  const baseEntries = [
    buildEntry({
      key: "latest_snapshot",
      label: "主持仓快照",
      asOf: extractLatestAsOf(payloads.latest),
      generatedAt: payloads.latest?.generated_at ?? payloads.latest?.updatedAt ?? null,
      anchorDate
    }),
    buildEntry({
      key: "cn_market_snapshot",
      label: "中国市场补充层",
      asOf: extractCnMarketSnapshotAsOf(payloads.cnMarketSnapshot),
      generatedAt: payloads.cnMarketSnapshot?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "signals_matrix",
      label: "L2 基金信号",
      asOf: extractSignalsAsOf(payloads.signalMatrix),
      generatedAt: payloads.signalMatrix?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "macro_radar",
      label: "宏观雷达",
      asOf: extractMacroAsOf(payloads.macroRadar),
      generatedAt: payloads.macroRadar?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "macro_state",
      label: "宏观状态机",
      asOf: extractMacroStateAsOf(payloads.macroState),
      generatedAt: payloads.macroState?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "regime_router_signals",
      label: "交易主脑信号路由",
      asOf: extractRegimeSignalsAsOf(payloads.regimeSignals),
      generatedAt: payloads.regimeSignals?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "quant_metrics_engine",
      label: "数学风控矩阵",
      asOf: extractQuantAsOf(payloads.quantMetrics),
      generatedAt: payloads.quantMetrics?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "risk_dashboard",
      label: "风险仪表盘",
      asOf: extractRiskAsOf(payloads.riskDashboard),
      generatedAt: payloads.riskDashboard?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "performance_attribution",
      label: "业绩归因",
      asOf: extractPerformanceAsOf(payloads.performanceAttribution),
      generatedAt: payloads.performanceAttribution?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "opportunity_pool",
      label: "机会池研究发现",
      asOf: extractOpportunityPoolAsOf(payloads.opportunityPool),
      generatedAt: payloads.opportunityPool?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "speculative_plan",
      label: "左侧博弈计划",
      asOf: extractSpeculativePlanAsOf(payloads.speculativePlan),
      generatedAt: payloads.speculativePlan?.generated_at ?? null,
      anchorDate
    }),
    buildEntry({
      key: "trade_plan",
      label: "交易预案",
      asOf: extractTradePlanAsOf(payloads.tradePlan),
      generatedAt: payloads.tradePlan?.generated_at ?? null,
      anchorDate
    })
  ];
  const entries = baseEntries.map((entry) => {
    const quality = qualityIssues.get(entry.key) ?? null;
    const dependencySummary = dependencyHints.get(entry.key) ?? null;
    return {
      ...entry,
      qualityStatus: quality ? quality.severity : "ok",
      qualitySummary: quality?.summary ?? null,
      qualityRefreshRecommended: quality?.refreshRecommended ?? false,
      dependencyRefreshRecommended: Boolean(dependencySummary),
      dependencySummary,
      blocksTrade: quality?.blocksTrade ?? false
    };
  });

  const staleEntries = entries.filter((entry) => entry.status === "stale");
  const missingEntries = entries.filter((entry) => entry.status === "missing");
  const degradedEntries = entries.filter((entry) => entry.qualityStatus !== "ok");
  const refreshRecommendedEntries = entries.filter(
    (entry) => entry.needsRefresh || entry.qualityRefreshRecommended || entry.dependencyRefreshRecommended
  );

  return {
    anchorDate,
    entries,
    staleEntries,
    missingEntries,
    degradedEntries,
    staleKeys: staleEntries.map((entry) => entry.key),
    missingKeys: missingEntries.map((entry) => entry.key),
    degradedKeys: degradedEntries.map((entry) => entry.key),
    refreshRecommendedKeys: refreshRecommendedEntries.map((entry) => entry.key),
    hasBlockingQualityIssues: degradedEntries.some((entry) => entry.blocksTrade),
    needsRefresh: refreshRecommendedEntries.some(
      (entry) => entry.key !== "latest_snapshot"
    )
  };
}

export function buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest = null) {
  const canonical = manifest?.canonical_entrypoints ?? {};
  const sharedCanonical = sharedManifest?.canonical_entrypoints ?? {};
  const statePaths = buildPortfolioStatePaths(portfolioRoot, manifest);
  return {
    manifestPath: buildPortfolioPath(portfolioRoot, "state-manifest.json"),
    latestPath: statePaths.portfolioStatePath,
    latestCompatPath: statePaths.latestCompatPath,
    latestRawPath: statePaths.latestRawPath,
    accountContextPath:
      canonical.account_context ?? buildPortfolioPath(portfolioRoot, "account_context.json"),
    assetMasterPath:
      canonical.asset_master ?? buildPortfolioPath(portfolioRoot, "config", "asset_master.json"),
    marketLakeDbPath:
      canonical.market_lake_db ?? buildPortfolioPath(portfolioRoot, "data", "market_lake.db"),
    cnMarketSnapshotPath:
      sharedCanonical.latest_cn_market_snapshot ??
      canonical.latest_cn_market_snapshot ??
      null,
    signalsMatrixPath:
      canonical.latest_fund_signals_matrix ??
      buildPortfolioPath(portfolioRoot, "signals", "signals_matrix.json"),
    macroRadarPath:
      canonical.latest_macro_radar ??
      buildPortfolioPath(portfolioRoot, "data", "macro_radar.json"),
    macroStatePath:
      canonical.latest_macro_state ?? buildPortfolioPath(portfolioRoot, "data", "macro_state.json"),
    regimeSignalsPath:
      canonical.latest_regime_router_signals ??
      buildPortfolioPath(portfolioRoot, "signals", "regime_router_signals.json"),
    quantMetricsPath:
      canonical.latest_quant_metrics_engine ??
      canonical.latest_quant_metrics ??
      buildPortfolioPath(portfolioRoot, "data", "quant_metrics_engine.json"),
    riskDashboardPath:
      canonical.risk_dashboard ?? buildPortfolioPath(portfolioRoot, "risk_dashboard.json"),
    performanceAttributionPath:
      canonical.latest_performance_attribution ??
      buildPortfolioPath(portfolioRoot, "data", "performance_attribution.json"),
    opportunityPoolJsonPath:
      canonical.latest_opportunity_pool_json ??
      buildPortfolioPath(portfolioRoot, "data", "opportunity_pool.json"),
    speculativePlanJsonPath:
      canonical.latest_speculative_plan_json ??
      buildPortfolioPath(portfolioRoot, "data", "speculative_plan.json"),
    opportunityPoolReportPath:
      canonical.latest_opportunity_pool_report ??
      buildPortfolioPath(portfolioRoot, "reports", "latest-opportunity-pool.md"),
    tradePlanJsonPath:
      canonical.latest_trade_plan_v4_json ??
      buildPortfolioPath(portfolioRoot, "data", "trade_plan_v4.json"),
    tradePlanReportPath:
      canonical.latest_trade_plan_v4_report ??
      canonical.latest_next_trade_generator ??
      buildPortfolioPath(portfolioRoot, "reports", "latest-next-trade-plan-regime-v4.md")
  };
}

async function loadPayloads(paths) {
  const preferredLatest = await readJsonOrNull(paths.latestPath);
  const latest = preferredLatest ?? (await readJsonOrNull(paths.latestCompatPath));
  const latestSourcePath = preferredLatest ? paths.latestPath : latest ? paths.latestCompatPath : null;
  const [
    cnMarketSnapshot,
    signalMatrix,
    macroRadar,
    macroState,
    regimeSignals,
    quantMetrics,
    riskDashboard,
    performanceAttribution,
    opportunityPool,
    speculativePlan,
    tradePlan
  ] =
    await Promise.all([
      readJsonOrNull(paths.cnMarketSnapshotPath),
      readJsonOrNull(paths.signalsMatrixPath),
      readJsonOrNull(paths.macroRadarPath),
      readJsonOrNull(paths.macroStatePath),
      readJsonOrNull(paths.regimeSignalsPath),
      readJsonOrNull(paths.quantMetricsPath),
      readJsonOrNull(paths.riskDashboardPath),
      readJsonOrNull(paths.performanceAttributionPath),
      readJsonOrNull(paths.opportunityPoolJsonPath),
      readJsonOrNull(paths.speculativePlanJsonPath),
      readJsonOrNull(paths.tradePlanJsonPath)
    ]);

  return {
    latest,
    latestSourcePath,
    cnMarketSnapshot,
    signalMatrix,
    macroRadar,
    macroState,
    regimeSignals,
    quantMetrics,
    riskDashboard,
    performanceAttribution,
    opportunityPool,
    speculativePlan,
    tradePlan
  };
}

export function shouldRefreshSpeculativePlan({
  refreshMode,
  refreshedKeys = new Set(),
  payloads = {},
  freshness = {}
}) {
  if (refreshMode === "force") {
    return true;
  }

  if (refreshedKeys.has("signals_matrix") || refreshedKeys.has("opportunity_pool")) {
    return true;
  }

  if (
    isGeneratedAfter(payloads.signalMatrix, payloads.speculativePlan) ||
    isGeneratedAfter(payloads.opportunityPool, payloads.speculativePlan)
  ) {
    return true;
  }

  const stale = Array.isArray(freshness?.staleKeys) ? freshness.staleKeys.includes("speculative_plan") : false;
  const missing = Array.isArray(freshness?.missingKeys) ? freshness.missingKeys.includes("speculative_plan") : false;
  const recommended = Array.isArray(freshness?.refreshRecommendedKeys)
    ? freshness.refreshRecommendedKeys.includes("speculative_plan")
    : false;

  return stale || missing || recommended;
}

export function shouldRefreshTradePlan({
  refreshMode,
  refreshedKeys = new Set(),
  payloads = {},
  freshness = {}
}) {
  if (refreshMode === "force") {
    return true;
  }

  if (
    refreshedKeys.has("regime_router_signals") ||
    refreshedKeys.has("speculative_plan") ||
    refreshedKeys.has("opportunity_pool")
  ) {
    return true;
  }

  if (
    isGeneratedAfter(payloads.latest, payloads.tradePlan) ||
    isGeneratedAfter(payloads.macroState, payloads.tradePlan) ||
    isGeneratedAfter(payloads.regimeSignals, payloads.tradePlan) ||
    isGeneratedAfter(payloads.opportunityPool, payloads.tradePlan) ||
    isGeneratedAfter(payloads.speculativePlan, payloads.tradePlan)
  ) {
    return true;
  }

  const stale = Array.isArray(freshness?.staleKeys) ? freshness.staleKeys.includes("trade_plan") : false;
  const missing = Array.isArray(freshness?.missingKeys) ? freshness.missingKeys.includes("trade_plan") : false;
  const recommended = Array.isArray(freshness?.refreshRecommendedKeys)
    ? freshness.refreshRecommendedKeys.includes("trade_plan")
    : false;

  return stale || missing || recommended;
}

export function shouldBlockTradePlanRefresh({
  speculativeRefreshRequested = false,
  refreshErrors = []
}) {
  if (!speculativeRefreshRequested) {
    return false;
  }

  return Array.isArray(refreshErrors)
    ? refreshErrors.some((error) => error?.step === "speculative_plan")
    : false;
}

async function runRefreshStep(step, command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024 * 8
    });
    return {
      step,
      ok: true,
      stdout: String(stdout ?? "").trim(),
      stderr: String(stderr ?? "").trim()
    };
  } catch (error) {
    return {
      step,
      ok: false,
      message: error?.message ?? String(error),
      stdout: String(error?.stdout ?? "").trim(),
      stderr: String(error?.stderr ?? "").trim()
    };
  }
}

async function syncSharedCanonicalPointers({
  portfolioRoot,
  manifest,
  manifestPath,
  sharedManifest
}) {
  if (
    portfolioRoot === defaultPortfolioRoot ||
    !manifest?.canonical_entrypoints ||
    !sharedManifest?.canonical_entrypoints
  ) {
    return manifest;
  }

  const nextCnSnapshot = sharedManifest.canonical_entrypoints.latest_cn_market_snapshot ?? null;
  if (
    nextCnSnapshot &&
    manifest.canonical_entrypoints.latest_cn_market_snapshot !== nextCnSnapshot
  ) {
    manifest.canonical_entrypoints.latest_cn_market_snapshot = nextCnSnapshot;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return manifest;
}

export async function ensureReportContext({
  portfolioRoot,
  options = {},
  includePerformanceAttribution = false
}) {
  const refreshMode = normalizeRefreshMode(options);
  let manifest = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "state-manifest.json"));
  const sharedManifestPath = buildPortfolioPath(defaultPortfolioRoot, "state-manifest.json");
  let sharedManifest = await readJsonOrNull(sharedManifestPath);
  let paths = buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest);
  let payloads = await loadPayloads(paths);
  const accountId = resolveAccountId(options);
  const anchorDate = extractLatestAsOf(payloads.latest);
  let freshness = buildAnalyticsFreshness({ anchorDate, payloads });
  const refresh = {
    mode: refreshMode,
    triggered: false,
    refreshedTargets: [],
    skippedTargets: [],
    errors: []
  };

  if (refreshMode !== "never") {
    manifest = await syncSharedCanonicalPointers({
      portfolioRoot,
      manifest,
      manifestPath: paths.manifestPath,
      sharedManifest
    });
  }

  if (!anchorDate) {
    return { manifest, paths, payloads, freshness, refresh };
  }

  if (refreshMode === "never") {
    if (freshness.needsRefresh) {
      refresh.skippedTargets = freshness.refreshRecommendedKeys.filter(
        (key) => key !== "latest_snapshot"
      );
    }
    return { manifest, paths, payloads, freshness, refresh };
  }

  if (!freshness.needsRefresh && refreshMode !== "force") {
    return { manifest, paths, payloads, freshness, refresh };
  }

  const userArgs = accountId && accountId !== "main" ? ["--user", accountId] : [];
  const refreshedKeys = new Set();
  refresh.triggered = true;
  const shouldRefreshKey = (key) =>
    refreshMode === "force" ||
    freshness.staleKeys.includes(key) ||
    freshness.missingKeys.includes(key) ||
    freshness.refreshRecommendedKeys.includes(key);

  if (shouldRefreshKey("cn_market_snapshot")) {
    const cnSnapshotArgs = [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_cn_market_snapshot.py"),
      "--portfolio-root",
      defaultPortfolioRoot
    ];
    if (anchorDate) {
      cnSnapshotArgs.push("--date", anchorDate);
    }
    const result = await runRefreshStep("cn_market_snapshot", "python3", cnSnapshotArgs);
    if (result.ok) {
      refreshedKeys.add("cn_market_snapshot");
      refresh.refreshedTargets.push("cn_market_snapshot");
    } else {
      refresh.errors.push(result);
    }
  }

  if (shouldRefreshKey("macro_radar")) {
    const result = await runRefreshStep("macro_radar", "python3", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_macro_radar.py"),
      "--portfolio-root",
      defaultPortfolioRoot
    ]);
    if (result.ok) {
      refreshedKeys.add("macro_radar");
      refresh.refreshedTargets.push("macro_radar");
    } else {
      refresh.errors.push(result);
    }
  }

  if (shouldRefreshKey("macro_state")) {
    const result = await runRefreshStep("macro_state", "python3", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_macro_state.py"),
      ...userArgs,
      "--portfolio-root",
      portfolioRoot,
      "--output",
      paths.macroStatePath
    ]);
    if (result.ok) {
      refreshedKeys.add("macro_state");
      refresh.refreshedTargets.push("macro_state");
    } else {
      refresh.errors.push(result);
    }
  }

  if (shouldRefreshKey("signals_matrix")) {
    const result = await runRefreshStep("signals_matrix", "python3", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_fund_signals_matrix.py"),
      ...userArgs
    ]);
    if (result.ok) {
      refreshedKeys.add("signals_matrix");
      refresh.refreshedTargets.push("signals_matrix");
    } else {
      refresh.errors.push(result);
    }
  }

  if (
    refreshMode === "force" ||
    refreshedKeys.has("macro_state") ||
    shouldRefreshKey("regime_router_signals")
  ) {
    const result = await runRefreshStep("regime_router_signals", "python3", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_signals.py"),
      "--asset-master",
      paths.assetMasterPath,
      "--account-context",
      paths.accountContextPath,
      "--macro-state",
      paths.macroStatePath,
      "--db",
      paths.marketLakeDbPath,
      "--output",
      paths.regimeSignalsPath
    ]);
    if (result.ok) {
      refreshedKeys.add("regime_router_signals");
      refresh.refreshedTargets.push("regime_router_signals");
    } else {
      refresh.errors.push(result);
    }
  }

  if (shouldRefreshKey("quant_metrics_engine")) {
    const result = await runRefreshStep("quant_metrics_engine", "python3", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "calculate_quant_metrics.py"),
      ...userArgs
    ]);
    if (result.ok) {
      refreshedKeys.add("quant_metrics_engine");
      refresh.refreshedTargets.push("quant_metrics_engine");
    } else {
      refresh.errors.push(result);
    }
  }

  const shouldRefreshRisk =
    refreshMode === "force" ||
    refreshedKeys.has("signals_matrix") ||
    refreshedKeys.has("quant_metrics_engine") ||
    shouldRefreshKey("risk_dashboard");

  if (shouldRefreshRisk) {
    const result = await runRefreshStep("risk_dashboard", "node", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_risk_dashboard.mjs"),
      ...userArgs
    ]);
    if (result.ok) {
      refreshedKeys.add("risk_dashboard");
      refresh.refreshedTargets.push("risk_dashboard");
    } else {
      refresh.errors.push(result);
    }
  }

  const shouldRefreshPerformance =
    includePerformanceAttribution &&
    (refreshMode === "force" ||
      refreshedKeys.has("quant_metrics_engine") ||
      shouldRefreshKey("performance_attribution"));

  if (shouldRefreshPerformance) {
    const result = await runRefreshStep("performance_attribution", "node", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_performance_attribution.mjs"),
      ...userArgs
    ]);
    if (result.ok) {
      refreshedKeys.add("performance_attribution");
      refresh.refreshedTargets.push("performance_attribution");
    } else {
      refresh.errors.push(result);
    }
  }

  const shouldRefreshOpportunityPool =
    refreshMode === "force" ||
    refreshedKeys.has("cn_market_snapshot") ||
    refreshedKeys.has("macro_state") ||
    shouldRefreshKey("opportunity_pool");

  if (shouldRefreshOpportunityPool) {
    const args = [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_opportunity_pool.mjs"),
      "--portfolio-root",
      portfolioRoot
    ];
    if (anchorDate) {
      args.push("--date", anchorDate);
    }
    const result = await runRefreshStep("opportunity_pool", "node", args);
    if (result.ok) {
      refreshedKeys.add("opportunity_pool");
      refresh.refreshedTargets.push("opportunity_pool");
    } else {
      refresh.errors.push(result);
    }
  }

  const shouldRefreshSpeculative =
    refreshMode === "force" ||
    shouldRefreshSpeculativePlan({
      refreshMode,
      refreshedKeys,
      payloads,
      freshness
    });

  if (shouldRefreshSpeculative) {
    const args = [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_speculative_plan.mjs"),
      ...userArgs,
      "--portfolio-root",
      portfolioRoot
    ];
    if (anchorDate) {
      args.push("--date", anchorDate);
    }

    const result = await runRefreshStep("speculative_plan", "node", args);
    if (result.ok) {
      refreshedKeys.add("speculative_plan");
      refresh.refreshedTargets.push("speculative_plan");
    } else {
      refresh.errors.push(result);
    }
  }

  const shouldRefreshTradePlanResult = shouldRefreshTradePlan({
    refreshMode,
    refreshedKeys,
    payloads,
    freshness: {
      staleKeys: freshness.staleKeys,
      missingKeys: freshness.missingKeys,
      refreshRecommendedKeys: freshness.refreshRecommendedKeys
    }
  });

  const blockTradePlanRefresh = shouldBlockTradePlanRefresh({
    speculativeRefreshRequested: shouldRefreshSpeculative,
    refreshErrors: refresh.errors
  });

  if (shouldRefreshTradePlanResult && !blockTradePlanRefresh) {
    const args = [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_next_trade_plan.mjs"),
      "--portfolio-root",
      portfolioRoot
    ];
    if (anchorDate) {
      args.push("--date", anchorDate);
    }
    const result = await runRefreshStep("trade_plan", "node", args);
    if (result.ok) {
      refreshedKeys.add("trade_plan");
      refresh.refreshedTargets.push("trade_plan");
    } else {
      refresh.errors.push(result);
    }
  } else if (shouldRefreshTradePlanResult && blockTradePlanRefresh) {
    refresh.skippedTargets.push("trade_plan");
  }

  manifest = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "state-manifest.json"));
  sharedManifest = await readJsonOrNull(sharedManifestPath);
  manifest = await syncSharedCanonicalPointers({
    portfolioRoot,
    manifest,
    manifestPath: paths.manifestPath,
    sharedManifest
  });
  paths = buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest);
  payloads = await loadPayloads(paths);
  freshness = buildAnalyticsFreshness({ anchorDate, payloads });

  return { manifest, paths, payloads, freshness, refresh };
}
