import test from "node:test";
import assert from "node:assert/strict";

import {
  createFundLookup,
  parseBuySpec,
  parseConversionSpec,
  parseSellSpec
} from "./manual_trade_recorder.mjs";
import { buildProposedTradesForGate } from "./manual_trade_gate_context.mjs";

function buildAssetMasterFixture() {
  return {
    fallback_bucket_key: "TACTICAL",
    buckets: {
      A_CORE: { label: "A股核心" },
      TACTICAL: { label: "战术刺客" }
    },
    bucket_mapping_rules: [
      {
        bucket_key: "A_CORE",
        category_equals: ["A股宽基"],
        name_patterns: ["沪深300"]
      },
      {
        bucket_key: "TACTICAL",
        category_equals: ["港股互联网/QDII"],
        name_patterns: ["恒生互联网"]
      }
    ],
    assets: [
      {
        symbol: "007339",
        name: "易方达沪深300ETF联接C",
        bucket: "A_CORE",
        theme_key: "CN_CORE_BETA"
      },
      {
        symbol: "023764",
        name: "华夏恒生互联网科技业ETF联接(QDII)D",
        bucket: "TACTICAL",
        theme_key: "HK_TECH"
      }
    ],
    themes: {
      CN_CORE_BETA: { label: "A股核心Beta" },
      HK_TECH: { label: "港股互联网科技" }
    },
    theme_mapping_rules: []
  };
}

test("buildProposedTradesForGate attaches bucket and theme metadata for buys, sells, and conversions", () => {
  const latestState = {
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        fund_code: "007339",
        category: "A股宽基",
        amount: 10000,
        status: "active"
      },
      {
        name: "华夏恒生互联网科技业ETF联接(QDII)D",
        fund_code: "023764",
        category: "港股互联网/QDII",
        amount: 10000,
        status: "active"
      }
    ]
  };
  const lookup = createFundLookup({
    positions: latestState.positions,
    pendingPositions: [],
    watchlistItems: []
  });

  const trades = buildProposedTradesForGate({
    buyItems: parseBuySpec("007339:8000"),
    sellItems: parseSellSpec("023764:5000"),
    conversionItems: parseConversionSpec("007339:4000->023764:4000"),
    lookup,
    latestState,
    assetMaster: buildAssetMasterFixture(),
    sellCashArrived: false
  });

  assert.deepEqual(
    trades.map((item) => ({
      type: item.type,
      fund_code: item.fund_code,
      bucket_key: item.bucket_key,
      theme_key: item.theme_key,
      cash_arrived: item.cash_arrived ?? null
    })),
    [
      {
        type: "buy",
        fund_code: "007339",
        bucket_key: "A_CORE",
        theme_key: "CN_CORE_BETA",
        cash_arrived: null
      },
      {
        type: "sell",
        fund_code: "023764",
        bucket_key: "TACTICAL",
        theme_key: "HK_TECH",
        cash_arrived: false
      },
      {
        type: "sell",
        fund_code: "007339",
        bucket_key: "A_CORE",
        theme_key: "CN_CORE_BETA",
        cash_arrived: null
      },
      {
        type: "buy",
        fund_code: "023764",
        bucket_key: "TACTICAL",
        theme_key: "HK_TECH",
        cash_arrived: null
      }
    ]
  );
});
