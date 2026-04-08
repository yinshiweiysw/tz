const DEFAULT_MAX_BUCKET_ADD_CNY = 15000;

export function deriveBucketPolicy(bucket = {}) {
  const gapAmount = Number(bucket?.gapAmountCny ?? 0) || 0;
  const weightPct = Number(bucket?.weightPct ?? 0) || 0;
  const targetPct = Number(bucket?.targetPct ?? 0) || 0;
  const actionBias =
    gapAmount > 0 ? "add_on_strength_with_limits" : gapAmount < 0 ? "do_not_add" : "hold";
  const maxAddTodayCny = gapAmount > 0 ? Math.min(gapAmount, DEFAULT_MAX_BUCKET_ADD_CNY) : 0;
  const requiresPullback = gapAmount <= 0;
  const forbiddenActions = requiresPullback ? ["do_not_chase"] : [];
  const notes = gapAmount > 0 ? [`结构性缺口 ${gapAmount} 元`] : ["接近或高于目标"];

  return {
    bucketKey: bucket?.bucketKey ?? null,
    label: bucket?.label ?? null,
    currentWeightPct: weightPct,
    targetWeightPct: targetPct,
    gapAmountCny: gapAmount,
    actionBias,
    maxAddTodayCny,
    requiresPullback,
    forbiddenActions,
    notes
  };
}

export function buildStrategyDecisionContract({ runtimeContext = {}, tradePlan = {}, signals = {} } = {}) {
  const bucketPolicies = Array.isArray(runtimeContext?.bucketView)
    ? runtimeContext.bucketView.map(deriveBucketPolicy)
    : [];
  const maxTotalBuyTodayCny = Number(tradePlan?.summary?.maxTotalBuyTodayCny ?? 20000) || 20000;
  const blockedReason = runtimeContext?.systemState?.blockedReason ?? null;

  const regime = {
    marketRegime: signals?.market_regime ?? "unknown",
    riskState: blockedReason ? "blocked" : "partial_chase_only",
    tradePermission: blockedReason ? "blocked" : "limited",
    overallStance: blockedReason ? "freeze" : "do_not_full_rebalance_today"
  };

  return {
    generatedAt: new Date().toISOString(),
    accountId: runtimeContext?.accountId ?? "main",
    contractVersion: 1,
    basedOnRuntimeContextAt: runtimeContext?.generatedAt ?? null,
    regime,
    bucketPolicies,
    executionGuardrails: {
      maxTotalBuyTodayCny,
      maxSingleBucketAddTodayCny: DEFAULT_MAX_BUCKET_ADD_CNY,
      restrictedActions: blockedReason ? ["no_new_risk"] : [],
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
