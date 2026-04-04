import { normalizeExchangeQuoteCode } from "./exchange_quotes.mjs";
import {
  annotateMarketQuote,
  isComparableQuoteUsage
} from "./market_schedule_guard.mjs";

function toNumberOrNull(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : null;
}

export function buildExchangeDashboardRow(position, assetConfig, quote, { now = new Date() } = {}) {
  const ticker =
    String(
      position?.ticker ??
        assetConfig?.ticker ??
        position?.symbol ??
        assetConfig?.symbol ??
        position?.code ??
        ""
    )
      .trim()
      .toUpperCase() || null;
  const shares = Number(position?.shares ?? 0);
  const sellableShares = Number(position?.sellable_shares ?? 0);
  const costPrice = toNumberOrNull(position?.cost_price, 4);
  const annotatedQuote =
    quote && ticker
      ? annotateMarketQuote({
          code: ticker,
          quote,
          market: position?.market ?? assetConfig?.market ?? null,
          now
        })
      : quote ?? null;
  const lastPrice = toNumberOrNull(annotatedQuote?.latestPrice, 4);
  const previousClose = toNumberOrNull(annotatedQuote?.previousClose, 4);
  const marketValue =
    Number.isFinite(shares) && Number.isFinite(lastPrice)
      ? toNumberOrNull(shares * lastPrice)
      : toNumberOrNull(position?.amount);
  const costBasis =
    Number.isFinite(shares) && Number.isFinite(costPrice)
      ? toNumberOrNull(shares * costPrice)
      : null;
  const unrealizedPnl =
    Number.isFinite(marketValue) && Number.isFinite(costBasis)
      ? toNumberOrNull(marketValue - costBasis)
      : toNumberOrNull(position?.holding_pnl);
  const unrealizedPnlPct =
    Number.isFinite(unrealizedPnl) && Number.isFinite(costBasis) && costBasis > 0
      ? toNumberOrNull((unrealizedPnl / costBasis) * 100)
      : null;
  const quoteUsage = String(annotatedQuote?.quote_usage ?? "").trim() || "unavailable";
  const isComparableToday = isComparableQuoteUsage(quoteUsage);
  const dailyPnl =
    isComparableToday && Number.isFinite(shares) && Number.isFinite(Number(annotatedQuote?.changeValue))
      ? toNumberOrNull(shares * Number(annotatedQuote.changeValue))
      : null;
  const changePercent = isComparableToday
    ? toNumberOrNull(annotatedQuote?.changePercent)
    : null;
  const quoteTimestamp =
    annotatedQuote?.quoteDate && annotatedQuote?.quoteTime
      ? `${annotatedQuote.quoteDate} ${annotatedQuote.quoteTime}`
      : annotatedQuote?.quoteDate ?? annotatedQuote?.quoteTime ?? null;

  return {
    name: position?.name ?? assetConfig?.name ?? ticker ?? "未命名证券",
    symbol: ticker,
    exchangeQuoteCode: normalizeExchangeQuoteCode(ticker),
    category: position?.category ?? assetConfig?.category ?? "--",
    market: position?.market ?? assetConfig?.market ?? "CN",
    shares: Number.isFinite(shares) ? shares : 0,
    sellableShares: Number.isFinite(sellableShares) ? sellableShares : 0,
    costPrice,
    lastPrice,
    previousClose,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct,
    dailyPnl,
    changePercent,
    settlementRule: position?.settlement_rule ?? assetConfig?.settlement_rule ?? "--",
    lotSize: Number(position?.lot_size ?? assetConfig?.lot_size ?? 100),
    signalProxySymbol: position?.signal_proxy_symbol ?? assetConfig?.signal_proxy_symbol ?? null,
    slippageBuffer: toNumberOrNull(position?.slippage_buffer ?? assetConfig?.slippage_buffer, 4),
    quoteTimestamp,
    quoteSource: annotatedQuote?.source ?? null,
    quoteAvailable: Number.isFinite(Number(lastPrice)),
    positionState: shares > 0 ? "invested" : "shell",
    quoteUsage,
    marketNote: annotatedQuote?.market_note ?? null,
    isComparableToday
  };
}
