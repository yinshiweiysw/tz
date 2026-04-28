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

function compactText(value, maxLength = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function sameExposure(left = {}, right = {}) {
  if (!left || !right) {
    return false;
  }
  const leftFactor = trimText(left?.factorProfile?.primaryFactor);
  const rightFactor = trimText(right?.factorProfile?.primaryFactor);
  if (leftFactor && rightFactor && leftFactor === rightFactor) {
    return true;
  }
  const leftProxy = new Set(asArray(left?.factorProfile?.proxySymbols).map((item) => trimText(item)).filter(Boolean));
  return asArray(right?.factorProfile?.proxySymbols).some((item) => leftProxy.has(trimText(item)));
}

function findBucketAction(bucketActions = [], bucket) {
  const key = trimText(bucket);
  return asArray(bucketActions).find((item) => trimText(item?.bucket) === key) ?? null;
}

function buildPeerFunds(candidate = {}, fundAnalyses = []) {
  return asArray(fundAnalyses)
    .filter((item) => item?.fundCode !== candidate?.fundCode && sameExposure(candidate, item))
    .sort((left, right) => (toFiniteNumber(right?.amountCny) ?? 0) - (toFiniteNumber(left?.amountCny) ?? 0))
    .slice(0, 6)
    .map((item) => ({
      fundCode: item?.fundCode ?? null,
      fundName: item?.fundName ?? null,
      bucket: item?.bucket ?? null,
      bucketLabel: item?.bucketLabel ?? null,
      factor: item?.factorProfile?.primaryFactor ?? null,
      factorLabel: item?.factorProfile?.primaryFactorLabel ?? null,
      amountCny: roundMoney(item?.amountCny),
      holdingPnl: roundMoney(item?.holdingPnl),
      tradeStance: item?.tradeStance ?? null
    }));
}

function templateInstruction(template) {
  switch (trimText(template)) {
    case "qdii_fof_fund":
      return "QDII/FOF 模板：重点看底层基金透明度、海外市场滞后、汇率/跨市场确认、与同类 QDII 暴露重复；低透明度本身可以构成降级或替换理由。";
    case "qdii_index_fund":
      return "QDII/指数模板：重点看跟踪指数/代理 ETF、QDII 净值 T+1/T+2 滞后、同指数重复暴露和申赎限制；不要把代理资产日内波动直接当确认净值。";
    case "qdii_active_fund":
      return "QDII/主动/主题模板：重点看海外主题代理、基金经理/组合风格、跨市场净值滞后、汇率和同类 QDII 重复暴露。";
    case "qdii_commodity_fund":
      return "QDII/商品模板：重点看商品/黄金对冲角色、海外交易日和汇率滞后、HEDGE 桶仓位上限；不要按权益进攻仓处理。";
    case "index_fund":
      return "指数基金模板：重点看跟踪标的、指数风格、跟踪误差/费率、与同标的基金重复；不做主动选股归因。";
    case "active_equity_fund":
      return "主动权益模板：重点看基金经理/公司、行业穿透、风格漂移、回撤与同类主动基金比较；若基金经理或重仓未加载，必须降低置信度。";
    case "defensive_fund":
      return "防守/固收模板：重点看流动性、回撤、信用/久期、现金替代角色；默认不参与进攻动作。";
    default:
      return "通用基金模板：先区分基金类型，再结合代理资产、资料层、组合仓位和本地护栏给出只读复核结论。";
  }
}

export function buildFundTradingAgentsContext({
  candidate = {},
  fundAnalyses = [],
  bucketActions = [],
  portfolioAnalysis = {},
  researchProfilesConfig = {},
  decisionSnapshot = {}
} = {}) {
  const bucketAction = findBucketAction(bucketActions, candidate?.bucket);
  const factorProfile = candidate?.factorProfile ?? {};
  const proxySymbols = asArray(factorProfile?.proxySymbols);
  const peerFunds = buildPeerFunds(candidate, fundAnalyses);
  const trigger = candidate?.deepDiveTrigger ?? {};
  const plain = candidate?.deepDiveAnalysis ?? {};
  const researchProfile = candidate?.researchProfile ?? null;
  const researchProfileQuality = candidate?.researchProfileQuality ?? null;
  const fundDisplayName = trimText(researchProfile?.fundName) ?? trimText(candidate?.fundName);
  const lookthrough = researchProfile?.lookthrough ?? {};
  const bucketExposure = asArray(portfolioAnalysis?.exposureSummary)
    .find((item) => trimText(item?.bucket) === trimText(candidate?.bucket));
  const factorExposure = asArray(portfolioAnalysis?.factorExposureSummary)
    .find((item) => trimText(item?.factor) === trimText(factorProfile?.primaryFactor));
  const questions = [
    researchProfile
      ? `结合基金资料层判断：${researchProfile.profileOneLine ?? "基金资料已加载"}，当前分析是否主要受持仓穿透不足影响？`
      : "基金资料层未加载时，哪些结论只能停留在代理资产层？",
    "这只基金的问题主要来自市场因子、同类基金重复暴露，还是基金自身/净值确认问题？",
    "在当前组合目标仓位下，它应该继续持有、降级观察，还是进入减风险候选？",
    "如果对应代理资产继续走弱，下一次复核应关注什么触发条件？",
    "它与同类基金是否重复过多，是否需要合并到更清晰的代表基金？"
  ];

  return {
    adapterVersion: 1,
    adapterMode: "context_only",
    target: "fund_in_portfolio",
    fundCode: candidate?.fundCode ?? null,
    fundName: fundDisplayName ?? null,
    mappedBucket: {
      bucket: candidate?.bucket ?? null,
      bucketLabel: candidate?.bucketLabel ?? null,
      tradingAgentsVerdict: bucketAction?.verdict ?? null,
      tradingAgentsRating: bucketAction?.rating ?? null,
      confidence: bucketAction?.confidence ?? null,
      reasonSummary: compactText(bucketAction?.reasonSummary),
      risks: asArray(bucketAction?.risks).slice(0, 3),
      proxySymbols: bucketAction?.proxySymbols ?? proxySymbols
    },
    fundProfile: {
      factor: factorProfile?.primaryFactor ?? null,
      factorLabel: factorProfile?.primaryFactorLabel ?? candidate?.factorLabel ?? null,
      secondaryFactors: factorProfile?.secondaryFactors ?? [],
      styleTags: factorProfile?.styleTags ?? [],
      region: factorProfile?.region ?? null,
      proxySymbols,
      confidence: factorProfile?.confidence ?? null,
      source: factorProfile?.source ?? null
    },
    researchProfile: researchProfile
      ? {
          source: researchProfile.source ?? null,
          dataQuality: researchProfile.dataQuality ?? null,
          asOf: researchProfile.asOf ?? null,
          fundCompany: researchProfile.fundCompany ?? null,
          fundSize: researchProfile.fundSize ?? null,
          fees: researchProfile.fees ?? null,
          fundType: researchProfile.fundType ?? null,
          underlyingIndexOrTheme: researchProfile.underlyingIndexOrTheme ?? null,
          analysisTemplate: researchProfile.analysisTemplate ?? null,
          templateInstruction: templateInstruction(researchProfile.analysisTemplate),
          manager: researchProfile.manager ?? null,
          lookthrough: {
            status: lookthrough.status ?? null,
            source: lookthrough.source ?? null,
            topIndustries: asArray(lookthrough.topIndustries).slice(0, 6),
            topHoldings: asArray(lookthrough.topHoldings).slice(0, 8)
          },
          dueDiligenceFocus: asArray(researchProfile.dueDiligenceFocus).slice(0, 6),
          limitations: asArray(researchProfile.limitations).slice(0, 6),
          profileOneLine: researchProfile.profileOneLine ?? null,
          quality: researchProfileQuality,
          confidence: researchProfile.confidence ?? null
        }
      : {
          source: "missing",
          dataQuality: "missing",
          lookthrough: { status: "not_loaded", topIndustries: [], topHoldings: [] },
          limitations: ["基金资料层缺失，不得编造基金经理、重仓股或行业穿透。"]
        },
    positionContext: {
      amountCny: roundMoney(candidate?.amountCny),
      weightPct: candidate?.weightPct ?? null,
      dayPnl: roundMoney(candidate?.dayPnl),
      holdingPnl: roundMoney(candidate?.holdingPnl),
      holdingPnlRatePct: trigger?.holdingPnlRatePct ?? null,
      dayPnlRatePct: trigger?.dayPnlRatePct ?? null,
      confirmationState: candidate?.confirmationState ?? null,
      tradeStance: candidate?.tradeStance ?? null,
      statusOneLine: candidate?.statusOneLine ?? null
    },
    portfolioContext: {
      decisionStatus: decisionSnapshot?.status ?? decisionSnapshot?.shouldTradeVerdict ?? null,
      riskLight: decisionSnapshot?.riskLight ?? null,
      marketDataTierLabel: decisionSnapshot?.marketDataTierLabel ?? decisionSnapshot?.decisionContext?.marketDataTierLabel ?? null,
      bucketWeightPct: bucketExposure?.weightPct ?? null,
      bucketTargetPct: bucketExposure?.targetPct ?? null,
      bucketTargetGapCny: bucketExposure?.targetGapCny ?? null,
      factorWeightPct: factorExposure?.weightPct ?? null,
      factorExposureCny: factorExposure?.exposureCny ?? null
    },
    triggerContext: {
      level: trigger?.level ?? null,
      priority: trigger?.priority ?? null,
      reasons: trigger?.reasons ?? [],
      reasonLabels: trigger?.reasonLabels ?? [],
      plainOneLine: plain?.plainOneLine ?? null,
      plainWatch: plain?.plainWatch ?? null,
      plainHandle: plain?.plainHandle ?? null
    },
    peerFunds,
    analysisQuestions: questions,
    guardrails: [
      "只输出基金复核结论，不生成订单。",
      "不得直接修改本地账本、份额、成本或确认净值。",
      "必须区分 TradingAgents 代理资产方向与基金本身净值滞后。",
      "基金经理、重仓行业、重仓股只能使用 researchProfile 中已加载资料；未加载时必须标注不确定。",
      "真实交易动作必须继续经过本地基金护栏。"
    ],
    prompt: [
      `请作为基金交易分析师分析 ${fundDisplayName ?? candidate?.fundCode ?? "这只基金"}。`,
      `它映射到 ${candidate?.bucketLabel ?? candidate?.bucket ?? "未命名桶"}，代理资产为 ${proxySymbols.join(" / ") || "未配置"}。`,
      `基金资料：${researchProfile?.profileOneLine ?? "未加载基金研究资料"}；穿透状态 ${lookthrough.status ?? "not_loaded"}。`,
      `资料完整度：${researchProfileQuality?.oneLine ?? "未生成资料完整度标签"}。`,
      `分析模板：${templateInstruction(researchProfile?.analysisTemplate)}。`,
      `当前持仓 ${roundMoney(candidate?.amountCny) ?? "--"} 元，持有盈亏 ${roundMoney(candidate?.holdingPnl) ?? "--"} 元，确认状态 ${candidate?.confirmationState ?? "--"}。`,
      "请结合代理资产方向、基金因子、基金资料、组合仓位、同类基金重复暴露，输出：继续持有 / 降级观察 / 减风险候选 / 替换候选，并解释原因。"
    ].join("\n")
  };
}

export function buildFundTradingAgentsAdapter({
  deepDiveCandidates = [],
  fundAnalyses = [],
  bucketActions = [],
  portfolioAnalysis = {},
  researchProfilesConfig = {},
  decisionSnapshot = {}
} = {}) {
  const candidates = asArray(deepDiveCandidates);
  const contexts = candidates.map((candidate) => buildFundTradingAgentsContext({
    candidate,
    fundAnalyses,
    bucketActions,
    portfolioAnalysis,
    researchProfilesConfig,
    decisionSnapshot
  }));
  return {
    adapterVersion: 1,
    adapterMode: "context_only",
    status: contexts.length > 0 ? "ready" : "empty",
    scope: "deep_dive_candidates",
    source: "TradingAgents bucket brain + local fund adapter",
    count: contexts.length,
    contexts
  };
}
