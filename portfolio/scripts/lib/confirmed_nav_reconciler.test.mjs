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

test("reconcileRawSnapshotWithConfirmedQuotes upgrades legacy identity, stores confirmed units, and rewrites summary totals", () => {
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
  assert.ok(Number(position.confirmed_units) > 0);
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
