import { getComparableChangePercent } from "./market_schedule_guard.mjs";

const ACTIVE_KEYWORDS = ["关税", "停火", "袭击", "降息", "制裁", "原油", "黄金", "美债", "中东", "油价", "原油"];
const NOISE_KEYWORDS = ["小作文", "传言", "局部异动", "盘面直播", "午评", "涨停分析", "快速拉升"];
const THEMES = [
  {
    key: "geopolitics_oil",
    label: "中东地缘升级推动油价再定价",
    keywords: ["中东", "伊朗", "以色列", "袭击", "油价", "原油", "WTI"]
  },
  {
    key: "trade_tariff",
    label: "关税与贸易摩擦冲击全球风险偏好",
    keywords: ["关税", "制裁", "贸易", "特朗普"]
  },
  {
    key: "rates_easing",
    label: "降息预期与利率交易继续发酵",
    keywords: ["降息", "加息", "美债", "收益率", "通胀"]
  }
];

const THEME_METADATA = {
  geopolitics_oil: {
    driver_type: "geopolitics",
    expected_consensus: "市场原本预期地缘扰动仍可控，油金不需要进入持续性的风险重定价。",
    positiveConfirmationHint: "油价与黄金同步走强，说明风险溢价仍在抬升。",
    negativeConfirmationHint: "若仅 headlines 升温而跨资产未确认，则更像情绪噪音。"
  },
  trade_tariff: {
    driver_type: "macro_policy",
    expected_consensus: "市场原本预期关税博弈更多停留在口头层面，不足以触发跨资产再定价。",
    positiveConfirmationHint: "股指承压而黄金、美元走强，说明风险资产正在重新定价。",
    negativeConfirmationHint: "若仅有标题冲击而资产价格未联动，则增量信息不足。"
  },
  rates_easing: {
    driver_type: "rates_macro",
    expected_consensus: "市场已部分计入宽松预期，但并未一致押注立刻进入单边风险偏好修复。",
    positiveConfirmationHint: "若利率下行、美元走弱且权益走强，则宽松交易开始被强化。",
    negativeConfirmationHint: "若宽松 headlines 出现但资产未协同，则仍停留在口头预期。"
  }
};

function normalizeHeadline(item) {
  const text = `${item?.title ?? ""} ${item?.content ?? ""}`.replace(/\s+/g, " ").trim();
  return text;
}

function scoreHeadline(text) {
  let score = 0;
  for (const keyword of ACTIVE_KEYWORDS) {
    if (text.includes(keyword)) {
      score += 2;
    }
  }
  for (const keyword of NOISE_KEYWORDS) {
    if (text.includes(keyword)) {
      score -= 3;
    }
  }
  return score;
}

function classifyTheme(headline) {
  let bestTheme = null;
  let bestScore = 0;

  for (const theme of THEMES) {
    const score = theme.keywords.reduce(
      (sum, keyword) => (headline.includes(keyword) ? sum + 1 : sum),
      0
    );
    if (score > bestScore) {
      bestTheme = theme;
      bestScore = score;
    }
  }

  return {
    theme: bestTheme,
    themeScore: bestScore
  };
}

function collectConfirmations(marketSnapshot = {}) {
  const rows = [
    ...(Array.isArray(marketSnapshot.global_indices) ? marketSnapshot.global_indices : []),
    ...(Array.isArray(marketSnapshot.commodities) ? marketSnapshot.commodities : []),
    ...(Array.isArray(marketSnapshot.rates_fx) ? marketSnapshot.rates_fx : [])
  ];
  return rows.filter((row) => {
    const move = getComparableChangePercent(row);
    return Number.isFinite(move) && Math.abs(move) >= 0.5;
  });
}

function deriveReactionDirection(confirmations = []) {
  const labels = confirmations.map((item) => String(item?.label ?? ""));
  const equityMoves = confirmations
    .filter((item) => /标普|纳斯|恒生|指数/.test(String(item?.label ?? "")))
    .map((item) => getComparableChangePercent(item))
    .filter((value) => Number.isFinite(value));
  const defensiveMoves = confirmations
    .filter((item) => /金|原油|美元/.test(String(item?.label ?? "")))
    .map((item) => getComparableChangePercent(item))
    .filter((value) => Number.isFinite(value));

  if (
    labels.some((label) => /金|美元/.test(label)) &&
    equityMoves.some((value) => value < 0)
  ) {
    return "risk_off";
  }

  if (
    equityMoves.some((value) => value > 0) &&
    defensiveMoves.every((value) => value <= 0.6)
  ) {
    return "risk_on";
  }

  return "mixed";
}

function buildActualMarketReaction(confirmations = []) {
  return {
    dominant_direction: deriveReactionDirection(confirmations),
    confirmation_count: confirmations.length,
    confirmed_assets: confirmations.slice(0, 4).map((row) => ({
      label: row?.label ?? "未知资产",
      move_pct: getComparableChangePercent(row)
    }))
  };
}

function buildExpectationGap({ primary, confirmations = [], status, pricedInAssessment }) {
  const metadata = THEME_METADATA[primary?.theme?.key] ?? {};
  if (status === "active_market_driver") {
    return [
      metadata.positiveConfirmationHint ??
        "主线 headlines 已被跨资产价格验证，说明现实交易结果强于先前共识。",
      pricedInAssessment === "underpriced"
        ? "当前仍属于预期差扩散阶段，尚未完全 price in。"
        : "当前更接近边走边 price in。"
    ].join("");
  }

  return metadata.negativeConfirmationHint ?? "当前 headlines 与价格反应尚未共振，预期差仍不足以转化为主驱动。";
}

function deriveCrowdingFlag(status, pricedInAssessment) {
  if (status === "priced_in_noise" || pricedInAssessment === "fully_priced_in") {
    return "crowded";
  }
  if (status === "active_market_driver" && pricedInAssessment === "underpriced") {
    return "building";
  }
  return "unclear";
}

function buildEvidence(headline, strategyRows, source) {
  const evidence = [];
  if (headline?.text) {
    evidence.push({
      source,
      headline: headline.text,
      timestamp: headline.published_at ?? null
    });
  }
  strategyRows.forEach((row) => {
    const movePct = getComparableChangePercent(row);
    if (!Number.isFinite(movePct)) {
      return;
    }
    evidence.push({
      source: "market_snapshot",
      headline: row.label,
      move_pct: movePct
    });
  });
  return evidence;
}

export function buildResearchEventDriver({ telegraphs = [], marketSnapshot = {} } = {}) {
  const normalized = telegraphs
    .map((item) => ({
      headline: normalizeHeadline(item),
      score: scoreHeadline(normalizeHeadline(item)),
      ...classifyTheme(normalizeHeadline(item)),
      published_at: item?.published_at ?? null,
      source: item?.source ?? "telegraph"
    }))
    .filter((item) => item.headline.length > 0);

  const primary = normalized.sort((left, right) => right.score - left.score)[0] ?? null;
  const confirmations = collectConfirmations(marketSnapshot);

  if (!primary) {
    return {
      status: "unavailable",
      primary_driver: null,
      secondary_drivers: [],
      driver_type: "unknown",
      driver_scope: "cross_asset",
      surprise_level: "low",
      expected_consensus: "",
      actual_market_reaction: {
        dominant_direction: "unknown",
        confirmation_count: 0,
        confirmed_assets: []
      },
      expectation_gap: "",
      crowding_flag: "unclear",
      priced_in_assessment: "unclear",
      evidence: [],
      market_impact: {}
    };
  }

  const evidenceRows = buildEvidence(
    {
      text: primary.theme?.label ?? primary.headline,
      published_at: primary.published_at
    },
    confirmations.slice(0, 3),
    primary.source
  );

  if (primary.score <= 0) {
    return {
      status: "watch_only",
      primary_driver: primary.theme?.label ?? primary.headline,
      secondary_drivers: [],
      driver_type: THEME_METADATA[primary.theme?.key]?.driver_type ?? "headline_noise",
      driver_scope: "cross_asset",
      surprise_level: "low",
      expected_consensus: THEME_METADATA[primary.theme?.key]?.expected_consensus ?? "",
      actual_market_reaction: buildActualMarketReaction(confirmations),
      expectation_gap: buildExpectationGap({
        primary,
        confirmations,
        status: "watch_only",
        pricedInAssessment: "unclear"
      }),
      crowding_flag: "unclear",
      priced_in_assessment: "unclear",
      evidence: evidenceRows,
      market_impact: {}
    };
  }

  const noiseTriggers = ["昨日已落地", "增量信息有限"];
  const isNoiseHeadline = noiseTriggers.some((trigger) => primary.headline.includes(trigger));

  if (isNoiseHeadline) {
    return {
      status: "priced_in_noise",
      primary_driver: primary.theme?.label ?? primary.headline,
      secondary_drivers: [],
      driver_type: THEME_METADATA[primary.theme?.key]?.driver_type ?? "headline_noise",
      driver_scope: "cross_asset",
      surprise_level: "low",
      expected_consensus: THEME_METADATA[primary.theme?.key]?.expected_consensus ?? "",
      actual_market_reaction: buildActualMarketReaction(confirmations),
      expectation_gap: buildExpectationGap({
        primary,
        confirmations,
        status: "priced_in_noise",
        pricedInAssessment: "fully_priced_in"
      }),
      crowding_flag: "crowded",
      priced_in_assessment: "fully_priced_in",
      evidence: evidenceRows,
      market_impact: {}
    };
  }

  if (confirmations.length < 2) {
    return {
      status: "watch_only",
      primary_driver: primary.theme?.label ?? primary.headline,
      secondary_drivers: [],
      driver_type: THEME_METADATA[primary.theme?.key]?.driver_type ?? "event",
      driver_scope: "cross_asset",
      surprise_level: "medium",
      expected_consensus: THEME_METADATA[primary.theme?.key]?.expected_consensus ?? "",
      actual_market_reaction: buildActualMarketReaction(confirmations),
      expectation_gap: buildExpectationGap({
        primary,
        confirmations,
        status: "watch_only",
        pricedInAssessment: "unclear"
      }),
      crowding_flag: "unclear",
      priced_in_assessment: "unclear",
      evidence: evidenceRows,
      market_impact: {}
    };
  }

  const status = "active_market_driver";
  const pricedInAssessment = "underpriced";

  return {
    status,
    primary_driver: primary.theme?.label ?? primary.headline,
    secondary_drivers: normalized.slice(1, 4).map((item) => item.headline),
    driver_type: THEME_METADATA[primary.theme?.key]?.driver_type ?? "event",
    driver_scope: "cross_asset",
    surprise_level: confirmations.length >= 3 ? "high" : "medium",
    expected_consensus: THEME_METADATA[primary.theme?.key]?.expected_consensus ?? "",
    actual_market_reaction: buildActualMarketReaction(confirmations),
    expectation_gap: buildExpectationGap({
      primary,
      confirmations,
      status,
      pricedInAssessment
    }),
    crowding_flag: deriveCrowdingFlag(status, pricedInAssessment),
    priced_in_assessment: pricedInAssessment,
    evidence: evidenceRows,
    market_impact: {}
  };
}
