import test from "node:test";
import assert from "node:assert/strict";

import { buildExchangeDashboardRow } from "./exchange_dashboard_row.mjs";

test("buildExchangeDashboardRow suppresses day pnl when quote is only previous-close reference", () => {
  const row = buildExchangeDashboardRow(
    {
      name: "港股ETF",
      ticker: "513100",
      shares: 10000,
      sellable_shares: 10000,
      cost_price: 1.5,
      amount: 15000
    },
    {
      market: "HK",
      category: "港股ETF"
    },
    {
      stockCode: "r_hkHSI",
      latestPrice: 1.68,
      previousClose: 1.7,
      changeValue: -0.02,
      changePercent: -1.18,
      quoteDate: "2026-04-02",
      quoteTime: "16:10:00"
    },
    {
      now: new Date("2026-04-03T10:00:00+08:00")
    }
  );

  assert.equal(row.quoteUsage, "previous_close_reference");
  assert.equal(row.isComparableToday, false);
  assert.equal(row.dailyPnl, null);
  assert.equal(row.changePercent, null);
});

test("buildExchangeDashboardRow keeps live day pnl when quote is comparable today", () => {
  const row = buildExchangeDashboardRow(
    {
      name: "纳指ETF",
      ticker: "513100",
      shares: 10000,
      sellable_shares: 10000,
      cost_price: 1.5,
      amount: 15000
    },
    {
      market: "CN",
      category: "美股代理ETF"
    },
    {
      stockCode: "513100",
      latestPrice: 1.68,
      previousClose: 1.7,
      changeValue: -0.02,
      changePercent: -1.18,
      quoteDate: "2026-04-03",
      quoteTime: "10:35:00"
    },
    {
      now: new Date("2026-04-03T10:36:00+08:00")
    }
  );

  assert.equal(row.quoteUsage, "live_today");
  assert.equal(row.isComparableToday, true);
  assert.equal(row.dailyPnl, -200);
  assert.equal(row.changePercent, -1.18);
});
