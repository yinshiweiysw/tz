import {
  buildUnifiedResearchSections,
  flattenResearchSections
} from "./research_brain_render.mjs";
import { extractSpeculativeConclusionLines } from "./dual_trade_plan_render.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatCurrency(value) {
  const numeric = asNumber(value, null);
  if (numeric === null) {
    return "--";
  }

  return `${numeric.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} 元`;
}

function normalizeTopCandidates(opportunityPool = {}) {
  return asArray(opportunityPool?.candidates)
    .slice(0, 3)
    .map((candidate) => ({
      theme: String(candidate?.theme_name ?? candidate?.theme ?? "").trim(),
      action_bias: String(candidate?.action_bias ?? "").trim(),
      expected_vs_actual:
        String(candidate?.expected_vs_actual ?? candidate?.expected_vs_actual_state ?? "").trim(),
      tradable_proxy: asArray(candidate?.tradable_proxies)[0] ?? null
    }))
    .filter((candidate) => candidate.theme);
}

function normalizeTradePlanSummary(tradePlan = {}) {
  const summary = tradePlan?.summary ?? {};
  const firstTrade = asArray(tradePlan?.trades)[0] ?? null;

  return {
    actionable_trade_count: asNumber(summary?.actionable_trade_count, 0),
    suppressed_trade_count: asNumber(summary?.suppressed_trade_count, 0),
    gross_buy_cny: asNumber(summary?.gross_buy_cny, 0),
    gross_sell_cny: asNumber(summary?.gross_sell_cny, 0),
    net_cash_impact_cny: asNumber(summary?.net_cash_impact_cny, 0),
    first_trade: firstTrade
      ? {
          symbol: String(firstTrade?.symbol ?? "").trim(),
          action: String(firstTrade?.execution_action ?? firstTrade?.signal_action ?? "").trim(),
          amount_cny: asNumber(firstTrade?.planned_trade_amount_cny, 0)
        }
      : null
  };
}

function normalizeSpeculativeOverlay(speculativePlan = {}) {
  const instructions = asArray(speculativePlan?.instructions);
  const instructionLines = instructions.map((item) => String(item ?? "").trim()).filter(Boolean);
  const conclusionLines = extractSpeculativeConclusionLines(instructionLines);

  return {
    data_state: instructions.length > 0 ? "available" : "empty",
    instruction_count: instructions.length,
    conclusion_lines: conclusionLines
  };
}

function normalizeNewsContext(researchBrain = {}) {
  return {
    analysis_mode: String(researchBrain?.analysis_mode ?? "").trim() || null,
    degraded_reason: String(researchBrain?.analysis_degraded_reason ?? "").trim() || null,
    event_watch: researchBrain?.event_watch ?? {
      readiness: "degraded",
      summary: {
        total_high_impact_events: 0,
        tomorrow_risk_count: 0,
        this_week_catalyst_count: 0,
        deadline_watch_count: 0
      },
      next_event: null,
      tomorrow_risks: [],
      this_week_catalysts: [],
      deadline_watch: []
    },
    top_headlines: asArray(researchBrain?.top_headlines)
      .slice(0, 5)
      .map((item) => ({
        source: String(item?.source ?? item?.sourceId ?? "").trim() || null,
        title: String(item?.title ?? item?.headline ?? "").trim() || null,
        published_at: String(item?.published_at ?? item?.publishedAt ?? "").trim() || null,
        url: String(item?.url ?? "").trim() || null,
        marketTags: asArray(item?.marketTags ?? item?.market_tags).filter(Boolean),
        portfolioRelevanceScore: asNumber(item?.portfolioRelevanceScore, 0),
        sourceConfirmationCount: asNumber(item?.sourceConfirmationCount, 1),
        crossAssetImpact: asArray(item?.crossAssetImpact ?? item?.cross_asset_impact).filter(Boolean)
      }))
      .filter((item) => item.title)
  };
}

function normalizeAgentEntryCashSemantics(agentRuntimeContext = {}, strategyDecisionContract = {}) {
  const strategyCash = strategyDecisionContract?.cashSemantics ?? {};
  const runtimePortfolio = agentRuntimeContext?.portfolio ?? {};

  return {
    settledCashCny:
      asNumber(strategyCash?.settledCashCny, null) ??
      asNumber(runtimePortfolio?.settledCashCny, null),
    tradeAvailableCashCny:
      asNumber(strategyCash?.tradeAvailableCashCny, null) ??
      asNumber(runtimePortfolio?.tradeAvailableCashCny, null),
    cashLikeFundAssetsCny:
      asNumber(strategyCash?.cashLikeFundAssetsCny, null) ??
      asNumber(runtimePortfolio?.cashLikeFundAssetsCny, null),
    liquiditySleeveAssetsCny:
      asNumber(strategyCash?.liquiditySleeveAssetsCny, null) ??
      asNumber(runtimePortfolio?.liquiditySleeveAssetsCny, null)
  };
}

function normalizeTopPositions(agentRuntimeContext = {}, strategyDecisionContract = {}) {
  const contractFacts = asArray(strategyDecisionContract?.positionFacts)
    .map((item) => ({
      code: String(item?.code ?? "").trim() || null,
      name: String(item?.name ?? "").trim() || null,
      amountCny: asNumber(item?.amountCny, null),
      decisionValueSource: String(item?.decisionValueSource ?? "").trim() || null,
      quoteMode: String(item?.quoteMode ?? "").trim() || null,
      confirmationState: String(item?.confirmationState ?? "").trim() || null
    }))
    .filter((item) => item.code && item.amountCny !== null);

  const runtimePositions = asArray(agentRuntimeContext?.positions)
    .map((item) => ({
      code: String(item?.code ?? "").trim() || null,
      name: String(item?.name ?? "").trim() || null,
      amountCny: asNumber(item?.observableAmount, null) ?? asNumber(item?.amount, null),
      decisionValueSource:
        asNumber(item?.observableAmount, null) !== null ? "observable" : "canonical",
      quoteMode: String(item?.quoteMode ?? "").trim() || null,
      confirmationState: String(item?.confirmationState ?? "").trim() || null
    }))
    .filter((item) => item.code && item.amountCny !== null);

  const source = contractFacts.length > 0 ? contractFacts : runtimePositions;
  return source.sort((left, right) => (right.amountCny ?? 0) - (left.amountCny ?? 0)).slice(0, 5);
}

function buildAgentEntrySnapshot({
  agentRuntimeContext = {},
  strategyDecisionContract = {},
  agentBootstrapContext = {},
  researchBrain = {}
} = {}) {
  return {
    runtime_generated_at: agentRuntimeContext?.generatedAt ?? null,
    strategy_decision_contract_generated_at: strategyDecisionContract?.generatedAt ?? null,
    bootstrap_generated_at: agentBootstrapContext?.generatedAt ?? null,
    account_id:
      String(
        strategyDecisionContract?.accountId ?? agentRuntimeContext?.accountId ?? ""
      ).trim() || null,
    snapshot_date:
      String(
        agentRuntimeContext?.snapshotDate ??
          strategyDecisionContract?.freshness?.snapshotDate ??
          researchBrain?.meta?.trade_date ??
          ""
      ).trim() || null,
    entrypoint_integrity: agentBootstrapContext?.entrypointIntegrity ?? null,
    cash_semantics: normalizeAgentEntryCashSemantics(
      agentRuntimeContext,
      strategyDecisionContract
    ),
    strategy_snapshot: {
      decisionReadiness:
        strategyDecisionContract?.decisionReadiness ??
        researchBrain?.decision_readiness?.level ??
        null,
      decisionReasons: asArray(strategyDecisionContract?.decisionReasons).filter(Boolean),
      tradePermission:
        strategyDecisionContract?.regime?.tradePermission ??
        researchBrain?.actionable_decision?.desk_conclusion?.trade_permission ??
        null,
      overallStance: strategyDecisionContract?.regime?.overallStance ?? null,
      maxTotalBuyTodayCny:
        asNumber(strategyDecisionContract?.executionGuardrails?.maxTotalBuyTodayCny, null),
      confirmedNavState:
        String(strategyDecisionContract?.freshness?.confirmedNavState ?? "").trim() || null
    },
    top_positions: normalizeTopPositions(agentRuntimeContext, strategyDecisionContract)
  };
}

export function buildDialogueAnalysisContract({
  researchBrain = {},
  cnMarketSnapshot = {},
  opportunityPool = {},
  speculativePlan = {},
  tradePlan = {},
  researchGuardLines = [],
  agentRuntimeContext = {},
  strategyDecisionContract = {},
  agentBootstrapContext = {}
} = {}) {
  const sharedResearchSections = buildUnifiedResearchSections({
    researchBrain,
    cnMarketSnapshot,
    researchGuardLines
  });
  const flatResearchLines = flattenResearchSections(sharedResearchSections);
  const desk = researchBrain?.actionable_decision?.desk_conclusion ?? {};
  const marketCore = {
    active_driver: researchBrain?.event_driver?.primary_driver ?? null,
    priced_in_assessment: researchBrain?.event_driver?.priced_in_assessment ?? null,
    liquidity_regime: researchBrain?.flow_macro_radar?.liquidity_regime ?? null,
    flow_summary: researchBrain?.flow_macro_radar?.summary ?? null,
    northbound_net_buy_100m_cny:
      cnMarketSnapshot?.sections?.northbound_flow?.latest_summary_net_buy_100m_cny ?? null,
    southbound_net_buy_100m_hkd:
      cnMarketSnapshot?.sections?.southbound_flow?.latest_summary_net_buy_100m_hkd ?? null
  };
  const portfolioActions = asArray(researchBrain?.actionable_decision?.portfolio_actions).slice(0, 3);
  const watchlistActions = asArray(researchBrain?.actionable_decision?.new_watchlist_actions).slice(0, 3);
  const opportunityCandidates = normalizeTopCandidates(opportunityPool);
  const speculativeOverlay = normalizeSpeculativeOverlay(speculativePlan);
  const tradePlanSummary = normalizeTradePlanSummary(tradePlan);
  const newsContext = normalizeNewsContext(researchBrain);
  const agentEntrySnapshot = buildAgentEntrySnapshot({
    agentRuntimeContext,
    strategyDecisionContract,
    agentBootstrapContext,
    researchBrain
  });
  const analystFocus = [];

  if (tradePlanSummary.first_trade?.symbol) {
    analystFocus.push(
      `优先核对主系统首笔动作：${tradePlanSummary.first_trade.symbol} ${tradePlanSummary.first_trade.action} ${formatCurrency(tradePlanSummary.first_trade.amount_cny)}`
    );
  }

  if (opportunityCandidates[0]?.theme) {
    analystFocus.push(`非持仓重点观察：${opportunityCandidates[0].theme}`);
  }

  if (speculativeOverlay.conclusion_lines[0]) {
    analystFocus.push(speculativeOverlay.conclusion_lines[0].replace(/^\s*-\s*/, ""));
  }

  return {
    meta: {
      generated_at: researchBrain?.generated_at ?? null,
      trade_permission: desk?.trade_permission ?? "restricted",
      readiness_level: researchBrain?.decision_readiness?.level ?? null
    },
    market_core: marketCore,
    market_context: {
      ...marketCore,
      event_watch: newsContext.event_watch
    },
    news_context: newsContext,
    agent_entry_snapshot: agentEntrySnapshot,
    gold_factor_model: researchBrain?.gold_factor_model ?? null,
    portfolio_actions: portfolioActions,
    watchlist_actions: watchlistActions,
    opportunity_candidates: opportunityCandidates,
    speculative_overlay: speculativeOverlay,
    trade_plan_summary: tradePlanSummary,
    shared_research_sections: sharedResearchSections,
    shared_research_lines: flatResearchLines,
    dialogue_cues: {
      opening_brief: [
        marketCore.active_driver,
        marketCore.flow_summary,
        desk?.one_sentence_order ?? null
      ]
        .filter(Boolean)
        .join("；"),
      allowed_actions: [
        desk?.one_sentence_order ?? null,
        ...portfolioActions
          .map((item) =>
            item?.target_key
              ? `${item.target_key} ${item?.stance ?? "hold"}：${item?.execution_note ?? "暂无"}`
              : null
          )
          .filter(Boolean)
      ].filter(Boolean),
      blocked_actions: asArray(desk?.must_not_do).filter(Boolean),
      analyst_focus: analystFocus
    }
  };
}
