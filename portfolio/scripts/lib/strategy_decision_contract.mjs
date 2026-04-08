const DEFAULT_MAX_BUCKET_ADD_CNY = 15000;

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickDecisionNumber(...values) {
  for (const value of values) {
    const numeric = toNullableNumber(value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

function projectPositionFact(position = {}) {
  const canonicalAmountCny = toNullableNumber(position?.canonicalAmount ?? position?.amount);
  const canonicalHoldingPnlCny = toNullableNumber(
    position?.canonicalHoldingPnl ?? position?.holdingPnl
  );
  const observableAmountCny = toNullableNumber(position?.observableAmount);
  const observableHoldingPnlCny = toNullableNumber(position?.observableHoldingPnl);
  const amountCny = pickDecisionNumber(observableAmountCny, canonicalAmountCny);
  const holdingPnlCny = pickDecisionNumber(observableHoldingPnlCny, canonicalHoldingPnlCny);

  return {
    name: position?.name ?? null,
    code: position?.code ?? null,
    bucketKey: position?.bucketKey ?? null,
    category: position?.category ?? null,
    units: toNullableNumber(position?.units),
    costBasisCny: toNullableNumber(position?.costBasis),
    canonicalAmountCny,
    canonicalHoldingPnlCny,
    observableAmountCny,
    observableHoldingPnlCny,
    amountCny,
    holdingPnlCny,
    decisionValueSource: observableAmountCny !== null ? "observable" : "canonical",
    quoteMode: position?.quoteMode ?? null,
    quoteDate: position?.quoteDate ?? null,
    confirmationState: position?.confirmationState ?? null
  };
}

export function deriveBucketPolicy(bucket = {}) {
  const gapAmountRaw = toNullableNumber(bucket?.gapAmountCny);
  const weightPctRaw = toNullableNumber(bucket?.weightPct);
  const targetPctRaw = toNullableNumber(bucket?.targetPct);
  const gapAmount = gapAmountRaw ?? 0;
  const weightPct = weightPctRaw ?? 0;
  const targetPct = targetPctRaw ?? 0;
  const hasRuntimeBucketView =
    weightPctRaw !== null || targetPctRaw !== null || gapAmountRaw !== null;
  const actionBias =
    hasRuntimeBucketView
      ? gapAmount > 0
        ? "add_on_strength_with_limits"
        : gapAmount < 0
          ? "do_not_add"
          : "hold"
      : "unknown";
  const maxAddTodayCny = gapAmount > 0 ? Math.min(gapAmount, DEFAULT_MAX_BUCKET_ADD_CNY) : 0;
  const requiresPullback = hasRuntimeBucketView ? gapAmount <= 0 : null;
  const forbiddenActions = requiresPullback === true ? ["do_not_chase"] : [];
  const notes = hasRuntimeBucketView
    ? gapAmount > 0
      ? [`结构性缺口 ${gapAmount} 元`]
      : ["接近或高于目标"]
    : ["缺少 runtime bucket view，当前仅保留占位策略"];

  return {
    bucketKey: bucket?.bucketKey ?? null,
    label: bucket?.label ?? null,
    currentWeightPct: weightPctRaw,
    targetWeightPct: targetPctRaw,
    gapAmountCny: gapAmountRaw,
    actionBias,
    maxAddTodayCny,
    requiresPullback,
    forbiddenActions,
    notes,
    source: hasRuntimeBucketView ? "runtime_bucket_view" : "missing_runtime_bucket_view"
  };
}

export function buildStrategyDecisionContract({ runtimeContext = {}, tradePlan = {}, signals = {} } = {}) {
  const bucketPolicies = Array.isArray(runtimeContext?.bucketView)
    ? runtimeContext.bucketView.map(deriveBucketPolicy)
    : [];
  const positionFacts = Array.isArray(runtimeContext?.positions)
    ? runtimeContext.positions.map(projectPositionFact)
    : [];
  const maxTotalBuyTodayCny = Number(tradePlan?.summary?.maxTotalBuyTodayCny ?? 20000) || 20000;
  const blockedReason = runtimeContext?.systemState?.blockedReason ?? null;
  const researchReadiness = runtimeContext?.systemState?.researchReadiness ?? {};
  const staleDependencies = Array.isArray(runtimeContext?.systemState?.staleDependencies)
    ? runtimeContext.systemState.staleDependencies.filter(Boolean)
    : [];
  const researchReadinessLevel = String(researchReadiness?.level ?? "").trim();
  const hasExplicitResearchReadiness =
    researchReadinessLevel.length > 0 ||
    typeof researchReadiness?.analysis_allowed === "boolean" ||
    typeof researchReadiness?.trading_allowed === "boolean";
  const hardResearchBlock =
    ["trading_blocked", "research_invalid"].includes(researchReadinessLevel) ||
    researchReadiness?.analysis_allowed === false;
  const hardBlockedByReason = Boolean(blockedReason) && (!hasExplicitResearchReadiness || hardResearchBlock);
  const decisionReasons = [
    ...(Array.isArray(researchReadiness?.reasons) ? researchReadiness.reasons.filter(Boolean) : []),
    ...(blockedReason ? [blockedReason] : [])
  ].filter((value, index, list) => list.indexOf(value) === index);
  const confirmedNavState = runtimeContext?.systemState?.confirmedNavState ?? null;
  const runtimeFreshness = runtimeContext?.meta?.dataFreshnessSummary ?? "unknown";
  const tradingAllowed = researchReadiness?.trading_allowed !== false && !hardBlockedByReason;
  const dataDegraded =
    runtimeFreshness !== "ready" ||
    staleDependencies.length > 0 ||
    ["late_missing", "source_missing", "blocked"].includes(String(confirmedNavState ?? "").trim());
  const decisionReadiness = hardBlockedByReason
    ? "blocked"
    : !tradingAllowed || dataDegraded
      ? "degraded_observe_only"
      : "ready";

  const regime = {
    marketRegime:
      signals?.market_regime ??
      (decisionReadiness === "degraded_observe_only" ? "observe_only" : "unknown"),
    riskState:
      hardBlockedByReason
        ? "blocked"
        : decisionReadiness === "degraded_observe_only"
          ? "degraded"
          : "partial_chase_only",
    tradePermission:
      hardBlockedByReason
        ? "blocked"
        : decisionReadiness === "degraded_observe_only"
          ? "degraded_observe_only"
          : "limited",
    overallStance:
      hardBlockedByReason
        ? "blocked_risk_gate"
        : decisionReadiness === "degraded_observe_only"
          ? "observe_only"
          : "do_not_full_rebalance_today"
  };

  return {
    generatedAt: new Date().toISOString(),
    accountId: runtimeContext?.accountId ?? "main",
    contractVersion: 1,
    basedOnRuntimeContextAt: runtimeContext?.generatedAt ?? null,
    freshness: {
      snapshotDate: runtimeContext?.snapshotDate ?? null,
      runtimeDataFreshness: runtimeContext?.meta?.dataFreshnessSummary ?? "unknown",
      confirmedNavState,
      staleDependencies
    },
    dataFreshness: {
      snapshotDate: runtimeContext?.snapshotDate ?? null,
      runtimeDataFreshness: runtimeFreshness,
      confirmedNavState,
      staleDependencies
    },
    decisionReadiness,
    decisionReasons,
    positionValueMode: "observable_preferred_with_canonical_fallback",
    cashSemantics: {
      settledCashCny: toNullableNumber(runtimeContext?.portfolio?.settledCashCny),
      tradeAvailableCashCny: toNullableNumber(runtimeContext?.portfolio?.tradeAvailableCashCny),
      cashLikeFundAssetsCny: toNullableNumber(runtimeContext?.portfolio?.cashLikeFundAssetsCny),
      liquiditySleeveAssetsCny: toNullableNumber(
        runtimeContext?.portfolio?.liquiditySleeveAssetsCny
      )
    },
    regime,
    bucketPolicies,
    positionFacts,
    executionGuardrails: {
      maxTotalBuyTodayCny,
      maxSingleBucketAddTodayCny: DEFAULT_MAX_BUCKET_ADD_CNY,
      restrictedActions: hardBlockedByReason ? ["no_new_risk"] : [],
      cashFloorRules: []
    },
    responsePolicy: {
      requiredSections: [
        "main_driver",
        "portfolio_impact",
        "allowed_actions",
        "forbidden_actions",
        "amount_bounds"
      ]
    }
  };
}
