import test from "node:test";
import assert from "node:assert/strict";

import { deriveDashboardAccountingSummary } from "./dashboard_accounting_summary.mjs";

test("deriveDashboardAccountingSummary prefers live unrealized pnl and performance snapshot fields", () => {
  const summary = deriveDashboardAccountingSummary({
    portfolioStateSummary: {
      unrealized_holding_profit_cny: 1000,
      realized_cumulative_profit_cny: 500,
      pending_buy_confirm: 2000,
      pending_sell_to_arrive: 3000,
      available_cash_cny: 12000
    },
    performanceSnapshot: {
      realized_cumulative_profit_cny: 800,
      pending_profit_effective_cny: 2500,
      pending_sell_settlement_cny: 3500,
      settled_cash_cny: 14000,
      projected_settled_cash_cny: 17500
    },
    cashLedger: {
      pending_buy_confirm_cny: 2200,
      execution_ledger_pending_cash_arrival_cny: 3200,
      available_cash_cny: 13000
    },
    liveUnrealizedHoldingProfitCny: 1234.56,
    liveUnrealizedHoldingProfitRatePct: 6.789
  });

  assert.deepEqual(summary, {
    unrealizedHoldingProfitCny: 1234.56,
    unrealizedHoldingProfitRatePct: 6.79,
    realizedCumulativeProfitCny: 800,
    pendingProfitEffectiveCny: 2500,
    pendingSellSettlementCny: 3500,
    settledCashCny: 14000,
    projectedSettledCashCny: 17500
  });
});

test("deriveDashboardAccountingSummary falls back through cash ledger and portfolio state when performance snapshot is sparse", () => {
  const summary = deriveDashboardAccountingSummary({
    portfolioStateSummary: {
      holding_profit: -500,
      pending_buy_confirm: 1000,
      pending_sell_to_arrive: 0,
      available_cash_cny: 9000
    },
    performanceSnapshot: {},
    cashLedger: {
      pending_buy_confirm_cny: 1200,
      execution_ledger_pending_cash_arrival_cny: 4500,
      available_cash_cny: 10000,
      projected_settled_cash_cny: 14500
    }
  });

  assert.deepEqual(summary, {
    unrealizedHoldingProfitCny: -500,
    unrealizedHoldingProfitRatePct: null,
    realizedCumulativeProfitCny: null,
    pendingProfitEffectiveCny: 1200,
    pendingSellSettlementCny: 4500,
    settledCashCny: 10000,
    projectedSettledCashCny: 14500
  });
});
