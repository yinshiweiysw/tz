import test from "node:test";
import assert from "node:assert/strict";

import { materializePortfolioStateFromInputs } from "./portfolio_state_materializer.mjs";

function buildFixture() {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-01",
    currency: "CNY",
    summary: {
      total_fund_assets: 15000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 15000,
      yesterday_profit: 0,
      holding_profit: 100,
      cumulative_profit: 100,
      available_cash_cny: 5000,
      total_portfolio_assets_cny: 20000
    },
    raw_account_snapshot: {
      total_fund_assets: 15000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 15000
    },
    cash_ledger: {
      available_cash_cny: 5000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "测试基金A",
        amount: 15000,
        daily_pnl: 0,
        holding_pnl: 100,
        holding_pnl_rate_pct: 0.67,
        category: "A股宽基",
        status: "active",
        execution_type: "OTC",
        code: "000001",
        symbol: "000001",
        fund_code: "000001"
      }
    ],
    recognition_notes: []
  };

  const executionLedger = {
    entries: [
      {
        id: "manual-buy-1",
        account_id: "main",
        type: "buy",
        status: "recorded",
        recorded_at: "2026-04-01T07:00:00.000Z",
        effective_trade_date: "2026-04-01",
        profit_effective_on: "2026-04-02",
        source: "manual_transaction_file",
        source_file: "/tmp/2026-04-01-manual-buys.json",
        normalized: {
          fund_name: "测试基金A",
          amount_cny: 5000,
          category: "A股宽基",
          execution_type: "OTC",
          code: "000001",
          symbol: "000001",
          fund_code: "000001",
          submitted_before_cutoff: true,
          cutoff_time_local: "15:00",
          profit_effective_on: "2026-04-02",
          cash_effect_cny: -5000,
          raw_snapshot_includes_trade: true
        },
        original: {
          trade_date: "2026-04-01",
          interpreted_fund_name: "测试基金A",
          amount_cny: 5000,
          submitted_before_cutoff: true,
          profit_effective_on: "2026-04-02",
          raw_snapshot_includes_trade: true
        }
      }
    ]
  };

  return { rawSnapshot, executionLedger };
}

function materialize(referenceDate) {
  const { rawSnapshot, executionLedger } = buildFixture();
  return materializePortfolioStateFromInputs({
    rawSnapshot,
    executionLedger,
    accountId: "main",
    portfolioRoot: "/tmp/portfolio",
    referenceDate,
    paths: {
      latestCompatPath: "/tmp/latest.json",
      latestRawPath: "/tmp/latest_raw.json",
      executionLedgerPath: "/tmp/execution_ledger.json",
      portfolioStatePath: "/tmp/portfolio_state.json"
    }
  }).portfolioState;
}

function materializeWithFixture(rawSnapshot, executionLedger, referenceDate = rawSnapshot.snapshot_date) {
  return materializePortfolioStateFromInputs({
    rawSnapshot,
    executionLedger,
    accountId: "main",
    portfolioRoot: "/tmp/portfolio",
    referenceDate,
    paths: {
      latestCompatPath: "/tmp/latest.json",
      latestRawPath: "/tmp/latest_raw.json",
      executionLedgerPath: "/tmp/execution_ledger.json",
      portfolioStatePath: "/tmp/portfolio_state.json"
    }
  }).portfolioState;
}

test("same-day OTC buy reflected in raw snapshot stays pending on trade date", () => {
  const state = materialize("2026-04-01");
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 10000);
  assert.equal(active.holding_pnl, 100);
  assert.equal(state.summary.available_cash_cny, 5000);
  assert.equal(state.summary.pending_buy_confirm, 5000);
  assert.equal(state.pending_profit_effective_positions.length, 1);
  assert.equal(state.pending_profit_effective_positions[0].amount, 5000);
});

test("same-day OTC buy reflected in raw snapshot activates cleanly on next profit date", () => {
  const state = materialize("2026-04-02");
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 15000);
  assert.equal(active.holding_pnl, 100);
  assert.equal(state.summary.available_cash_cny, 5000);
  assert.equal(state.summary.pending_buy_confirm, 0);
  assert.equal(state.pending_profit_effective_positions.length, 0);
});

test("same-day OTC sell reflected in raw snapshot is not double-counted", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-01",
    currency: "CNY",
    summary: {
      total_fund_assets: 10000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 5000,
      effective_exposure_after_pending_sell: 10000,
      yesterday_profit: 0,
      holding_profit: 100,
      cumulative_profit: 100,
      available_cash_cny: 5000,
      total_portfolio_assets_cny: 20000
    },
    raw_account_snapshot: {
      total_fund_assets: 10000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 5000,
      effective_exposure_after_pending_sell: 10000
    },
    cash_ledger: {
      available_cash_cny: 5000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 5000
    },
    positions: [
      {
        name: "测试基金A",
        amount: 10000,
        daily_pnl: 0,
        holding_pnl: 100,
        holding_pnl_rate_pct: 1,
        category: "A股宽基",
        status: "active",
        execution_type: "OTC",
        code: "000001",
        symbol: "000001",
        fund_code: "000001"
      }
    ],
    recognition_notes: []
  };

  const executionLedger = {
    entries: [
      {
        id: "manual-sell-1",
        account_id: "main",
        type: "sell",
        status: "recorded",
        recorded_at: "2026-04-01T07:00:00.000Z",
        effective_trade_date: "2026-04-01",
        profit_effective_on: null,
        source: "manual_transaction_file",
        source_file: "/tmp/2026-04-01-manual-trades.json",
        normalized: {
          fund_name: "测试基金A",
          amount_cny: 5000,
          cash_effect_cny: 0,
          pending_sell_to_arrive_cny: 5000,
          raw_snapshot_includes_trade: true
        },
        original: {
          trade_date: "2026-04-01",
          interpreted_fund_name: "测试基金A",
          amount_cny: 5000,
          cash_arrived: false,
          raw_snapshot_includes_trade: true
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger);
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 10000);
  assert.equal(state.summary.pending_sell_to_arrive, 5000);
  assert.equal(state.summary.available_cash_cny, 5000);
});

test("same-day OTC conversion reflected in raw snapshot is not double-counted", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-01",
    currency: "CNY",
    summary: {
      total_fund_assets: 15000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 15000,
      yesterday_profit: 0,
      holding_profit: 100,
      cumulative_profit: 100,
      available_cash_cny: 5000,
      total_portfolio_assets_cny: 20000
    },
    raw_account_snapshot: {
      total_fund_assets: 15000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 15000
    },
    cash_ledger: {
      available_cash_cny: 5000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "测试基金A",
        amount: 10000,
        daily_pnl: 0,
        holding_pnl: 100,
        holding_pnl_rate_pct: 1,
        category: "A股宽基",
        status: "active",
        execution_type: "OTC",
        code: "000001",
        symbol: "000001",
        fund_code: "000001"
      },
      {
        name: "测试基金B",
        amount: 5000,
        daily_pnl: 0,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        category: "A股宽基",
        status: "active",
        execution_type: "OTC",
        code: "000002",
        symbol: "000002",
        fund_code: "000002"
      }
    ],
    recognition_notes: []
  };

  const executionLedger = {
    entries: [
      {
        id: "manual-conversion-1",
        account_id: "main",
        type: "conversion",
        status: "recorded",
        recorded_at: "2026-04-01T07:00:00.000Z",
        effective_trade_date: "2026-04-01",
        profit_effective_on: null,
        source: "manual_transaction_file",
        source_file: "/tmp/2026-04-01-manual-trades.json",
        normalized: {
          from_fund_name: "测试基金A",
          to_fund_name: "测试基金B",
          from_amount_cny: 5000,
          to_amount_cny: 5000,
          execution_type: "OTC",
          raw_snapshot_includes_trade: true
        },
        original: {
          trade_date: "2026-04-01",
          from_fund_name: "测试基金A",
          to_fund_name: "测试基金B",
          from_amount_cny: 5000,
          to_amount_cny: 5000,
          raw_snapshot_includes_trade: true
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger);
  const fundA = state.positions.find((item) => item.name === "测试基金A");
  const fundB = state.positions.find((item) => item.name === "测试基金B");

  assert.equal(fundA.amount, 10000);
  assert.equal(fundB.amount, 5000);
  assert.equal(state.summary.total_fund_assets, 15000);
});
