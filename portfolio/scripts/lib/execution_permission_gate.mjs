function normalizeTradePermission(input) {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "allowed" || normalized === "blocked" || normalized === "restricted") {
    return normalized;
  }
  return "restricted";
}

function readResearchTradePermission(researchDecision = {}) {
  return normalizeTradePermission(
    researchDecision?.actionable_decision?.desk_conclusion?.trade_permission ??
      researchDecision?.desk_conclusion?.trade_permission
  );
}

function readResearchOrderText(researchDecision = {}) {
  return String(
    researchDecision?.actionable_decision?.desk_conclusion?.one_sentence_order ??
      researchDecision?.desk_conclusion?.one_sentence_order ??
      ""
  ).trim();
}

function isRiskIncreasingTrade(trade = {}) {
  const normalizedType = String(trade?.type ?? "")
    .trim()
    .toLowerCase();
  return normalizedType === "buy" || normalizedType === "conversion";
}

export function evaluateExecutionPermission({
  structuralGate = {},
  researchDecision = {},
  proposedTrades = []
} = {}) {
  const structuralAllowed = structuralGate?.allowed === true;
  const structuralBlockingReasons = Array.isArray(structuralGate?.blockingReasons)
    ? structuralGate.blockingReasons
    : [];
  const warnings = Array.isArray(structuralGate?.warnings) ? structuralGate.warnings.slice() : [];

  if (!structuralAllowed) {
    return {
      allowed: false,
      mode: "structural_blocked",
      blockingReasons: structuralBlockingReasons,
      warnings,
      researchTradePermission: readResearchTradePermission(researchDecision)
    };
  }

  const tradePermission = readResearchTradePermission(researchDecision);
  const orderText = readResearchOrderText(researchDecision);
  if (tradePermission === "blocked") {
    const reason = orderText
      ? `Trade blocked by research permission: blocked. ${orderText}`
      : "Trade blocked by research permission: blocked.";
    return {
      allowed: false,
      mode: "research_blocked",
      blockingReasons: [reason],
      warnings,
      researchTradePermission: tradePermission
    };
  }

  const normalizedProposedTrades = Array.isArray(proposedTrades) ? proposedTrades : [];
  const hasRiskIncreasingTrades = normalizedProposedTrades.some(isRiskIncreasingTrade);
  if (tradePermission === "restricted" && hasRiskIncreasingTrades) {
    return {
      allowed: false,
      mode: "research_restricted",
      blockingReasons: [
        "Trade blocked by research permission: restricted only allows sell-only de-risking; buys and conversions are blocked."
      ],
      warnings,
      researchTradePermission: tradePermission
    };
  }

  return {
    allowed: true,
    mode: tradePermission === "restricted" ? "research_restricted_sell_only" : "research_allowed",
    blockingReasons: [],
    warnings,
    researchTradePermission: tradePermission
  };
}
