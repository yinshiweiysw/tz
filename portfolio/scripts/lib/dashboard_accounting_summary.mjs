import { round } from "./format_utils.mjs";

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric) : null;
}

export function deriveDashboardAccountingSummary({
  portfolioStateSummary = {},
  performanceSnapshot = {},
  cashLedger = {},
  liveUnrealizedHoldingProfitCny = null,
  liveUnrealizedHoldingProfitRatePct = null
} = {}) {
  const unrealizedHoldingProfitCny =
    toFiniteNumber(liveUnrealizedHoldingProfitCny) ??
    toFiniteNumber(portfolioStateSummary?.unrealized_holding_profit_cny) ??
    toFiniteNumber(portfolioStateSummary?.holding_profit);
  const unrealizedHoldingProfitRatePct =
    toFiniteNumber(liveUnrealizedHoldingProfitRatePct) ??
    toFiniteNumber(performanceSnapshot?.unrealized_holding_profit_rate_pct);
  const realizedCumulativeProfitCny =
    toFiniteNumber(performanceSnapshot?.realized_cumulative_profit_cny) ??
    toFiniteNumber(portfolioStateSummary?.realized_cumulative_profit_cny);
  const pendingProfitEffectiveCny =
    toFiniteNumber(performanceSnapshot?.pending_profit_effective_cny) ??
    toFiniteNumber(cashLedger?.pending_buy_confirm_cny) ??
    toFiniteNumber(portfolioStateSummary?.pending_buy_confirm) ??
    0;
  const pendingSellSettlementCny =
    toFiniteNumber(performanceSnapshot?.pending_sell_settlement_cny) ??
    toFiniteNumber(cashLedger?.execution_ledger_pending_cash_arrival_cny) ??
    toFiniteNumber(cashLedger?.pending_sell_to_arrive_cny) ??
    toFiniteNumber(portfolioStateSummary?.pending_sell_to_arrive) ??
    0;
  const settledCashCny =
    toFiniteNumber(performanceSnapshot?.settled_cash_cny) ??
    toFiniteNumber(cashLedger?.settled_cash_cny) ??
    toFiniteNumber(cashLedger?.available_cash_cny) ??
    toFiniteNumber(portfolioStateSummary?.settled_cash_cny) ??
    toFiniteNumber(portfolioStateSummary?.available_cash_cny);
  const projectedSettledCashCny =
    toFiniteNumber(performanceSnapshot?.projected_settled_cash_cny) ??
    toFiniteNumber(cashLedger?.projected_settled_cash_cny) ??
    (settledCashCny !== null ? round(settledCashCny + pendingSellSettlementCny) : null);
  const tradeAvailableCashCny =
    toFiniteNumber(performanceSnapshot?.trade_available_cash_cny) ??
    toFiniteNumber(cashLedger?.trade_available_cash_cny) ??
    toFiniteNumber(portfolioStateSummary?.trade_available_cash_cny) ??
    settledCashCny;
  const cashLikeFundAssetsCny =
    toFiniteNumber(performanceSnapshot?.cash_like_fund_assets_cny) ??
    toFiniteNumber(cashLedger?.cash_like_fund_assets_cny) ??
    toFiniteNumber(portfolioStateSummary?.cash_like_fund_assets_cny);
  const liquiditySleeveAssetsCny =
    toFiniteNumber(performanceSnapshot?.liquidity_sleeve_assets_cny) ??
    toFiniteNumber(cashLedger?.liquidity_sleeve_assets_cny) ??
    toFiniteNumber(portfolioStateSummary?.liquidity_sleeve_assets_cny);

  return {
    unrealizedHoldingProfitCny,
    unrealizedHoldingProfitRatePct,
    realizedCumulativeProfitCny,
    pendingProfitEffectiveCny,
    pendingSellSettlementCny,
    settledCashCny,
    projectedSettledCashCny,
    tradeAvailableCashCny,
    cashLikeFundAssetsCny,
    liquiditySleeveAssetsCny
  };
}
