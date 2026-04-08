import { round } from "./format_utils.mjs";

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
  return String(left).localeCompare(String(right));
}

function normalizeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function summarizeFlowQuality({ latestDate, tradeDate, summaryValue, intradayValue, note }) {
  const zeroed =
    summaryValue !== null &&
    intradayValue !== null &&
    summaryValue === 0 &&
    intradayValue === 0;
  const stale = Boolean(latestDate && tradeDate && compareDateStrings(latestDate, tradeDate) < 0);
  const explicitlySoftBlocked =
    typeof note === "string" &&
    ["暂不做强解释", "回零", "降级", "仅供参考"].some((token) => note.includes(token));

  let status = "ok";
  let blockedReason = null;

  if (!latestDate && summaryValue === null && intradayValue === null) {
    status = "missing";
    blockedReason = "资金通道缺少可用日期与核心数值。";
  } else if (stale && zeroed) {
    status = "degraded";
    blockedReason = "资金数据日期落后于交易日且核心数值回零，不纳入当日资金判断。";
  } else if (stale) {
    status = "degraded";
    blockedReason = "资金数据日期落后于当前交易日，仅可作上一交易日参考。";
  } else if (zeroed || explicitlySoftBlocked) {
    status = "degraded";
    blockedReason = note || "资金端点可返回结构，但核心流入数值回零，不纳入当日资金判断。";
  }

  return {
    status,
    stale,
    zeroed,
    blockedReason
  };
}

function buildFlowSection({
  key,
  latestDate,
  tradeDate,
  summaryValue,
  intradayValue,
  note
}) {
  const quality = summarizeFlowQuality({
    latestDate,
    tradeDate,
    summaryValue,
    intradayValue,
    note
  });

  return {
    key,
    status: quality.status,
    freshness: quality.stale ? "stale" : latestDate ? "aligned" : "missing",
    completeness:
      latestDate || summaryValue !== null || intradayValue !== null ? "partial_or_better" : "missing",
    cross_source_consistency: quality.status === "degraded" ? "needs_review" : "ok",
    tradability_relevance: quality.status === "ok" ? "usable" : "blocked",
    latest_date: latestDate ?? null,
    trade_date: tradeDate ?? null,
    summary_value: summaryValue,
    intraday_value: intradayValue,
    blocked_reason: quality.blockedReason
  };
}

function buildQuoteCoverageSection(key, rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const okCount = normalizedRows.filter((row) => row?.fetch_status === "ok").length;
  const liveCount = normalizedRows.filter((row) => row?.is_live_today === true).length;
  const referenceOnlyCount = normalizedRows.filter((row) =>
    ["previous_close_reference", "closed_market_reference"].includes(String(row?.quote_usage ?? ""))
  ).length;

  let status = "ok";
  let blockedReason = null;

  if (normalizedRows.length === 0 || okCount === 0) {
    status = "missing";
    blockedReason = "当前组别无可用行情样本。";
  } else if (liveCount === 0 && referenceOnlyCount === okCount) {
    status = "reference_only";
    blockedReason = "当前仅有上一交易日参考行情，不应用作日内动作判断。";
  } else if (okCount < normalizedRows.length) {
    status = "partial";
    blockedReason = "部分关键锚点缺失，结论需要降低置信度。";
  }

  return {
    key,
    status,
    freshness: liveCount > 0 ? "live_or_fresh" : referenceOnlyCount > 0 ? "reference_only" : "missing",
    completeness: okCount === normalizedRows.length ? "complete" : okCount > 0 ? "partial" : "missing",
    cross_source_consistency: "ok",
    tradability_relevance: liveCount > 0 ? "usable" : status === "reference_only" ? "observe_only" : "blocked",
    row_count: normalizedRows.length,
    ok_count: okCount,
    live_count: liveCount,
    reference_only_count: referenceOnlyCount,
    blocked_reason: blockedReason
  };
}

export function buildResearchDataQualityMatrix({
  tradeDate = null,
  session = null,
  cnMarketSnapshot = {},
  marketSnapshot = {}
} = {}) {
  const northbound = cnMarketSnapshot?.sections?.northbound_flow ?? {};
  const southbound = cnMarketSnapshot?.sections?.southbound_flow ?? {};

  const sections = {
    northbound_flow: buildFlowSection({
      key: "northbound_flow",
      latestDate: String(northbound?.latest_date ?? "").slice(0, 10) || null,
      tradeDate,
      summaryValue: normalizeNumber(northbound?.latest_summary_net_buy_100m_cny),
      intradayValue: normalizeNumber(northbound?.latest_intraday_net_inflow_100m_cny),
      note: northbound?.note ?? null
    }),
    southbound_flow: buildFlowSection({
      key: "southbound_flow",
      latestDate: String(southbound?.latest_date ?? "").slice(0, 10) || null,
      tradeDate,
      summaryValue: normalizeNumber(southbound?.latest_summary_net_buy_100m_hkd),
      intradayValue: normalizeNumber(southbound?.latest_intraday_net_inflow_100m_hkd),
      note: southbound?.note ?? null
    }),
    a_share_quotes: buildQuoteCoverageSection("a_share_quotes", marketSnapshot?.a_share_indices),
    hong_kong_quotes: buildQuoteCoverageSection("hong_kong_quotes", marketSnapshot?.hong_kong_indices),
    global_risk_quotes: buildQuoteCoverageSection(
      "global_risk_quotes",
      [
        ...(Array.isArray(marketSnapshot?.global_indices) ? marketSnapshot.global_indices : []),
        ...(Array.isArray(marketSnapshot?.commodities) ? marketSnapshot.commodities : []),
        ...(Array.isArray(marketSnapshot?.rates_fx) ? marketSnapshot.rates_fx : [])
      ]
    )
  };

  const degradedKeys = Object.values(sections)
    .filter((section) => ["degraded", "missing"].includes(section.status))
    .map((section) => section.key);
  const overallStatus = degradedKeys.length > 0 ? "degraded" : "ok";
  const flags = degradedKeys.map((key) => `${key}_degraded`);
  const blockedReasons = Object.values(sections)
    .map((section) => section.blocked_reason)
    .filter(Boolean);

  return {
    trade_date: tradeDate,
    session,
    overall_status: overallStatus,
    sections,
    degraded_sections: degradedKeys,
    flags,
    blocked_reasons: blockedReasons
  };
}

export function deriveResearchSectionConfidence({
  decisionReadiness = {},
  eventDriver = {},
  flowMacroRadar = {},
  marketDataQuality = {}
} = {}) {
  const level = String(decisionReadiness?.level ?? "").trim();
  const degradedSections = Array.isArray(marketDataQuality?.degraded_sections)
    ? marketDataQuality.degraded_sections
    : [];
  const eventConfidence =
    eventDriver?.status === "active_market_driver" && degradedSections.length === 0
      ? "high"
      : eventDriver?.status === "active_market_driver"
      ? "medium"
      : eventDriver?.status === "watch_only"
      ? "low"
      : "blocked";
  const flowConfidence =
    Number(flowMacroRadar?.confidence ?? 0) >= 0.75 && degradedSections.length === 0
      ? "high"
      : Number(flowMacroRadar?.confidence ?? 0) >= 0.45
      ? "medium"
      : "low";
  const actionConfidence =
    ["trading_blocked", "research_invalid"].includes(level)
      ? "blocked"
      : level === "analysis_degraded"
      ? "low"
      : flowConfidence === "high" && eventConfidence !== "blocked"
      ? "high"
      : "medium";

  return {
    event_driver: eventConfidence,
    flow_macro_radar: flowConfidence,
    actionable_decision: actionConfidence
  };
}

export function buildDriverExpectationMatrix({
  eventDriver = {},
  sessionInfo = {},
  marketDataQuality = {}
} = {}) {
  return {
    trade_date: sessionInfo?.tradeDate ?? null,
    market_session: sessionInfo?.session ?? null,
    status: eventDriver?.status ?? "unavailable",
    driver_type: eventDriver?.driver_type ?? "unknown",
    primary_driver: eventDriver?.primary_driver ?? null,
    expected_consensus: eventDriver?.expected_consensus ?? "",
    actual_market_reaction: eventDriver?.actual_market_reaction ?? {},
    expectation_gap: eventDriver?.expectation_gap ?? "",
    crowding_flag: eventDriver?.crowding_flag ?? "unclear",
    priced_in_assessment: eventDriver?.priced_in_assessment ?? "unclear",
    data_quality_flags: marketDataQuality?.flags ?? []
  };
}

export function buildMarketFlowMatrix({
  flowMacroRadar = {},
  sessionInfo = {},
  marketDataQuality = {}
} = {}) {
  const northboundSection = marketDataQuality?.sections?.northbound_flow ?? {};
  const southboundSection = marketDataQuality?.sections?.southbound_flow ?? {};

  return {
    trade_date: sessionInfo?.tradeDate ?? null,
    market_session: sessionInfo?.session ?? null,
    liquidity_regime: flowMacroRadar?.liquidity_regime ?? "neutral",
    confidence: round(flowMacroRadar?.confidence ?? null, 2),
    summary: flowMacroRadar?.summary ?? "",
    overall_status: marketDataQuality?.overall_status ?? "unknown",
    china_flows: {
      northbound_status: northboundSection.status ?? "unknown",
      northbound_value: northboundSection.summary_value ?? null,
      southbound_status: southboundSection.status ?? "unknown",
      southbound_value: southboundSection.summary_value ?? null
    },
    cross_asset_anchors: flowMacroRadar?.cross_asset_anchors ?? {},
    alerts: Array.isArray(flowMacroRadar?.alerts) ? flowMacroRadar.alerts : []
  };
}
