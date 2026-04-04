import test from "node:test";
import assert from "node:assert/strict";

import {
  createLedgerEntriesFromTransactionContent,
  materializePortfolioStateFromInputs
} from "./portfolio_state_materializer.mjs";

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
  assert.equal(state.summary.unrealized_holding_profit_cny, 100);
  assert.equal(state.summary.realized_cumulative_profit_cny, 0);
  assert.equal(state.pending_profit_effective_positions.length, 1);
  assert.equal(state.pending_profit_effective_positions[0].amount, 5000);
  assert.equal(state.cash_ledger.deployed_pending_profit_effective_cny, 5000);
  assert.equal(state.cash_ledger.projected_settled_cash_cny, 5000);
  assert.equal(state.performance_snapshot.unrealized_holding_profit_cny, 100);
  assert.equal(state.performance_snapshot.realized_cumulative_profit_cny, 0);
  assert.equal(state.performance_snapshot.pending_profit_effective_cny, 5000);
  assert.equal(state.performance_snapshot.projected_settled_cash_cny, 5000);
  assert.equal(state.trade_lifecycle_summary.counts_by_stage.platform_confirmed_pending_profit, 1);
  assert.equal(state.trade_lifecycle_summary.amounts_by_stage.platform_confirmed_pending_profit, 5000);
});

test("createLedgerEntriesFromTransactionContent preserves enriched trade metadata", () => {
  const entries = createLedgerEntriesFromTransactionContent({
    accountId: "main",
    filePath: "/tmp/2026-04-01-manual-trades.json",
    recordedAt: "2026-04-01T07:00:00.000Z",
    content: {
      snapshot_date: "2026-04-01",
      executed_buy_transactions: [
        {
          trade_date: "2026-04-01",
          interpreted_fund_name: "易方达沪深300ETF联接C",
          fund_code: "007339",
          amount_cny: 8000,
          execution_type: "OTC",
          submitted_before_cutoff: true,
          cutoff_time_local: "15:00",
          source_confidence: "user_dialogue_confirmed",
          fund_identity: {
            code: "007339",
            name: "易方达沪深300ETF联接C",
            user_stated_token: "007339"
          },
          bucket_key: "A_CORE",
          theme_key: "CN_CORE"
        }
      ]
    }
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].trade_id, "/tmp/2026-04-01-manual-trades.json::buy::2026-04-01::007339::8000::0");
  assert.equal(entries[0].normalized.bucket_key, "A_CORE");
  assert.equal(entries[0].normalized.theme_key, "CN_CORE");
  assert.equal(entries[0].normalized.source_confidence, "user_dialogue_confirmed");
  assert.deepEqual(entries[0].normalized.fund_identity, {
    code: "007339",
    name: "易方达沪深300ETF联接C",
    user_stated_token: "007339"
  });
});

test("same-day OTC buy reflected in raw snapshot activates cleanly on next profit date", () => {
  const state = materialize("2026-04-02");
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 15000);
  assert.equal(active.holding_pnl, 100);
  assert.equal(state.summary.available_cash_cny, 5000);
  assert.equal(state.summary.pending_buy_confirm, 0);
  assert.equal(state.summary.unrealized_holding_profit_cny, 100);
  assert.equal(state.summary.realized_cumulative_profit_cny, 0);
  assert.equal(state.pending_profit_effective_positions.length, 0);
  assert.equal(state.cash_ledger.deployed_pending_profit_effective_cny, 0);
  assert.equal(state.trade_lifecycle_summary.counts_by_stage.profit_effective, 1);
  assert.equal(state.trade_lifecycle_summary.amounts_by_stage.profit_effective, 5000);
});

test("duplicate ledger entries are applied once", () => {
  const { rawSnapshot, executionLedger } = buildFixture();
  executionLedger.entries.push({
    ...executionLedger.entries[0],
    recorded_at: "2026-04-01T07:05:00.000Z"
  });

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-01");
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 10000);
  assert.equal(state.summary.pending_buy_confirm, 5000);
  assert.equal(state.trade_lifecycle_summary.total_entries, 1);
});

test("older OTC buy still activates when newer raw snapshot has not yet included the trade", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-03",
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
        id: "manual-buy-older-snapshot-gap",
        account_id: "main",
        type: "buy",
        status: "recorded",
        recorded_at: "2026-04-03T02:00:00.000Z",
        effective_trade_date: "2026-04-02",
        profit_effective_on: "2026-04-03",
        source: "manual_transaction_file",
        source_file: "/tmp/2026-04-02-manual-buys.json",
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
          profit_effective_on: "2026-04-03",
          cash_effect_cny: -5000,
          raw_snapshot_includes_trade: false
        },
        original: {
          trade_date: "2026-04-02",
          interpreted_fund_name: "测试基金A",
          amount_cny: 5000,
          submitted_before_cutoff: true,
          profit_effective_on: "2026-04-03",
          raw_snapshot_includes_trade: false
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-03");
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 20000);
  assert.equal(state.summary.available_cash_cny, 0);
  assert.equal(state.summary.pending_buy_confirm, 0);
  assert.equal(state.pending_profit_effective_positions.length, 0);
  assert.equal(state.trade_lifecycle_summary.counts_by_stage.profit_effective, 1);
  assert.equal(state.trade_lifecycle_summary.amounts_by_stage.profit_effective, 5000);
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
  assert.equal(state.cash_ledger.projected_settled_cash_cny, 10000);
  assert.equal(state.cash_ledger.execution_ledger_pending_cash_arrival_cny, 5000);
  assert.equal(state.cash_ledger.execution_ledger_cash_arrived_cny, 0);
  assert.equal(state.performance_snapshot.pending_sell_settlement_cny, 5000);
  assert.equal(state.performance_snapshot.settled_cash_cny, 5000);
  assert.equal(state.trade_lifecycle_summary.counts_by_stage.platform_confirmed_pending_cash_arrival, 1);
  assert.equal(state.trade_lifecycle_summary.amounts_by_stage.platform_confirmed_pending_cash_arrival, 5000);
});

test("same-day OTC sell with cash arrived stays settled after raw unwind and overlay", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-01",
    currency: "CNY",
    summary: {
      total_fund_assets: 10000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 10000,
      yesterday_profit: 0,
      holding_profit: 100,
      cumulative_profit: 600,
      available_cash_cny: 10000,
      total_portfolio_assets_cny: 20000
    },
    raw_account_snapshot: {
      total_fund_assets: 10000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 10000
    },
    cash_ledger: {
      available_cash_cny: 10000,
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
      }
    ],
    recognition_notes: []
  };

  const executionLedger = {
    entries: [
      {
        id: "manual-sell-cash-arrived-1",
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
          cash_effect_cny: 5000,
          pending_sell_to_arrive_cny: 0,
          raw_snapshot_includes_trade: true
        },
        original: {
          trade_date: "2026-04-01",
          interpreted_fund_name: "测试基金A",
          amount_cny: 5000,
          cash_arrived: true,
          raw_snapshot_includes_trade: true
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger);
  const active = state.positions.find((item) => item.name === "测试基金A");

  assert.equal(active.amount, 10000);
  assert.equal(state.summary.available_cash_cny, 10000);
  assert.equal(state.summary.pending_sell_to_arrive, 0);
  assert.equal(state.summary.unrealized_holding_profit_cny, 100);
  assert.equal(state.summary.realized_cumulative_profit_cny, 500);
  assert.equal(state.cash_ledger.execution_ledger_pending_cash_arrival_cny, 0);
  assert.equal(state.cash_ledger.execution_ledger_cash_arrived_cny, 5000);
  assert.equal(state.performance_snapshot.realized_cumulative_profit_cny, 500);
  assert.equal(state.performance_snapshot.settled_cash_cny, 10000);
  assert.equal(state.trade_lifecycle_summary.counts_by_stage.cash_arrived, 1);
  assert.equal(state.trade_lifecycle_summary.amounts_by_stage.cash_arrived, 5000);
});

test("bootstrap-like zero cumulative profit stays unknown instead of fabricating realized pnl", () => {
  const { rawSnapshot, executionLedger } = buildFixture();
  rawSnapshot.summary.cumulative_profit = 0;
  rawSnapshot.performance_snapshot = {};

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-02");

  assert.equal(state.summary.unrealized_holding_profit_cny, 100);
  assert.equal(state.summary.realized_cumulative_profit_cny, null);
  assert.equal(state.performance_snapshot.cumulative_profit_cny, null);
  assert.equal(state.performance_snapshot.realized_cumulative_profit_cny, null);
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
