import { deriveCanonicalHoldingSnapshot } from "./holding_cost_basis.mjs";

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * 100) / 100;
}

function deriveBucketGapAmountCny(bucket = {}, totalPortfolioAssetsCny = null) {
  const explicitGap = toNullableNumber(bucket?.gapAmountCny);
  if (explicitGap !== null) {
    return explicitGap;
  }

  const currentPct = toNullableNumber(bucket?.currentPct ?? bucket?.weightPct);
  const targetPct = toNullableNumber(bucket?.targetPct);
  const totalAssets = toNullableNumber(totalPortfolioAssetsCny);
  if (currentPct === null || targetPct === null || totalAssets === null) {
    return null;
  }

  return roundMoney(((targetPct - currentPct) / 100) * totalAssets);
}

function normalizeRows(dashboardState = {}) {
  if (Array.isArray(dashboardState?.rows)) {
    return dashboardState.rows;
  }
  if (Array.isArray(dashboardState?.holdings)) {
    return dashboardState.holdings;
  }
  return [];
}

function normalizeBucketSummary(bucketSummary = [], dashboardState = {}, totalPortfolioAssetsCny = null) {
  if (Array.isArray(bucketSummary) && bucketSummary.length > 0) {
    return bucketSummary;
  }
  if (
    Array.isArray(dashboardState?.presentation?.bucketSummary) &&
    dashboardState.presentation.bucketSummary.length > 0
  ) {
    return dashboardState.presentation.bucketSummary;
  }
  if (Array.isArray(dashboardState?.bucketGroups)) {
    return dashboardState.bucketGroups.map((bucket) => ({
      bucketKey: bucket?.bucketKey ?? bucket?.key ?? null,
      label: bucket?.label ?? bucket?.bucketLabel ?? bucket?.bucketLongLabel ?? null,
      amount: toNumber(bucket?.currentAmount ?? bucket?.amount ?? bucket?.totalAmount),
      weightPct: toNumber(bucket?.currentPct ?? bucket?.weightPct),
      targetPct: toNumber(bucket?.targetPct),
      gapAmountCny: deriveBucketGapAmountCny(bucket, totalPortfolioAssetsCny)
    }));
  }
  return [];
}

function resolvePositionUnits(position = {}) {
  return toNullableNumber(position?.units ?? position?.confirmed_units);
}

function normalizeEventWatch(eventWatch = {}) {
  const readiness = String(
    eventWatch?.readiness ??
      eventWatch?.status ??
      eventWatch?.eventWatchReadiness ??
      "unknown"
  ).trim() || "unknown";
  const upcomingHighImpactEventCount = toNumber(
    eventWatch?.upcomingHighImpactEventCount ?? eventWatch?.upcomingCount
  );
  const nextHighImpactEvent =
    eventWatch?.nextHighImpactEvent && typeof eventWatch.nextHighImpactEvent === "object"
      ? eventWatch.nextHighImpactEvent
      : null;

  return {
    readiness,
    upcomingHighImpactEventCount,
    nextHighImpactEvent
  };
}

export function buildAgentRuntimeContextPayload({
  accountId,
  portfolioState = {},
  dashboardState = {},
  researchBrain = {},
  health = {},
  bucketSummary = []
} = {}) {
  const summary = portfolioState?.summary ?? {};
  const dashboardSummary = dashboardState?.presentation?.summary ?? dashboardState?.summary ?? {};
  const dashboardRows = normalizeRows(dashboardState);
  const positions = Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];
  const totalPortfolioAssetsCny = toNumber(summary?.total_portfolio_assets_cny);

  return {
    generatedAt: new Date().toISOString(),
    accountId: String(accountId ?? "").trim() || "main",
    snapshotDate:
      String(portfolioState?.snapshot_date ?? dashboardState?.snapshotDate ?? "").trim() || null,
    meta: {
      marketSession: String(researchBrain?.meta?.market_session ?? "unknown").trim() || "unknown",
      dataFreshnessSummary: String(health?.state ?? "unknown").trim() || "unknown"
    },
    portfolio: {
      totalPortfolioAssetsCny: toNumber(summary?.total_portfolio_assets_cny),
      investedAssetsCny: toNumber(summary?.total_fund_assets),
      settledCashCny: toNumber(summary?.settled_cash_cny ?? summary?.available_cash_cny),
      tradeAvailableCashCny: toNumber(
        summary?.trade_available_cash_cny ??
          summary?.settled_cash_cny ??
          summary?.available_cash_cny
      ),
      cashLikeFundAssetsCny: toNumber(summary?.cash_like_fund_assets_cny),
      liquiditySleeveAssetsCny: toNumber(summary?.liquidity_sleeve_assets_cny),
      holdingProfitCny: toNumber(
        summary?.unrealized_holding_profit_cny ?? summary?.holding_profit
      ),
      dailyPnlCny: toNumber(
        dashboardSummary?.displayDailyPnl ??
          dashboardSummary?.estimatedDailyPnl ??
          dashboardSummary?.dailyPnl
      )
    },
    positions: positions
      .filter((position) => position?.status !== "user_confirmed_sold")
      .map((position) => {
        const code =
          String(position?.code ?? position?.fund_code ?? position?.symbol ?? "").trim() || null;
        const row = dashboardRows.find(
          (item) =>
            String(item?.code ?? item?.fundCode ?? item?.symbol ?? "").trim() ===
            String(code ?? "")
        );
        const canonicalSnapshot = deriveCanonicalHoldingSnapshot(position);
        const canonicalUnits = canonicalSnapshot.units ?? resolvePositionUnits(position);
        return {
          name: position?.name ?? row?.name ?? null,
          code,
          bucketKey: position?.bucket ?? row?.bucketKey ?? null,
          category: position?.category ?? row?.category ?? null,
          units: canonicalUnits === null ? null : canonicalUnits,
          canonicalAmount: toNumber(canonicalSnapshot.amountCny ?? position?.amount),
          amount: toNumber(canonicalSnapshot.amountCny ?? position?.amount),
          observableAmount: toNumber(
            row?.amount ??
              row?.currentAmount ??
              row?.observableAmount ??
              canonicalSnapshot.amountCny ??
              position?.amount
          ),
          costBasis: toNumber(
            canonicalSnapshot.costBasisCny ??
              position?.holding_cost_basis_cny ??
              position?.cost_basis
          ),
          canonicalHoldingPnl: toNumber(canonicalSnapshot.holdingPnlCny ?? position?.holding_pnl),
          holdingPnl: toNumber(canonicalSnapshot.holdingPnlCny ?? position?.holding_pnl),
          observableHoldingPnl: toNumber(
            row?.holdingPnl ??
              row?.holding_pnl ??
              row?.observableHoldingPnl ??
              canonicalSnapshot.holdingPnlCny ??
              position?.holding_pnl
          ),
          holdingPnlRatePct: toNullableNumber(
            canonicalSnapshot.holdingPnlRatePct ?? position?.holding_pnl_rate_pct
          ),
          changePct: toNullableNumber(row?.changePct ?? row?.dailyChangePct),
          quoteDate: row?.quoteDate ?? row?.netValueDate ?? null,
          quoteMode: row?.quoteMode ?? null,
          confirmationState: row?.confirmationState ?? position?.confirmation_state ?? null
        };
      }),
    bucketView: normalizeBucketSummary(bucketSummary, dashboardState, totalPortfolioAssetsCny),
    marketContext: {
      topHeadlines: Array.isArray(researchBrain?.top_headlines)
        ? researchBrain.top_headlines.slice(0, 8)
        : [],
      newsCoverageReadiness:
        String(researchBrain?.coverage_guard?.overall_status ?? "").trim() || "unknown",
      crossAssetSnapshot: researchBrain?.market_snapshot ?? {},
      dominantDrivers: researchBrain?.event_driver?.active_drivers ?? [],
      goldRegime: researchBrain?.gold_factor_model?.goldRegime ?? null,
      riskTone: researchBrain?.actionable_decision?.desk_conclusion?.overall_stance ?? null,
      eventWatch: normalizeEventWatch(researchBrain?.event_watch)
    },
    systemState: {
      dashboardHealth: health,
      researchReadiness: researchBrain?.decision_readiness ?? {},
      confirmedNavState: health?.confirmedNavState ?? null,
      blockedReason: researchBrain?.blocked_reason ?? null,
      staleDependencies: researchBrain?.freshness_guard?.stale_dependencies ?? []
    }
  };
}
