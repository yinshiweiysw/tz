function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function normalizeBucketSummary(bucketSummary = [], dashboardState = {}) {
  if (Array.isArray(bucketSummary) && bucketSummary.length > 0) {
    return bucketSummary;
  }
  if (Array.isArray(dashboardState?.presentation?.bucketSummary)) {
    return dashboardState.presentation.bucketSummary;
  }
  if (Array.isArray(dashboardState?.bucketGroups)) {
    return dashboardState.bucketGroups.map((bucket) => ({
      bucketKey: bucket?.bucketKey ?? bucket?.key ?? null,
      label: bucket?.label ?? null,
      amount: toNumber(bucket?.amount ?? bucket?.totalAmount),
      weightPct: toNumber(bucket?.weightPct),
      targetPct: toNumber(bucket?.targetPct),
      gapAmountCny: toNumber(bucket?.gapAmountCny)
    }));
  }
  return [];
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
        return {
          name: position?.name ?? row?.name ?? null,
          code,
          bucketKey: position?.bucket ?? row?.bucketKey ?? null,
          category: position?.category ?? row?.category ?? null,
          amount: toNumber(position?.amount),
          costBasis: toNumber(position?.holding_cost_basis_cny ?? position?.cost_basis),
          holdingPnl: toNumber(position?.holding_pnl),
          holdingPnlRatePct: toNullableNumber(position?.holding_pnl_rate_pct),
          changePct: toNullableNumber(row?.changePct ?? row?.dailyChangePct),
          quoteDate: row?.quoteDate ?? row?.netValueDate ?? null,
          confirmationState: position?.confirmation_state ?? row?.confirmationState ?? null
        };
      }),
    bucketView: normalizeBucketSummary(bucketSummary, dashboardState),
    marketContext: {
      topHeadlines: Array.isArray(researchBrain?.top_headlines)
        ? researchBrain.top_headlines.slice(0, 8)
        : [],
      crossAssetSnapshot: researchBrain?.market_snapshot ?? {},
      dominantDrivers: researchBrain?.event_driver?.active_drivers ?? [],
      goldRegime: researchBrain?.gold_factor_model?.goldRegime ?? null,
      riskTone: researchBrain?.actionable_decision?.desk_conclusion?.overall_stance ?? null
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
