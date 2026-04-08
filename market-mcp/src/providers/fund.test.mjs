import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFundFallbackRequestOptions,
  buildFundPrimaryRequestOptions,
  getFundQuotes,
  mergeFundQuote
} from "./fund.js";
import { http } from "./http.js";

test("buildFundPrimaryRequestOptions caps the primary quote request timeout", () => {
  const options = buildFundPrimaryRequestOptions({ Fcodes: "016482,007339" });

  assert.equal(options.timeout, 5000);
  assert.deepEqual(options.params, { Fcodes: "016482,007339" });
});

test("buildFundFallbackRequestOptions caps optional fallback requests to a shorter timeout", () => {
  const options = buildFundFallbackRequestOptions({ rt: 123 }, "text");

  assert.equal(options.timeout, 3000);
  assert.equal(options.responseType, "text");
  assert.deepEqual(options.params, { rt: 123 });
});

test("mergeFundQuote separates confirmed nav from mirrored index-fund reference mode", () => {
  const merged = mergeFundQuote(
    "007339",
    {
      code: "007339",
      name: "易方达沪深300ETF联接C",
      netValueDate: "2026-04-07",
      netValue: 1.766,
      growthRate: 0
    },
    {
      code: "007339",
      name: "易方达沪深300ETF联接C",
      netValueDate: "2026-04-03",
      netValue: 1.766,
      valuation: 1.766,
      valuationChangePercent: 0,
      valuationTime: "2026-04-07 15:00"
    },
    null
  );

  assert.equal(merged.observationKind, "confirmed_only");
  assert.equal(merged.confirmedNavDate, "2026-04-07");
  assert.equal(merged.confirmedNav, 1.766);
  assert.equal(merged.intradayValuation, null);
  assert.equal(merged.intradayChangePercent, null);
  assert.equal(merged.valuation, null);
  assert.equal(merged.valuationChangePercent, null);
});

test("mergeFundQuote keeps trusted active-fund intraday estimates as observation data", () => {
  const merged = mergeFundQuote(
    "001917",
    {
      code: "001917",
      name: "招商量化精选股票A",
      netValueDate: "2026-04-07",
      netValue: 3.5001,
      growthRate: 0.67
    },
    {
      code: "001917",
      name: "招商量化精选股票A",
      netValueDate: "2026-04-03",
      netValue: 3.4767,
      valuation: 3.5074,
      valuationChangePercent: 0.88,
      valuationTime: "2026-04-07 15:00"
    },
    null
  );

  assert.equal(merged.observationKind, "intraday_estimate");
  assert.equal(merged.confirmedNavDate, "2026-04-07");
  assert.equal(merged.confirmedNav, 3.5001);
  assert.equal(merged.intradayValuation, 3.5074);
  assert.equal(merged.intradayChangePercent, 0.88);
  assert.equal(merged.valuation, 3.5074);
  assert.equal(merged.valuationChangePercent, 0.88);
});

test("getFundQuotes limits fallback concurrency across legacy and history sources", async () => {
  const originalGet = http.get;
  let activeFallback = 0;
  let maxFallback = 0;

  http.get = async (url) => {
    if (String(url).includes("FundMNFInfo")) {
      return { data: { Datas: [] } };
    }

    activeFallback += 1;
    maxFallback = Math.max(maxFallback, activeFallback);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeFallback -= 1;

    if (String(url).includes("fundgz.1234567.com.cn")) {
      const code = String(url).match(/\/js\/(\d+)\.js/)?.[1] ?? "000000";
      return {
        data: `jsonpgz({"name":"基金${code}","fundcode":"${code}","dwjz":"1.0000","gsz":"1.0100","gszzl":"1.00","gztime":"2026-04-07 14:30"});`
      };
    }

    const code = String(url).match(/\/(\d+)\.js/)?.[1] ?? "000000";
    return {
      data: `var fS_name = "基金${code}"; var Data_netWorthTrend = [{"x":1775491200000,"y":1.0}];`
    };
  };

  try {
    const quotes = await getFundQuotes(["000001", "000002", "000003", "000004", "000005", "000006"]);
    assert.equal(quotes.length, 6);
    assert.ok(maxFallback <= 5, `expected shared fallback concurrency <= 5, got ${maxFallback}`);
  } finally {
    http.get = originalGet;
  }
});

test("getFundQuotes records primary source failures in sourceDiagnostics", async () => {
  const originalGet = http.get;

  http.get = async (url) => {
    if (String(url).includes("FundMNFInfo")) {
      throw new Error("primary upstream timeout");
    }
    if (String(url).includes("fundgz.1234567.com.cn")) {
      return {
        data: 'jsonpgz({"name":"测试基金","fundcode":"016482","dwjz":"1.0020","gsz":"1.0030","gszzl":"0.10","gztime":"2026-04-07 14:30"});'
      };
    }
    return {
      data: 'var fS_name = "测试基金"; var Data_netWorthTrend = [{"x":1775491200000,"y":1.0020}];'
    };
  };

  try {
    const [quote] = await getFundQuotes(["016482"]);
    assert.match(String(quote?.sourceDiagnostics?.primary?.error ?? ""), /timeout/i);
  } finally {
    http.get = originalGet;
  }
});
