import test from "node:test";
import assert from "node:assert/strict";

import {
  createLedgerEntriesFromTransactionContent,
  ensureMaterializationFiles,
  materializePortfolioStateFromInputs
} from "./portfolio_state_materializer.mjs";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

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

test("raw-reflected OTC buy stays pending until profit effective date even after trade date has passed", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-08",
    currency: "CNY",
    summary: {
      total_fund_assets: 4000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 4000,
      yesterday_profit: 0,
      holding_profit: 0,
      cumulative_profit: 0,
      available_cash_cny: 6000,
      total_portfolio_assets_cny: 10000
    },
    raw_account_snapshot: {
      total_fund_assets: 4000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 4000
    },
    cash_ledger: {
      available_cash_cny: 6000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "测试QDII基金",
        amount: 4000,
        daily_pnl: 0,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        category: "美股科技/QDII",
        status: "active",
        execution_type: "OTC",
        code: "019736",
        symbol: "019736",
        fund_code: "019736"
      }
    ],
    recognition_notes: []
  };
  const executionLedger = {
    entries: [
      {
        id: "manual-buy-qdii-pending",
        account_id: "main",
        type: "buy",
        status: "recorded",
        recorded_at: "2026-04-08T08:30:00.000Z",
        effective_trade_date: "2026-04-03",
        profit_effective_on: "2026-04-09",
        source: "manual_transaction_file",
        source_file: "/tmp/2026-04-03-manual-buys.json",
        normalized: {
          fund_name: "测试QDII基金",
          amount_cny: 4000,
          category: "美股科技/QDII",
          execution_type: "OTC",
          code: "019736",
          symbol: "019736",
          fund_code: "019736",
          submitted_before_cutoff: false,
          cutoff_time_local: "15:00",
          profit_effective_on: "2026-04-09",
          cash_effect_cny: -4000,
          raw_snapshot_includes_trade: true
        },
        original: {
          trade_date: "2026-04-03",
          interpreted_fund_name: "测试QDII基金",
          amount_cny: 4000,
          submitted_before_cutoff: false,
          profit_effective_on: "2026-04-09",
          raw_snapshot_includes_trade: true
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-08");
  const active = state.positions.find((item) => item.name === "测试QDII基金");

  assert.equal(active.amount, 0);
  assert.equal(state.summary.total_fund_assets, 0);
  assert.equal(state.summary.pending_buy_confirm, 4000);
  assert.equal(state.pending_profit_effective_positions.length, 1);
  assert.equal(state.pending_profit_effective_positions[0].amount, 4000);
});

test("materializer rebuilds otc amount from confirmed units and last confirmed nav when canonical fields are available", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-08",
    currency: "CNY",
    summary: {
      total_fund_assets: 999999,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 999999,
      yesterday_profit: 0,
      holding_profit: 999999,
      cumulative_profit: 999999,
      available_cash_cny: 5000,
      total_portfolio_assets_cny: 1004999
    },
    raw_account_snapshot: {
      total_fund_assets: 999999,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 999999
    },
    cash_ledger: {
      available_cash_cny: 5000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        amount: 999999,
        daily_pnl: 0,
        holding_pnl: 999999,
        holding_pnl_rate_pct: 999999,
        holding_cost_basis_cny: 21000,
        confirmed_units: 10000,
        last_confirmed_nav: 2.168019,
        last_confirmed_nav_date: "2026-04-07",
        category: "A股宽基",
        status: "active",
        execution_type: "OTC",
        code: "007339",
        symbol: "007339",
        fund_code: "007339"
      }
    ],
    recognition_notes: []
  };

  const state = materializeWithFixture(rawSnapshot, { entries: [] }, "2026-04-08");
  const position = state.positions.find((item) => item.code === "007339");

  assert.equal(position.amount, 21680.19);
  assert.equal(position.holding_pnl, 680.19);
  assert.equal(position.holding_pnl_rate_pct, 3.24);
  assert.equal(state.summary.total_fund_assets, 21680.19);
});

test("ensureMaterializationFiles no longer creates a placeholder portfolio_state.json", async () => {
  const portfolioRoot = await mkdtemp(path.join(tmpdir(), "portfolio-materializer-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });

  const result = await ensureMaterializationFiles({
    portfolioRoot,
    accountId: "main",
    seedMissing: false
  });

  const portfolioStateChange = result.changes.find((item) => item.path === result.paths.portfolioStatePath);
  assert.equal(portfolioStateChange?.action, "portfolio_state_missing_requires_materialization");
  await assert.rejects(() => readFile(result.paths.portfolioStatePath, "utf8"));
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

test("exchange full sell keeps pre-trade market value in last_seen_amount", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-03",
    currency: "CNY",
    summary: {
      total_fund_assets: 12000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 12000,
      yesterday_profit: 0,
      holding_profit: 0,
      cumulative_profit: 0,
      available_cash_cny: 5000,
      total_portfolio_assets_cny: 17000
    },
    raw_account_snapshot: {
      total_fund_assets: 12000
    },
    cash_ledger: {
      available_cash_cny: 5000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "纳指ETF",
        amount: 12000,
        shares: 1000,
        sellable_shares: 1000,
        cost_price: 12,
        daily_pnl: 0,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        category: "美股ETF",
        status: "active",
        execution_type: "EXCHANGE",
        settlement_rule: "T+0",
        code: "513100",
        symbol: "513100",
        ticker: "513100"
      }
    ],
    recognition_notes: []
  };
  const executionLedger = {
    entries: [
      {
        id: "exchange-sell-1",
        account_id: "main",
        type: "sell",
        status: "recorded",
        recorded_at: "2026-04-03T07:00:00.000Z",
        effective_trade_date: "2026-04-03",
        source: "manual_transaction_file",
        normalized: {
          execution_type: "EXCHANGE",
          fund_name: "纳指ETF",
          symbol: "513100",
          code: "513100",
          ticker: "513100",
          quantity: 1000,
          actual_avg_price: 11,
          actual_notional_cny: 11000,
          settlement_rule: "T+0",
          cash_effect_cny: 11000,
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-03");
  const position = state.positions.find((item) => item.symbol === "513100");

  assert.equal(position.amount, 0);
  assert.equal(position.last_seen_amount, 12000);
});

test("materializer recomputes total_portfolio_assets_cny instead of trusting stale raw summary totals", () => {
  const { rawSnapshot, executionLedger } = buildFixture();
  rawSnapshot.summary.total_portfolio_assets_cny = 99999;

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-01");

  assert.equal(state.summary.total_portfolio_assets_cny, 20000);
});

test("materializer separates settled cash from cash-like sleeve assets", () => {
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
      holding_profit: 300,
      cumulative_profit: 300,
      available_cash_cny: 5000,
      total_portfolio_assets_cny: 20000
    },
    raw_account_snapshot: {
      total_fund_assets: 15000
    },
    cash_ledger: {
      available_cash_cny: 5000,
      frozen_cash_cny: 1000,
      cash_reserve_override_cny: 500,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "兴全恒信债券C",
        amount: 3000,
        holding_pnl: 20,
        holding_pnl_rate_pct: 0.67,
        category: "偏债混合",
        bucket: "CASH",
        status: "active",
        execution_type: "OTC",
        code: "016482",
        symbol: "016482",
        fund_code: "016482"
      },
      {
        name: "测试权益基金",
        amount: 12000,
        holding_pnl: 280,
        holding_pnl_rate_pct: 2.33,
        category: "A股宽基",
        bucket: "A_CORE",
        status: "active",
        execution_type: "OTC",
        code: "007339",
        symbol: "007339",
        fund_code: "007339"
      }
    ],
    recognition_notes: []
  };

  const state = materializeWithFixture(rawSnapshot, { entries: [] }, "2026-04-03");

  assert.equal(state.summary.available_cash_cny, 5000);
  assert.equal(state.summary.settled_cash_cny, 5000);
  assert.equal(state.summary.trade_available_cash_cny, 3500);
  assert.equal(state.summary.cash_like_fund_assets_cny, 3000);
  assert.equal(state.summary.liquidity_sleeve_assets_cny, 3000);
  assert.equal(state.cash_ledger.available_cash_cny, 5000);
  assert.equal(state.cash_ledger.settled_cash_cny, 5000);
  assert.equal(state.cash_ledger.trade_available_cash_cny, 3500);
  assert.equal(state.cash_ledger.cash_like_fund_assets_cny, 3000);
  assert.equal(state.cash_ledger.liquidity_sleeve_assets_cny, 3000);
  assert.equal(state.performance_snapshot.settled_cash_cny, 5000);
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

test("materializer carries durable otc cost basis through later manual buys", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-04-02",
    currency: "CNY",
    summary: {
      total_fund_assets: 50000,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 50000,
      yesterday_profit: 0,
      holding_profit: 0,
      cumulative_profit: 0,
      available_cash_cny: 200000,
      total_portfolio_assets_cny: 250000
    },
    raw_account_snapshot: {
      total_fund_assets: 50000
    },
    cash_ledger: {
      available_cash_cny: 200000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "兴全恒信债券C",
        amount: 50000,
        daily_pnl: 0,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        category: "偏债混合",
        status: "active",
        execution_type: "OTC",
        code: "016482",
        symbol: "016482",
        fund_code: "016482"
      }
    ],
    recognition_notes: []
  };
  const executionLedger = {
    entries: [
      {
        id: "manual-buy-016482",
        account_id: "main",
        type: "buy",
        status: "recorded",
        recorded_at: "2026-04-02T07:00:00.000Z",
        effective_trade_date: "2026-04-02",
        profit_effective_on: "2026-04-03",
        source: "manual_transaction_file",
        normalized: {
          fund_name: "兴全恒信债券C",
          amount_cny: 20000,
          category: "偏债混合",
          execution_type: "OTC",
          code: "016482",
          symbol: "016482",
          fund_code: "016482",
          cash_effect_cny: -20000
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-04-03");
  const position = state.positions.find((item) => item.code === "016482");

  assert.equal(position.amount, 70000);
  assert.equal(position.holding_cost_basis_cny, 70000);
  assert.equal(position.holding_pnl, 0);
});

test("materializer preserves transferred cost basis on otc fund conversion", () => {
  const rawSnapshot = {
    account_id: "main",
    snapshot_date: "2026-03-25",
    currency: "CNY",
    summary: {
      total_fund_assets: 31320.63,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 31320.63,
      yesterday_profit: 1548.88,
      holding_profit: -1556.1,
      cumulative_profit: -1556.1,
      available_cash_cny: 1000,
      total_portfolio_assets_cny: 32320.63
    },
    raw_account_snapshot: {
      total_fund_assets: 31320.63
    },
    cash_ledger: {
      available_cash_cny: 1000,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    positions: [
      {
        name: "国泰黄金ETF联接E",
        amount: 2000,
        daily_pnl: 0,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        category: "黄金",
        status: "active",
        execution_type: "OTC",
        code: "022502",
        symbol: "022502",
        fund_code: "022502"
      },
      {
        name: "工银瑞信黄金ETF联接C",
        amount: 29320.63,
        daily_pnl: 1548.88,
        holding_pnl: -1556.1,
        holding_pnl_rate_pct: -5.04,
        category: "黄金",
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: []
  };
  const executionLedger = {
    entries: [
      {
        id: "gold-conversion-1",
        account_id: "main",
        type: "conversion",
        status: "recorded",
        recorded_at: "2026-03-25T06:30:00.000Z",
        effective_trade_date: "2026-03-25",
        source: "manual_transaction_file",
        normalized: {
          execution_type: "OTC",
          from_fund_name: "工银瑞信黄金ETF联接C",
          from_amount_cny: 29320.63,
          to_fund_name: "国泰黄金ETF联接E",
          to_amount_cny: 34320.63,
          cash_effect_cny: 0
        }
      }
    ]
  };

  const state = materializeWithFixture(rawSnapshot, executionLedger, "2026-03-26");
  const target = state.positions.find((item) => item.code === "022502");

  assert.equal(target.amount, 36320.63);
  assert.equal(target.holding_cost_basis_cny, 32876.73);
  assert.equal(target.holding_pnl, 3443.9);
});
