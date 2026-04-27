import { fileURLToPath } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./account_root.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./atomic_json_state.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./manifest_state.mjs";
import { loadCanonicalPortfolioState } from "./portfolio_state_view.mjs";
import {
  loadTradingAgentsBridgeConfig,
  loadTradingAgentsRawFixture,
  loadTradingAdviceSnapshot,
  resolveTradingAdvicePaths
} from "./tradingagents_bridge.mjs";
import { computeTradingAdviceFreshness } from "./tradingagents_guardrails.mjs";
import { normalizeTradingAgentsRating, translateTradingAgentsRating } from "./tradingagents_mapping.mjs";

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
  const lookup = new Map();
  for (const asset of asArray(assetMaster?.assets)) {
    const code = trimText(asset?.symbol);
    if (!code) {
      continue;
    }
    lookup.set(code, asset);
  }
  return lookup;
}

function buildPositionLookup(portfolioState = {}, assetMaster = {}) {
  const assetLookup = buildAssetLookup(assetMaster);
  const positionsByFundCode = new Map();
  const heldBuckets = new Map();

  for (const position of asArray(portfolioState?.positions)) {
    if (String(position?.status ?? "").trim() && String(position.status).trim() !== "active") {
      continue;
    }

    const code = resolveFundCode(position);
    if (!code) {
      continue;
    }

    const assetMeta = assetLookup.get(code) ?? {};
    const amountCny =
      toFiniteNumber(position?.amount) ??
      toFiniteNumber(position?.observableAmount) ??
      toFiniteNumber(position?.observable_amount) ??
      0;
    const next = {
      fundCode: code,
      fundName: trimText(position?.name) ?? trimText(assetMeta?.name) ?? code,
      bucket: trimText(position?.bucket) ?? trimText(assetMeta?.bucket),
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

function labelMarketDataTier(tier) {
  switch (String(tier ?? "").trim()) {
    case "live":
      return "实时行情";
    case "reference_close":
      return "前收参考";
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
  return ["live", "reference_close"].includes(String(marketDataTier ?? "").trim());
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
  const providerLabel = trimText(provider) ?? "provider";

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
      buildPortfolioPath(portfolioRoot, "data", "tradingagents_signal_memory.json")
  };
}

export async function buildTradingDecisionSnapshot({
  rawSnapshot = {},
  adviceSnapshot = {},
  portfolioState = {},
  assetMaster = {},
  bridgeConfig = {},
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
  const decisionContext = {
    marketDataTier,
    marketDataTierLabel: labelMarketDataTier(marketDataTier),
    marketDataAsOf: marketDataLatestDates[0] ?? trimText(rawSnapshot?.asOf),
    marketDataLatestDates,
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
              ...sizing
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
              ...sizing
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
  const provider = trimText(rawSnapshot?.provider) ?? trimText(adviceSnapshot?.provider);
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
  const mode = normalizeMode(rawSnapshot?.mode);
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

  return {
    generatedAt,
    asOf: trimText(rawSnapshot?.asOf) ?? trimText(adviceSnapshot?.asOf) ?? trimText(rawSnapshot?.generatedAt),
    accountId,
    mode,
    source: trimText(rawSnapshot?.source) ?? trimText(adviceSnapshot?.source) ?? "TradingAgents",
    provider,
    status: shouldTradeVerdict,
    riskLight,
    shouldTradeVerdict,
    decisionHeadline,
    decisionSummary: summary,
    decisionContext,
    signalMemorySummary,
    executionChecklist: {
      realActions: uniqueRealActions,
      observeLine,
      blockedSuggestions
    },
    bucketActions,
    bucketVerdicts,
    fundActions: uniqueRealActions,
    watchItems: observeLine,
    blockedItems: blockedSuggestions,
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
      marketDataTierLabel: labelMarketDataTier(marketDataTier),
      marketDataAsOf: marketDataLatestDates[0] ?? trimText(rawSnapshot?.asOf),
      tradingCalendarState,
      activePositionCount: positionsByFundCode.size,
      executableBuckets: [...executableBuckets],
      defensiveBuckets: asArray(bridgeConfig?.blockedBuckets),
      fallbackReason: trimText(diagnostics?.fallbackReason),
      providerError,
      providerReady: !providerError,
      executionEnabled,
      liveRequested: diagnostics?.liveRequested === true,
      marketDataRefreshStatus: trimText(diagnostics?.marketDataRefresh?.status),
      marketDataRefreshTriggered: diagnostics?.marketDataRefresh?.triggered === true,
      marketDataRefresh: diagnostics?.marketDataRefresh ?? null
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
    return persisted;
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
  const signalMemory = (await readJsonOrDefault(paths.signalMemoryPath, {})) ?? {};

  return buildTradingDecisionSnapshot({
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
    accountId,
    now,
    signalMemory,
    diagnostics: {
      fallbackReason:
        normalizeMode(rawSnapshot?.mode ?? adviceSnapshot?.mode) === "live" ? null : "decision_snapshot_missing_using_non_live_source"
    }
  });
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
  const signalMemory = (await readJsonOrDefault(paths.signalMemoryPath, {})) ?? {};
  const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingDecisionConfig());
  const nextDecisionSnapshot =
    decisionSnapshot ??
    (await buildTradingDecisionSnapshot({
      rawSnapshot,
      adviceSnapshot,
      portfolioState: canonicalState?.payload ?? {},
      assetMaster,
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
