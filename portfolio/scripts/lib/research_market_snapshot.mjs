import { getStockQuote } from "../../../market-mcp/src/providers/stock.js";
import { annotateMarketQuote } from "./market_schedule_guard.mjs";

const SNAPSHOT_CONFIG = {
  a_share_indices: [
    { label: "上证指数", code: "000001.SH" },
    { label: "深证成指", code: "399001.SZ" }
  ],
  hong_kong_indices: [
    { label: "恒生指数", code: "hkHSI" },
    { label: "恒生科技", code: "hkHSTECH" }
  ],
  global_indices: [
    { label: "标普500", code: "usINX" },
    { label: "纳斯达克100", code: "usNDX" }
  ],
  commodities: [
    { label: "COMEX黄金", code: "hf_XAU" },
    { label: "WTI原油", code: "hf_CL" }
  ],
  rates_fx: [
    { label: "美元指数", code: "USDX" }
  ]
};

function buildMissingRow(item, now) {
  const annotated = annotateMarketQuote({
    code: item.code,
    quote: {},
    now
  });

  return {
    label: item.label,
    code: item.code,
    latest_price: null,
    pct_change: null,
    quote_time: null,
    quote_date: annotated.quote_date ?? null,
    market: annotated.market ?? null,
    market_status: annotated.market_status ?? null,
    market_trading_day: annotated.market_trading_day ?? null,
    quote_usage: "missing",
    is_live_today: false,
    market_note: annotated.market_note ?? null,
    fetch_status: "missing"
  };
}

async function fetchAndNormalizeRow(item, quoteFetcher, now) {
  try {
    const quote = await quoteFetcher(item.code);
    if (!quote) {
      return buildMissingRow(item, now);
    }

    const latestPrice = Number(quote.latestPrice);
    if (!Number.isFinite(latestPrice)) {
      return buildMissingRow(item, now);
    }

    const pctChange = Number(quote.changePercent);
    const annotated = annotateMarketQuote({
      code: item.code,
      quote,
      now
    });

    return {
      label: item.label,
      code: item.code,
      latest_price: latestPrice,
      pct_change: Number.isFinite(pctChange) ? pctChange : null,
      quote_time: quote.quoteTime ?? null,
      quote_date: annotated.quote_date ?? null,
      market: annotated.market ?? null,
      market_status: annotated.market_status ?? null,
      market_trading_day: annotated.market_trading_day ?? null,
      quote_usage: annotated.quote_usage ?? "live_or_unclassified",
      is_live_today: annotated.is_live_today ?? false,
      market_note: annotated.market_note ?? null,
      fetch_status: "ok"
    };
  } catch {
    return buildMissingRow(item, now);
  }
}

export async function buildResearchMarketSnapshot({
  quoteFetcher = getStockQuote,
  now = new Date()
} = {}) {
  const result = {};
  for (const [groupName, items] of Object.entries(SNAPSHOT_CONFIG)) {
    result[groupName] = await Promise.all(
      items.map((item) =>
        fetchAndNormalizeRow(
          item,
          quoteFetcher,
          now
        )
      )
    );
  }
  return result;
}
