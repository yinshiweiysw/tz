import { round } from "./format_utils.mjs";

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function formatSigned(value, suffix = "") {
  const numeric = round(value);
  if (numeric === null) {
    return "--";
  }

  return `${numeric > 0 ? "+" : ""}${numeric}${suffix}`;
}

export function buildResearchDriverLines(eventDriver = {}) {
  const evidence = normalizeArray(eventDriver?.evidence).slice(0, 3);
  const confirmedAssets = normalizeArray(eventDriver?.actual_market_reaction?.confirmed_assets)
    .slice(0, 3)
    .map((item) =>
      item?.label ? `${item.label} ${formatSigned(item?.move_pct, "%")}` : null
    )
    .filter(Boolean);

  return [
    `- 状态：${eventDriver?.status ?? "unavailable"}`,
    `- 主线：${eventDriver?.primary_driver ?? "暂无明确驱动"}`,
    `- 驱动类型：${eventDriver?.driver_type ?? "unknown"}`,
    `- 计价判断：${eventDriver?.priced_in_assessment ?? "unclear"}`,
    `- 市场原始共识：${eventDriver?.expected_consensus ?? "暂无"}`,
    `- 实际市场反应：${confirmedAssets.length > 0 ? confirmedAssets.join("；") : "暂无跨资产确认"}`,
    `- 预期差：${eventDriver?.expectation_gap ?? "暂无"}`,
    `- 拥挤度：${eventDriver?.crowding_flag ?? "unclear"}`,
    ...(evidence.length > 0
      ? [`- 证据链：${evidence.map((item) => item?.headline ?? item?.source ?? "未知").join("；")}`]
      : ["- 证据链：暂无"]
    )
  ];
}

export function buildResearchHeadlineLines(newsContext = {}) {
  const headlines = normalizeArray(newsContext?.top_headlines ?? newsContext?.topHeadlines).slice(0, 3);
  const coverage = newsContext?.news_coverage ?? newsContext?.coverage ?? {};
  const mode = String(newsContext?.analysis_mode ?? newsContext?.analysisMode ?? "").trim();
  const degradedReason =
    String(newsContext?.analysis_degraded_reason ?? newsContext?.degradedReason ?? "").trim() || null;
  const totalStories = Number(coverage?.totalStories ?? headlines.length ?? 0);
  const uniqueSources = Number(coverage?.uniqueSourceCount ?? 0);
  const trustedSources = Number(coverage?.trustedSourceCount ?? 0);
  const displayUniqueSources = uniqueSources > 0 ? uniqueSources : headlines.length > 0 ? 1 : 0;
  if (!mode && !degradedReason && headlines.length === 0 && totalStories <= 0) {
    return [];
  }

  return [
    `- 分析模式：${mode || "unavailable"}`,
    `- 覆盖概览：stories=${totalStories}，sources=${displayUniqueSources}，trusted=${trustedSources}`,
    ...(degradedReason ? [`- 降级原因：${degradedReason}`] : []),
    ...(headlines.length > 0
      ? headlines.map((item) => {
          const source = String(item?.source ?? item?.sourceId ?? "unknown").trim() || "unknown";
          const title = String(item?.title ?? item?.headline ?? "").trim() || "未命名新闻";
          const publishedAt = String(item?.published_at ?? item?.publishedAt ?? "").trim() || "--";
          return `- 头条：${source}｜${title}｜${publishedAt}`;
        })
      : ["- 头条：暂无"])
  ];
}

export function buildResearchEventWatchLines(eventWatch = {}) {
  const tomorrowRisks = normalizeArray(eventWatch?.tomorrow_risks).slice(0, 3);
  const thisWeekCatalysts = normalizeArray(eventWatch?.this_week_catalysts).slice(0, 4);
  const deadlineWatch = normalizeArray(eventWatch?.deadline_watch).slice(0, 3);
  const summary = eventWatch?.summary ?? {};
  const readiness = String(eventWatch?.readiness ?? "").trim();

  if (!readiness && tomorrowRisks.length === 0 && thisWeekCatalysts.length === 0 && deadlineWatch.length === 0) {
    return [];
  }

  return [
    `- 状态：${readiness || "unknown"}`,
    `- 事件总数：${Number(summary?.total_high_impact_events ?? 0) || 0}`,
    `- 明日风险：${Number(summary?.tomorrow_risk_count ?? tomorrowRisks.length ?? 0) || 0}`,
    `- 周内催化：${Number(summary?.this_week_catalyst_count ?? thisWeekCatalysts.length ?? 0) || 0}`,
    `- 到期窗口：${Number(summary?.deadline_watch_count ?? deadlineWatch.length ?? 0) || 0}`,
    ...(tomorrowRisks.length > 0
      ? tomorrowRisks.map((item) => `- 明日风险项：${item?.title ?? "未命名事件"}｜${item?.scheduledAt ?? "--"}`)
      : []),
    ...(thisWeekCatalysts.length > 0
      ? thisWeekCatalysts.map((item) => `- 周内催化项：${item?.title ?? "未命名事件"}｜${item?.scheduledAt ?? "--"}`)
      : []),
    ...(deadlineWatch.length > 0
      ? deadlineWatch.map((item) => `- 到期窗口项：${item?.title ?? "未命名事件"}｜${item?.deadlineAt ?? item?.scheduledAt ?? "--"}`)
      : [])
  ];
}

export function buildResearchGoldFactorLines(goldFactorModel = {}) {
  const secondaryDrivers = normalizeArray(goldFactorModel?.secondaryGoldDrivers).slice(0, 4);
  const riskNotes = normalizeArray(goldFactorModel?.goldRiskNotes).slice(0, 3);
  const dominantDriver = String(goldFactorModel?.dominantGoldDriver ?? "").trim();
  const goldRegime = String(goldFactorModel?.goldRegime ?? "").trim();
  const actionBias = String(goldFactorModel?.goldActionBias ?? "").trim();

  if (!dominantDriver && !goldRegime && !actionBias && secondaryDrivers.length === 0 && riskNotes.length === 0) {
    return [];
  }

  return [
    `- 主驱动：${dominantDriver || "mixed_inputs"}`,
    `- 市场状态：${goldRegime || "unclear"}`,
    `- 操作偏置：${actionBias || "observe"}`,
    ...(secondaryDrivers.length > 0
      ? [`- 次级驱动：${secondaryDrivers.join("、")}`]
      : []),
    ...(riskNotes.length > 0 ? riskNotes.map((item) => `- 风险提示：${item}`) : [])
  ];
}

export function buildResearchFlowRadarLines(flowMacroRadar = {}) {
  const alerts = normalizeArray(flowMacroRadar?.alerts).slice(0, 3);

  return [
    `- 流动性状态：${flowMacroRadar?.liquidity_regime ?? "neutral"}`,
    `- 置信度：${flowMacroRadar?.confidence ?? "--"}`,
    `- 摘要：${flowMacroRadar?.summary ?? "暂无"}`,
    ...(alerts.length > 0 ? alerts.map((item) => `- 提示：${item}`) : [])
  ];
}

export function buildResearchFlowValidationLines(cnMarketSnapshot = {}, marketDataQuality = {}) {
  const northbound = cnMarketSnapshot?.sections?.northbound_flow ?? {};
  const southbound = cnMarketSnapshot?.sections?.southbound_flow ?? {};
  const northboundQuality = marketDataQuality?.sections?.northbound_flow ?? {};
  const southboundQuality = marketDataQuality?.sections?.southbound_flow ?? {};
  const lines = [];

  const northboundLooksSuppressed =
    northbound.note &&
    Number(northbound.latest_summary_net_buy_100m_cny ?? 0) === 0 &&
    Number(northbound.latest_intraday_net_inflow_100m_cny ?? 0) === 0;

  if (northboundQuality?.status === "degraded" && northboundQuality?.blocked_reason) {
    lines.push(`- 北向资金：${northboundQuality.blocked_reason}`);
  } else if (
    !northboundLooksSuppressed &&
    (northbound.latest_summary_net_buy_100m_cny !== null &&
      northbound.latest_summary_net_buy_100m_cny !== undefined)
  ) {
    lines.push(
      `- 北向资金：当日净买额 ${formatSigned(northbound.latest_summary_net_buy_100m_cny, " 亿元")}；盘中最新 ${formatSigned(northbound.latest_intraday_net_inflow_100m_cny, " 亿元")}`
    );
  } else if (northbound.note) {
    lines.push(`- 北向资金：${northbound.note}`);
  }

  const southboundLooksSuppressed =
    southbound.note &&
    Number(southbound.latest_summary_net_buy_100m_hkd ?? 0) === 0 &&
    Number(southbound.latest_intraday_net_inflow_100m_hkd ?? 0) === 0;

  if (southboundQuality?.status === "degraded" && southboundQuality?.blocked_reason) {
    lines.push(`- 南向资金：${southboundQuality.blocked_reason}`);
  } else if (
    !southboundLooksSuppressed &&
    (southbound.latest_summary_net_buy_100m_hkd !== null &&
      southbound.latest_summary_net_buy_100m_hkd !== undefined)
  ) {
    lines.push(
      `- 南向资金：${southbound.latest_date ?? "--"} 净买额 ${formatSigned(southbound.latest_summary_net_buy_100m_hkd, " 亿元")}；盘中最新 ${southbound.latest_intraday_time ?? "--"} 为 ${formatSigned(southbound.latest_intraday_net_inflow_100m_hkd, " 亿元")}`
    );
  } else if (southbound.note) {
    lines.push(`- 南向资金：${southbound.note}`);
  }

  return lines.length > 0 ? lines : ["- 北向 / 南向资金：暂无可用验证数据"];
}

export function buildResearchActionDecisionLines(actionableDecision = {}) {
  const desk = actionableDecision?.desk_conclusion ?? {};
  const portfolioActions = normalizeArray(actionableDecision?.portfolio_actions).slice(0, 3);
  const watchlist = normalizeArray(actionableDecision?.new_watchlist_actions).slice(0, 3);

  return [
    `- 交易许可：${desk?.trade_permission ?? "restricted"}`,
    `- 总结指令：${desk?.one_sentence_order ?? "暂无"}`,
    ...(portfolioActions.length > 0
      ? portfolioActions.map(
          (item) => `- 持仓动作：${item?.target_key ?? "unknown"}｜${item?.stance ?? "hold"}｜${item?.execution_note ?? "暂无"}`
        )
      : ["- 持仓动作：暂无"]
    ),
    ...(watchlist.length > 0
      ? watchlist.map(
          (item) => `- 观察名单：${item?.theme ?? "未命名主题"}｜${item?.stance ?? "watch"}｜${item?.why_now ?? "暂无"}`
        )
      : [])
  ];
}

export function buildUnifiedResearchSections({
  researchBrain = {},
  cnMarketSnapshot = {},
  researchGuardLines = []
} = {}) {
  return [
    {
      heading: "## Institutional Research Readiness",
      lines: normalizeArray(researchGuardLines)
    },
    {
      heading: "## Active Market Driver",
      lines: buildResearchDriverLines(researchBrain?.event_driver)
    },
    {
      heading: "## Headline Tape",
      lines: buildResearchHeadlineLines(researchBrain)
    },
    {
      heading: "## Event Watch",
      lines: buildResearchEventWatchLines(researchBrain?.event_watch)
    },
    {
      heading: "## Gold Factor Model",
      lines: buildResearchGoldFactorLines(researchBrain?.gold_factor_model)
    },
    {
      heading: "## Flow & Macro Radar",
      lines: buildResearchFlowRadarLines(researchBrain?.flow_macro_radar)
    },
    {
      heading: "## China / HK Flow Validation",
      lines: buildResearchFlowValidationLines(
        cnMarketSnapshot,
        researchBrain?.market_data_quality ?? {}
      )
    },
    {
      heading: "## Desk Action Conclusion",
      lines: buildResearchActionDecisionLines(researchBrain?.actionable_decision)
    }
  ].filter((section) => normalizeArray(section.lines).length > 0);
}

export function flattenResearchSections(sections = [], options = {}) {
  const includeHeadings = Array.isArray(options.includeHeadings)
    ? new Set(options.includeHeadings)
    : null;
  const lines = [];

  for (const section of sections) {
    if (!section?.heading || !Array.isArray(section?.lines) || section.lines.length === 0) {
      continue;
    }

    if (includeHeadings && !includeHeadings.has(section.heading)) {
      continue;
    }

    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(section.heading, "", ...section.lines);
  }

  return lines;
}
