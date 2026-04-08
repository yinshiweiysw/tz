import test from "node:test";
import assert from "node:assert/strict";

import {
  computeConfirmedDailyPnl,
  reconcileRawSnapshotWithConfirmedQuotes
} from "./confirmed_nav_reconciler.mjs";

test("computeConfirmedDailyPnl uses confirmed units and official net value change instead of amount * pct shortcut", () => {
  const pnl = computeConfirmedDailyPnl({
    amount: 36724.87,
    eligibleAmount: 36724.87,
    confirmedUnits: 9726.15520712,
    quote: {
      netValue: 3.7756,
      growthRate: 2.79
    }
  });

  assert.equal(pnl, 996.74);
});

test("computeConfirmedDailyPnl falls back to implied units when stored confirmed units no longer matches active amount", () => {
  const pnl = computeConfirmedDailyPnl({
    amount: 36724.87,
    eligibleAmount: 36724.87,
    confirmedUnits: 12375.48204259,
    quote: {
      netValue: 3.7756,
      growthRate: 2.79
    }
  });

  assert.equal(pnl, 996.81);
});

test("reconcileRawSnapshotWithConfirmedQuotes upgrades legacy identity without inferring missing confirmed units and rewrites summary totals", () => {
  const rawSnapshot = {
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 69564.99,
      effective_exposure_after_pending_sell: 69564.99,
      yesterday_profit: 0,
      holding_profit: -18509.82,
      available_cash_cny: 1000,
      total_portfolio_assets_cny: 70564.99
    },
    cash_ledger: {
      available_cash_cny: 1000
    },
    positions: [
      {
        name: "华夏恒生互联网科技业ETF联接(QDII)C",
        code: "013172",
        symbol: "013172",
        fund_code: "013172",
        amount: 69564.99,
        holding_pnl: -18509.82,
        holding_pnl_rate_pct: -21.02,
        daily_pnl: 0,
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: []
  };

  const quotes = [
    {
      code: "023764",
      name: "华夏恒生互联网科技业ETF联接(QDII)D",
      netValueDate: "2026-04-01",
      netValue: 1.2345,
      growthRate: 2.09
    }
  ];

  const result = reconcileRawSnapshotWithConfirmedQuotes({
    rawSnapshot,
    quotes,
    asOfDate: "2026-04-01"
  });

  const position = result.rawSnapshot.positions[0];
  assert.equal(position.code, "023764");
  assert.equal(position.symbol, "023764");
  assert.equal(position.fund_code, "023764");
  assert.equal(position.name, "华夏恒生互联网科技业ETF联接(QDII)D");
  assert.equal(position.confirmed_units, null);
  assert.equal(result.rawSnapshot.summary.total_fund_assets, position.amount);
  assert.equal(
    result.rawSnapshot.summary.total_portfolio_assets_cny,
    Number((position.amount + 1000).toFixed(2))
  );
  assert.match(
    result.rawSnapshot.summary.performance_precision,
    /confirmed_nav/i
  );
});

test("reconcileRawSnapshotWithConfirmedQuotes partially updates confirmed funds while flagging late domestic funds", () => {
  const rawSnapshot = {
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 300,
      effective_exposure_after_pending_sell: 300,
      yesterday_profit: 3,
      holding_profit: 10,
      available_cash_cny: 100,
      total_portfolio_assets_cny: 400
    },
    cash_ledger: {
      available_cash_cny: 100
    },
    positions: [
      {
        name: "测试A",
        code: "000001",
        symbol: "000001",
        fund_code: "000001",
        amount: 100,
        holding_pnl: 5,
        daily_pnl: 1,
        status: "active",
        execution_type: "OTC",
        last_confirmed_nav_date: "2026-04-01"
      },
      {
        name: "测试B",
        code: "000002",
        symbol: "000002",
        fund_code: "000002",
        amount: 200,
        holding_pnl: 5,
        daily_pnl: 2,
        status: "active",
        execution_type: "OTC",
        last_confirmed_nav_date: "2026-04-01"
      }
    ],
    recognition_notes: []
  };

  const result = reconcileRawSnapshotWithConfirmedQuotes({
    rawSnapshot,
    quotes: [
      {
        code: "000001",
        name: "测试A",
        netValueDate: "2026-04-02",
        netValue: 1.01,
        growthRate: 1
      },
      {
        code: "000002",
        name: "测试B",
        netValueDate: "2026-04-01",
        netValue: 1,
        growthRate: 0
      }
    ],
    asOfDate: "2026-04-02"
  });

  assert.equal(result.rawSnapshot.snapshot_date, "2026-04-02");
  assert.equal(result.rawSnapshot.positions[0].amount, 100);
  assert.equal(result.rawSnapshot.positions[0].daily_pnl, 1);
  assert.equal(result.rawSnapshot.positions[1].amount, 200);
  assert.deepEqual(result.stats.stalePositions, [
    {
      code: "000002",
      name: "测试B",
      quoteDate: "2026-04-01",
      state: "late_missing",
      expectedConfirmedDate: "2026-04-02"
    }
  ]);
  assert.equal(result.stats.fullyConfirmedForDate, false);
  assert.equal(result.stats.updatedPositions, 1);
  assert.equal(result.stats.lateMissingFundCount, 1);
});

test("reconcileRawSnapshotWithConfirmedQuotes does not infer confirmed_units from current net value on first reconciliation", () => {
  const rawSnapshot = {
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 10000,
      effective_exposure_after_pending_sell: 10000,
      yesterday_profit: 0,
      holding_profit: 0,
      available_cash_cny: 1000,
      total_portfolio_assets_cny: 11000
    },
    cash_ledger: {
      available_cash_cny: 1000
    },
    positions: [
      {
        name: "测试基金A",
        code: "000001",
        symbol: "000001",
        fund_code: "000001",
        amount: 10000,
        holding_pnl: 0,
        daily_pnl: 0,
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: []
  };

  const result = reconcileRawSnapshotWithConfirmedQuotes({
    rawSnapshot,
    quotes: [
      {
        code: "000001",
        name: "测试基金A",
        netValueDate: "2026-04-02",
        netValue: 2.1,
        growthRate: 5
      }
    ],
    asOfDate: "2026-04-02"
  });

  const position = result.rawSnapshot.positions[0];
  assert.equal(position.confirmed_units, null);
  assert.equal(position.amount, 10000);
  assert.equal(position.daily_pnl, 500);
});

test("reconcileRawSnapshotWithConfirmedQuotes uses durable holding_cost_basis_cny instead of zero-locked holding_pnl", () => {
  const rawSnapshot = {
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 10000,
      effective_exposure_after_pending_sell: 10000,
      yesterday_profit: 0,
      holding_profit: 0,
      available_cash_cny: 1000,
      total_portfolio_assets_cny: 11000
    },
    cash_ledger: {
      available_cash_cny: 1000
    },
    positions: [
      {
        name: "测试基金A",
        code: "000001",
        symbol: "000001",
        fund_code: "000001",
        amount: 10000,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        holding_cost_basis_cny: 9000,
        confirmed_units: 5000,
        daily_pnl: 0,
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: []
  };

  const result = reconcileRawSnapshotWithConfirmedQuotes({
    rawSnapshot,
    quotes: [
      {
        code: "000001",
        name: "测试基金A",
        netValueDate: "2026-04-02",
        netValue: 2.2,
        growthRate: 10
      }
    ],
    asOfDate: "2026-04-02"
  });

  const position = result.rawSnapshot.positions[0];
  assert.equal(position.amount, 11000);
  assert.equal(position.holding_cost_basis_cny, 9000);
  assert.equal(position.holding_pnl, 2000);
  assert.equal(position.holding_pnl_rate_pct, 22.22);
});

test("reconcileRawSnapshotWithConfirmedQuotes accepts normal US QDII lag without flagging failure", () => {
  const rawSnapshot = {
    snapshot_date: "2026-04-02",
    summary: {
      total_fund_assets: 300,
      effective_exposure_after_pending_sell: 300,
      yesterday_profit: 0,
      holding_profit: 0,
      available_cash_cny: 100,
      total_portfolio_assets_cny: 400
    },
    cash_ledger: {
      available_cash_cny: 100
    },
    positions: [
      {
        name: "博时标普500ETF联接(QDII)C",
        code: "006075",
        symbol: "006075",
        fund_code: "006075",
        amount: 100,
        holding_pnl: 0,
        daily_pnl: 0,
        status: "active",
        execution_type: "OTC",
        category: "美股指数/QDII"
      },
      {
        name: "易方达沪深300ETF联接C",
        code: "007339",
        symbol: "007339",
        fund_code: "007339",
        amount: 200,
        holding_pnl: 0,
        daily_pnl: 0,
        status: "active",
        execution_type: "OTC",
        category: "A股宽基"
      }
    ],
    recognition_notes: []
  };

  const result = reconcileRawSnapshotWithConfirmedQuotes({
    rawSnapshot,
    quotes: [
      {
        code: "006075",
        name: "博时标普500ETF联接(QDII)C",
        netValueDate: "2026-04-01",
        netValue: 1.01,
        growthRate: 0.5
      },
      {
        code: "007339",
        name: "易方达沪深300ETF联接C",
        netValueDate: "2026-04-02",
        netValue: 1.02,
        growthRate: 0.4
      }
    ],
    asOfDate: "2026-04-02",
    assetMaster: {
      assets: [
        { symbol: "006075", market: "US", category: "美股指数/QDII" },
        { symbol: "007339", market: "CN", category: "A股宽基" }
      ]
    }
  });

  assert.equal(result.stats.fullyConfirmedForDate, false);
  assert.equal(result.stats.normalLagFundCount, 1);
  assert.equal(result.stats.lateMissingFundCount, 0);
  assert.equal(result.stats.sourceMissingFundCount, 0);
  assert.equal(result.stats.updatedPositions, 2);
  assert.deepEqual(result.stats.stalePositions, []);
});
