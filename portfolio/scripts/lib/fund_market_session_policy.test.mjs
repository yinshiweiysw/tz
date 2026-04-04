import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveFundMarketSessionPolicy,
  resolveFundQuoteSessionMode
} from "./fund_market_session_policy.mjs";

test("resolveFundMarketSessionPolicy uses 15:00 for domestic OTC funds by default", () => {
  const policy = resolveFundMarketSessionPolicy({
    asset: {
      name: "易方达沪深300ETF联接C",
      market: "CN",
      category: "A股宽基"
    }
  });

  assert.deepEqual(policy, {
    profile: "domestic",
    openTime: "09:30",
    closeTime: "15:00",
    timeZone: "Asia/Shanghai"
  });
});

test("resolveFundMarketSessionPolicy allows explicit close-time override for gold funds", () => {
  const policy = resolveFundMarketSessionPolicy({
    asset: {
      name: "国泰黄金ETF联接A",
      market: "GLB",
      category: "黄金",
      dashboard_close_time: "15:30"
    }
  });

  assert.deepEqual(policy, {
    profile: "gold",
    openTime: "09:30",
    closeTime: "15:30",
    timeZone: "Asia/Shanghai"
  });
});

test("resolveFundMarketSessionPolicy uses 16:10 for Hong Kong related funds", () => {
  const policy = resolveFundMarketSessionPolicy({
    asset: {
      name: "华夏恒生互联网科技业ETF联接(QDII)C",
      market: "HK",
      category: "港股科技/QDII"
    }
  });

  assert.deepEqual(policy, {
    profile: "hk",
    openTime: "09:30",
    closeTime: "16:10",
    timeZone: "Asia/Shanghai"
  });
});

test("resolveFundMarketSessionPolicy marks non-HK QDII funds as global_qdii", () => {
  const policy = resolveFundMarketSessionPolicy({
    asset: {
      name: "摩根纳斯达克100指数(QDII)人民币A",
      market: "US",
      category: "美股科技/QDII"
    }
  });

  assert.deepEqual(policy, {
    profile: "global_qdii",
    openTime: "09:30",
    closeTime: "15:00",
    timeZone: "Asia/Shanghai"
  });
});

test("resolveFundQuoteSessionMode treats same-day 04:00 qdii updates as prior-session carry not today's pnl", () => {
  const mode = resolveFundQuoteSessionMode({
    quoteDate: "2026-04-03",
    today: "2026-04-03",
    updateTime: "2026-04-03 04:00",
    now: new Date("2026-04-03T13:56:00+08:00"),
    sessionPolicy: {
      profile: "global_qdii",
      openTime: "09:30",
      closeTime: "15:00"
    }
  });

  assert.equal(mode, "confirmed_nav");
});
