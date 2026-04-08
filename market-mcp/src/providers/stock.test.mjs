import test from "node:test";
import assert from "node:assert/strict";

import { http } from "./http.js";
import { getStockQuote } from "./stock.js";

test("getStockQuote includes Eastmoney quote timestamp when f124 is present", async () => {
  const originalGet = http.get;
  let capturedFields = "";
  http.get = async (_url, options = {}) => {
    capturedFields = String(options?.params?.fields ?? "");
    return {
    data: {
      data: {
        f57: "000001",
        f58: "上证指数",
        f43: 398722,
        f44: 399500,
        f45: 397000,
        f46: 397800,
        f47: 123456,
        f48: 654321,
        f60: 388000,
        f169: 9722,
        f170: 250,
        f171: 350,
        f168: 123,
        f162: 1500,
        f124: 1775634660
      }
    }
    };
  };

  try {
    const quote = await getStockQuote("000001.SH");
    assert.equal(capturedFields.includes("f124"), true);
    assert.equal(quote.quoteDate, "2026-04-08");
    assert.equal(quote.quoteTime, "2026-04-08 15:51:00");
  } finally {
    http.get = originalGet;
  }
});

test("getStockQuote falls back to observed fetch time when Eastmoney timestamp is missing for CN quotes", async () => {
  const originalGet = http.get;
  const OriginalDate = Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super("2026-04-08T14:20:00+08:00");
        return;
      }
      super(...args);
    }
    static now() {
      return new OriginalDate("2026-04-08T14:20:00+08:00").getTime();
    }
  };

  http.get = async () => ({
    data: {
      data: {
        f57: "000001",
        f58: "上证指数",
        f43: 398722,
        f44: 399500,
        f45: 397000,
        f46: 397800,
        f47: 123456,
        f48: 654321,
        f60: 388000,
        f169: 9722,
        f170: 250,
        f171: 350,
        f168: 123,
        f162: 1500,
        f124: 0
      }
    }
  });

  try {
    const quote = await getStockQuote("000001.SH");
    assert.equal(quote.quoteDate, "2026-04-08");
    assert.equal(quote.quoteTime, "2026-04-08 14:20:00");
  } finally {
    globalThis.Date = OriginalDate;
    http.get = originalGet;
  }
});
