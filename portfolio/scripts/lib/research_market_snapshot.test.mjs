import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchMarketSnapshot } from "./research_market_snapshot.mjs";

test("buildResearchMarketSnapshot normalizes quote payloads into coverage groups", async () => {
  const now = new Date("2026-04-02T10:00:00.000Z");
  const mockQuoteFetcher = async (code) => ({
    stockCode: code,
    latestPrice: 100,
    changePercent: 1.23,
    quoteTime: "2026-04-02 18:00:00"
  });

  const snapshot = await buildResearchMarketSnapshot({
    quoteFetcher: mockQuoteFetcher,
    now
  });

  const expectedGroups = [
    "a_share_indices",
    "hong_kong_indices",
    "global_indices",
    "commodities",
    "rates_fx"
  ];
  assert.deepEqual(Object.keys(snapshot), expectedGroups);

  for (const group of expectedGroups) {
    const rows = snapshot[group];
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(typeof row.label, "string");
      assert.equal(typeof row.code, "string");
      assert.equal(row.latest_price, 100);
      assert.equal(row.pct_change, 1.23);
      assert.equal(row.quote_time, "2026-04-02 18:00:00");
      assert.equal(row.fetch_status, "ok");
    }
  }

  assert.deepEqual(
    snapshot.rates_fx.map((item) => item.code),
    ["USDX"]
  );
});

test("buildResearchMarketSnapshot keeps missing rows when quote fetch fails", async () => {
  const now = new Date("2026-04-02T10:00:00.000Z");
  const mockQuoteFetcher = async (code) => {
    if (code === "USDX") {
      return null;
    }
    if (code === "usINX") {
      throw new Error("upstream down");
    }
    return {
      stockCode: code,
      latestPrice: 200,
      changePercent: -0.5,
      quoteTime: "2026-04-02 18:10:00"
    };
  };

  const snapshot = await buildResearchMarketSnapshot({
    quoteFetcher: mockQuoteFetcher,
    now
  });

  const usdxRow = snapshot.rates_fx.find((item) => item.code === "USDX");
  assert.ok(usdxRow);
  assert.equal(usdxRow.fetch_status, "missing");
  assert.equal(usdxRow.latest_price, null);
  assert.equal(usdxRow.pct_change, null);
  assert.equal(usdxRow.quote_time, null);

  const spxRow = snapshot.global_indices.find((item) => item.code === "usINX");
  assert.ok(spxRow);
  assert.equal(spxRow.fetch_status, "missing");
  assert.equal(spxRow.latest_price, null);
  assert.equal(spxRow.pct_change, null);
  assert.equal(spxRow.quote_time, null);

  const aShareOkRows = snapshot.a_share_indices.filter((item) => item.fetch_status === "ok");
  assert.ok(aShareOkRows.length > 0);
});

test("buildResearchMarketSnapshot treats quote without usable latestPrice as missing", async () => {
  const now = new Date("2026-04-02T10:00:00.000Z");
  const mockQuoteFetcher = async (code) => {
    if (code === "USDX") {
      return {
        stockCode: code,
        changePercent: 0.15,
        quoteTime: "2026-04-02 18:20:00"
      };
    }

    return {
      stockCode: code,
      latestPrice: 123.45,
      changePercent: 0.1,
      quoteTime: "2026-04-02 18:20:00"
    };
  };

  const snapshot = await buildResearchMarketSnapshot({
    quoteFetcher: mockQuoteFetcher,
    now
  });

  const usdIndexRow = snapshot.rates_fx.find((item) => item.code === "USDX");
  assert.ok(usdIndexRow);
  assert.equal(usdIndexRow.fetch_status, "missing");
  assert.equal(usdIndexRow.latest_price, null);
  assert.equal(usdIndexRow.pct_change, null);
  assert.equal(usdIndexRow.quote_time, null);
});

test("buildResearchMarketSnapshot marks Hong Kong holiday quotes as previous-close references", async () => {
  const now = new Date("2026-04-03T10:00:00+08:00");
  const mockQuoteFetcher = async (code) => ({
    stockCode: code,
    latestPrice: 100,
    changePercent: -0.7,
    quoteTime: code.startsWith("hk") || code.startsWith("r_hk") ? "2026-04-02 16:10:00" : "2026-04-03 10:00:00"
  });

  const snapshot = await buildResearchMarketSnapshot({
    quoteFetcher: mockQuoteFetcher,
    now
  });

  const hsi = snapshot.hong_kong_indices.find((item) => item.code === "hkHSI");
  assert.ok(hsi);
  assert.equal(hsi.market_status, "holiday_closed");
  assert.equal(hsi.quote_usage, "previous_close_reference");
  assert.equal(hsi.is_live_today, false);
});
