function normalizeOpportunityCandidates(opportunityPool = {}) {
  const input = opportunityPool?.candidates ?? opportunityPool?.top_candidates ?? [];
  return Array.isArray(input) ? input.slice(0, 3) : [];
}

function normalizePortfolioTargets(portfolioState = {}) {
  if (Array.isArray(portfolioState?.positions)) {
    return portfolioState.positions;
  }

  return [];
}

export function buildResearchActionableDecision({
  decisionReadiness = {},
  eventDriver = {},
  flowMacroRadar = {},
  portfolioState = {},
  opportunityPool = {}
} = {}) {
  const level = String(decisionReadiness?.level ?? "").trim();
  const tradingAllowed = decisionReadiness?.trading_allowed === true;

  if (level === "trading_blocked" || level === "research_invalid") {
    return {
      portfolio_actions: [],
      new_watchlist_actions: [],
      desk_conclusion: {
        overall_stance: "freeze",
        trade_permission: "blocked",
        one_sentence_order: "研究闸门未通过，当前禁止生成交易指令。",
        must_not_do: ["不要追单", "不要扩大风险敞口"],
        decision_basis: [eventDriver?.primary_driver ?? "研究状态异常"]
      }
    };
  }

  const watchlist = normalizeOpportunityCandidates(opportunityPool).map((item) => ({
    theme: item?.theme ?? item?.theme_name ?? item?.name ?? "未命名主题",
    stance: "watch",
    why_now:
      item?.why_now ??
      item?.expected_vs_actual_state ??
      item?.expected_vs_actual ??
      "事件或资金面开始出现改善。",
    why_not_in_portfolio_yet: "仍需等待更完整的证据链或更好的执行位置。",
    trigger_to_act: "资金确认与价格结构继续同步改善。"
  }));

  const tradePermission = tradingAllowed ? "allowed" : "restricted";
  const overallStance =
    flowMacroRadar?.liquidity_regime === "stress"
      ? "defensive"
      : tradePermission === "allowed"
        ? "selective_offense"
        : "defensive";

  return {
    portfolio_actions:
      tradePermission !== "blocked"
        ? normalizePortfolioTargets(portfolioState)
            .slice(0, 3)
            .map((holding) => ({
            target_type: "holding",
            target_key: holding?.code ?? holding?.fund_code ?? "unknown",
            stance: tradePermission === "allowed" ? "hold" : "avoid",
            urgency: "low",
            reason_chain: [
              `事件主线：${eventDriver?.primary_driver ?? "暂无明确主线"}`,
              `流动性：${flowMacroRadar?.liquidity_regime ?? "neutral"}`,
              `研究状态：${level}`
            ],
            execution_note:
              tradePermission === "allowed" ? "仅在既定计划范围内执行。" : "等待更完整数据后再动作。"
            }))
        : [],
    new_watchlist_actions: watchlist,
    desk_conclusion: {
      overall_stance: overallStance,
      trade_permission: tradePermission,
      one_sentence_order:
        tradePermission === "allowed"
          ? "允许围绕现有组合做选择性进攻，并跟踪最多三条新增观察线索。"
          : "当前只允许条件式观察，不建议直接下强结论交易单。",
      must_not_do:
        tradePermission === "allowed"
          ? ["不要脱离组合框架追涨"]
          : ["不要把降级分析直接转化为强买卖动作"],
      decision_basis: [
        `event_driver=${eventDriver?.status ?? "unknown"}`,
        `liquidity_regime=${flowMacroRadar?.liquidity_regime ?? "neutral"}`,
        `readiness=${level || "unknown"}`
      ]
    }
  };
}
