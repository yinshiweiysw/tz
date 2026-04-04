import test from "node:test";
import assert from "node:assert/strict";

import {
  annotateMarketQuote,
  classifyExchangeClock,
  formatMarketQuoteLine,
  getComparableChangePercent
} from "./market_schedule_guard.mjs";

test("classifyExchangeClock marks Hong Kong as holiday closed on Good Friday 2026", () => {
  const result = classifyExchangeClock({
    market: "HK",
    now: new Date("2026-04-03T10:00:00+08:00")
  });

  assert.equal(result.market, "HK");
  assert.equal(result.isTradingDay, false);
  assert.equal(result.marketStatus, "holiday_closed");
});

test("annotateMarketQuote downgrades Hong Kong holiday data to previous-close reference", () => {
  const result = annotateMarketQuote({
    code: "r_hkHSI",
    quote: {
      stockCode: "r_hkHSI",
      latestPrice: 25116.53,
      changePercent: -0.7,
      quoteTime: "2026-04-02 16:10:00"
    },
    now: new Date("2026-04-03T10:00:00+08:00")
  });

  assert.equal(result.market, "HK");
  assert.equal(result.market_status, "holiday_closed");
  assert.equal(result.quote_date, "2026-04-02");
  assert.equal(result.quote_usage, "previous_close_reference");
  assert.equal(result.is_live_today, false);
});

test("formatMarketQuoteLine labels closed-market quotes as previous trading close references", () => {
  const quote = annotateMarketQuote({
    code: "r_hkHSI",
    quote: {
      stockCode: "r_hkHSI",
      latestPrice: 25116.53,
      changePercent: -0.7,
      quoteTime: "2026-04-02 16:10:00"
    },
    now: new Date("2026-04-03T10:00:00+08:00")
  });

  assert.equal(
    formatMarketQuoteLine("恒生指数", quote),
    "- 恒生指数：休市（上一交易日收盘 25116.53，-0.7%）"
  );
});

test("getComparableChangePercent ignores previous-close references for same-day tone calculations", () => {
  const quote = annotateMarketQuote({
    code: "r_hkHSTECH",
    quote: {
      stockCode: "r_hkHSTECH",
      latestPrice: 4679.1,
      changePercent: -1.63,
      quoteTime: "2026-04-02 16:10:00"
    },
    now: new Date("2026-04-03T10:00:00+08:00")
  });

  assert.equal(getComparableChangePercent(quote), null);
  assert.equal(getComparableChangePercent(quote, { includeReferenceClose: true }), -1.63);
});
