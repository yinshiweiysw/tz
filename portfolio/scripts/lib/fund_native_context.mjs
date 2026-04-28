import { buildFundTradingAgentsContext } from "./fund_tradingagents_adapter.mjs";

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

function findBucketAction(bucketActions = [], bucket) {
  const key = trimText(bucket);
  return asArray(bucketActions).find((item) => trimText(item?.bucket) === key) ?? null;
}

function templateLabel(template) {
  switch (trimText(template)) {
    case "qdii_index_fund":
      return "QDII/指数";
    case "qdii_active_fund":
      return "QDII/主动";
    case "qdii_commodity_fund":
      return "QDII/商品";
    case "qdii_fof_fund":
      return "QDII/FOF";
    case "index_fund":
      return "指数基金";
    case "active_equity_fund":
      return "主动权益";
    case "defensive_fund":
      return "防守/固收";
    default:
      return "通用基金";
  }
}

function buildPromptContext({ candidate = {}, researchProfile = {}, factorProfile = {}, bucketAction = null } = {}) {
  const fundName = trimText(researchProfile?.fundName) ?? trimText(candidate?.fundName) ?? trimText(candidate?.fundCode) ?? "未知基金";
  const template = trimText(researchProfile?.analysisTemplate);
  const topHoldings = asArray(researchProfile?.lookthrough?.topHoldings)
    .slice(0, 6)
    .map((item) => trimText(item?.name) ?? trimText(item?.symbol))
    .filter(Boolean)
    .join(" / ");
  return [
    `基金：${fundName}`,
    `类型：${templateLabel(template)}`,
    `基金经理：${trimText(researchProfile?.manager) ?? "未加载"}`,
    `基金公司：${trimText(researchProfile?.fundCompany) ?? "未加载"}`,
    `规模：${trimText(researchProfile?.fundSize) ?? "未加载"}`,
    `费率：${trimText(researchProfile?.fees) ?? "未加载"}`,
    `重仓：${topHoldings || "未加载"}`,
    `因子：${trimText(factorProfile?.primaryFactorLabel) ?? trimText(factorProfile?.primaryFactor) ?? "未映射"}`,
    `代理资产：${asArray(factorProfile?.proxySymbols).join(" / ") || "未配置"}`,
    `桶方向：${trimText(bucketAction?.verdict) ?? "无桶信号"}`,
    `当前持仓：${roundMoney(candidate?.amountCny) ?? "--"} 元`,
    `持有盈亏：${roundMoney(candidate?.holdingPnl) ?? "--"} 元`,
    `确认状态：${trimText(candidate?.confirmationState) ?? "unknown"}`
  ].join("\n");
}

export function buildFundNativeContext({ candidate = {}, decisionSnapshot = {} } = {}) {
  const fundAnalyses = asArray(decisionSnapshot?.fundAnalyses);
  const bucketActions = asArray(decisionSnapshot?.bucketActions);
  const portfolioAnalysis = decisionSnapshot?.portfolioAnalysis ?? {};
  const bucketAction = findBucketAction(bucketActions, candidate?.bucket);
  const researchProfile = candidate?.researchProfile ?? {};
  const factorProfile = candidate?.factorProfile ?? {};
  const adapterContext = buildFundTradingAgentsContext({
    candidate,
    fundAnalyses,
    bucketActions,
    portfolioAnalysis,
    decisionSnapshot
  });

  const fundCode = trimText(candidate?.fundCode);
  const fundName = trimText(researchProfile?.fundName) ?? trimText(candidate?.fundName) ?? fundCode;
  const fundTemplate = trimText(researchProfile?.analysisTemplate) ?? "generic_fund";

  return {
    targetType: "fund",
    targetId: fundCode ? `fund:${fundCode}` : "fund:unknown",
    fundCode,
    fundName,
    fundTemplate,
    source: "TradingAgents fund-native compatibility context",
    adapterContext,
    holding: {
      amountCny: roundMoney(candidate?.amountCny),
      holdingPnl: roundMoney(candidate?.holdingPnl),
      dayPnl: roundMoney(candidate?.dayPnl),
      confirmationState: trimText(candidate?.confirmationState) ?? "unknown",
      tradeStance: trimText(candidate?.tradeStance)
    },
    researchProfile,
    researchProfileQuality: candidate?.researchProfileQuality ?? null,
    factorContext: {
      primaryFactor: trimText(factorProfile?.primaryFactor),
      primaryFactorLabel: trimText(factorProfile?.primaryFactorLabel),
      secondaryFactors: asArray(factorProfile?.secondaryFactors),
      proxySymbols: asArray(factorProfile?.proxySymbols),
      styleTags: asArray(factorProfile?.styleTags),
      region: trimText(factorProfile?.region),
      confidence: toFiniteNumber(factorProfile?.confidence)
    },
    peerContext: {
      peerFunds: asArray(adapterContext?.peerFunds),
      peerGroup: trimText(factorProfile?.primaryFactorLabel) ?? trimText(factorProfile?.primaryFactor),
      representativeCandidate: Boolean(candidate?.peerRole?.representativeCandidate)
    },
    marketContext: {
      bucket: trimText(candidate?.bucket),
      bucketLabel: trimText(candidate?.bucketLabel),
      bucketVerdict: trimText(bucketAction?.verdict),
      bucketRating: trimText(bucketAction?.rating),
      proxySymbols: asArray(bucketAction?.proxySymbols).length > 0 ? asArray(bucketAction?.proxySymbols) : asArray(factorProfile?.proxySymbols),
      marketDataTierLabel: trimText(decisionSnapshot?.marketDataTierLabel ?? decisionSnapshot?.decisionContext?.marketDataTierLabel)
    },
    triggerContext: {
      level: trimText(candidate?.deepDiveTrigger?.level),
      reasons: asArray(candidate?.deepDiveTrigger?.reasons),
      reasonLabels: asArray(candidate?.deepDiveTrigger?.reasonLabels)
    },
    guardrails: {
      reviewOnly: true,
      canWriteLedger: false,
      canGenerateOrder: false,
      confirmedNavState: trimText(decisionSnapshot?.confirmedNavState ?? decisionSnapshot?.diagnostics?.confirmedNavState),
      forbidStockIntradayLanguage: true
    },
    promptContext: buildPromptContext({ candidate, researchProfile, factorProfile, bucketAction })
  };
}

export function buildFundNativeContextsFromDecision({ decisionSnapshot = {}, scope = "deep_dive", limit = 4 } = {}) {
  const source = scope === "all"
    ? asArray(decisionSnapshot?.fundAnalyses)
    : asArray(decisionSnapshot?.portfolioAnalysis?.deepDiveCandidates ?? decisionSnapshot?.deepDiveCandidates);
  return source
    .slice(0, Math.max(1, Number(limit) || 4))
    .map((candidate) => buildFundNativeContext({ candidate, decisionSnapshot }));
}
