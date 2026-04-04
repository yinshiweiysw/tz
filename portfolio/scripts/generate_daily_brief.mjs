import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { getFundWatchlistQuotes } from "../../market-mcp/src/providers/fund.js";
import { buildCnDailyBriefLines, loadCnMarketSnapshotFromManifest } from "./lib/cn_market_snapshot.mjs";
import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { buildBucketConfigMap, loadAssetMaster } from "./lib/asset_master.mjs";
import {
  buildInstitutionalActionLines,
  extractSpeculativeConclusionLines
} from "./lib/dual_trade_plan_render.mjs";
import {
  buildUnifiedResearchSections,
  flattenResearchSections
} from "./lib/research_brain_render.mjs";
import {
  buildReportSessionInheritanceLines,
  buildReportSessionRecord,
  isClosingSessionRecord,
  isClosingSessionSlot,
  resolveReportSessionSlot,
  readReportSessionMemory
} from "./lib/report_session_memory.mjs";
import {
  buildAnalysisHitRateSummary,
  buildReportQualityScorecard
} from "./lib/report_quality_scorecard.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { ensureReportContext } from "./lib/report_context.mjs";
import { loadCanonicalPortfolioState } from "./lib/portfolio_state_view.mjs";
import { buildCanonicalPortfolioView } from "./lib/portfolio_canonical_view.mjs";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    result[token.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }

  return result;
}

function resolveDate(dateArg) {
  if (dateArg) {
    return dateArg;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

async function readJsonOrNull(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function pickWorkingView(riskDashboard) {
  return riskDashboard.working_view ?? riskDashboard.canonical_view ?? {};
}

function extractQuoteDate(item) {
  const raw = String(item?.valuationTime ?? "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function formatTopMovers(items, briefDate) {
  const withChange = items.filter(
    (item) => item && item.valuationChangePercent !== null && item.valuationChangePercent !== undefined
  );
  const sameDay = withChange.filter((item) => extractQuoteDate(item) === briefDate);
  const filtered = (sameDay.length > 0 ? sameDay : withChange)
    .filter((item) => item && item.valuationChangePercent !== null && item.valuationChangePercent !== undefined)
    .sort((left, right) => Number(right.valuationChangePercent) - Number(left.valuationChangePercent));

  const gainers = filtered
    .filter((item) => Number(item.valuationChangePercent) > 0)
    .slice(0, 3)
    .map((item) =>
      `${item.name}：${item.valuationChangePercent}%（${item.valuationTime ?? "时间未知"}）`
    );
  const losers = filtered
    .filter((item) => Number(item.valuationChangePercent) < 0)
    .sort((left, right) => Number(left.valuationChangePercent) - Number(right.valuationChangePercent))
    .slice(0, 3)
    .map((item) => `${item.name}：${item.valuationChangePercent}%（${item.valuationTime ?? "时间未知"}）`);
  const neutral = filtered
    .filter((item) => Number(item.valuationChangePercent) === 0)
    .slice(0, 3)
    .map((item) =>
    `${item.name}：${item.valuationChangePercent}%（${item.valuationTime ?? "时间未知"}）`
  );

  const freshness = {
    totalWithChange: withChange.length,
    sameDayCount: sameDay.length,
    staleFilteredCount: Math.max(withChange.length - sameDay.length, 0),
    mode: sameDay.length > 0 ? "same_day_only" : "fallback_all_quotes"
  };

  return { gainers, losers, neutral, freshness };
}

function parseHypothesesMarkdown(markdown) {
  const sections = markdown.split(/\n## 假设 \d+\n/g).slice(1);
  return sections.map((section) => {
    const id = section.match(/- 编号：`([^`]+)`/)?.[1] ?? null;
    const title = section.match(/- 标题：`([^`]+)`/)?.[1] ?? null;
    const status = section.match(/- 当前状态：`([^`]+)`/)?.[1] ?? null;
    return { id, title, status };
  });
}

function extractMarkdownSectionLines(markdown, heading) {
  const pattern = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |\\Z)`, "m");
  const match = markdown.match(pattern);
  if (!match) {
    return [];
  }

  return match[1]
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function stripBulletPrefix(line) {
  return String(line ?? "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*>\s*/, "")
    .trim();
}

function pickActionableSummaryLines(lines, limit = 2) {
  return (lines ?? [])
    .map((line) => stripBulletPrefix(line))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 2));
}

function extractLabeledValue(lines, label) {
  const prefix = `${label}：`;
  const match = (lines ?? [])
    .map((line) => stripBulletPrefix(line))
    .find((line) => line.startsWith(prefix));

  return match ? match.slice(prefix.length).trim() : "";
}

function buildFirstLegActionSummary(lines) {
  const bucket = extractLabeledValue(lines, "仓位桶");
  const instrument = extractLabeledValue(lines, "标的");
  const amount = extractLabeledValue(lines, "金额");
  const status = extractLabeledValue(lines, "状态");
  const parts = [bucket, instrument, amount].filter(Boolean);

  if (parts.length === 0) {
    return "";
  }

  return `主系统优先处理 ${parts.join(" / ")}${status ? `，状态：${status}` : ""}`;
}

function buildDailyInstitutionalMemoLines({
  bucketWeights = {},
  bucketConfigMap = {},
  nextTradeCurrentConclusion = [],
  nextTradeFirstLeg = [],
  nextTradeSpeculativeConclusions = [],
  hasBlockingQualityIssues = false,
  researchDeskConclusion = null
} = {}) {
  const dominantBucket = Object.entries(bucketWeights)
    .map(([bucketKey, value]) => ({
      bucketKey,
      weightPct: Number(value),
      label: bucketConfigMap?.[bucketKey]?.label ?? bucketConfigMap?.[bucketKey]?.shortLabel ?? bucketKey
    }))
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct)[0];
  const currentConclusion = pickActionableSummaryLines(nextTradeCurrentConclusion, 2);
  const firstLeg = pickActionableSummaryLines(nextTradeFirstLeg, 2);
  const firstLegSummary = buildFirstLegActionSummary(nextTradeFirstLeg);
  const speculative = pickActionableSummaryLines(nextTradeSpeculativeConclusions, 2);
  const speculativeHasTrigger = speculative.some(
    (line) =>
      !line.includes("无触发的左侧博弈机会") &&
      !line.includes("博弈计划数据缺失") &&
      !line.includes("未检测到博弈系统可执行结论")
  );

  const thesis = dominantBucket
    ? `当前组合主线仍由 ${dominantBucket.label} 驱动，执行以双轨计划优先级为准。`
    : "当前组合主线不够集中，默认以风控与观察优先。";
  const expectationGap =
    currentConclusion[0] ??
    "双轨计划暂无明确“当前结论”段落，先保持仓位纪律并等待新信号。";
  const allowedActions = [
    ...(firstLegSummary
      ? [firstLegSummary]
      : firstLeg.length > 0
      ? firstLeg.map((item) => `按主系统计划执行：${item}`)
      : ["仅允许按既有计划做小步调整，不新增临时动作"]),
    ...(speculative.length > 0 && speculativeHasTrigger
      ? [`博弈系统仅在触发条件满足时执行：${speculative[0]}`]
      : [])
  ];
  const blockedActions = [
    "禁止跳过 trade card / journal 直接下单",
    "禁止把盘中情绪波动当成加仓理由",
    ...(speculative.length > 0 && !speculativeHasTrigger
      ? [`博弈系统当前无触发：${speculative[0]}`]
      : []),
    ...(hasBlockingQualityIssues ? ["禁止在关键链路 degraded 时启动新增交易"] : [])
  ];

  return buildInstitutionalActionLines({
    thesis,
    expectationGap,
    allowedActions,
    blockedActions,
    tradePermission: researchDeskConclusion?.trade_permission,
    blockedOrder: researchDeskConclusion?.one_sentence_order
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveFirstExistingPath(candidates = []) {
  const normalized = candidates.filter(Boolean);
  for (const candidate of normalized) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return normalized[0] ?? null;
}

function normalizeTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function isArtifactFreshEnough({ artifact, sessionMemoryUpdatedAt }) {
  if (!artifact) {
    return false;
  }

  const artifactGeneratedAt =
    normalizeTimestamp(artifact?.generated_at) ?? normalizeTimestamp(artifact?.updated_at);
  const sessionUpdatedAt = normalizeTimestamp(sessionMemoryUpdatedAt);

  if (artifactGeneratedAt === null) {
    return false;
  }

  if (sessionUpdatedAt === null) {
    return true;
  }

  return artifactGeneratedAt >= sessionUpdatedAt;
}

function selectDailyBriefQualityArtifacts({
  briefDate,
  reportSessionMemory,
  persistedReportQualityScorecard,
  persistedAnalysisHitRate,
  buildReportQualityScorecard: buildScorecard,
  buildAnalysisHitRateSummary: buildHitRate
}) {
  const toTimestamp = (value) => {
    const text = String(value ?? "").trim();
    if (!text) {
      return null;
    }
    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
  };
  const isFreshEnough = (artifact, sessionMemoryUpdatedAt) => {
    if (!artifact) {
      return false;
    }
    const artifactGeneratedAt =
      toTimestamp(artifact?.generated_at) ?? toTimestamp(artifact?.updated_at);
    const sessionUpdatedAt = toTimestamp(sessionMemoryUpdatedAt);
    if (artifactGeneratedAt === null) {
      return false;
    }
    if (sessionUpdatedAt === null) {
      return true;
    }
    return artifactGeneratedAt >= sessionUpdatedAt;
  };
  const sessionMemoryUpdatedAt =
    reportSessionMemory?.updated_at ??
    reportSessionMemory?.generated_at ??
    reportSessionMemory?.days?.[briefDate]?.close?.generated_at ??
    null;
  const canReusePersistedScorecard = isFreshEnough(
    persistedReportQualityScorecard,
    sessionMemoryUpdatedAt
  );
  const reportQualityScorecard = canReusePersistedScorecard
    ? persistedReportQualityScorecard
    : buildScorecard(reportSessionMemory, {
        asOfDate: briefDate,
        windowSize: 20
      });
  const canReusePersistedHitRate =
    canReusePersistedScorecard &&
    isFreshEnough(persistedAnalysisHitRate, sessionMemoryUpdatedAt);
  const analysisHitRate = canReusePersistedHitRate
    ? persistedAnalysisHitRate
    : buildHitRate(reportQualityScorecard);

  return {
    reportQualityScorecard,
    analysisHitRate
  };
}

function buildDailyBriefTradePlanCandidates({ briefDate, portfolioRoot, manifest }) {
  const sameDayPrimary = `${portfolioRoot}/reports/${briefDate}-next-trade-plan-regime-v4.md`;
  const sameDayFallback = `${portfolioRoot}/reports/${briefDate}-next-trade-generator.md`;
  const manifestCandidates = [
    manifest?.canonical_entrypoints?.latest_trade_plan_v4_report,
    manifest?.canonical_entrypoints?.latest_next_trade_generator
  ]
    .filter((candidate) => String(candidate ?? "").includes(briefDate));

  return [...new Set([sameDayPrimary, sameDayFallback, ...manifestCandidates].filter(Boolean))];
}

function extractJournalHighlights(markdown) {
  if (!markdown) {
    return [];
  }

  const summaryLines = extractMarkdownSectionLines(markdown, "当日摘要")
    .filter((line) => line.startsWith("- "))
    .slice(0, 3);

  if (summaryLines.length > 0) {
    return summaryLines;
  }

  const eventMatches = [...markdown.matchAll(/- 摘要：(.+)/g)]
    .map((match) => `- ${match[1].trim()}`)
    .slice(0, 3);

  return eventMatches;
}

function buildMacroRadarLines(macroRadar) {
  if (!macroRadar || (macroRadar.errors ?? []).length > 0) {
    return ["- 总体判断：宏观雷达暂未生成可用结果，当前日报仍以既有风控链路为准。"];
  }

  const overall = macroRadar.overall_assessment ?? {};
  const alerts = macroRadar.alerts ?? [];
  const dimensions = macroRadar.dimensions ?? {};
  const lines = [];

  lines.push(
    `- 总体判断：${overall.summary ?? "宏观线索暂无统一方向。"}`
  );

  for (const alert of alerts) {
    lines.push(`- 宏观警报：${alert.message}`);
  }

  if (dimensions.yield_curve?.brief) {
    lines.push(`- ${dimensions.yield_curve.brief}`);
  }

  if (dimensions.credit_radar?.brief) {
    lines.push(`- ${dimensions.credit_radar.brief}`);
  }

  if (dimensions.growth_radar?.brief) {
    lines.push(`- ${dimensions.growth_radar.brief}`);
  }

  if (dimensions.capital_flow?.brief) {
    lines.push(`- ${dimensions.capital_flow.brief}`);
  }

  return lines;
}

function buildBucketExposureLines(bucketWeights, bucketConfigMap = {}) {
  const entries = Object.entries(bucketWeights ?? {})
    .map(([bucketKey, value]) => ({
      bucketKey,
      label: bucketConfigMap?.[bucketKey]?.label ?? bucketConfigMap?.[bucketKey]?.shortLabel ?? bucketKey,
      weightPct: Number(value)
    }))
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct);

  if (entries.length === 0) {
    return ["- 当前暂无可识别的正向仓位暴露。"];
  }

  return entries.map((item) => `- ${item.label}占比：${round(item.weightPct)}%`);
}

function buildObservationFocusLines(bucketWeights, bucketConfigMap = {}) {
  const dominantBucket = Object.entries(bucketWeights ?? {})
    .map(([bucketKey, value]) => ({
      bucketKey,
      label: bucketConfigMap?.[bucketKey]?.label ?? bucketConfigMap?.[bucketKey]?.shortLabel ?? bucketKey,
      weightPct: Number(value)
    }))
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct)[0];

  const lines = ["- 优先确认现金和总资产口径；如出现明显偏差，再补截图做校准。"];

  if (!dominantBucket) {
    lines.push("- 当前暂无主导仓位，优先观察结构信号是否继续成形，再决定是否需要主动调仓。");
  } else if (dominantBucket.bucketKey === "A_CORE") {
    lines.push(`- 重点盯住 ${dominantBucket.label} 这条主仓是否从反弹走向趋势确认，避免把盘中修复误判成中期反转。`);
  } else if (dominantBucket.bucketKey === "GLB_MOM" || dominantBucket.bucketKey === "TACTICAL") {
    lines.push(`- 重点盯住 ${dominantBucket.label} 这条高波腿的持续性，避免把短线修复误判成确认主升。`);
  } else if (dominantBucket.bucketKey === "HEDGE") {
    lines.push(`- 重点盯住 ${dominantBucket.label} 的突破持续性，避免在波动放大阶段机械追高。`);
  } else if (dominantBucket.bucketKey === "INCOME") {
    lines.push(`- 重点盯住 ${dominantBucket.label} 的估值与防守性是否继续匹配，避免高估值区间机械加仓。`);
  } else {
    lines.push(`- 重点盯住 ${dominantBucket.label} 这条主风险腿的延续性，避免把短线波动误判成趋势确认。`);
  }

  lines.push("- 若有新的结构调整或重要判断，先写日志和 trade card，再决定是否执行。");
  return lines;
}

function formatSigned(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "--";
  }

  const rounded = round(Number(value), digits);
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function buildPerformanceAttributionLines(performanceAttribution) {
  if (!performanceAttribution) {
    return ["- 归因状态：业绩归因文件尚未生成，当前日报仍以账户概览与风控盘为准。"];
  }

  if (Array.isArray(performanceAttribution.markdown_lines) && performanceAttribution.markdown_lines.length > 0) {
    return performanceAttribution.markdown_lines;
  }

  const summary = performanceAttribution.portfolio_summary ?? {};
  const rankedBuckets = performanceAttribution.bucket_attribution ?? [];
  const leaders = performanceAttribution.leaders ?? {};
  const lines = [];

  lines.push(
    `- 归因口径：当前 active 持仓 ${summary.active_position_count ?? "--"} 只，估算成本 ${summary.estimated_cost_cny ?? "--"} 元，当前市值 ${summary.market_value_cny ?? "--"} 元，截面收益率 ${summary.estimated_return_pct ?? "--"}%。`
  );

  if (rankedBuckets.length === 0) {
    lines.push("- 贡献排名：暂无可用仓位桶归因结果。");
  } else {
    for (const item of rankedBuckets) {
      lines.push(
        `- 排名 ${item.rank ?? "--"}：${item.bucket_label}，盈亏贡献 ${formatSigned(
          item.profit_contribution_cny
        )} 元，桶收益率 ${formatSigned(item.bucket_return_pct)}%，当前权重 ${
          item.current_weight_pct ?? "--"
        }%，相对基准 ${formatSigned(item.weight_gap_pct)}pct。`
      );
    }
  }

  lines.push(`- 利润牛：${leaders.profit_bull?.commentary ?? "当前暂无稳定正贡献来源。"}`);
  lines.push(`- 亏损王：${leaders.loss_drag?.commentary ?? "当前暂无明显回撤主拖累。"}`);

  return lines;
}

function buildResearchQualityReviewLines(scorecard, hitRateSummary) {
  if (!scorecard || !hitRateSummary) {
    return ["- 评分状态：研究质量评分板尚未生成，当前仅保留会话主线继承。"];
  }

  const lines = [];
  const summary = hitRateSummary ?? {};
  const latestRecords = Array.isArray(scorecard?.daily_records)
    ? scorecard.daily_records.slice(-3).reverse()
    : [];

  lines.push(
    `- 统计窗口：最近 ${scorecard.window_size ?? "--"} 个交易日，已记录 ${scorecard.record_count ?? "--"} 条日度链路。`
  );
  lines.push(
    `- 午间验证命中率：${summary.morning_to_noon?.hit_rate_pct ?? "--"}%（已结算 ${summary.morning_to_noon?.settled_count ?? 0} 条）。`
  );
  lines.push(
    `- 收盘归因命中率：${summary.morning_to_close?.hit_rate_pct ?? "--"}%（已结算 ${summary.morning_to_close?.settled_count ?? 0} 条）。`
  );
  lines.push(
    `- 次日偏置兑现率：${summary.next_day_bias?.hit_rate_pct ?? "--"}%（已结算 ${summary.next_day_bias?.settled_count ?? 0} 条）。`
  );

  for (const record of latestRecords) {
    lines.push(
      `- ${record.trade_date}：午间=${record.morning_to_noon?.status ?? "pending"}，收盘=${record.morning_to_close?.status ?? "pending"}，次日=${record.next_day_bias?.status ?? "pending"}。`
    );
  }

  return lines;
}

function buildQuantRiskAlertLines(quantMetrics, riskDashboard = null) {
  if (!quantMetrics) {
    return ["- ⚠️ [核心风险雷达] quant_metrics_engine.json 尚未生成，当前无法渲染真实数学预警。"];
  }

  const lines = [];
  const topMrc = (quantMetrics?.risk_model?.bucket_marginal_risk_contribution ?? [])
    .filter((item) => Number(item?.risk_share_pct ?? 0) > 0)
    .slice()
    .sort((left, right) => Number(right?.risk_share_pct ?? 0) - Number(left?.risk_share_pct ?? 0))
    .slice(0, 3);

  if (topMrc.length > 0) {
    for (const item of topMrc) {
      lines.push(
        `- ⚠️ [敞口警告] ${item.bucket_label} (权重 ${item.weight_pct}%) 正在贡献高达 ${item.risk_share_pct}% 的系统风险！请警惕该模块的极值回撤。`
      );
    }
  } else {
    lines.push("- ⚠️ [敞口警告] 暂无可用的 MRC 风险份额数据。");
  }

  const dynamicRadar = riskDashboard?.dynamic_correlation_radar ?? {};
  const resonancePairs = Array.isArray(dynamicRadar.resonance_pairs)
    ? dynamicRadar.resonance_pairs.slice(0, 3)
    : [];
  const crowdingPairs = Array.isArray(dynamicRadar.crowding_pairs)
    ? dynamicRadar.crowding_pairs.slice(0, 3)
    : [];

  const topPairs = [
    ...resonancePairs.map((pair) => ({
      kind: "cross_bucket",
      left_bucket_label: pair.left_bucket ?? "未分类",
      right_bucket_label: pair.right_bucket ?? "未分类",
      left_name: pair.left_fund ?? pair.left_symbol ?? "左侧资产",
      right_name: pair.right_fund ?? pair.right_symbol ?? "右侧资产",
      rho: round(pair.correlation_60d, 4)
    })),
    ...crowdingPairs.map((pair) => ({
      kind: "intra_bucket",
      left_bucket_label: pair.left_bucket ?? "未分类",
      right_bucket_label: pair.right_bucket ?? pair.left_bucket ?? "未分类",
      left_name: pair.left_fund ?? pair.left_symbol ?? "左侧资产",
      right_name: pair.right_fund ?? pair.right_symbol ?? "右侧资产",
      rho: round(pair.correlation_60d, 4)
    }))
  ];

  if (topPairs.length > 0) {
    for (const pair of topPairs) {
      lines.push(
        pair.kind === "cross_bucket"
          ? `- ⚠️ [同质化警告] ${pair.left_bucket_label}(${pair.left_name}) 与 ${pair.right_bucket_label}(${pair.right_name}) 相关性高达 ${pair.rho}，起不到分散对冲作用，本质为同一风险敞口！`
          : `- ⚠️ [拥挤警告] ${pair.left_bucket_label} 内部的 ${pair.left_name} 与 ${pair.right_name} 相关性高达 ${pair.rho}，并未增加分散度，只是在同一风险腿上继续拥挤。`
      );
    }
  } else {
    lines.push("- ⚠️ [同质化警告] 当前暂无需要额外提示的高共振或高拥挤资产对。");
  }

  return lines;
}

function buildDataFreshnessLines({ latest, freshness, refresh }) {
  const lines = [
    `- 主持仓快照：${latest?.snapshot_date ?? "未知日期"} 收盘口径。`,
    "- 基金估值看板：本页生成时重新抓取观察名单估值，属于当前可得的实时/近实时数据。"
  ];

  if (refresh.mode === "never") {
    lines.push("- 刷新策略：当前为只读模式，本次生成不会自动改写底层状态文件。");
  } else if (refresh.mode === "force") {
    lines.push("- 刷新策略：当前为强制刷新模式，会先重跑底层链路再渲染本页。");
  } else {
    lines.push("- 刷新策略：当前为按需自动刷新模式，仅在缺失/滞后或关键质量告警时重跑底层链路。");
  }

  if (refresh.triggered && refresh.refreshedTargets.length > 0) {
    lines.push(`- 本次生成前已自动刷新：${refresh.refreshedTargets.join("、")}。`);
  } else if (refresh.mode === "never" && (refresh.skippedTargets ?? []).length > 0) {
    lines.push(`- 本次未自动刷新：${refresh.skippedTargets.join("、")} 仍按现有快照渲染。`);
  }

  for (const entry of freshness?.entries ?? []) {
    if (entry.key === "latest_snapshot") {
      continue;
    }

    const generatedSuffix = entry.generatedAt ? `；文件生成于 ${entry.generatedAt}` : "";
    if (entry.status === "aligned") {
      lines.push(`- ${entry.label}：已对齐到 ${entry.asOf}${generatedSuffix}`);
    } else if (entry.status === "stale") {
      lines.push(`- ⚠️ ${entry.label}：仍停留在 ${entry.asOf}${generatedSuffix}`);
    } else {
      lines.push(`- ⚠️ ${entry.label}：当前缺失，相关章节只能展示最近可用快照。`);
    }

    if (entry.qualitySummary) {
      lines.push(`- ⚠️ ${entry.label} 质量告警：${entry.qualitySummary}`);
    }
  }

  if (refresh.errors.length > 0) {
    lines.push(
      `- ⚠️ 自动刷新未完全成功：${refresh.errors
        .map((item) => `${item.step} 失败`)
        .join("、")}；下方宏观/风控/归因若出现旧日期，均按最近可用快照解读。`
    );
  }

  if (freshness?.hasBlockingQualityIssues) {
    lines.push("- 🚨 质量门禁提示：当前至少一条关键链路处于 fallback/degraded 状态，本页更适合做风控核查，不宜直接下达实盘指令。");
  }

  return lines;
}

const options = parseArgs(args);
const briefDate = resolveDate(options.date);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const riskDashboardPath = buildPortfolioPath(portfolioRoot, "risk_dashboard.json");
const hypothesesPath = buildPortfolioPath(portfolioRoot, "hypotheses.md");
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
const journalPath = buildPortfolioPath(portfolioRoot, "journal", "daily", `${briefDate}.md`);
const watchlistPath = buildPortfolioPath(portfolioRoot, "fund-watchlist.json");
const outputDir = buildPortfolioPath(portfolioRoot, "daily_briefs");
const outputPath = buildPortfolioPath(outputDir, `${briefDate}-brief.md`);

await mkdir(outputDir, { recursive: true });

const reportContext = await ensureReportContext({
  portfolioRoot,
  options: {
    ...options,
    session: "close"
  },
  includePerformanceAttribution: true
});
const { manifest, payloads, freshness, refresh } = reportContext;
const latestView = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
const latest =
  payloads.latest ??
  buildCanonicalPortfolioView({
    payload: latestView.payload,
    sourceKind: latestView.sourceKind,
    sourcePath: latestView.sourcePath
  });
const riskDashboard = payloads.riskDashboard ?? JSON.parse(await readFile(riskDashboardPath, "utf8"));
const macroRadar = payloads.macroRadar ?? null;
const performanceAttribution = payloads.performanceAttribution ?? null;
const quantMetrics = payloads.quantMetrics ?? null;
const researchBrain = payloads.researchBrain ?? null;

const [hypothesesMarkdown, watchlistQuotes] = await Promise.all([
  readFile(hypothesesPath, "utf8"),
  getFundWatchlistQuotes(watchlistPath).catch(() => ({ items: [], estimatedDailyPnlCny: null }))
]);
const assetMasterPath =
  manifest?.canonical_entrypoints?.asset_master ??
  buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
const assetMaster = await loadAssetMaster(assetMasterPath).catch(() => null);
const bucketConfigMap = assetMaster ? buildBucketConfigMap(assetMaster) : {};
const fallbackJournalPath = manifest?.canonical_entrypoints?.latest_daily_journal ?? null;
const resolvedJournalPath =
  (await pathExists(journalPath))
    ? journalPath
    : fallbackJournalPath && (await pathExists(fallbackJournalPath))
      ? fallbackJournalPath
      : journalPath;
const journalMarkdown = await readFile(resolvedJournalPath, "utf8").catch(() => "");
const cnMarketSnapshot = payloads.cnMarketSnapshot ?? (await loadCnMarketSnapshotFromManifest(manifest));

const nextTradePlanPath = await resolveFirstExistingPath(
  buildDailyBriefTradePlanCandidates({
    briefDate,
    portfolioRoot,
    manifest
  })
);
const nextTradePlanMarkdown = await readFile(nextTradePlanPath, "utf8").catch(() => "");

const summary = latest.summary ?? {};
const workingView = pickWorkingView(riskDashboard);
const bucketWeights = workingView.bucket_weights_pct_of_invested_capital ?? {};
const bucketExposureLines = buildBucketExposureLines(bucketWeights, bucketConfigMap);
const observationFocusLines = buildObservationFocusLines(bucketWeights, bucketConfigMap);
const topPositions = workingView.top_positions ?? [];
const alerts = workingView.alerts ?? [];
const riskResonanceAlerts = riskDashboard.risk_resonance_alerts ?? [];
const crowdingAlerts = riskDashboard.crowding_alerts ?? [];
const correlationHedgeNotes = riskDashboard.correlation_hedge_notes ?? [];
const l2SignalAlerts = riskDashboard.l2_signal_alerts ?? [];
const valuationAlerts = riskDashboard.valuation_alerts ?? [];
const hypotheses = parseHypothesesMarkdown(hypothesesMarkdown);
const inProgressHypotheses = hypotheses.filter((item) => item.status === "进行中");
const movers = formatTopMovers(watchlistQuotes.items ?? [], briefDate);
const cnDailyBriefLines = buildCnDailyBriefLines(cnMarketSnapshot).filter(
  (line) => !line.startsWith("- 北向核验：") && !line.startsWith("- 南向核验：")
);
const dailyResearchLines = flattenResearchSections(
  buildUnifiedResearchSections({
    researchBrain,
    cnMarketSnapshot,
    researchGuardLines: []
  }),
  {
    includeHeadings: ["## Active Market Driver", "## China / HK Flow Validation"]
  }
);
const macroRadarLines = buildMacroRadarLines(macroRadar);
const performanceAttributionLines = buildPerformanceAttributionLines(performanceAttribution);
const quantRiskAlertLines = buildQuantRiskAlertLines(quantMetrics, riskDashboard);
const dataFreshnessLines = buildDataFreshnessLines({ latest, freshness, refresh });
const reportSessionMemory = await readReportSessionMemory(reportContext.paths.reportSessionMemoryPath);
const persistedReportQualityScorecard = await readJsonOrNull(reportContext.paths.reportQualityScorecardPath);
const persistedAnalysisHitRate = await readJsonOrNull(reportContext.paths.analysisHitRatePath);
const { reportQualityScorecard, analysisHitRate } = selectDailyBriefQualityArtifacts({
  briefDate,
  reportSessionMemory,
  persistedReportQualityScorecard,
  persistedAnalysisHitRate,
  buildReportQualityScorecard,
  buildAnalysisHitRateSummary
});
const researchBrainSessionSlot = resolveReportSessionSlot({
  researchBrain
});
const persistedCloseRecord = isClosingSessionRecord(reportSessionMemory?.days?.[briefDate]?.close)
  ? reportSessionMemory.days[briefDate].close
  : null;
const derivedCloseRecord =
  persistedCloseRecord ??
  (researchBrain && isClosingSessionSlot(researchBrainSessionSlot)
    ? buildReportSessionRecord({
        tradeDate: briefDate,
        session: researchBrainSessionSlot,
        reportType: "daily_brief",
        researchBrain
      })
    : null);
const sessionInheritanceLines = derivedCloseRecord
  ? buildReportSessionInheritanceLines({
      memory: reportSessionMemory,
      tradeDate: briefDate,
      session: "close",
      currentRecord: derivedCloseRecord
    })
  : ["- 会话继承：当前缺少早报/午报/收盘主线记录。"];
const researchQualityReviewLines = buildResearchQualityReviewLines(
  reportQualityScorecard,
  analysisHitRate
);
const nextTradeCurrentConclusion = extractMarkdownSectionLines(nextTradePlanMarkdown, "当前结论");
const nextTradeFirstLeg = extractMarkdownSectionLines(nextTradePlanMarkdown, "第一笔计划");
const nextTradeSpeculativePlanLines = extractMarkdownSectionLines(nextTradePlanMarkdown, "博弈系统计划");
const nextTradeSpeculativeConclusions = extractSpeculativeConclusionLines(nextTradeSpeculativePlanLines);
const journalHighlights = extractJournalHighlights(journalMarkdown);
const hasRecentTradeContext = Boolean(
  latest.related_files?.manual_trade_transactions ||
  latest.related_files?.manual_buy_transactions ||
  (latest.related_files?.last_dialogue_merge_sources ?? []).length > 0 ||
  latest.related_files?.recent_transactions
);
const freshnessLine =
  movers.freshness.totalWithChange === 0
    ? "- 当日估值新鲜度：暂无可用涨跌数据"
    : movers.freshness.mode === "same_day_only"
      ? `- 当日估值新鲜度：${movers.freshness.sameDayCount}/${movers.freshness.totalWithChange} 只为 ${briefDate} 数据，已排除 ${movers.freshness.staleFilteredCount} 只滞后估值`
      : `- 当日估值新鲜度：未获取到 ${briefDate} 当日数据，当前展示最近可用估值`;
const hasSystemAlerts =
  riskResonanceAlerts.length > 0 ||
  crowdingAlerts.length > 0 ||
  valuationAlerts.length > 0 ||
  l2SignalAlerts.length > 0 ||
  correlationHedgeNotes.length > 0;
const institutionalMemoLines = buildDailyInstitutionalMemoLines({
  bucketWeights,
  bucketConfigMap,
  nextTradeCurrentConclusion,
  nextTradeFirstLeg,
  nextTradeSpeculativeConclusions,
  hasBlockingQualityIssues: freshness?.hasBlockingQualityIssues,
  researchDeskConclusion: researchBrain?.actionable_decision?.desk_conclusion
});

const lines = [
  `# ${briefDate} 组合日报`,
  "",
  `- 账户：${accountId}`,
  "",
  "## 今日主线与行动备忘录",
  "",
  ...institutionalMemoLines,
  "",
  "## 数据时点与新鲜度",
  "",
  ...dataFreshnessLines,
  "",
  ...(
    hasSystemAlerts
      ? [
          "## 🚨 系统级风控警报 🚨",
          "",
          ...(riskResonanceAlerts.length > 0
            ? [
                "### 🔗 风险共振警报",
                "",
                ...riskResonanceAlerts.map((item) => `- ${item}`),
                ""
              ]
            : []),
          ...(crowdingAlerts.length > 0
            ? [
                "### 🎯 同桶拥挤警报",
                "",
                ...crowdingAlerts.map((item) => `- ${item}`),
                ""
              ]
            : []),
          ...(valuationAlerts.length > 0
            ? [
                "### ⚠️ 极值估值警报",
                "",
                ...valuationAlerts.map((item) => `- ${item}`),
                ""
              ]
            : []),
          ...(l2SignalAlerts.length > 0
            ? [
                "### 📉 L2 趋势 / 走弱警报",
                "",
                ...l2SignalAlerts.map((item) => `- ${item}`),
                ""
              ]
            : []),
          ...(correlationHedgeNotes.length > 0
            ? [
                "### ✅ 动态对冲观察",
                "",
                ...correlationHedgeNotes.map((item) => `- ${item}`),
                ""
              ]
            : []),
          ""
        ]
      : []
  ),
  "## 🌍 机构级宏观气候雷达 (Macro & Liquidity Radar)",
  "",
  ...macroRadarLines,
  "",
  "## 会话主线继承",
  "",
  ...sessionInheritanceLines,
  "",
  "## 研究质量回看",
  "",
  ...researchQualityReviewLines,
  "",
  "## 🚨 核心风险雷达 (Quant Risk Alerts)",
  "",
  ...quantRiskAlertLines,
  ...(dailyResearchLines.length > 0 ? ["", ...dailyResearchLines] : []),
  "",
  "## 当日摘要",
  "",
  `- 当前工作口径已投资资金：${workingView.invested_capital_cny ?? "--"} 元，持有收益：${summary.holding_profit ?? "--"} 元，累计收益：${summary.cumulative_profit ?? "--"} 元。`,
  `- 当前单一最大仓仍为 ${topPositions[0]?.name ?? "暂无"}，占已投资仓位 ${topPositions[0]?.weight_pct_of_invested_capital ?? "--"}%。`,
  watchlistQuotes.estimatedDailyPnlCny !== null && watchlistQuotes.estimatedDailyPnlCny !== undefined
    ? `- 观察名单估算日内盈亏：${watchlistQuotes.estimatedDailyPnlCny} 元；当前仍以修结构、控集中度为主。`
    : "- 观察名单估算日内盈亏：暂无；当前仍以修结构、控集中度为主。",
  ...(Number(summary.pending_buy_confirm ?? 0) > 0
    ? [
        `- 今日另有 ${summary.pending_buy_confirm} 元基金买入已执行，但按确认口径将自下一交易日开始计收益，未并入当前 active 持仓。`
      ]
    : []),
  "",
  "## 账户概览",
  "",
  `- 主档案持仓：${summary.total_fund_assets ?? "--"} 元`,
  `- 工作口径已投资资金：${workingView.invested_capital_cny ?? "--"} 元`,
  ...(Number(summary.pending_buy_confirm ?? 0) > 0
    ? [`- 待下一交易日计收益买入：${summary.pending_buy_confirm} 元`]
    : []),
  `- 用户口头申报现金：${riskDashboard.capital_context?.reported_cash_estimate_cny ?? "--"} 元`,
  `- 持有收益：${summary.holding_profit ?? "--"} 元`,
  `- 累计收益：${summary.cumulative_profit ?? "--"} 元`,
  watchlistQuotes.estimatedDailyPnlCny !== null && watchlistQuotes.estimatedDailyPnlCny !== undefined
    ? `- 观察名单估算日内盈亏：${watchlistQuotes.estimatedDailyPnlCny} 元`
    : "- 观察名单估算日内盈亏：暂无",
  freshnessLine,
  "",
  "## 📊 业绩归因分析",
  "",
  ...performanceAttributionLines,
  "",
  "## 风险雷达",
  "",
  `- 单一最大仓：${topPositions[0]?.name ?? "暂无"}，占已投资仓位 ${topPositions[0]?.weight_pct_of_invested_capital ?? "--"}%`,
  ...bucketExposureLines,
  "",
  ...(alerts.length > 0 ? alerts.map((item) => `- 风险提示：${item}`) : ["- 风险提示：暂无新增超限提示"]),
  "",
  "## 当日估值看板",
  "",
  ...(movers.gainers.length > 0 ? movers.gainers.map((item) => `- 强势：${item}`) : ["- 强势：暂无"]),
  ...(movers.neutral.length > 0 ? movers.neutral.map((item) => `- 平稳：${item}`) : []),
  ...(movers.losers.length > 0 ? movers.losers.map((item) => `- 偏弱：${item}`) : ["- 偏弱：暂无"]),
  ...(
    cnDailyBriefLines.length > 0
      ? ["", "## 中国市场补充层", "", ...cnDailyBriefLines]
      : []
  ),
  "",
  "## 核心假设状态",
  "",
  ...(
    inProgressHypotheses.length > 0
      ? inProgressHypotheses.slice(0, 5).map((item) => `- ${item.id} ${item.title}：${item.status}`)
      : ["- 当前无进行中的假设"]
  ),
  "",
  "## 当日执行与记录",
  "",
  `- 当日日志：${resolvedJournalPath}`,
  ...(journalHighlights.length > 0 ? journalHighlights : ["- 日志摘要：暂无可提取的结构化摘要"]),
  `- 风险仪表盘：${riskDashboardPath}`,
  `- 今日重要交易卡片：${hasRecentTradeContext ? "已存在近期交易记录，可结合 trade_cards 和 journal 阅读" : "暂无新增交易上下文"}`,
  "",
  "## 明日观察重点 / 交易预案",
  "",
  ...(
    nextTradeCurrentConclusion.length > 0
      ? ["### 交易计划当前结论", "", ...nextTradeCurrentConclusion, ""]
      : []
  ),
  ...(
    nextTradeFirstLeg.length > 0
      ? ["### 下一笔候选计划", "", ...nextTradeFirstLeg, ""]
      : []
  ),
  ...(
    nextTradeSpeculativeConclusions.length > 0
      ? ["### 双轨计划引用（博弈系统）", "", ...nextTradeSpeculativeConclusions.slice(0, 6), ""]
      : ["### 双轨计划引用（博弈系统）", "", "- 当前未检测到博弈系统可执行结论，默认维持观察。", ""]
  ),
  ...observationFocusLines,
  `- 下一笔交易生成器：${nextTradePlanPath ?? "暂无可用交易预案"}`
];

await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

if (manifest && manifest.canonical_entrypoints) {
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      latest_daily_brief: outputPath
    }
  });
}

console.log(
  JSON.stringify(
    {
      outputPath,
      moversTracked: (watchlistQuotes.items ?? []).length,
      activeHypotheses: inProgressHypotheses.length,
      refreshedTargets: refresh.refreshedTargets,
      staleAfterRefresh: freshness.staleKeys
    },
    null,
    2
  )
);
