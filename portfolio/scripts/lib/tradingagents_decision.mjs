import { fileURLToPath } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./account_root.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./atomic_json_state.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./manifest_state.mjs";
import { loadMarketProxyQuoteSnapshot } from "./market_proxy_quotes.mjs";
import { loadCanonicalPortfolioState } from "./portfolio_state_view.mjs";
import {
  loadTradingAgentsBridgeConfig,
  loadTradingAgentsRawFixture,
  loadTradingAdviceSnapshot,
  resolveTradingAdvicePaths
} from "./tradingagents_bridge.mjs";
import { computeTradingAdviceFreshness } from "./tradingagents_guardrails.mjs";
import { normalizeTradingAgentsRating, translateTradingAgentsRating } from "./tradingagents_mapping.mjs";
import {
  buildBucketFactorSummary,
  buildFactorExposureSummary,
  buildFactorRiskNotes,
  buildFundFactorContribution,
  enrichFundAnalysesWithFactorAttribution,
  resolveFundFactorProfile
} from "./fund_factor_attribution.mjs";
import { resolveFundResearchProfile } from "./fund_research_profiles.mjs";
import { buildFundTradingAgentsAdapter } from "./fund_tradingagents_adapter.mjs";

const DEFAULT_BRIDGE_CONFIG_PATH = fileURLToPath(
  new URL("../../config/tradingagents_bridge.json", import.meta.url)
);
const SIGNAL_MEMORY_LIMIT = 10;
const MIN_ACTION_CONFIDENCE = 0.6;
const STRONG_ACTION_CONFIDENCE = 0.65;
const REQUIRED_DIRECTION_STREAK = 2;
const MAX_REAL_ACTIONS = 3;
const DEFAULT_MIN_TRADE_AMOUNT_CNY = 1000;

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeBrainProfile(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["fast", "full"].includes(text) ? text : null;
}

function resolveTradingAgentsBrainProfile({
  snapshot = {},
  rawSnapshot = {},
  adviceSnapshot = {},
  bridgeConfig = {}
} = {}) {
  return (
    normalizeBrainProfile(snapshot?.brainProfile) ??
    normalizeBrainProfile(snapshot?.diagnostics?.brainProfile) ??
    normalizeBrainProfile(snapshot?.providerRuntime?.brainProfile) ??
    normalizeBrainProfile(rawSnapshot?.runtimeConfig?.brainProfile) ??
    normalizeBrainProfile(rawSnapshot?.runtimeDiagnostics?.brainProfile) ??
    normalizeBrainProfile(
      (Array.isArray(rawSnapshot?.calls) ? rawSnapshot.calls : [])
        .map((call) => call?.runtimeDiagnostics?.brainProfile)
        .find(Boolean)
    ) ??
    normalizeBrainProfile(adviceSnapshot?.brainProfile) ??
    normalizeBrainProfile(bridgeConfig?.providerDefaults?.brainProfile)
  );
}

function attachBrainProfile(snapshot = {}, brainProfile = null) {
  const resolved = normalizeBrainProfile(brainProfile);
  if (!resolved) {
    return snapshot;
  }
  const providerRuntime = {
    ...(snapshot?.providerRuntime ?? snapshot?.diagnostics?.providerRuntime ?? {}),
    brainProfile: resolved
  };
  return {
    ...snapshot,
    brainProfile: resolved,
    providerRuntime,
    diagnostics: {
      ...(snapshot?.diagnostics ?? {}),
      brainProfile: resolved,
      providerRuntime
    }
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? null : Math.round(numeric * 100) / 100;
}

function roundPct(value) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? null : Math.round(numeric * 100) / 100;
}

function toDisplayBucketLabel(assetMaster = {}, bucket) {
  return (
    trimText(assetMaster?.buckets?.[bucket]?.label) ??
    trimText(assetMaster?.buckets?.[bucket]?.short_label) ??
    trimText(bucket) ??
    "未命名桶"
  );
}

function resolveFundCode(position = {}) {
  return (
    trimText(position?.code) ??
    trimText(position?.symbol) ??
    trimText(position?.fund_code) ??
    trimText(position?.fundCode)
  );
}

function resolveTradeAvailableCash(portfolioState = {}) {
  const summary = portfolioState?.summary ?? {};
  const cashLedger = portfolioState?.cash_ledger ?? {};
  return (
    toFiniteNumber(summary?.trade_available_cash_cny) ??
    toFiniteNumber(summary?.settled_cash_cny) ??
    toFiniteNumber(summary?.available_cash_cny) ??
    toFiniteNumber(cashLedger?.trade_available_cash_cny) ??
    toFiniteNumber(cashLedger?.settled_cash_cny) ??
    toFiniteNumber(cashLedger?.available_cash_cny) ??
    0
  );
}

function resolveMinTradeAmount(assetMaster = {}) {
  return toFiniteNumber(assetMaster?.cash_sweeper?.min_trade_amount_cny) ?? DEFAULT_MIN_TRADE_AMOUNT_CNY;
}

function resolvePortfolioTotalAssets(portfolioState = {}) {
  const summary = portfolioState?.summary ?? {};
  return (
    toFiniteNumber(summary?.total_portfolio_assets_cny) ??
    toFiniteNumber(summary?.totalPortfolioAssets) ??
    toFiniteNumber(summary?.total_assets_cny) ??
    0
  );
}

function resolveBucketTargetAmount(assetMaster = {}, bucket, totalAssetsCny = 0) {
  const target = toFiniteNumber(assetMaster?.buckets?.[bucket]?.target);
  if (target === null || totalAssetsCny <= 0) {
    return null;
  }
  return target * totalAssetsCny;
}

function buildAssetLookup(assetMaster = {}) {
  const bySymbol = new Map();
  const byName = new Map();
  for (const asset of asArray(assetMaster?.assets)) {
    const code = trimText(asset?.symbol);
    if (code) {
      bySymbol.set(code, asset);
    }
    const name = normalizeLookupText(asset?.name);
    if (name) {
      byName.set(name, asset);
    }
  }
  return {
    bySymbol,
    byName
  };
}

function normalizeLookupText(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function buildPositionLookup(portfolioState = {}, assetMaster = {}) {
  const assetLookup = buildAssetLookup(assetMaster);
  const positionsByFundCode = new Map();
  const heldBuckets = new Map();

  for (const position of asArray(portfolioState?.positions)) {
    if (String(position?.status ?? "").trim() && String(position.status).trim() !== "active") {
      continue;
    }

    const namedAsset = assetLookup.byName.get(normalizeLookupText(position?.name));
    const code = resolveFundCode(position) ?? trimText(namedAsset?.symbol);
    if (!code) {
      continue;
    }

    const assetMeta = assetLookup.bySymbol.get(code) ?? namedAsset ?? {};
    const amountCny =
      toFiniteNumber(position?.amount) ??
      toFiniteNumber(position?.observableAmount) ??
      toFiniteNumber(position?.observable_amount) ??
      0;
    const next = {
      fundCode: code,
      fundName: trimText(position?.name) ?? trimText(assetMeta?.name) ?? code,
      bucket: trimText(assetMeta?.bucket) ?? trimText(position?.bucket),
      amountCny,
      position
    };
    positionsByFundCode.set(code, next);

    if (next.bucket) {
      heldBuckets.set(next.bucket, (heldBuckets.get(next.bucket) ?? 0) + amountCny);
    }
  }

  return {
    positionsByFundCode,
    heldBuckets
  };
}

function buildFundSuggestionLookup(fundSuggestions = []) {
  const byBucket = new Map();

  for (const suggestion of asArray(fundSuggestions)) {
    const bucket = trimText(suggestion?.bucket);
    if (!bucket) {
      continue;
    }
    const current = byBucket.get(bucket) ?? [];
    current.push(suggestion);
    byBucket.set(bucket, current);
  }

  return byBucket;
}

function normalizeMode(value) {
  return String(value ?? "").trim().toLowerCase() || "fixture";
}

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function parseShanghaiDateAnchor(value) {
  const text = trimText(value);
  const dateText = text?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!dateText) {
    return null;
  }
  const date = new Date(`${dateText}T12:00:00+08:00`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    date,
    dateText
  };
}

function resolveTradingCalendarAnchor({ rawSnapshot = {}, adviceSnapshot = {}, now = new Date() } = {}) {
  return (
    parseShanghaiDateAnchor(rawSnapshot?.asOf) ??
    parseShanghaiDateAnchor(adviceSnapshot?.asOf) ??
    parseShanghaiDateAnchor(rawSnapshot?.generatedAt) ??
    parseShanghaiDateAnchor(adviceSnapshot?.generatedAt) ?? {
      date: now,
      dateText: formatShanghaiDate(now)
    }
  );
}

function resolveTradingCalendarState(date = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short"
  }).format(date);
  return weekday === "Sun" || weekday === "Sat" ? "weekend" : "trading_day";
}

function compareDateText(left, right) {
  const leftText = trimText(left);
  const rightText = trimText(right);
  if (!leftText || !rightText) {
    return 0;
  }
  return leftText.localeCompare(rightText);
}

function resolveMarketDataFreshnessRows(diagnostics = {}) {
  const refresh = diagnostics?.marketDataRefresh ?? {};
  return asArray(refresh?.freshnessAfter).length > 0
    ? asArray(refresh.freshnessAfter)
    : asArray(refresh?.freshnessBefore);
}

function resolveMarketDataLatestDates(diagnostics = {}) {
  return [
    ...new Set(resolveMarketDataFreshnessRows(diagnostics).map((item) => trimText(item?.latestDate)).filter(Boolean))
  ].sort((left, right) => right.localeCompare(left));
}

function resolveMarketProxyQuoteTier(snapshot = null) {
  const quotes = asArray(snapshot?.quotes);
  if (quotes.some((item) => trimText(item?.quoteTier) === "live")) {
    return "live";
  }
  if (quotes.some((item) => trimText(item?.quoteTier) === "delayed")) {
    return "delayed";
  }
  if (quotes.some((item) => trimText(item?.quoteTier) === "reference_close")) {
    return "reference_close";
  }
  if (quotes.length > 0 && quotes.every((item) => trimText(item?.quoteTier) === "missing")) {
    return "missing";
  }
  return null;
}

function resolveMarketProxyQuoteAsOf(snapshot = null) {
  return asArray(snapshot?.quotes)
    .map((item) => trimText(item?.quoteTime) ?? trimText(item?.quoteDate))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function labelMarketDataTier(tier) {
  switch (String(tier ?? "").trim()) {
    case "live":
      return "实时行情";
    case "delayed":
      return "延迟行情";
    case "reference_close":
      return "前收参考 · 非实时";
    case "reference":
      return "参考快照";
    case "stale":
      return "行情过旧";
    case "missing":
      return "行情缺失";
    default:
      return "行情未知";
  }
}

function resolveMarketProxyQuoteTierLabel(snapshot = null, tier = null) {
  const labels = [
    ...new Set(
      asArray(snapshot?.quotes)
        .map((item) => trimText(item?.displayLabel))
        .filter(Boolean)
    )
  ];
  const previousTradingDay = labels.find((item) => /上一交易日/.test(item));
  if (previousTradingDay) {
    return previousTradingDay;
  }
  const reference = labels.find((item) => /前收参考/.test(item));
  if (reference) {
    return reference;
  }
  return labelMarketDataTier(tier);
}

function labelDecisionReason(reason) {
  const text = String(reason ?? "").trim();
  if (!text) {
    return "原因未明";
  }
  if (text.startsWith("provider_rate_limited:")) {
    return "provider 触发限流";
  }
  if (text.startsWith("provider_connection_error:")) {
    return "provider 连接失败";
  }
  if (text.startsWith("market_data_")) {
    return `行情层：${labelMarketDataTier(text.replace(/^market_data_/, ""))}`;
  }
  if (text.startsWith("calendar_")) {
    return text === "calendar_weekend" ? "非交易日" : "交易日历限制";
  }
  switch (text) {
    case "confidence_below_watch_threshold":
      return "信号置信度未过观察阈值";
    case "confidence_below_action_threshold":
      return "信号置信度未过执行阈值";
    case "signal_continuity_insufficient":
      return "方向连续性不足";
    case "direction_flip_cooldown":
      return "方向刚反转，等待确认";
    case "bucket_not_enabled_for_execution":
      return "该桶暂不开放真实动作";
    case "neutral_or_hold_signal":
      return "中性/维持信号";
    case "cash_bucket_unavailable":
      return "CASH 承载桶可用资金不足";
    case "bucket_has_no_fund_mapping":
      return "桶缺少基金映射";
    case "no_current_holdings":
      return "当前无可卖持仓";
    case "held_position_not_mapped":
      return "持仓未完成本地映射";
    case "bucket_not_above_target":
      return "该桶未高于目标，减配只作为复核区间";
    case "bucket_not_below_target":
      return "该桶未低于目标，增配不生成金额区间";
    case "bucket_target_missing":
      return "该桶缺少目标权重，无法计算建议区间";
    case "below_min_trade_amount":
      return "建议区间低于最小交易额";
    case "snapshot_stale":
      return "TradingAgents 快照已过期";
    case "non_live_mode":
      return "当前不是 live 结果";
    default:
      return text;
  }
}

function labelDecisionReasons(reasons = []) {
  return asArray(reasons).map(labelDecisionReason);
}

function resolveMarketDataTier({ diagnostics = {}, rawSnapshot = {}, now = new Date() } = {}) {
  const proxyTier = resolveMarketProxyQuoteTier(diagnostics?.marketProxyQuotes);
  if (proxyTier) {
    return proxyTier;
  }

  const tradeDate = trimText(rawSnapshot?.asOf) ?? formatShanghaiDate(now);
  const freshnessRows = resolveMarketDataFreshnessRows(diagnostics);
  const latestDates = freshnessRows.map((item) => trimText(item?.latestDate)).filter(Boolean);
  if (freshnessRows.some((item) => trimText(item?.status) === "missing")) {
    return "missing";
  }
  if (freshnessRows.some((item) => trimText(item?.status) === "stale")) {
    return "stale";
  }
  if (normalizeMode(rawSnapshot?.mode) !== "live") {
    return "reference";
  }
  if (latestDates.length > 0 && latestDates.every((date) => compareDateText(date, tradeDate) < 0)) {
    return "reference_close";
  }
  return "live";
}

function isMarketDataExecutionReady(marketDataTier) {
  return ["live", "delayed", "reference_close"].includes(String(marketDataTier ?? "").trim());
}

function ratingToDirection(rating) {
  switch (normalizeTradingAgentsRating(rating)) {
    case "BUY":
    case "OVERWEIGHT":
      return "buy";
    case "SELL":
    case "UNDERWEIGHT":
      return "sell";
    default:
      return "hold";
  }
}

function compactSignalMemory(signalMemory = {}) {
  return asArray(signalMemory?.entries).slice(-SIGNAL_MEMORY_LIMIT);
}

function resolveSignalMemorySummary(signalMemory = {}, bucketSuggestions = []) {
  const entries = compactSignalMemory(signalMemory);
  const buckets = [];
  for (const suggestion of asArray(bucketSuggestions)) {
    const bucket = trimText(suggestion?.bucket);
    if (!bucket) {
      continue;
    }
    const direction = ratingToDirection(suggestion?.rating);
    const recent = entries.filter((entry) => trimText(entry?.bucket) === bucket).slice(-3);
    let sameDirectionStreak = 1;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (trimText(recent[index]?.direction) !== direction) {
        break;
      }
      sameDirectionStreak += 1;
    }
    const recentDirections = recent.map((entry) => trimText(entry?.direction)).filter(Boolean);
    const directionFlipCooldown =
      recentDirections.length >= 2 &&
      new Set([...recentDirections, direction].filter((item) => item && item !== "hold")).size > 1;
    buckets.push({
      bucket,
      direction,
      sameDirectionStreak,
      recentDirections,
      directionFlipCooldown
    });
  }
  return {
    updatedAt: trimText(signalMemory?.generatedAt) ?? null,
    lookback: SIGNAL_MEMORY_LIMIT,
    buckets
  };
}

function lookupBucketMemory(summary = {}, bucket) {
  return asArray(summary?.buckets).find((item) => trimText(item?.bucket) === trimText(bucket)) ?? {
    sameDirectionStreak: 1,
    recentDirections: [],
    directionFlipCooldown: false
  };
}

function isExecutionEnabled({ rawSnapshot = {}, diagnostics = {}, freshnessLabel = "unknown" } = {}) {
  const mode = normalizeMode(rawSnapshot?.mode);
  if (mode !== "live") {
    return false;
  }
  if (freshnessLabel !== "fresh") {
    return false;
  }
  return !trimText(diagnostics?.providerError) && !trimText(diagnostics?.fallbackReason);
}

function toActionProfile(rating) {
  switch (normalizeTradingAgentsRating(rating)) {
    case "BUY":
    case "OVERWEIGHT":
      return { stance: "buy", actionLabel: "增配候选" };
    case "SELL":
    case "UNDERWEIGHT":
      return { stance: "sell", actionLabel: "减配候选" };
    default:
      return { stance: "hold", actionLabel: "观察" };
  }
}

function normalizeProviderName(value) {
  return String(value ?? "provider").trim().toLowerCase() || "provider";
}

export function summarizeTradingAgentsProviderError(value, provider = "provider") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  if (/^provider_(timeout|rate_limited|connection_error):[a-z0-9_-]+$/i.test(text)) {
    return text;
  }
  const providerName = normalizeProviderName(provider);
  if (/APITimeoutError|ReadTimeout|timed out|timeout/i.test(text)) {
    return `provider_timeout:${providerName}`;
  }
  if (/openai\.RateLimitError|RateLimitError|Rate limit reached|Error code:\s*429|code['"]?:\s*['"]?1302/i.test(text)) {
    return `provider_rate_limited:${providerName}`;
  }
  if (/openai\.APIConnectionError|APIConnectionError|RemoteProtocolError|Server disconnected without sending a response|Connection error/i.test(text)) {
    return `provider_connection_error:${providerName}`;
  }
  if (/YFRateLimitError|Too Many Requests|rate limited/i.test(text)) {
    return "market_data_rate_limited:yfinance";
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function buildDecisionHeadline(verdict) {
  switch (verdict) {
    case "limited_execute":
      return "今天可做有限动作";
    case "reduce_risk":
      return "今天以降风险为主";
    case "risk_watch":
      return "今天只进入风险观察";
    case "blocked":
      return "当前无法形成可靠交易判断";
    default:
      return "今天以观察为主";
  }
}

function buildDecisionSummary({
  verdict,
  mode,
  provider,
  realActions = [],
  observeLine = [],
  blockedSuggestions = [],
  diagnostics = {}
} = {}) {
  const fallbackReason = trimText(diagnostics?.fallbackReason);
  const providerError = summarizeTradingAgentsProviderError(diagnostics?.providerError, provider);
  const freshnessLabel = trimText(diagnostics?.freshnessLabel) ?? "unknown";
  const providerLabel =
    trimText(providerError?.match(/^provider_[^:]+:([^:]+)/i)?.[1]) ??
    trimText(provider) ??
    "provider";

  if (providerError) {
    return `${providerLabel} live 调用失败，当前仅展示降级观察结论；原因：${providerError}`;
  }

  if (fallbackReason) {
    return `当前展示为 ${mode || "fallback"} 结果，不形成真实执行动作；原因：${fallbackReason}`;
  }

  if (freshnessLabel !== "fresh") {
    return "当前建议已超出有效时效窗口，只保留观察线和风险提示，不生成真实动作。";
  }

  if (verdict === "reduce_risk") {
    return `已形成 ${realActions.length} 条减配/退出候选，其余 ${observeLine.length} 条继续观察。`;
  }

  if (verdict === "limited_execute") {
    const buyCount = realActions.filter((item) => item?.stance === "buy").length;
    const sellCount = realActions.filter((item) => item?.stance === "sell").length;
    return `已形成 ${realActions.length} 条真实动作（增配 ${buyCount} / 减配 ${sellCount}），另有 ${blockedSuggestions.length} 条被本地护栏拦下。`;
  }

  if (verdict === "blocked") {
    return "当前缺少可依赖的 live 决策结果，请先检查 provider、raw snapshot 或本地映射配置。";
  }

  if (verdict === "risk_watch") {
    return `TradingAgents 已给出方向信号，但本地基金护栏未放行真实动作；保留 ${observeLine.length} 条风险观察。`;
  }

  return `当前没有足够强的可执行基金动作；保留 ${observeLine.length} 条观察线，拦下 ${blockedSuggestions.length} 条建议。`;
}

function isActionConstraintReason(reason) {
  return [
    "bucket_not_below_target",
    "bucket_not_above_target",
    "below_min_trade_amount",
    "cash_below_min_trade_amount",
    "bucket_target_gap_unavailable",
    "trade_cash_unavailable",
    "unmapped_fund",
    "no_held_position",
    "blocked_bucket"
  ].includes(trimText(reason));
}

function compactObservationItem(item = {}, fallbackTitle = "观察") {
  const reasonLabels = asArray(item?.reasonLabels);
  const reasons = asArray(item?.reasons);
  return {
    bucket: item?.bucket ?? null,
    bucketLabel: item?.bucketLabel ?? item?.bucket ?? null,
    verdict: item?.verdict ?? null,
    executionState: item?.executionState ?? null,
    title: item?.bucketLabel ?? item?.bucket ?? fallbackTitle,
    oneLine: trimText(item?.note) ?? trimText(item?.reasonSummary) ?? fallbackTitle,
    reasons,
    reasonLabels
  };
}

function buildObservationGroups({
  observeLine = [],
  bucketActions = [],
  decisionContext = {},
  diagnostics = {},
  mode = null,
  providerRuntime = {},
  providerError = null,
  fallbackReason = null
} = {}) {
  const directionObservations = [];
  const actionConstraints = [];
  const dataConstraints = [];

  for (const item of asArray(observeLine)) {
    const compact = compactObservationItem(item, "方向观察");
    directionObservations.push({
      ...compact,
      oneLine: `${compact.bucketLabel ?? compact.bucket ?? "该桶"} ${compact.verdict ?? "观察"}；${trimText(item?.note) ?? "继续观察。"}`
    });
    const constraintReasons = asArray(item?.reasons).filter(isActionConstraintReason);
    if (constraintReasons.length > 0 || ["blocked", "risk_watch"].includes(trimText(item?.executionState))) {
      const labels = labelDecisionReasons(constraintReasons.length > 0 ? constraintReasons : item?.reasons);
      actionConstraints.push({
        ...compact,
        reasons: constraintReasons.length > 0 ? constraintReasons : asArray(item?.reasons),
        reasonLabels: labels,
        oneLine: `${compact.bucketLabel ?? compact.bucket ?? "该桶"}：${labels.join(" / ") || compact.oneLine}`
      });
    }
  }

  for (const item of asArray(bucketActions)) {
    const bucket = trimText(item?.bucket);
    if (!bucket || directionObservations.some((row) => row.bucket === bucket)) {
      continue;
    }
    if (trimText(item?.verdict) || trimText(item?.executionState)) {
      directionObservations.push({
        bucket,
        bucketLabel: item?.bucketLabel ?? bucket,
        verdict: item?.verdict ?? null,
        executionState: item?.executionState ?? null,
        title: item?.bucketLabel ?? bucket,
        oneLine: `${item?.bucketLabel ?? bucket} ${item?.verdict ?? "观察"}。`,
        reasons: asArray(item?.reasons),
        reasonLabels: labelDecisionReasons(item?.reasons)
      });
    }
  }

  const marketLabel = trimText(decisionContext?.marketDataTierLabel) ?? labelMarketDataTier(decisionContext?.marketDataTier);
  if (marketLabel && !["实时行情", "延迟行情"].includes(marketLabel)) {
    dataConstraints.push({
      title: "行情时效",
      oneLine: `${marketLabel}${decisionContext?.marketDataAsOf ? ` · as-of ${decisionContext.marketDataAsOf}` : ""}`,
      source: "market_data"
    });
  }
  const freshnessLabel = trimText(diagnostics?.freshnessLabel);
  if (freshnessLabel && freshnessLabel !== "fresh") {
    dataConstraints.push({
      title: "主脑快照",
      oneLine: `TradingAgents 快照 ${freshnessLabel}，仅保留观察。`,
      source: "freshness"
    });
  }
  const providerMode = trimText(providerRuntime?.providerMode);
  if (providerError || fallbackReason || normalizeMode(mode) !== "live" || providerMode === "fallback_fixture") {
    dataConstraints.push({
      title: "Provider",
      oneLine: providerError
        ? `live provider 异常：${providerError}`
        : fallbackReason
          ? `当前为降级观察：${fallbackReason}`
          : "当前不是 live 主脑结果。",
      source: "provider"
    });
  }

  return {
    directionObservations,
    actionConstraints,
    dataConstraints
  };
}

function buildMorningBrief({
  shouldTradeVerdict,
  riskLight,
  realActions = [],
  observeLine = [],
  observationGroups = {},
  deepDiveCandidates = [],
  decisionSummary = ""
} = {}) {
  const actionConstraints = asArray(observationGroups?.actionConstraints);
  const directionObservations = asArray(observationGroups?.directionObservations);
  const dataConstraints = asArray(observationGroups?.dataConstraints);
  const firstConstraint = actionConstraints[0];
  const maintainBuckets = directionObservations
    .filter((item) => /维持|观察|HOLD/i.test(String(item?.verdict ?? item?.oneLine ?? "")))
    .map((item) => item.bucketLabel ?? item.bucket)
    .filter(Boolean)
    .slice(0, 2);
  const highDeepDive = asArray(deepDiveCandidates).filter((item) => item?.deepDiveTrigger?.level === "high");

  let headline = trimText(decisionSummary) ?? "等待 TradingAgents 主链。";
  if (realActions.length > 0) {
    headline = `今天形成 ${realActions.length} 条只读动作候选，仍需人工复核后再处理。`;
  } else if (shouldTradeVerdict === "risk_watch" && firstConstraint) {
    headline = `${firstConstraint.bucketLabel ?? firstConstraint.bucket ?? "有方向信号"}有方向信号，但${firstConstraint.reasonLabels?.[0] ?? "本地护栏未放行"}，今天不生成真实动作${maintainBuckets.length > 0 ? `；${maintainBuckets.join("和")}维持观察` : ""}。`;
  } else if (shouldTradeVerdict === "blocked") {
    headline = "当前无法形成可靠交易判断，先处理 provider、行情或映射问题。";
  } else if (shouldTradeVerdict === "observe_only") {
    headline = "今天以观察为主，未形成足够强的基金动作候选。";
  }

  const actionExplanation = realActions.length > 0
    ? `为什么有动作：${realActions.length} 条候选通过本地基金护栏；建议区间仍是 review_only，不构成订单。`
    : actionConstraints.length > 0
      ? `为什么没有真实动作：${actionConstraints.map((item) => item.oneLine).slice(0, 2).join("；")}。`
      : "为什么没有真实动作：当前方向不足以通过本地基金护栏，先观察不执行。";

  const watchFocus = [
    firstConstraint ? `${firstConstraint.bucketLabel ?? firstConstraint.bucket}：${firstConstraint.reasonLabels?.[0] ?? firstConstraint.oneLine}` : null,
    highDeepDive[0] ? `深看 ${highDeepDive[0].fundName}` : null,
    dataConstraints[0] ? dataConstraints[0].oneLine : null,
    directionObservations.find((item) => item !== firstConstraint)?.oneLine
  ].filter(Boolean).slice(0, 3);

  while (watchFocus.length < 3) {
    watchFocus.push(["确认净值链更新后再对账收益", "复核深看候选是否需要人工调整", "等待下一次 TradingAgents live cache"][watchFocus.length]);
  }

  return {
    headline,
    actionExplanation,
    watchFocus,
    actionStateLabel: realActions.length > 0
      ? "有只读动作候选"
      : shouldTradeVerdict === "risk_watch"
        ? "有方向但不动作"
        : shouldTradeVerdict === "blocked"
          ? "主脑受阻"
          : "观察为主",
    riskLight
  };
}

function pickPrimaryFundSuggestion(suggestions = [], positionsByFundCode = new Map(), stance = "hold") {
  const sorted = [...asArray(suggestions)].sort((left, right) => {
    const leftHeld = positionsByFundCode.get(String(left?.fundCode ?? "").trim());
    const rightHeld = positionsByFundCode.get(String(right?.fundCode ?? "").trim());
    const leftAmount = leftHeld?.amountCny ?? 0;
    const rightAmount = rightHeld?.amountCny ?? 0;
    if (stance === "sell" && leftAmount !== rightAmount) {
      return rightAmount - leftAmount;
    }
    if (stance === "buy") {
      const leftHasHeld = leftAmount > 0 ? 1 : 0;
      const rightHasHeld = rightAmount > 0 ? 1 : 0;
      if (leftHasHeld !== rightHasHeld) {
        return rightHasHeld - leftHasHeld;
      }
      if (leftAmount !== rightAmount) {
        return leftAmount - rightAmount;
      }
    }
    return String(left?.fundCode ?? "").localeCompare(String(right?.fundCode ?? ""), "zh-CN");
  });
  return sorted[0] ?? null;
}

function buildPassiveBucketVerdicts(assetMaster = {}, bridgeConfig = {}, heldBuckets = new Map(), existingBuckets = new Set()) {
  const passiveBuckets = new Set(asArray(bridgeConfig?.blockedBuckets));
  const items = [];

  for (const bucket of passiveBuckets) {
    if (existingBuckets.has(bucket)) {
      continue;
    }
    const heldAmountCny = heldBuckets.get(bucket) ?? 0;
    items.push({
      bucket,
      bucketLabel: toDisplayBucketLabel(assetMaster, bucket),
      rating: null,
      verdict: "观察 / 维持",
      confidence: null,
      executionState: "observe",
      reasonSummary:
        heldAmountCny > 0
          ? "该防守桶已纳入全组合判断，但第一版不生成主动进攻动作，先维持/观察。"
          : "该防守桶本轮只纳入全组合判断，不生成主动进攻动作。",
      risks: [],
      signalCount: 0,
      proxySymbols: [],
      riskJudge: null,
      investmentJudge: null,
      heldAmountCny
    });
  }

  return items;
}

function decorateBlockedSuggestion(item = {}, reason, extra = {}) {
  return {
    symbol: trimText(item?.symbol),
    bucket: trimText(item?.bucket),
    fundCode: trimText(item?.fundCode),
    fundName: trimText(item?.fundName),
    verdict: trimText(item?.verdict),
    reason: trimText(reason) ?? trimText(item?.reason) ?? "blocked",
    guardrailStatus: "blocked",
    ...extra
  };
}

function buildFundCandidate(suggestion = {}, positionsByFundCode = new Map(), profile = {}) {
  const fundCode = String(suggestion?.fundCode ?? "").trim();
  const held = positionsByFundCode.get(fundCode);
  return {
    fundCode: suggestion?.fundCode,
    fundName: suggestion?.fundName,
    bucket: suggestion?.bucket,
    stance: profile?.stance ?? "hold",
    actionLabel: profile?.actionLabel ?? "观察",
    verdict: suggestion?.verdict,
    rating: suggestion?.rating,
    confidence: suggestion?.confidence ?? null,
    confidenceSource: trimText(suggestion?.confidenceSource),
    reasonSummary: suggestion?.reasonSummary,
    proxySymbols: suggestion?.proxySymbols ?? [],
    heldAmountCny: held?.amountCny ?? 0,
    isHeld: Boolean(held)
  };
}

function buildPctRange(range, denominator) {
  const base = toFiniteNumber(denominator);
  if (!range || !base || base <= 0) {
    return null;
  }
  return {
    min: roundPct((Number(range.min) / base) * 100),
    max: roundPct((Number(range.max) / base) * 100)
  };
}

function normalizeAmountRange({ min, max, minTradeAmountCny, warnings = [] } = {}) {
  const resolvedMax = toFiniteNumber(max);
  if (resolvedMax === null || resolvedMax < minTradeAmountCny) {
    return {
      range: null,
      warnings: [...warnings, "below_min_trade_amount"]
    };
  }
  const resolvedMin = Math.min(resolvedMax, Math.max(minTradeAmountCny, toFiniteNumber(min) ?? minTradeAmountCny));
  return {
    range: {
      min: roundMoney(resolvedMin),
      max: roundMoney(resolvedMax)
    },
    warnings
  };
}

function buildActionSizing({
  stance,
  currentHoldingAmountCny = 0,
  bucketHeldAmountCny = 0,
  targetAmountCny = null,
  tradeAvailableCashCny = 0,
  totalAssetsCny = 0,
  minTradeAmountCny = DEFAULT_MIN_TRADE_AMOUNT_CNY
} = {}) {
  const currentHolding = toFiniteNumber(currentHoldingAmountCny) ?? 0;
  const bucketHeld = toFiniteNumber(bucketHeldAmountCny) ?? 0;
  const cash = toFiniteNumber(tradeAvailableCashCny) ?? 0;
  const target = toFiniteNumber(targetAmountCny);

  if (stance === "sell") {
    if (currentHolding <= 0) {
      return {
        currentHoldingAmountCny: roundMoney(currentHolding),
        suggestedAmountRangeCny: null,
        suggestedPctRange: null,
        sizingBasis: "holding_pct_and_bucket_gap",
        sizingWarnings: ["no_current_holdings"],
        executionIntent: "review_only"
      };
    }

    const warnings = [];
    let maxAmount = null;
    if (target === null) {
      warnings.push("bucket_target_missing");
      maxAmount = currentHolding * 0.1;
    } else if (bucketHeld > target) {
      maxAmount = Math.min(currentHolding * 0.25, bucketHeld - target);
    } else {
      warnings.push("bucket_not_above_target");
      maxAmount = currentHolding * 0.1;
    }

    const { range, warnings: sizingWarnings } = normalizeAmountRange({
      min: currentHolding * 0.05,
      max: maxAmount,
      minTradeAmountCny,
      warnings
    });
    return {
      currentHoldingAmountCny: roundMoney(currentHolding),
      suggestedAmountRangeCny: range,
      suggestedPctRange: buildPctRange(range, currentHolding),
      sizingBasis: "holding_pct_and_bucket_gap",
      sizingWarnings,
      executionIntent: "review_only"
    };
  }

  if (stance === "buy") {
    const warnings = [];
    let maxAmount = null;
    if (target === null) {
      warnings.push("bucket_target_missing");
    } else if (target <= bucketHeld) {
      warnings.push("bucket_not_below_target");
    } else if (cash <= 0) {
      warnings.push("cash_bucket_unavailable");
    } else {
      maxAmount = Math.min(cash * 0.25, target - bucketHeld);
    }

    const { range, warnings: sizingWarnings } = normalizeAmountRange({
      min: minTradeAmountCny,
      max: maxAmount,
      minTradeAmountCny,
      warnings
    });
    return {
      currentHoldingAmountCny: roundMoney(currentHolding),
      suggestedAmountRangeCny: range,
      suggestedPctRange: buildPctRange(range, totalAssetsCny),
      sizingBasis: "cash_pct_and_bucket_gap",
      sizingWarnings,
      executionIntent: "review_only"
    };
  }

  return {
    currentHoldingAmountCny: roundMoney(currentHolding),
    suggestedAmountRangeCny: null,
    suggestedPctRange: null,
    sizingBasis: "not_directional",
    sizingWarnings: [],
    executionIntent: "review_only"
  };
}

function stripMarkdownText(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function firstReadableSentence(value, maxLength = 92) {
  const text = stripMarkdownText(value)
    .replace(/^(评级|执行摘要|投资论点|最终决策|关键证据|一句话总结)\s*[:：]?\s*/i, "")
    .trim();
  const candidates = text
    .split(/(?<=[。！？!?；;])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const picked = candidates.find((item) => item.length >= 12) ?? candidates[0] ?? text;
  return picked.length > maxLength ? `${picked.slice(0, maxLength - 3)}...` : picked;
}

function sanitizeFundOnlyText(value, { stance = "hold", bucketLabel = "" } = {}) {
  let text = firstReadableSentence(value);
  text = text
    .replace(/立即执行|立即/g, "本地仅提示")
    .replace(/卖出\s*\(Sell\)|市价卖出|开盘后[^，。；;]*卖出|无条件清仓|清仓|卖出/g, stance === "sell" ? "减配候选" : "观察")
    .replace(/大幅减仓|减仓\s*\d+(?:\.\d+)?%?\s*(?:以上|以内)?/g, "按复核区间减配")
    .replace(/限价单|订单|下单/g, "复核提示")
    .replace(/当前价位/g, "参考价位")
    .replace(/止损线|止损|移动止损/g, "风险复核线")
    .replace(/做空|空单|买入虚值看跌期权|行权价/g, "风险对冲观察")
    .replace(/禁止在当前价格[^。；;]*买入/g, "暂不追高")
    .replace(/\$[0-9]+(?:\.[0-9]+)?/g, "对应价格位")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || containsStockExecutionLanguage(text)) {
    const actionLabel = stance === "sell" ? "减配候选" : stance === "buy" ? "增配候选" : "观察";
    return `${bucketLabel || "该方向"} 为 ${actionLabel}，本地只给基金复核区间，不构成订单。`;
  }
  return text;
}

function containsStockExecutionLanguage(value) {
  return /市价|清仓|止损|开盘|做空|期权|卖出|减仓|立即|限价单|下单/.test(String(value ?? ""));
}

function formatRangeForSummary(range) {
  if (!range || toFiniteNumber(range.min) === null || toFiniteNumber(range.max) === null) {
    return "仅复核";
  }
  const formatter = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0
  });
  return `${formatter.format(range.min)}-${formatter.format(range.max)}`;
}

function buildActionSummaryFields({
  reasonSummary,
  stance,
  actionLabel,
  bucketLabel,
  suggestedAmountRangeCny,
  sizingWarnings = []
} = {}) {
  const rangeText = formatRangeForSummary(suggestedAmountRangeCny);
  const warningText = asArray(sizingWarnings).length > 0 ? `；限制：${labelDecisionReasons(sizingWarnings).join(" / ")}` : "";
  const actionOneLine = `${bucketLabel || "该桶"} ${actionLabel || stance || "观察"}，只读复核区间 ${rangeText}，不构成订单${warningText}`;
  const fundReasonOneLine = sanitizeFundOnlyText(reasonSummary, { stance, bucketLabel });
  const riskOneLine = stance === "sell"
    ? "风险灯优先按降风险解释；减配区间用于复核，不等同于全卖。"
    : stance === "buy"
      ? "增配只在现金与目标缺口允许时作为候选，不自动执行。"
      : "当前仅观察，不形成基金动作。";
  const digest = [
    fundReasonOneLine,
    actionOneLine
  ].filter(Boolean);
  return {
    actionOneLine,
    riskOneLine,
    fundReasonOneLine,
    evidenceDigest: digest,
    rawEvidenceRef: "reasonSummary"
  };
}

function buildBucketAction({
  bucketSuggestion = {},
  bucketLabel,
  rating,
  profile,
  heldAmountCny,
  executionState,
  reasons = [],
  candidateFunds = [],
  primaryAction = null
} = {}) {
  return {
    bucket: trimText(bucketSuggestion?.bucket),
    bucketLabel,
    rating,
    direction: profile?.stance ?? "hold",
    verdict: trimText(bucketSuggestion?.verdict),
    confidence: bucketSuggestion?.confidence ?? null,
    confidenceSource: trimText(bucketSuggestion?.confidenceSource),
    actionLevel: executionState === "real" ? "real_candidate" : executionState,
    executionState,
    reasons,
    reasonLabels: labelDecisionReasons(reasons),
    reasonSummary: trimText(bucketSuggestion?.reasonSummary) ?? "暂无明确论据",
    proxySymbols: asArray(bucketSuggestion?.proxySymbols),
    signalCount: Number(bucketSuggestion?.signalCount ?? 0) || 0,
    heldAmountCny,
    primaryAction,
    candidateFunds,
    riskJudge: trimText(bucketSuggestion?.riskJudge),
    investmentJudge: trimText(bucketSuggestion?.investmentJudge)
  };
}

function resolvePositionAmount(position = {}) {
  return (
    toFiniteNumber(position?.amount) ??
    toFiniteNumber(position?.observableAmount) ??
    toFiniteNumber(position?.observable_amount) ??
    0
  );
}

function resolvePositionHoldingPnl(position = {}) {
  return roundMoney(
    toFiniteNumber(position?.holdingPnl) ??
      toFiniteNumber(position?.holding_pnl) ??
      toFiniteNumber(position?.holding_profit) ??
      0
  );
}

function resolvePositionDayPnl(position = {}) {
  return roundMoney(
    toFiniteNumber(position?.dayPnl) ??
      toFiniteNumber(position?.daily_pnl) ??
      toFiniteNumber(position?.estimatedPnl) ??
      toFiniteNumber(position?.estimated_pnl) ??
      0
  );
}

function resolveConfirmationState(position = {}) {
  return (
    trimText(position?.confirmationState) ??
    trimText(position?.confirmation_state) ??
    trimText(position?.dialogue_merge_status) ??
    trimText(position?.quoteMode) ??
    "unknown"
  );
}

function formatShortMoney(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "--";
  }
  if (Math.abs(numeric) >= 10000) {
    return `${roundPct(numeric / 10000)}万`;
  }
  return `${Math.round(numeric)}元`;
}

function describePnl(value, prefix) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return `${prefix}--`;
  }
  if (numeric > 0) {
    return `${prefix}+${formatShortMoney(numeric)}`;
  }
  if (numeric < 0) {
    return `${prefix}-${formatShortMoney(Math.abs(numeric))}`;
  }
  return `${prefix}持平`;
}

function resolveHoldingPnlRatePct({ amountCny = 0, holdingPnl = 0 } = {}) {
  const amount = toFiniteNumber(amountCny);
  const pnl = toFiniteNumber(holdingPnl);
  if (amount === null || pnl === null) {
    return null;
  }
  const costBasis = amount - pnl;
  return costBasis > 0 ? roundPct((pnl / costBasis) * 100) : null;
}

function resolveDayPnlRatePct({ amountCny = 0, dayPnl = 0 } = {}) {
  const amount = toFiniteNumber(amountCny);
  const pnl = toFiniteNumber(dayPnl);
  return amount && pnl !== null ? roundPct((pnl / amount) * 100) : null;
}

function resolveFundTradeStance({ bucketAction = null, fundCode, bucket, mode, providerRuntime = null } = {}) {
  if (normalizeMode(mode) !== "live" || trimText(providerRuntime?.providerMode) === "fallback_fixture") {
    return "仅观察";
  }
  const executionState = trimText(bucketAction?.executionState);
  const direction = trimText(bucketAction?.direction);
  const primaryFundCode = trimText(bucketAction?.primaryAction?.fundCode);
  if (executionState === "real" && primaryFundCode === trimText(fundCode)) {
    return bucketAction?.primaryAction?.actionLabel ?? (direction === "sell" ? "减配候选" : "增配候选");
  }
  if (["HEDGE", "INCOME", "CASH"].includes(trimText(bucket))) {
    return "防守维持";
  }
  if (direction === "sell") {
    return executionState === "blocked" ? "减配被拦" : "减配复核";
  }
  if (direction === "buy") {
    return executionState === "blocked" ? "增配被拦" : "增配观察";
  }
  return "维持观察";
}

function buildFundRiskNote({ position = {}, bucketAction = null, confirmationState = "unknown", sourceLabel = "" } = {}) {
  const notes = [];
  const firstReason = asArray(bucketAction?.reasonLabels)[0] ?? asArray(bucketAction?.reasons)[0];
  if (firstReason) {
    notes.push(firstReason);
  }
  if (confirmationState && !["confirmed", "normal", "normal_lag"].includes(confirmationState)) {
    notes.push(`确认状态 ${confirmationState}`);
  }
  const dayPnl = resolvePositionDayPnl(position);
  if (dayPnl !== null && dayPnl < 0) {
    notes.push("今日观察为负");
  }
  if (/fallback/.test(sourceLabel)) {
    notes.push("非 live 主脑");
  }
  return notes.slice(0, 3).join(" / ") || "暂无额外风险提示";
}

export function buildFundDeepDiveTrigger({ fundAnalysis = {}, factorProfile = {} } = {}) {
  const reasons = [];
  const addReason = (code, label, priority) => {
    if (!reasons.some((item) => item.code === code)) {
      reasons.push({ code, label, priority });
    }
  };
  const amountCny = toFiniteNumber(fundAnalysis?.amountCny) ?? 0;
  const weightPct = toFiniteNumber(fundAnalysis?.weightPct);
  const holdingPnl = toFiniteNumber(fundAnalysis?.holdingPnl) ?? 0;
  const dayPnl = toFiniteNumber(fundAnalysis?.dayPnl) ?? 0;
  const holdingPnlRatePct = resolveHoldingPnlRatePct({ amountCny, holdingPnl });
  const dayPnlRatePct = resolveDayPnlRatePct({ amountCny, dayPnl });
  const tradeStance = trimText(fundAnalysis?.tradeStance) ?? "";
  const confirmationState = trimText(fundAnalysis?.confirmationState) ?? "unknown";
  const factor = trimText(factorProfile?.primaryFactor) ?? trimText(fundAnalysis?.factorProfile?.primaryFactor);
  const bucket = trimText(fundAnalysis?.bucket);
  const factorLabel = trimText(factorProfile?.primaryFactorLabel) ?? trimText(fundAnalysis?.factorProfile?.primaryFactorLabel) ?? factor;
  const isBondCash = factor === "BOND_CASH" || bucket === "CASH";
  const isHighBeta = ["TACTICAL_HIGH_BETA", "CHINA_INTERNET", "US_SEMI"].includes(factor);
  const isGoldOrCommodity = factor === "GOLD";
  const isDividend = factor === "HK_DIVIDEND";
  const assetClass = isBondCash
    ? "bond_cash"
    : isHighBeta
      ? "high_beta"
      : isGoldOrCommodity
        ? "gold_commodity"
        : isDividend
          ? "dividend_low_vol"
          : "equity";

  if (/候选|被拦|减配/.test(tradeStance)) {
    addReason("action_state", `动作语义为 ${tradeStance}`, /减配|被拦/.test(tradeStance) ? 92 : 82);
  }
  if (holdingPnlRatePct !== null) {
    if (isBondCash) {
      if (holdingPnlRatePct <= -2) {
        addReason("bond_cash_abnormal_drawdown", `债券/现金替代持有亏损 ${holdingPnlRatePct}%`, 88);
      } else if (holdingPnlRatePct <= -1) {
        addReason("bond_cash_drawdown_watch", `债券/现金替代持有亏损 ${holdingPnlRatePct}%`, 66);
      }
    } else if (isHighBeta) {
      if (holdingPnlRatePct <= -8) {
        addReason("large_holding_drawdown", `持有亏损 ${holdingPnlRatePct}%`, 90);
      } else if (holdingPnlRatePct <= -5) {
        addReason("holding_drawdown_watch", `持有亏损 ${holdingPnlRatePct}%`, 74);
      }
    } else if (isGoldOrCommodity || isDividend) {
      if (holdingPnlRatePct <= -8) {
        addReason("large_holding_drawdown", `持有亏损 ${holdingPnlRatePct}%`, 86);
      } else if (holdingPnlRatePct <= -5) {
        addReason("holding_drawdown_watch", `持有亏损 ${holdingPnlRatePct}%`, 70);
      }
    } else if (holdingPnlRatePct <= -10) {
      addReason("large_holding_drawdown", `持有亏损 ${holdingPnlRatePct}%`, 88);
    } else if (holdingPnlRatePct <= -6) {
      addReason("holding_drawdown_watch", `持有亏损 ${holdingPnlRatePct}%`, 72);
    }
  }
  if (dayPnlRatePct !== null && dayPnlRatePct <= (isBondCash ? -0.5 : -2)) {
    addReason(isBondCash ? "bond_cash_day_move" : "large_day_drawdown", `今日观察 ${dayPnlRatePct}%`, isBondCash ? 76 : 86);
  } else if (!isBondCash && dayPnl <= -500) {
    addReason("day_pnl_drag", `今日拖累 ${formatShortMoney(Math.abs(dayPnl))}`, 70);
  }
  if (weightPct !== null) {
    if (!isBondCash && isHighBeta && weightPct >= 5) {
      addReason("position_concentration", `组合权重 ${weightPct}%`, 78);
    } else if (!isBondCash && isGoldOrCommodity && weightPct >= 10) {
      addReason("position_concentration", `组合权重 ${weightPct}%`, 72);
    } else if (!isBondCash && isDividend && weightPct >= 15) {
      addReason("position_concentration", `组合权重 ${weightPct}%`, 70);
    } else if (!isBondCash && weightPct >= 10) {
      addReason("position_concentration", `组合权重 ${weightPct}%`, 76);
    }
  }
  if (["late_missing", "source_missing"].includes(confirmationState)) {
    addReason("confirmation_missing", `确认状态 ${confirmationState}`, 68);
  } else if (confirmationState === "materialized_from_execution_ledger") {
    addReason("ledger_materialized", "账本物化仓位，需确认净值承接", 58);
  }
  if (isHighBeta && (weightPct ?? 0) >= 2) {
    addReason("high_beta_factor", `${factorLabel} 高波动因子`, 62);
  }

  const sorted = reasons.sort((left, right) => right.priority - left.priority);
  const priority = sorted[0]?.priority ?? 0;
  const level = priority >= 85 ? "high" : priority >= 65 ? "medium" : priority > 0 ? "low" : "normal";
  const needed = priority >= 65;
  const reasonLabels = sorted.map((item) => item.label).slice(0, 4);
  return {
    needed,
    level,
    priority,
    reasons: sorted.map((item) => item.code),
    reasonLabels,
    holdingPnlRatePct,
    dayPnlRatePct,
    assetClass,
    oneLine: needed
      ? `${fundAnalysis?.fundName ?? fundAnalysis?.fundCode ?? "该基金"} 建议深看：${reasonLabels.slice(0, 2).join(" / ")}。`
      : `${fundAnalysis?.fundName ?? fundAnalysis?.fundCode ?? "该基金"} 暂不需要单独深看。`
  };
}

function attachFundDeepDiveTriggers(fundAnalyses = []) {
  return asArray(fundAnalyses).map((item) => {
    const deepDiveTrigger = item?.deepDiveTrigger ?? buildFundDeepDiveTrigger({
      fundAnalysis: item,
      factorProfile: item?.factorProfile
    });
    return {
      ...item,
      deepDiveTrigger,
      statusOneLine: trimText(item?.statusOneLine) ?? buildFundStatusOneLine({
        fundAnalysis: item,
        factorProfile: item?.factorProfile,
        deepDiveTrigger
      })
    };
  });
}

function buildDeepDiveCandidates(fundAnalyses = [], limit = 8) {
  return asArray(fundAnalyses)
    .filter((item) => item?.deepDiveTrigger?.needed)
    .sort((left, right) => {
      const priorityDelta = (toFiniteNumber(right?.deepDiveTrigger?.priority) ?? 0) -
        (toFiniteNumber(left?.deepDiveTrigger?.priority) ?? 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return (toFiniteNumber(right?.amountCny) ?? 0) - (toFiniteNumber(left?.amountCny) ?? 0);
    })
    .slice(0, limit)
    .map((item) => {
      const candidate = {
        fundCode: item?.fundCode ?? null,
        fundName: item?.fundName ?? null,
        bucket: item?.bucket ?? null,
        bucketLabel: item?.bucketLabel ?? null,
        factorLabel: item?.factorProfile?.primaryFactorLabel ?? null,
        factorProfile: item?.factorProfile ?? null,
        researchProfile: item?.researchProfile ?? null,
        researchProfileQuality: item?.researchProfileQuality ?? null,
        amountCny: item?.amountCny ?? null,
        weightPct: item?.weightPct ?? null,
        dayPnl: item?.dayPnl ?? null,
        holdingPnl: item?.holdingPnl ?? null,
        tradeStance: item?.tradeStance ?? null,
        confirmationState: item?.confirmationState ?? null,
        statusOneLine: item?.statusOneLine ?? null,
        riskNote: item?.riskNote ?? null,
        sourceLabel: item?.sourceLabel ?? null,
        deepDiveTrigger: item?.deepDiveTrigger ?? null
      };
      return {
        ...candidate,
        deepDiveAnalysis: buildDeepDiveAnalysis(candidate)
      };
    });
}

function describeConfirmationForDeepDive(state) {
  switch (trimText(state)) {
    case "confirmed":
      return "确认净值已承接，可直接用当前账本口径复核。";
    case "normal_lag":
      return "QDII/跨市场正常滞后，先看代理行情与观察估值，等确认净值承接。";
    case "late_missing":
      return "确认净值超窗待补，收益判断要以观察口径和后续确认净值分开看。";
    case "materialized_from_execution_ledger":
      return "新近账本物化仓位，先等净值链继续承接。";
    case "holiday_delay":
      return "假期或跨市场确认滞后，暂按观察口径复核。";
    default:
      return "确认状态一般，按基金状态矩阵继续观察。";
  }
}

function buildPlainDeepDiveRead({
  candidate = {},
  trigger = {},
  mainReason = "",
  factorLabel = "",
  proxySymbols = []
} = {}) {
  const fundName = candidate?.fundName ?? candidate?.fundCode ?? "这只基金";
  const isHigh = trigger.level === "high";
  const holdingRate = toFiniteNumber(trigger?.holdingPnlRatePct);
  const dayRate = toFiniteNumber(trigger?.dayPnlRatePct);
  const weightPct = toFiniteNumber(candidate?.weightPct);
  const hasDeepDrawdown = holdingRate !== null && holdingRate <= -12;
  const hasDayDrop = dayRate !== null && dayRate <= -2;
  const hasLargePosition = weightPct !== null && weightPct >= 10;
  const proxyText = proxySymbols.length > 0 ? proxySymbols.slice(0, 3).join(" / ") : null;
  const oneLine = hasDeepDrawdown
    ? `${fundName}亏损已经比较深，今天要确认它是继续留、降级观察，还是后续需要减风险；这不是自动卖出指令。`
    : hasLargePosition
      ? `${fundName}仓位不小，今天重点确认它有没有继续拖累组合；先看，不急着动。`
      : `${fundName}有异常苗头，今天列入${isHigh ? "必须复核" : "可选复核"}；没有进一步恶化就不用单独处理。`;
  const why = mainReason
    ? `因为它触发了：${mainReason}。简单说，就是这只基金现在比普通观察仓更需要你看一眼。`
    : "因为它触发了本地深看规则，需要从普通观察里单独拎出来。";
  const watch = [
    proxyText ? `先看代理资产 ${proxyText} 今天是不是继续走弱。` : `先看它所属的 ${factorLabel || "同类资产"} 有没有继续走弱。`,
    hasDayDrop ? "再看今日亏损有没有扩大。" : "再看持有亏损有没有继续扩大。",
    hasLargePosition ? "最后看仓位是否已经大到影响组合情绪和风险。" : "最后看它是否只是小仓位波动。"
  ].join("");
  const handle = isHigh
    ? "如果代理继续弱、亏损继续扩大，明天仍放在“必须看”；如果止跌或确认净值承接正常，就降回普通观察。"
    : "如果没有继续恶化，就放回普通观察；如果亏损扩大、仓位继续拖累，再升级成“必须看”。";
  return {
    oneLine,
    why,
    watch,
    handle,
    guardrail: "深看只代表“需要复核”，不代表今天买入或卖出；真实动作仍要等主脑方向和本地护栏同时放行。"
  };
}

function buildDeepDiveAnalysis(candidate = {}) {
  const trigger = candidate?.deepDiveTrigger ?? {};
  const reasonLabels = asArray(trigger.reasonLabels);
  const factorProfile = candidate?.factorProfile ?? {};
  const factorLabel = trimText(candidate?.factorLabel) ?? trimText(factorProfile?.primaryFactorLabel) ?? "未识别因子";
  const proxySymbols = asArray(factorProfile?.proxySymbols);
  const level = trigger.level === "high" ? "必须看" : "可选看";
  const holdingRate =
    trigger.holdingPnlRatePct === null || trigger.holdingPnlRatePct === undefined
      ? null
      : `${trigger.holdingPnlRatePct}%`;
  const dayRate =
    trigger.dayPnlRatePct === null || trigger.dayPnlRatePct === undefined
      ? null
      : `${trigger.dayPnlRatePct}%`;
  const pnlParts = [
    describePnl(candidate?.dayPnl, "今日观察"),
    describePnl(candidate?.holdingPnl, "持有"),
    holdingRate ? `持有收益率 ${holdingRate}` : null,
    dayRate ? `今日波动 ${dayRate}` : null
  ].filter(Boolean);
  const positionRead = [
    `持仓 ${formatShortMoney(candidate?.amountCny)}`,
    candidate?.weightPct === null || candidate?.weightPct === undefined ? null : `组合权重 ${candidate.weightPct}%`,
    `${candidate?.bucketLabel ?? candidate?.bucket ?? "未命名桶"} / ${factorLabel}`
  ].filter(Boolean).join("；");
  const mainReason = reasonLabels.slice(0, 2).join(" / ") || trimText(candidate?.statusOneLine) || "触发本地深看规则";
  const nextChecks = [
    `先确认触发项：${mainReason}`,
    proxySymbols.length > 0 ? `对照代理 ${proxySymbols.slice(0, 3).join(" / ")} 是否继续同向。` : null,
    `复核 ${candidate?.bucketLabel ?? candidate?.bucket ?? "该桶"} 是否仍符合当前目标仓位。`,
    describeConfirmationForDeepDive(candidate?.confirmationState),
    "不直接生成订单；只决定是否需要人工复核、调仓或继续观察。"
  ].filter(Boolean).slice(0, 5);
  const plainRead = buildPlainDeepDiveRead({
    candidate,
    trigger,
    mainReason,
    factorLabel,
    proxySymbols
  });

  return {
    fundCode: candidate?.fundCode ?? null,
    fundName: candidate?.fundName ?? null,
    level: trigger.level ?? "medium",
    levelLabel: level,
    headline: `${level}：${candidate?.fundName ?? candidate?.fundCode ?? "该基金"} · ${mainReason}。`,
    plainRead,
    plainOneLine: plainRead.oneLine,
    plainWhy: plainRead.why,
    plainWatch: plainRead.watch,
    plainHandle: plainRead.handle,
    plainGuardrail: plainRead.guardrail,
    whyNow: mainReason,
    factorRead: `${factorLabel}${proxySymbols.length > 0 ? ` · 代理 ${proxySymbols.slice(0, 3).join(" / ")}` : ""}`,
    positionRead,
    pnlRead: pnlParts.join("；"),
    confirmationRead: describeConfirmationForDeepDive(candidate?.confirmationState),
    actionRead: `${candidate?.tradeStance ?? "维持观察"}；${candidate?.statusOneLine ?? "仅作为深看候选，不构成订单。"}`,
    nextChecks,
    sourceLabel: candidate?.sourceLabel ?? "TradingAgents 桶方向 + 本地基金护栏"
  };
}

function buildFundStatusOneLine({
  fundAnalysis = {},
  bucketAction = null,
  factorProfile = {},
  deepDiveTrigger = null
} = {}) {
  const tradeStance = trimText(fundAnalysis?.tradeStance) ?? "维持观察";
  const bucket = trimText(fundAnalysis?.bucket);
  const confirmationState = trimText(fundAnalysis?.confirmationState);
  const factorLabel = trimText(factorProfile?.primaryFactorLabel) ?? trimText(fundAnalysis?.factorProfile?.primaryFactorLabel);
  const reasonCodes = asArray(bucketAction?.reasons);

  if (deepDiveTrigger?.needed && deepDiveTrigger?.level === "high") {
    return `${factorLabel ?? "该基金"}高优先级深看：${asArray(deepDiveTrigger.reasonLabels).slice(0, 2).join(" / ")}。`;
  }
  if (deepDiveTrigger?.needed) {
    return `${factorLabel ?? "该基金"}进入可选深看：${asArray(deepDiveTrigger.reasonLabels).slice(0, 2).join(" / ")}。`;
  }
  if (["HEDGE", "INCOME", "CASH"].includes(bucket) || tradeStance === "防守维持") {
    return "防守承载，不参与进攻动作。";
  }
  if (/增配/.test(tradeStance) && reasonCodes.includes("bucket_not_below_target")) {
    return "桶偏增配，但当前仓位已足，暂不生成买入区间。";
  }
  if (/减配/.test(tradeStance) && reasonCodes.includes("bucket_not_above_target")) {
    return "桶偏减配，但当前仓位未明显超目标，先做复核观察。";
  }
  if (confirmationState === "normal_lag") {
    return "QDII/跨市场正常滞后，等确认净值承接。";
  }
  if (confirmationState === "materialized_from_execution_ledger") {
    return "新近账本物化仓位，等待净值链继续承接。";
  }
  if (confirmationState === "holiday_delay") {
    return `${tradeStance}；假期或跨市场确认滞后，先按观察口径看。`;
  }
  if (/维持/.test(tradeStance)) {
    return "桶方向维持，继续观察。";
  }
  return `${tradeStance}；继续按基金状态矩阵观察。`;
}

function researchQualityScore(status) {
  switch (trimText(status)) {
    case "ready":
      return 4;
    case "partial":
      return 3;
    case "stale":
      return 2;
    case "inferred":
      return 1;
    default:
      return 0;
  }
}

function representativeScore(fund = {}) {
  const quality = fund?.researchProfileQuality ?? {};
  const amountCny = toFiniteNumber(fund?.amountCny) ?? 0;
  const holdingPnl = toFiniteNumber(fund?.holdingPnl) ?? 0;
  const stancePenalty = /替换|减风险|减配/.test(String(fund?.tradeStance ?? "")) ? 0.8 : 1;
  return (
    researchQualityScore(quality.status) * 100000000 +
    Math.max(0, amountCny) * stancePenalty +
    Math.max(-20000, holdingPnl) * 0.02
  );
}

function toPeerFundRow(fund = {}) {
  return {
    fundCode: fund?.fundCode ?? null,
    fundName: fund?.fundName ?? null,
    bucket: fund?.bucket ?? null,
    bucketLabel: fund?.bucketLabel ?? null,
    amountCny: roundMoney(fund?.amountCny),
    weightPct: fund?.weightPct ?? null,
    holdingPnl: roundMoney(fund?.holdingPnl),
    dayPnl: roundMoney(fund?.dayPnl),
    tradeStance: fund?.tradeStance ?? null,
    researchStatus: fund?.researchProfileQuality?.status ?? null,
    researchLabel: fund?.researchProfileQuality?.statusLabel ?? null,
    profileTags: fund?.researchProfileQuality?.tagLabels ?? []
  };
}

function buildPeerGroupSummary({ fundAnalyses = [], totalAssetsCny = 0, limit = 8 } = {}) {
  const groups = new Map();
  for (const fund of asArray(fundAnalyses)) {
    const factor = trimText(fund?.factorProfile?.primaryFactor) ?? trimText(fund?.bucket);
    if (!factor || factor === "BOND_CASH") {
      continue;
    }
    const factorLabel =
      trimText(fund?.factorProfile?.primaryFactorLabel) ??
      trimText(fund?.factorLabel) ??
      factor;
    const current = groups.get(factor) ?? {
      groupKey: factor,
      groupLabel: factorLabel,
      funds: [],
      exposureCny: 0,
      dayPnl: 0,
      holdingPnl: 0
    };
    current.funds.push(fund);
    current.exposureCny += toFiniteNumber(fund?.amountCny) ?? 0;
    current.dayPnl += toFiniteNumber(fund?.dayPnl) ?? 0;
    current.holdingPnl += toFiniteNumber(fund?.holdingPnl) ?? 0;
    groups.set(factor, current);
  }

  return [...groups.values()]
    .filter((group) => group.funds.length > 1)
    .map((group) => {
      const sortedFunds = [...group.funds].sort((left, right) => representativeScore(right) - representativeScore(left));
      const representative = sortedFunds[0] ?? {};
      const duplicates = sortedFunds.slice(1);
      const staleCount = group.funds.filter((fund) => fund?.researchProfileQuality?.status === "stale").length;
      const partialCount = group.funds.filter((fund) => fund?.researchProfileQuality?.status === "partial").length;
      const representativeQuality = representative?.researchProfileQuality;
      const notes = [
        staleCount > 0 ? `重仓陈旧 ${staleCount} 只` : null,
        partialCount > 0 ? `仅部分穿透 ${partialCount} 只` : null,
        duplicates.length > 0 ? `重复观察 ${duplicates.slice(0, 3).map((item) => item.fundName ?? item.fundCode).join(" / ")}` : null
      ].filter(Boolean);
      return {
        groupKey: group.groupKey,
        groupLabel: group.groupLabel,
        count: group.funds.length,
        exposureCny: roundMoney(group.exposureCny),
        weightPct: totalAssetsCny > 0 ? roundPct((group.exposureCny / totalAssetsCny) * 100) : null,
        dayPnl: roundMoney(group.dayPnl),
        holdingPnl: roundMoney(group.holdingPnl),
        representative: toPeerFundRow(representative),
        duplicateFunds: duplicates.map(toPeerFundRow).slice(0, 8),
        topFunds: sortedFunds.map(toPeerFundRow).slice(0, 8),
        representativeReason: `暂以 ${representative?.fundName ?? representative?.fundCode ?? "该基金"} 作为 ${group.groupLabel} 代表：${representativeQuality?.statusLabel ?? "资料状态待确认"}，持仓 ${formatShortMoney(representative?.amountCny)}。`,
        oneLine: `${group.groupLabel} 同类 ${group.funds.length} 只，暴露 ${formatShortMoney(group.exposureCny)}；代表基金暂看 ${representative?.fundName ?? representative?.fundCode ?? "--"}。`,
        notes
      };
    })
    .sort((left, right) => (toFiniteNumber(right.exposureCny) ?? 0) - (toFiniteNumber(left.exposureCny) ?? 0))
    .slice(0, limit);
}

function daysSinceDateText(value, now = new Date()) {
  const anchor = parseShanghaiDateAnchor(value);
  if (!anchor) {
    return null;
  }
  const today = parseShanghaiDateAnchor(formatShanghaiDate(now)) ?? { date: now };
  const diffDays = Math.floor((today.date.getTime() - anchor.date.getTime()) / 86400000);
  return Number.isFinite(diffDays) ? Math.max(0, diffDays) : null;
}

function buildResearchProfileQuality({ researchProfile = {}, now = new Date() } = {}) {
  const source = trimText(researchProfile?.source);
  const dataQuality = trimText(researchProfile?.dataQuality);
  const lookthroughStatus = trimText(researchProfile?.lookthrough?.status);
  const topHoldings = asArray(researchProfile?.lookthrough?.topHoldings);
  const managerName = trimText(researchProfile?.manager?.name);
  const holdingsAsOf =
    trimText(researchProfile?.holdingsAsOf) ??
    trimText(topHoldings.find((item) => trimText(item?.asOf))?.asOf);
  const holdingsAgeDays = daysSinceDateText(holdingsAsOf, now);
  const tags = [];
  const addTag = (label, tone = "flat", code = null) => {
    const normalizedLabel = trimText(label);
    if (!normalizedLabel) {
      return;
    }
    tags.push({ label: normalizedLabel, tone, code: code ?? normalizedLabel });
  };

  const profileLoaded = source === "fund_research_profiles";
  addTag(profileLoaded ? "资料已同步" : "本地推断", profileLoaded ? "ok" : "warn", profileLoaded ? "profile_synced" : "profile_inferred");
  addTag(managerName ? "经理已同步" : "经理未加载", managerName ? "ok" : "warn", managerName ? "manager_loaded" : "manager_missing");

  let lookthroughCode = "lookthrough_missing";
  if (lookthroughStatus === "latest_quarter_holdings" || topHoldings.length > 0) {
    if (holdingsAgeDays !== null && holdingsAgeDays > 210) {
      addTag("重仓陈旧", "warn", "holdings_stale");
      lookthroughCode = "holdings_stale";
    } else if (holdingsAgeDays !== null && holdingsAgeDays > 130) {
      addTag("重仓偏旧", "warn", "holdings_aging");
      lookthroughCode = "holdings_aging";
    } else {
      addTag("重仓已穿透", "ok", "holdings_loaded");
      lookthroughCode = "holdings_loaded";
    }
  } else if (["theme_only", "fund_of_funds_theme", "profile_partial"].includes(lookthroughStatus)) {
    addTag("仅主题穿透", "warn", "theme_only");
    lookthroughCode = "theme_only";
  } else {
    addTag("穿透未加载", "danger", "lookthrough_missing");
  }

  const status =
    !profileLoaded
      ? "inferred"
      : lookthroughCode === "holdings_stale"
        ? "stale"
        : lookthroughCode === "holdings_loaded"
          ? "ready"
          : lookthroughCode === "theme_only" || lookthroughCode === "holdings_aging"
            ? "partial"
            : "missing";
  const statusLabel =
    status === "ready"
      ? "资料完整"
      : status === "stale"
        ? "重仓陈旧"
        : status === "partial"
          ? "资料部分可用"
          : status === "inferred"
            ? "本地推断"
            : "资料不足";

  return {
    status,
    statusLabel,
    tags,
    tagLabels: tags.map((item) => item.label),
    oneLine: tags.slice(0, 3).map((item) => item.label).join(" · "),
    source,
    dataQuality,
    profileAsOf: trimText(researchProfile?.asOf),
    fetchedAt: trimText(researchProfile?.fetchedAt),
    managerLoaded: Boolean(managerName),
    lookthroughStatus,
    holdingsAsOf: holdingsAsOf ?? null,
    holdingsAgeDays,
    topHoldingCount: topHoldings.length
  };
}

export function buildFundAnalyses({
  portfolioState = {},
  assetMaster = {},
  bucketActions = [],
  bucketVerdicts = [],
  mode = "fixture",
  providerRuntime = null,
  provider = null,
  factorProfilesConfig = {},
  researchProfilesConfig = {},
  now = new Date()
} = {}) {
  const { positionsByFundCode } = buildPositionLookup(portfolioState, assetMaster);
  const bucketActionByKey = new Map(asArray(bucketActions).map((item) => [trimText(item?.bucket), item]));
  const bucketVerdictByKey = new Map(asArray(bucketVerdicts).map((item) => [trimText(item?.bucket), item]));
  const totalAssetsCny = resolvePortfolioTotalAssets(portfolioState);
  const sourceLabel =
    normalizeMode(mode) === "live" && trimText(providerRuntime?.providerMode) !== "fallback_fixture"
      ? `TradingAgents ${trimText(providerRuntime?.providerUsed) ?? trimText(provider) ?? "live"} + 本地基金护栏`
      : "基于 fallback 主脑，仅供观察";

  return [...positionsByFundCode.values()]
    .filter((item) => item.amountCny > 0)
    .sort((left, right) => {
      const leftRank = toFiniteNumber(assetMaster?.buckets?.[left.bucket]?.priority_rank) ?? 999;
      const rightRank = toFiniteNumber(assetMaster?.buckets?.[right.bucket]?.priority_rank) ?? 999;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      if (left.bucket !== right.bucket) {
        return String(left.bucket ?? "").localeCompare(String(right.bucket ?? ""), "zh-CN");
      }
      return right.amountCny - left.amountCny;
    })
    .map((item) => {
      const bucket = trimText(item.bucket) ?? "UNMAPPED";
      const bucketAction = bucketActionByKey.get(bucket) ?? bucketVerdictByKey.get(bucket) ?? null;
      const confirmationState = resolveConfirmationState(item.position);
      const tradeStance = resolveFundTradeStance({
        bucketAction,
        fundCode: item.fundCode,
        bucket,
        mode,
        providerRuntime
      });
      const dayPnl = resolvePositionDayPnl(item.position);
      const holdingPnl = resolvePositionHoldingPnl(item.position);
      const bucketLabel = toDisplayBucketLabel(assetMaster, bucket);
      const today = describePnl(dayPnl, "今日");
      const holding = describePnl(holdingPnl, "持有");
      const actionText = tradeStance === "仅观察" ? "不形成动作" : tradeStance;
      const oneLine = `${bucketLabel} · ${today} · ${holding}；${actionText}。`;
      const riskNote = buildFundRiskNote({
        position: item.position,
        bucketAction,
        confirmationState,
        sourceLabel
      });
      const baseAnalysis = {
        fundCode: item.fundCode,
        fundName: item.fundName,
        bucket,
        bucketLabel,
        amountCny: roundMoney(item.amountCny),
        holdingPnl,
        dayPnl,
        weightPct: totalAssetsCny > 0 ? roundPct((item.amountCny / totalAssetsCny) * 100) : null,
        confirmationState,
        tradeStance,
        oneLine,
        riskNote,
        sourceLabel
      };
      const factorProfile = resolveFundFactorProfile({
        fundCode: item.fundCode,
        fundName: item.fundName,
        bucket,
        position: item.position,
        assetMaster,
        factorProfilesConfig
      });
      const factorContribution = buildFundFactorContribution({
        fundAnalysis: baseAnalysis,
        factorProfile,
        totalAssetsCny,
        factorProfilesConfig
      });
      const researchProfile = resolveFundResearchProfile({
        fundCode: item.fundCode,
        fundName: item.fundName,
        bucket,
        position: item.position,
        assetMaster,
        factorProfile,
        researchProfilesConfig
      });
      const researchProfileQuality = buildResearchProfileQuality({
        researchProfile,
        now
      });
      const factorTags = [
        factorProfile.primaryFactorLabel,
        ...factorProfile.secondaryFactorLabels.slice(0, 1)
      ].filter(Boolean).join(" / ");
      const enrichedAnalysis = {
        ...baseAnalysis,
        factorProfile,
        researchProfile,
        researchProfileQuality,
        factorContribution,
        factorOneLine: `${factorTags || "未识别因子"} · ${oneLine}`
      };
      const deepDiveTrigger = buildFundDeepDiveTrigger({
        fundAnalysis: enrichedAnalysis,
        factorProfile
      });
      return {
        ...enrichedAnalysis,
        deepDiveTrigger,
        statusOneLine: buildFundStatusOneLine({
          fundAnalysis: enrichedAnalysis,
          bucketAction,
          factorProfile,
          deepDiveTrigger
        })
      };
    });
}

export function buildPortfolioAnalysis({
  fundAnalyses = [],
  portfolioState = {},
  assetMaster = {},
  bucketActions = [],
  shouldTradeVerdict = "observe_only",
  riskLight = "yellow",
  mode = "fixture",
  providerRuntime = null,
  factorProfilesConfig = {},
  researchProfilesConfig = {}
} = {}) {
  const totalAssetsCny = resolvePortfolioTotalAssets(portfolioState);
  const byBucket = new Map();
  for (const item of asArray(fundAnalyses)) {
    const bucket = trimText(item?.bucket) ?? "UNMAPPED";
    const current = byBucket.get(bucket) ?? {
      bucket,
      bucketLabel: item?.bucketLabel ?? bucket,
      amountCny: 0,
      dayPnl: 0,
      holdingPnl: 0,
      count: 0
    };
    current.amountCny += toFiniteNumber(item?.amountCny) ?? 0;
    current.dayPnl += toFiniteNumber(item?.dayPnl) ?? 0;
    current.holdingPnl += toFiniteNumber(item?.holdingPnl) ?? 0;
    current.count += 1;
    byBucket.set(bucket, current);
  }
  const exposureSummary = [...byBucket.values()]
    .map((item) => {
      const targetAmount = resolveBucketTargetAmount(assetMaster, item.bucket, totalAssetsCny);
      return {
        ...item,
        amountCny: roundMoney(item.amountCny),
        dayPnl: roundMoney(item.dayPnl),
        holdingPnl: roundMoney(item.holdingPnl),
        weightPct: totalAssetsCny > 0 ? roundPct((item.amountCny / totalAssetsCny) * 100) : null,
        targetPct: toFiniteNumber(assetMaster?.buckets?.[item.bucket]?.target) === null
          ? null
          : roundPct(toFiniteNumber(assetMaster.buckets[item.bucket].target) * 100),
        targetGapCny: targetAmount === null ? null : roundMoney(item.amountCny - targetAmount)
      };
    })
    .sort((left, right) => (right.amountCny ?? 0) - (left.amountCny ?? 0));
  const directionalActions = asArray(bucketActions)
    .filter((item) => ["buy", "sell"].includes(trimText(item?.direction)))
    .slice(0, 3)
    .map((item) => `${item.bucketLabel ?? item.bucket} ${item.direction === "sell" ? "减配复核" : "增配观察"}`);
  const riskNotes = [
    ...(riskLight === "red" ? ["风险灯红色：优先复核减风险与 provider 状态。"] : []),
    ...(normalizeMode(mode) !== "live" || trimText(providerRuntime?.providerMode) === "fallback_fixture"
      ? ["当前结果不是 live 主脑，只能作为晨会观察。"]
      : []),
    ...asArray(fundAnalyses)
      .filter((item) => trimText(item?.riskNote) && item.riskNote !== "暂无额外风险提示")
      .slice(0, 3)
      .map((item) => `${item.fundName}：${item.riskNote}`)
  ].slice(0, 5);
  const cashBucket = exposureSummary.find((item) => item.bucket === "CASH");
  const defenseBuckets = exposureSummary.filter((item) => ["CASH", "HEDGE", "INCOME"].includes(item.bucket));
  const defenseAmount = defenseBuckets.reduce((sum, item) => sum + (toFiniteNumber(item.amountCny) ?? 0), 0);
  const liveLabel = normalizeMode(mode) === "live" && trimText(providerRuntime?.providerMode) !== "fallback_fixture"
    ? "live 主脑"
    : "fallback 观察";
  const factorExposureSummary = buildFactorExposureSummary({
    fundAnalyses,
    totalAssetsCny,
    factorProfilesConfig
  });
  const dominantFactors = factorExposureSummary.slice(0, 3).map((item) => ({
    factor: item.factor,
    factorLabel: item.factorLabel,
    weightPct: item.weightPct,
    exposureCny: item.exposureCny
  }));
  const factorRiskNotes = buildFactorRiskNotes({ factorExposureSummary });
  const bucketFactorSummary = buildBucketFactorSummary({
    fundAnalyses,
    totalAssetsCny
  });
  const peerGroupSummary = buildPeerGroupSummary({
    fundAnalyses,
    totalAssetsCny
  });
  const deepDiveCandidates = buildDeepDiveCandidates(fundAnalyses);
  const deepDiveAnalyses = deepDiveCandidates.map((item) => item.deepDiveAnalysis).filter(Boolean);
  const basePortfolioAnalysis = {
    exposureSummary,
    factorExposureSummary,
    dominantFactors,
    factorRiskNotes,
    bucketFactorSummary,
    peerGroupSummary,
    deepDiveCandidates,
    deepDiveAnalyses
  };
  const fundTradingAgentsAdapter = buildFundTradingAgentsAdapter({
    deepDiveCandidates,
    fundAnalyses,
    bucketActions,
    portfolioAnalysis: basePortfolioAnalysis,
    researchProfilesConfig,
    decisionSnapshot: {
      status: shouldTradeVerdict,
      shouldTradeVerdict,
      riskLight,
      mode,
      providerRuntime
    }
  });
  return {
    oneLine: `全组合 ${asArray(fundAnalyses).length} 只基金，风险灯 ${String(riskLight).toUpperCase()}，当前结论 ${shouldTradeVerdict}（${liveLabel}）。`,
    exposureSummary,
    factorExposureSummary,
    dominantFactors,
    factorRiskNotes,
    bucketFactorSummary,
    peerGroupSummary,
    deepDiveCandidates,
    deepDiveAnalyses,
    fundTradingAgentsAdapter,
    deepDiveSummary: deepDiveCandidates.length > 0
      ? `今日建议深看 ${deepDiveCandidates.length} 只：${deepDiveCandidates.slice(0, 3).map((item) => item.fundName).join(" / ")}。`
      : "今日没有必须单独深看的基金；按状态矩阵观察即可。",
    riskNotes,
    cashAndDefenseNote: `CASH/防守承载约 ${formatShortMoney(defenseAmount)}；可动用现金以本地账本为准${cashBucket ? `，CASH 桶约 ${formatShortMoney(cashBucket.amountCny)}` : ""}。`,
    nextReviewFocus: directionalActions.length > 0
      ? directionalActions
      : ["等待 TradingAgents live cache 回补", "复核前收参考是否升级为延迟/实时行情", "确认净值链更新后再对账收益"]
  };
}

export function addFundAnalysesToDecisionSnapshot(
  snapshot = {},
  { portfolioState = {}, assetMaster = {}, bridgeConfig = {}, factorProfilesConfig = {}, researchProfilesConfig = {}, now = new Date() } = {}
) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }
  const providerRuntime = snapshot?.providerRuntime ?? snapshot?.diagnostics?.providerRuntime ?? null;
  const bucketActions = asArray(snapshot?.bucketActions);
  const bucketVerdicts = asArray(snapshot?.bucketVerdicts);
  const baseFundAnalyses = asArray(snapshot?.fundAnalyses).length > 0
    ? snapshot.fundAnalyses
    : buildFundAnalyses({
        portfolioState,
        assetMaster,
        bucketActions,
        bucketVerdicts,
        mode: snapshot?.mode,
        providerRuntime,
        provider: snapshot?.provider,
        factorProfilesConfig,
        researchProfilesConfig,
        now
      });
  const fundAnalyses = enrichFundAnalysesWithFactorAttribution({
    fundAnalyses: baseFundAnalyses,
    portfolioState,
    assetMaster,
    factorProfilesConfig
  });
  const fundAnalysesWithResearch = fundAnalyses.map((item) => {
    const resolvedResearchProfile = resolveFundResearchProfile({
      fundCode: item?.fundCode,
      fundName: item?.fundName,
      bucket: item?.bucket,
      position: item?.position ?? {},
      assetMaster,
      factorProfile: item?.factorProfile ?? {},
      researchProfilesConfig
    });
    const existingResearchProfile = item?.researchProfile ?? null;
    const needsFreshResearchProfile =
      !existingResearchProfile ||
      !item?.researchProfileQuality ||
      (
        existingResearchProfile?.lookthrough?.status === "latest_quarter_holdings" &&
        !trimText(existingResearchProfile?.holdingsAsOf)
      );
    const researchProfile = needsFreshResearchProfile ? resolvedResearchProfile : existingResearchProfile;
    return {
      ...item,
      researchProfile,
      researchProfileQuality: item?.researchProfileQuality ?? buildResearchProfileQuality({
        researchProfile,
        now
      })
    };
  });
  const fundAnalysesWithDeepDive = attachFundDeepDiveTriggers(fundAnalysesWithResearch);
  const computedPortfolioAnalysis = buildPortfolioAnalysis({
    fundAnalyses: fundAnalysesWithDeepDive,
    portfolioState,
    assetMaster,
    bucketActions,
    shouldTradeVerdict: snapshot?.shouldTradeVerdict ?? snapshot?.status,
    riskLight: snapshot?.riskLight,
    mode: snapshot?.mode,
    providerRuntime,
    factorProfilesConfig,
    researchProfilesConfig
  });
  const portfolioAnalysis = snapshot?.portfolioAnalysis
    ? {
        ...computedPortfolioAnalysis,
        ...snapshot.portfolioAnalysis,
      factorExposureSummary: snapshot.portfolioAnalysis.factorExposureSummary ?? computedPortfolioAnalysis.factorExposureSummary,
      factorRiskNotes: snapshot.portfolioAnalysis.factorRiskNotes ?? computedPortfolioAnalysis.factorRiskNotes,
      dominantFactors: snapshot.portfolioAnalysis.dominantFactors ?? computedPortfolioAnalysis.dominantFactors,
      bucketFactorSummary: snapshot.portfolioAnalysis.bucketFactorSummary ?? computedPortfolioAnalysis.bucketFactorSummary,
      peerGroupSummary: snapshot.portfolioAnalysis.peerGroupSummary ?? computedPortfolioAnalysis.peerGroupSummary,
      deepDiveCandidates: snapshot.portfolioAnalysis.deepDiveCandidates ?? computedPortfolioAnalysis.deepDiveCandidates,
      deepDiveAnalyses: snapshot.portfolioAnalysis.deepDiveAnalyses ?? computedPortfolioAnalysis.deepDiveAnalyses,
      fundTradingAgentsAdapter: snapshot.portfolioAnalysis.fundTradingAgentsAdapter?.contexts?.[0]?.researchProfile
        ? snapshot.portfolioAnalysis.fundTradingAgentsAdapter
        : computedPortfolioAnalysis.fundTradingAgentsAdapter,
      deepDiveSummary: snapshot.portfolioAnalysis.deepDiveSummary ?? computedPortfolioAnalysis.deepDiveSummary
      }
    : computedPortfolioAnalysis;
  const observationGroups = snapshot?.observationGroups ?? buildObservationGroups({
    observeLine: snapshot?.executionChecklist?.observeLine ?? snapshot?.watchItems ?? [],
    bucketActions,
    decisionContext: snapshot?.decisionContext ?? {},
    diagnostics: snapshot?.diagnostics ?? {},
    mode: snapshot?.mode,
    providerRuntime,
    providerError: snapshot?.diagnostics?.providerError,
    fallbackReason: snapshot?.diagnostics?.fallbackReason
  });
  const morningBrief = snapshot?.morningBrief ?? buildMorningBrief({
    shouldTradeVerdict: snapshot?.shouldTradeVerdict ?? snapshot?.status,
    riskLight: snapshot?.riskLight,
    realActions: snapshot?.executionChecklist?.realActions ?? snapshot?.fundActions ?? [],
    observeLine: snapshot?.executionChecklist?.observeLine ?? snapshot?.watchItems ?? [],
    observationGroups,
    deepDiveCandidates: portfolioAnalysis.deepDiveCandidates ?? [],
    decisionSummary: snapshot?.decisionSummary
  });
  return {
    ...snapshot,
    fundAnalyses: fundAnalysesWithDeepDive,
    portfolioAnalysis,
    deepDiveCandidates: portfolioAnalysis.deepDiveCandidates ?? [],
    deepDiveAnalyses: portfolioAnalysis.deepDiveAnalyses ?? [],
    fundTradingAgentsAdapter: portfolioAnalysis.fundTradingAgentsAdapter ?? null,
    observationGroups,
    morningBrief,
    diagnostics: {
      ...(snapshot?.diagnostics ?? {}),
      fundAnalysisCount: fundAnalysesWithDeepDive.length,
      deepDiveCandidateCount: asArray(portfolioAnalysis.deepDiveCandidates).length,
      portfolioAnalysisReady: Boolean(portfolioAnalysis)
    }
  };
}

function buildSignalMemoryKey(entry = {}) {
  return [
    trimText(entry?.asOf) ?? "unknown_date",
    trimText(entry?.bucket) ?? "unknown_bucket",
    trimText(entry?.provider) ?? "unknown_provider",
    trimText(entry?.mode) ?? "unknown_mode"
  ].join("|");
}

export function buildNextSignalMemory({ signalMemory = {}, bucketActions = [], rawSnapshot = {}, accountId = "main", now = new Date() } = {}) {
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(String(now ?? Date.now())).toISOString();
  const byKey = new Map();
  const append = (entry) => {
    const key = buildSignalMemoryKey(entry);
    if (byKey.has(key)) {
      byKey.delete(key);
    }
    byKey.set(key, entry);
  };

  for (const entry of compactSignalMemory(signalMemory)) {
    append(entry);
  }
  for (const item of asArray(bucketActions)) {
    if (!trimText(item?.bucket) || !item?.rating) {
      continue;
    }
    append({
      generatedAt,
      asOf: trimText(rawSnapshot?.asOf),
      bucket: trimText(item.bucket),
      rating: normalizeTradingAgentsRating(item.rating),
      direction: trimText(item.direction) ?? ratingToDirection(item.rating),
      confidence: item.confidence ?? null,
      provider: trimText(rawSnapshot?.provider),
      mode: normalizeMode(rawSnapshot?.mode)
    });
  }

  const entries = [...byKey.values()].slice(-SIGNAL_MEMORY_LIMIT);

  return {
    generatedAt,
    accountId,
    entries
  };
}

export async function loadTradingDecisionConfig(configPath = DEFAULT_BRIDGE_CONFIG_PATH) {
  return loadTradingAgentsBridgeConfig(configPath);
}

function normalizeDecisionSnapshotRuntimeFields(snapshot = {}) {
  const normalizeAction = (item = {}) => {
    if (
      trimText(item?.actionOneLine) &&
      trimText(item?.fundReasonOneLine) &&
      !containsStockExecutionLanguage(item.fundReasonOneLine)
    ) {
      return item;
    }
    return {
      ...item,
      ...buildActionSummaryFields({
        reasonSummary: item?.reasonSummary ?? item?.verdict,
        stance: item?.stance,
        actionLabel: item?.actionLabel,
        bucketLabel: item?.bucketLabel ?? item?.bucket,
        suggestedAmountRangeCny: item?.suggestedAmountRangeCny,
        sizingWarnings: item?.sizingWarnings
      })
    };
  };
  const realActions = asArray(snapshot?.executionChecklist?.realActions).map(normalizeAction);
  const fundActions = asArray(snapshot?.fundActions).map(normalizeAction);
  const bucketActions = asArray(snapshot?.bucketActions).map((item) => ({
    ...item,
    primaryAction: item?.primaryAction ? normalizeAction(item.primaryAction) : item?.primaryAction
  }));
  const providerRuntime = snapshot?.providerRuntime ?? snapshot?.diagnostics?.providerRuntime ?? null;
  const brainProfile = resolveTradingAgentsBrainProfile({ snapshot });
  const snapshotMode = normalizeMode(snapshot?.mode);
  const rawProviderUsed = trimText(snapshot?.providerUsed) ?? trimText(providerRuntime?.providerUsed) ?? trimText(snapshot?.provider);
  const providerUsed = snapshotMode === "fallback_fixture" && rawProviderUsed !== "fallback_fixture"
    ? "fallback_fixture"
    : rawProviderUsed;
  const providerMode =
    trimText(snapshot?.providerMode) ??
    trimText(providerRuntime?.providerMode) ??
    (snapshotMode === "live" ? "live" : "fallback_fixture");
  const providerFallbackReason =
    trimText(snapshot?.providerFallbackReason) ?? trimText(providerRuntime?.providerFallbackReason);
  const providerAttempted = asArray(snapshot?.providerAttempted).length > 0
    ? asArray(snapshot.providerAttempted)
    : asArray(providerRuntime?.providerAttempted);
  const normalizedRuntime = providerRuntime
    ? {
        ...providerRuntime,
        providerUsed: trimText(providerRuntime.providerUsed) ?? providerUsed,
        providerMode: trimText(providerRuntime.providerMode) ?? providerMode,
        providerFallbackReason: trimText(providerRuntime.providerFallbackReason) ?? providerFallbackReason,
        providerAttempted,
        latestLiveAttempt: providerRuntime.latestLiveAttempt ?? null,
        ...(brainProfile ? { brainProfile } : {})
      }
    : {
        providerUsed,
        providerMode,
        providerFallbackReason,
        providerAttempted,
        latestLiveAttempt: null,
        ...(brainProfile ? { brainProfile } : {})
      };
  return {
    ...snapshot,
    ...(brainProfile ? { brainProfile } : {}),
    executionChecklist: {
      ...(snapshot?.executionChecklist ?? {}),
      realActions
    },
    fundActions: fundActions.length > 0 ? fundActions : realActions,
    bucketActions: bucketActions.length > 0 ? bucketActions : snapshot?.bucketActions,
    providerUsed,
    providerMode,
    providerFallbackReason,
    providerAttempted,
    providerRuntime: normalizedRuntime,
    diagnostics: {
      ...(snapshot?.diagnostics ?? {}),
      ...(brainProfile ? { brainProfile } : {}),
      providerRuntime: normalizedRuntime
    }
  };
}

export function applyMarketProxyQuotesToDecisionSnapshot(snapshot = {}, marketProxyQuotes = null) {
  if (!snapshot) {
    return snapshot;
  }
  const normalizedSnapshot = normalizeDecisionSnapshotRuntimeFields(snapshot);
  if (!marketProxyQuotes) {
    return normalizedSnapshot;
  }
  const marketDataTier = resolveMarketProxyQuoteTier(marketProxyQuotes) ?? normalizedSnapshot?.diagnostics?.marketDataTier;
  const marketDataTierLabel = resolveMarketProxyQuoteTierLabel(marketProxyQuotes, marketDataTier);
  const marketDataAsOf = resolveMarketProxyQuoteAsOf(marketProxyQuotes) ?? normalizedSnapshot?.diagnostics?.marketDataAsOf;
  return {
    ...normalizedSnapshot,
    marketDataTier,
    marketDataTierLabel,
    marketDataAsOf,
    decisionContext: {
      ...(normalizedSnapshot.decisionContext ?? {}),
      marketDataTier,
      marketDataTierLabel,
      marketDataAsOf,
      marketProxyQuoteAsOf: resolveMarketProxyQuoteAsOf(marketProxyQuotes)
    },
    diagnostics: {
      ...(normalizedSnapshot.diagnostics ?? {}),
      marketDataTier,
      marketDataTierLabel,
      marketDataAsOf,
      marketProxyQuotes
    },
    marketProxyQuotes
  };
}

export function resolveTradingDecisionPaths(portfolioRoot, manifest = {}) {
  const advicePaths = resolveTradingAdvicePaths(portfolioRoot, manifest);
  const canonical = manifest?.canonical_entrypoints ?? {};
  return {
    ...advicePaths,
    decisionSnapshotPath:
      canonical.latest_trading_decision_snapshot ??
      buildPortfolioPath(portfolioRoot, "data", "trading_decision_snapshot.json"),
    signalMemoryPath:
      canonical.latest_tradingagents_signal_memory ??
      buildPortfolioPath(portfolioRoot, "data", "tradingagents_signal_memory.json"),
    factorProfilesPath:
      canonical.fund_factor_profiles ??
      buildPortfolioPath(portfolioRoot, "config", "fund_factor_profiles.json"),
    researchProfilesPath:
      canonical.fund_research_profiles ??
      buildPortfolioPath(portfolioRoot, "config", "fund_research_profiles.json")
  };
}

export async function buildTradingDecisionSnapshot({
  rawSnapshot = {},
  adviceSnapshot = {},
  portfolioState = {},
  assetMaster = {},
  bridgeConfig = {},
  factorProfilesConfig = {},
  researchProfilesConfig = {},
  accountId = "main",
  now = new Date(),
  diagnostics = {},
  signalMemory = {}
} = {}) {
  const freshness = computeTradingAdviceFreshness(rawSnapshot, {
    now,
    staleAfterHours: bridgeConfig?.staleAfterHours ?? 36
  });
  const executionEnabled = isExecutionEnabled({
    rawSnapshot,
    diagnostics,
    freshnessLabel: freshness.freshnessLabel
  });
  const executableBuckets = new Set(asArray(bridgeConfig?.phase1Buckets).map((item) => String(item ?? "").trim()));
  const { positionsByFundCode, heldBuckets } = buildPositionLookup(portfolioState, assetMaster);
  const fundSuggestionsByBucket = buildFundSuggestionLookup(adviceSnapshot?.fundSuggestions);
  const tradeAvailableCashCny = resolveTradeAvailableCash(portfolioState);
  const totalAssetsCny = resolvePortfolioTotalAssets(portfolioState);
  const minTradeAmountCny = resolveMinTradeAmount(assetMaster);
  const tradingCalendarAnchor = resolveTradingCalendarAnchor({ rawSnapshot, adviceSnapshot, now });
  const tradingCalendarState = resolveTradingCalendarState(tradingCalendarAnchor.date);
  const marketDataTier = resolveMarketDataTier({ diagnostics, rawSnapshot, now });
  const marketDataLatestDates = resolveMarketDataLatestDates(diagnostics);
  const marketProxyQuoteAsOf = resolveMarketProxyQuoteAsOf(diagnostics?.marketProxyQuotes);
  const marketDataTierLabel = resolveMarketProxyQuoteTierLabel(diagnostics?.marketProxyQuotes, marketDataTier);
  const decisionContext = {
    marketDataTier,
    marketDataTierLabel,
    marketDataAsOf: marketProxyQuoteAsOf ?? marketDataLatestDates[0] ?? trimText(rawSnapshot?.asOf),
    marketDataLatestDates,
    marketProxyQuoteAsOf,
    tradingCalendarState,
    calendarAsOf: tradingCalendarAnchor.dateText
  };
  const signalMemorySummary = resolveSignalMemorySummary(signalMemory, adviceSnapshot?.bucketSuggestions);
  const realActions = [];
  const observeLine = [];
  const blockedSuggestions = [];
  const bucketVerdicts = [];
  const bucketActions = [];
  const existingBuckets = new Set();

  for (const blocked of asArray(adviceSnapshot?.blockedSuggestions)) {
    blockedSuggestions.push(decorateBlockedSuggestion(blocked));
  }

  for (const bucketSuggestion of asArray(adviceSnapshot?.bucketSuggestions)) {
    const bucket = trimText(bucketSuggestion?.bucket);
    if (!bucket) {
      continue;
    }
    existingBuckets.add(bucket);
    const rating = normalizeTradingAgentsRating(bucketSuggestion?.rating);
    const profile = toActionProfile(rating);
    const bucketLabel = trimText(bucketSuggestion?.bucketLabel) ?? toDisplayBucketLabel(assetMaster, bucket);
    const heldAmountCny = heldBuckets.get(bucket) ?? 0;
    const fundSuggestions = fundSuggestionsByBucket.get(bucket) ?? [];
    const candidateFunds = fundSuggestions
      .map((suggestion) => buildFundCandidate(suggestion, positionsByFundCode, profile))
      .sort((left, right) => {
        if (profile.stance === "sell" && left.heldAmountCny !== right.heldAmountCny) {
          return right.heldAmountCny - left.heldAmountCny;
        }
        if (profile.stance === "buy") {
          const leftHeld = left.heldAmountCny > 0 ? 1 : 0;
          const rightHeld = right.heldAmountCny > 0 ? 1 : 0;
          if (leftHeld !== rightHeld) {
            return rightHeld - leftHeld;
          }
          if (left.heldAmountCny !== right.heldAmountCny) {
            return left.heldAmountCny - right.heldAmountCny;
          }
        }
        return String(left.fundCode ?? "").localeCompare(String(right.fundCode ?? ""), "zh-CN");
      });
    const memory = lookupBucketMemory(signalMemorySummary, bucket);
    const confidence = Number(bucketSuggestion?.confidence ?? 0.5) || 0.5;
    const directional = profile.stance === "buy" || profile.stance === "sell";
    const reasons = [];
    let executionState = "observe";

    if (!executionEnabled) {
      reasons.push(
        trimText(diagnostics?.providerError) ??
          trimText(diagnostics?.fallbackReason) ??
          (freshness.freshnessLabel !== "fresh" ? "snapshot_stale" : "non_live_mode")
      );
    } else if (!executableBuckets.has(bucket)) {
      reasons.push("bucket_not_enabled_for_execution");
    } else if (profile.stance === "hold") {
      reasons.push("neutral_or_hold_signal");
    } else if (memory.directionFlipCooldown) {
      reasons.push("direction_flip_cooldown");
    } else if (confidence < MIN_ACTION_CONFIDENCE) {
      reasons.push("confidence_below_watch_threshold");
      if (marketDataTier !== "live") {
        reasons.push(`market_data_${marketDataTier}`);
      }
      if (tradingCalendarState !== "trading_day") {
        reasons.push(`calendar_${tradingCalendarState}`);
      }
      executionState = directional ? "risk_watch" : "observe";
    } else if (!isMarketDataExecutionReady(marketDataTier)) {
      reasons.push(`market_data_${marketDataTier}`);
      executionState = "risk_watch";
    } else if (tradingCalendarState !== "trading_day") {
      reasons.push(`calendar_${tradingCalendarState}`);
      executionState = "risk_watch";
    } else if (confidence < STRONG_ACTION_CONFIDENCE) {
      reasons.push("confidence_below_action_threshold");
      executionState = "risk_watch";
    } else if (memory.sameDirectionStreak < REQUIRED_DIRECTION_STREAK) {
      reasons.push("signal_continuity_insufficient");
      executionState = "risk_watch";
    } else if (profile.stance === "buy") {
      if (tradeAvailableCashCny <= 0) {
        reasons.push("cash_bucket_unavailable");
        executionState = "blocked";
      } else if (fundSuggestions.length === 0) {
        reasons.push("bucket_has_no_fund_mapping");
        executionState = "blocked";
      } else {
        executionState = "real";
      }
    } else if (profile.stance === "sell") {
      if (heldAmountCny <= 0) {
        reasons.push("no_current_holdings");
      } else if (fundSuggestions.some((item) => positionsByFundCode.has(String(item?.fundCode ?? "").trim()))) {
        executionState = "real";
      } else {
        reasons.push("held_position_not_mapped");
        executionState = "blocked";
      }
    }

    let primaryAction = null;
    if (executionState === "real") {
      if (profile.stance === "buy") {
        const primary = pickPrimaryFundSuggestion(fundSuggestions, positionsByFundCode, profile.stance);
        if (primary) {
          const sizing = buildActionSizing({
            stance: profile.stance,
            currentHoldingAmountCny: positionsByFundCode.get(String(primary.fundCode ?? "").trim())?.amountCny ?? 0,
            bucketHeldAmountCny: heldAmountCny,
            targetAmountCny: resolveBucketTargetAmount(assetMaster, bucket, totalAssetsCny),
            tradeAvailableCashCny,
            totalAssetsCny,
            minTradeAmountCny
          });
          if (!sizing.suggestedAmountRangeCny) {
            reasons.push(...sizing.sizingWarnings);
            executionState = "risk_watch";
          } else {
            primaryAction = {
              bucket,
              bucketLabel,
              fundCode: primary.fundCode,
              fundName: primary.fundName,
              stance: profile.stance,
              actionLabel: profile.actionLabel,
              verdict: primary.verdict,
              rating: primary.rating,
              confidence: primary.confidence,
              confidenceSource: trimText(primary.confidenceSource),
              reasonSummary: primary.reasonSummary,
              proxySymbols: primary.proxySymbols,
              heldAmountCny: sizing.currentHoldingAmountCny,
              ...sizing,
              ...buildActionSummaryFields({
                reasonSummary: primary.reasonSummary,
                stance: profile.stance,
                actionLabel: profile.actionLabel,
                bucketLabel,
                suggestedAmountRangeCny: sizing.suggestedAmountRangeCny,
                sizingWarnings: sizing.sizingWarnings
              })
            };
            realActions.push(primaryAction);
          }
        }
      } else if (profile.stance === "sell") {
        const primary = pickPrimaryFundSuggestion(
          fundSuggestions.filter((suggestion) => {
            const fundCode = String(suggestion?.fundCode ?? "").trim();
            const held = positionsByFundCode.get(fundCode);
            return held && held.amountCny > 0;
          }),
          positionsByFundCode,
          profile.stance
        );
        if (primary) {
          const held = positionsByFundCode.get(String(primary?.fundCode ?? "").trim());
          const sizing = buildActionSizing({
            stance: profile.stance,
            currentHoldingAmountCny: held?.amountCny ?? 0,
            bucketHeldAmountCny: heldAmountCny,
            targetAmountCny: resolveBucketTargetAmount(assetMaster, bucket, totalAssetsCny),
            tradeAvailableCashCny,
            totalAssetsCny,
            minTradeAmountCny
          });
          if (!sizing.suggestedAmountRangeCny) {
            reasons.push(...sizing.sizingWarnings);
            executionState = "risk_watch";
          } else {
            primaryAction = {
              bucket,
              bucketLabel,
              fundCode: primary.fundCode,
              fundName: primary.fundName,
              stance: profile.stance,
              actionLabel: profile.actionLabel,
              verdict: primary.verdict,
              rating: primary.rating,
              confidence: primary.confidence,
              confidenceSource: trimText(primary.confidenceSource),
              reasonSummary: primary.reasonSummary,
              proxySymbols: primary.proxySymbols,
              heldAmountCny: sizing.currentHoldingAmountCny,
              ...sizing,
              ...buildActionSummaryFields({
                reasonSummary: primary.reasonSummary,
                stance: profile.stance,
                actionLabel: profile.actionLabel,
                bucketLabel,
                suggestedAmountRangeCny: sizing.suggestedAmountRangeCny,
                sizingWarnings: sizing.sizingWarnings
              })
            };
            realActions.push(primaryAction);
          }
        }
      }
    } else if (executionState === "blocked") {
      const primary = pickPrimaryFundSuggestion(fundSuggestions, positionsByFundCode, profile.stance);
      blockedSuggestions.push(
        decorateBlockedSuggestion(primary ?? bucketSuggestion, reasons[0], {
          bucket,
          fundCode: trimText(primary?.fundCode),
          fundName: trimText(primary?.fundName),
          verdict: trimText(primary?.verdict) ?? trimText(bucketSuggestion?.verdict)
        })
      );
    }

    if (executionState !== "real") {
      const reasonLabels = labelDecisionReasons(reasons);
      const primaryReasonLabel = reasonLabels[0] ?? reasons[0];
      observeLine.push({
        bucket,
        bucketLabel,
        verdict: trimText(bucketSuggestion?.verdict) ?? translateTradingAgentsRating(rating, bridgeConfig?.ratingMap ?? {}),
        note:
          executionState === "blocked"
            ? `已被本地护栏拦下：${primaryReasonLabel ?? "blocked"}`
            : executionState === "risk_watch"
              ? `进入风险观察：${primaryReasonLabel ?? "risk_watch"}`
              : reasons.length > 0
                ? `继续观察：${primaryReasonLabel}`
            : trimText(bucketSuggestion?.reasonSummary) ?? "继续观察。",
        reasons,
        reasonLabels,
        confidence: bucketSuggestion?.confidence ?? null,
        confidenceSource: trimText(bucketSuggestion?.confidenceSource),
        proxySymbols: bucketSuggestion?.proxySymbols ?? [],
        executionState,
        candidateFunds
      });
    }

    const bucketAction = buildBucketAction({
      bucketSuggestion,
      bucketLabel,
      rating,
      profile,
      heldAmountCny,
      executionState,
      reasons,
      candidateFunds,
      primaryAction
    });
    bucketActions.push(bucketAction);

    bucketVerdicts.push({
      bucket,
      bucketLabel,
      rating,
      verdict: trimText(bucketSuggestion?.verdict) ?? translateTradingAgentsRating(rating, bridgeConfig?.ratingMap ?? {}),
      confidence: bucketSuggestion?.confidence ?? null,
      confidenceSource: trimText(bucketSuggestion?.confidenceSource),
      executionState,
      reasonSummary: trimText(bucketSuggestion?.reasonSummary) ?? "暂无明确论据",
      risks: asArray(bucketSuggestion?.risks),
      signalCount: Number(bucketSuggestion?.signalCount ?? 0) || 0,
      proxySymbols: asArray(bucketSuggestion?.proxySymbols),
      riskJudge: trimText(bucketSuggestion?.riskJudge),
      investmentJudge: trimText(bucketSuggestion?.investmentJudge),
      heldAmountCny,
      candidateFunds
    });
  }

  bucketVerdicts.push(
    ...buildPassiveBucketVerdicts(assetMaster, bridgeConfig, heldBuckets, existingBuckets)
  );

  const uniqueRealActions = realActions
    .filter(
      (item, index, list) =>
        list.findIndex(
          (candidate) =>
            candidate?.bucket === item?.bucket && candidate?.fundCode === item?.fundCode && candidate?.stance === item?.stance
        ) === index
    )
    .slice(0, MAX_REAL_ACTIONS);
  const realSellActions = uniqueRealActions.filter((item) => item?.stance === "sell");
  const realBuyActions = uniqueRealActions.filter((item) => item?.stance === "buy");
  const hasRiskWatch = bucketActions.some((item) => item?.executionState === "risk_watch");
  const mode = normalizeMode(rawSnapshot?.mode);
  const provider = trimText(rawSnapshot?.provider) ?? trimText(adviceSnapshot?.provider);
  const brainProfile = resolveTradingAgentsBrainProfile({
    rawSnapshot,
    adviceSnapshot,
    bridgeConfig
  });
  const providerRuntime = {
    ...(diagnostics?.providerRuntime ?? {}),
    ...(brainProfile ? { brainProfile } : {})
  };
  const providerUsed = mode === "fallback_fixture" && !trimText(providerRuntime?.providerUsed)
    ? "fallback_fixture"
    : trimText(providerRuntime?.providerUsed) ?? provider;
  const providerMode = trimText(providerRuntime?.providerMode) ?? (mode === "live" ? "live" : "fallback_fixture");
  const providerError = summarizeTradingAgentsProviderError(diagnostics?.providerError, provider);
  const hasFallback = Boolean(providerError || trimText(diagnostics?.fallbackReason));
  const nonLiveMode = normalizeMode(rawSnapshot?.mode) !== "live";
  let shouldTradeVerdict = "observe_only";

  if ((hasFallback || nonLiveMode) && uniqueRealActions.length === 0) {
    shouldTradeVerdict = blockedSuggestions.length > 0 ? "blocked" : "observe_only";
  } else if (freshness.freshnessLabel !== "fresh") {
    shouldTradeVerdict = "observe_only";
  } else if (realSellActions.length > 0 && realBuyActions.length === 0) {
    shouldTradeVerdict = "reduce_risk";
  } else if (uniqueRealActions.length > 0) {
    shouldTradeVerdict = "limited_execute";
  } else if (hasRiskWatch) {
    shouldTradeVerdict = "risk_watch";
  } else if (blockedSuggestions.length > 0 && observeLine.length === 0) {
    shouldTradeVerdict = "blocked";
  }

  let riskLight = "yellow";
  if (shouldTradeVerdict === "blocked") {
    riskLight = "red";
  } else if (shouldTradeVerdict === "reduce_risk") {
    const hasHardSell = realSellActions.some((item) => normalizeTradingAgentsRating(item?.rating) === "SELL");
    riskLight = hasHardSell ? "red" : "yellow";
  } else if (shouldTradeVerdict === "limited_execute") {
    riskLight = realSellActions.length > 0 ? "yellow" : "green";
  } else if (shouldTradeVerdict === "risk_watch") {
    const hasSellWatch = bucketActions.some(
      (item) => item?.executionState === "risk_watch" && item?.direction === "sell"
    );
    riskLight = hasSellWatch ? "yellow" : "green";
  }

  const generatedAt = now instanceof Date ? now.toISOString() : new Date(String(now ?? Date.now())).toISOString();
  const decisionHeadline = buildDecisionHeadline(shouldTradeVerdict);
  const summary = buildDecisionSummary({
    verdict: shouldTradeVerdict,
    mode,
    provider,
    realActions: uniqueRealActions,
    observeLine,
    blockedSuggestions,
    diagnostics: {
      ...diagnostics,
      freshnessLabel: freshness.freshnessLabel
    }
  });
  const provisionalSnapshot = {
    mode,
    provider,
    providerUsed,
    providerMode,
    providerRuntime,
    bucketActions,
    bucketVerdicts,
    shouldTradeVerdict,
    status: shouldTradeVerdict,
    riskLight
  };
  const fundAnalyses = buildFundAnalyses({
    portfolioState,
    assetMaster,
    bucketActions,
    bucketVerdicts,
    mode,
    providerRuntime: provisionalSnapshot.providerRuntime,
    provider,
    factorProfilesConfig,
    researchProfilesConfig,
    now
  });
  const portfolioAnalysis = buildPortfolioAnalysis({
    fundAnalyses,
    portfolioState,
    assetMaster,
    bucketActions,
    shouldTradeVerdict,
    riskLight,
    mode,
    providerRuntime: provisionalSnapshot.providerRuntime,
    factorProfilesConfig,
    researchProfilesConfig
  });
  const observationGroups = buildObservationGroups({
    observeLine,
    bucketActions,
    decisionContext,
    diagnostics: {
      ...diagnostics,
      freshnessLabel: freshness.freshnessLabel
    },
    mode,
    providerRuntime,
    providerError,
    fallbackReason: trimText(diagnostics?.fallbackReason)
  });
  const morningBrief = buildMorningBrief({
    shouldTradeVerdict,
    riskLight,
    realActions: uniqueRealActions,
    observeLine,
    observationGroups,
    deepDiveCandidates: portfolioAnalysis.deepDiveCandidates ?? [],
    decisionSummary: summary
  });

  return {
    generatedAt,
    asOf: trimText(rawSnapshot?.asOf) ?? trimText(adviceSnapshot?.asOf) ?? trimText(rawSnapshot?.generatedAt),
    accountId,
    mode,
    source: trimText(rawSnapshot?.source) ?? trimText(adviceSnapshot?.source) ?? "TradingAgents",
    provider,
    brainProfile,
    providerUsed,
    providerAttempted: asArray(providerRuntime?.providerAttempted),
    providerFallbackReason: trimText(providerRuntime?.providerFallbackReason),
    providerMode,
    providerRuntime,
    marketDataTier,
    marketDataTierLabel,
    marketDataAsOf: marketProxyQuoteAsOf ?? marketDataLatestDates[0] ?? trimText(rawSnapshot?.asOf),
    status: shouldTradeVerdict,
    riskLight,
    shouldTradeVerdict,
    decisionHeadline,
    decisionSummary: summary,
    morningBrief,
    decisionContext,
    signalMemorySummary,
    executionChecklist: {
      realActions: uniqueRealActions,
      observeLine,
      blockedSuggestions
    },
    bucketActions,
    bucketVerdicts,
    observationGroups,
    fundActions: uniqueRealActions,
    fundAnalyses,
    portfolioAnalysis,
    deepDiveCandidates: portfolioAnalysis.deepDiveCandidates ?? [],
    deepDiveAnalyses: portfolioAnalysis.deepDiveAnalyses ?? [],
    fundTradingAgentsAdapter: portfolioAnalysis.fundTradingAgentsAdapter ?? null,
    watchItems: observeLine,
    blockedItems: blockedSuggestions,
    marketProxyQuotes: diagnostics?.marketProxyQuotes ?? null,
    diagnostics: {
      freshnessLabel: freshness.freshnessLabel,
      ageHours: freshness.ageHours,
      rawCallCount: Number(adviceSnapshot?.rawCallCount ?? asArray(rawSnapshot?.calls).length),
      bucketSuggestionCount: asArray(adviceSnapshot?.bucketSuggestions).length,
      fundSuggestionCount: asArray(adviceSnapshot?.fundSuggestions).length,
      blockedSuggestionCount: blockedSuggestions.length,
      tradeAvailableCashCny,
      portfolioSnapshotDate: trimText(portfolioState?.snapshot_date),
      marketDataTier,
      marketDataTierLabel,
      marketDataAsOf: marketProxyQuoteAsOf ?? marketDataLatestDates[0] ?? trimText(rawSnapshot?.asOf),
      marketProxyQuotes: diagnostics?.marketProxyQuotes ?? null,
      tradingCalendarState,
      activePositionCount: positionsByFundCode.size,
      fundAnalysisCount: fundAnalyses.length,
      deepDiveCandidateCount: asArray(portfolioAnalysis.deepDiveCandidates).length,
      executableBuckets: [...executableBuckets],
      defensiveBuckets: asArray(bridgeConfig?.blockedBuckets),
      fallbackReason: trimText(diagnostics?.fallbackReason),
      providerError,
      providerRuntime: diagnostics?.providerRuntime ?? null,
      providerReady: !providerError,
      executionEnabled,
      liveRequested: diagnostics?.liveRequested === true,
      marketDataRefreshStatus: trimText(diagnostics?.marketDataRefresh?.status),
      marketDataRefreshTriggered: diagnostics?.marketDataRefresh?.triggered === true,
      marketDataRefresh: diagnostics?.marketDataRefresh ?? null,
      brainProfile
    }
  };
}

export async function loadTradingDecisionSnapshot({
  portfolioRoot = resolvePortfolioRoot(),
  accountId = resolveAccountId({ portfolioRoot }),
  allowFixtureFallback = true,
  now = new Date(),
  manifest = null,
  bridgeConfig = null
} = {}) {
  const resolvedManifest = manifest ?? (await readManifestState(buildPortfolioPath(portfolioRoot, "state-manifest.json")));
  const paths = resolveTradingDecisionPaths(portfolioRoot, resolvedManifest);
  const persisted = await readJsonOrDefault(paths.decisionSnapshotPath, null);
  if (persisted) {
    const rawForRuntime = await readJsonOrDefault(paths.rawSnapshotPath, null);
    const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingDecisionConfig());
    const factorProfilesConfig = (await readJsonOrDefault(paths.factorProfilesPath, {})) ?? {};
    const researchProfilesConfig = (await readJsonOrDefault(paths.researchProfilesPath, {})) ?? {};
    const withQuotes = applyMarketProxyQuotesToDecisionSnapshot(
      persisted,
      await loadMarketProxyQuoteSnapshot({ portfolioRoot, manifest: resolvedManifest })
    );
    const withRuntimeProfile = attachBrainProfile(
      withQuotes,
      resolveTradingAgentsBrainProfile({
        snapshot: withQuotes,
        rawSnapshot: rawForRuntime ?? {},
        bridgeConfig: resolvedBridgeConfig
      })
    );
    if (
      asArray(withRuntimeProfile?.fundAnalyses).length > 0 &&
      withRuntimeProfile?.fundAnalyses?.[0]?.factorProfile &&
      withRuntimeProfile?.fundAnalyses?.[0]?.researchProfile &&
      withRuntimeProfile?.fundAnalyses?.[0]?.researchProfileQuality &&
      withRuntimeProfile?.fundAnalyses?.[0]?.deepDiveTrigger &&
      withRuntimeProfile?.fundAnalyses?.[0]?.statusOneLine &&
      withRuntimeProfile?.portfolioAnalysis?.factorExposureSummary &&
      withRuntimeProfile?.portfolioAnalysis?.peerGroupSummary &&
      withRuntimeProfile?.portfolioAnalysis?.deepDiveCandidates &&
      withRuntimeProfile?.portfolioAnalysis?.deepDiveAnalyses &&
      withRuntimeProfile?.portfolioAnalysis?.fundTradingAgentsAdapter &&
      withRuntimeProfile?.portfolioAnalysis?.fundTradingAgentsAdapter?.contexts?.[0]?.researchProfile &&
      withRuntimeProfile?.observationGroups &&
      withRuntimeProfile?.morningBrief
    ) {
      return withRuntimeProfile;
    }
    const canonicalState = await loadCanonicalPortfolioState({
      portfolioRoot,
      manifest: resolvedManifest
    });
    const assetMaster = (await readJsonOrDefault(paths.assetMasterPath, {})) ?? {};
    return addFundAnalysesToDecisionSnapshot(withRuntimeProfile, {
      portfolioState: canonicalState?.payload ?? {},
      assetMaster,
      bridgeConfig: resolvedBridgeConfig,
      factorProfilesConfig,
      researchProfilesConfig,
      now
    });
  }

  const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingDecisionConfig());
  const rawSnapshot =
    (await readJsonOrDefault(paths.rawSnapshotPath, null)) ??
    (allowFixtureFallback ? await loadTradingAgentsRawFixture() : null);
  const adviceSnapshot = await loadTradingAdviceSnapshot({
    portfolioRoot,
    accountId,
    allowFixtureFallback,
    now,
    manifest: resolvedManifest,
    bridgeConfig: resolvedBridgeConfig
  });
  const canonicalState = await loadCanonicalPortfolioState({
    portfolioRoot,
    manifest: resolvedManifest
  });
  const assetMaster = (await readJsonOrDefault(paths.assetMasterPath, {})) ?? {};
  const factorProfilesConfig = (await readJsonOrDefault(paths.factorProfilesPath, {})) ?? {};
  const researchProfilesConfig = (await readJsonOrDefault(paths.researchProfilesPath, {})) ?? {};
  const signalMemory = (await readJsonOrDefault(paths.signalMemoryPath, {})) ?? {};

  return applyMarketProxyQuotesToDecisionSnapshot(
    await buildTradingDecisionSnapshot({
    rawSnapshot:
      rawSnapshot ??
      {
        asOf: adviceSnapshot?.asOf,
        generatedAt: adviceSnapshot?.generatedAt,
        mode: adviceSnapshot?.mode,
        source: adviceSnapshot?.source,
        provider: adviceSnapshot?.provider
      },
    adviceSnapshot,
    portfolioState: canonicalState?.payload ?? {},
    assetMaster,
    bridgeConfig: resolvedBridgeConfig,
    factorProfilesConfig,
    researchProfilesConfig,
    accountId,
    now,
    signalMemory,
    diagnostics: {
      fallbackReason:
        normalizeMode(rawSnapshot?.mode ?? adviceSnapshot?.mode) === "live" ? null : "decision_snapshot_missing_using_non_live_source"
    }
    }),
    await loadMarketProxyQuoteSnapshot({ portfolioRoot, manifest: resolvedManifest })
  );
}

export async function persistTradingDecisionArtifacts({
  portfolioRoot = resolvePortfolioRoot(),
  accountId = resolveAccountId({ portfolioRoot }),
  rawSnapshot = {},
  adviceSnapshot = {},
  decisionSnapshot = null,
  bridgeConfig = null,
  diagnostics = {},
  now = new Date()
} = {}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const paths = resolveTradingDecisionPaths(portfolioRoot, manifest);
  const canonicalState = await loadCanonicalPortfolioState({
    portfolioRoot,
    manifest
  });
  const assetMaster = (await readJsonOrDefault(paths.assetMasterPath, {})) ?? {};
  const factorProfilesConfig = (await readJsonOrDefault(paths.factorProfilesPath, {})) ?? {};
  const researchProfilesConfig = (await readJsonOrDefault(paths.researchProfilesPath, {})) ?? {};
  const signalMemory = (await readJsonOrDefault(paths.signalMemoryPath, {})) ?? {};
  const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingDecisionConfig());
  const nextDecisionSnapshot =
    decisionSnapshot ??
    (await buildTradingDecisionSnapshot({
      rawSnapshot,
      adviceSnapshot,
      portfolioState: canonicalState?.payload ?? {},
      assetMaster,
      factorProfilesConfig,
      researchProfilesConfig,
      bridgeConfig: resolvedBridgeConfig,
      accountId,
      diagnostics,
      now,
      signalMemory
    }));
  const nextSignalMemory = buildNextSignalMemory({
    signalMemory,
    bucketActions: nextDecisionSnapshot?.bucketActions ?? [],
    rawSnapshot,
    accountId,
    now
  });

  await writeJsonAtomic(paths.decisionSnapshotPath, nextDecisionSnapshot);
  await writeJsonAtomic(paths.signalMemoryPath, nextSignalMemory);
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      latest_trading_decision_snapshot: paths.decisionSnapshotPath,
      latest_tradingagents_signal_memory: paths.signalMemoryPath
    }
  });

  return {
    decisionSnapshotPath: paths.decisionSnapshotPath,
    decisionSnapshot: nextDecisionSnapshot,
    signalMemoryPath: paths.signalMemoryPath,
    signalMemory: nextSignalMemory
  };
}
