import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { getStockQuote } from "../../../market-mcp/src/providers/stock.js";
import { buildPortfolioPath, resolvePortfolioRoot } from "./account_root.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./atomic_json_state.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./manifest_state.mjs";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SYMBOLS = ["ASHR", "QQQ", "SOXX", "KWEB", "ARKK"];

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function parseDateText(value) {
  const text = trimText(value)?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  if (!text) {
    return null;
  }
  const date = new Date(`${text}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : { text, date };
}

function diffCalendarDays(leftText, rightText) {
  const left = parseDateText(leftText);
  const right = parseDateText(rightText);
  if (!left || !right) {
    return null;
  }
  return Math.round((right.date.getTime() - left.date.getTime()) / 86_400_000);
}

function formatDateText(date) {
  return date.toISOString().slice(0, 10);
}

function previousWeekdayText(dateText) {
  const parsed = parseDateText(dateText);
  if (!parsed) {
    return null;
  }
  const date = new Date(parsed.date.getTime());
  do {
    date.setUTCDate(date.getUTCDate() - 1);
  } while ([0, 6].includes(date.getUTCDay()));
  return formatDateText(date);
}

function normalizeSymbols(symbols = DEFAULT_SYMBOLS) {
  return [
    ...new Set(
      (Array.isArray(symbols) ? symbols : String(symbols ?? "").split(","))
        .map((item) => String(item ?? "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
}

function providerCodeForSymbol(symbol) {
  const normalized = String(symbol ?? "").trim().toUpperCase();
  return /^US/.test(normalized) ? normalized : `US${normalized}`;
}

function classifyQuoteTier({ price, pctChange, quoteTime, now = new Date() } = {}) {
  if (toFiniteNumber(price) === null && toFiniteNumber(pctChange) === null) {
    return "missing";
  }
  const today = formatShanghaiDate(now);
  const quoteDate = parseDateText(quoteTime)?.text ?? null;
  if (quoteDate === today) {
    return "live";
  }
  const lagDays = quoteDate ? diffCalendarDays(quoteDate, today) : null;
  if (lagDays !== null && lagDays >= 0 && lagDays <= 1) {
    return "delayed";
  }
  return "reference_close";
}

function labelQuoteFreshness({ quoteTier, quoteTime, now = new Date() } = {}) {
  const tier = trimText(quoteTier) ?? "missing";
  if (tier === "missing") {
    return {
      stalenessLabel: "missing",
      displayLabel: "行情缺失"
    };
  }
  if (tier === "live") {
    return {
      stalenessLabel: "same_day",
      displayLabel: "实时行情"
    };
  }
  if (tier === "delayed") {
    return {
      stalenessLabel: "delayed",
      displayLabel: "延迟行情"
    };
  }
  const today = formatShanghaiDate(now);
  const quoteDate = parseDateText(quoteTime)?.text ?? null;
  if (quoteDate && quoteDate === previousWeekdayText(today)) {
    return {
      stalenessLabel: "previous_trading_day",
      displayLabel: "上一交易日参考 · 非实时"
    };
  }
  return {
    stalenessLabel: "reference_close",
    displayLabel: "前收参考 · 非实时"
  };
}

function normalizeQuote({ symbol, quote = {}, now = new Date() } = {}) {
  const price = toFiniteNumber(quote?.latestPrice ?? quote?.price);
  const pctChange = toFiniteNumber(quote?.changePercent ?? quote?.pctChange);
  const quoteTime = trimText(quote?.quoteTime) ?? trimText(quote?.quoteDate);
  const quoteTier = classifyQuoteTier({ price, pctChange, quoteTime, now });
  const freshness = labelQuoteFreshness({ quoteTier, quoteTime, now });
  return {
    symbol,
    price,
    pctChange,
    quoteTime,
    quoteTier,
    stalenessLabel: freshness.stalenessLabel,
    displayLabel: freshness.displayLabel,
    source: trimText(quote?.source) ?? "market_mcp_stock",
    error: null
  };
}

function missingQuote(symbol, error) {
  return {
    symbol,
    price: null,
    pctChange: null,
    quoteTime: null,
    quoteTier: "missing",
    stalenessLabel: "missing",
    displayLabel: "行情缺失",
    source: null,
    error: trimText(error) ?? "quote_missing"
  };
}

function summarizeCoverage(quotes = []) {
  const counts = {
    live: 0,
    delayed: 0,
    reference_close: 0,
    missing: 0,
    total: quotes.length
  };
  for (const quote of quotes) {
    const tier = trimText(quote?.quoteTier) ?? "missing";
    if (Object.prototype.hasOwnProperty.call(counts, tier)) {
      counts[tier] += 1;
    } else {
      counts.missing += 1;
    }
  }
  return counts;
}

function isSnapshotFresh(snapshot = {}, now = new Date(), ttlMs = DEFAULT_TTL_MS) {
  const generatedAt = trimText(snapshot?.generatedAt);
  if (!generatedAt) {
    return false;
  }
  const date = new Date(generatedAt);
  return !Number.isNaN(date.getTime()) && now.getTime() - date.getTime() <= ttlMs;
}

export function resolveMarketProxyQuotePaths(portfolioRoot = resolvePortfolioRoot(), manifest = {}) {
  const canonical = manifest?.canonical_entrypoints ?? {};
  return {
    quoteSnapshotPath:
      canonical.latest_market_proxy_quote_snapshot ??
      buildPortfolioPath(portfolioRoot, "data", "market_proxy_quote_snapshot.json"),
    marketLakeDbPath:
      canonical.market_lake_db ??
      buildPortfolioPath(portfolioRoot, "data", "market_lake.db")
  };
}

function readReferenceQuotesFromMarketLake({ dbPath, symbols = [], now = new Date(), spawnSyncFn = spawnSync } = {}) {
  if (!dbPath || !existsSync(dbPath) || symbols.length === 0) {
    return new Map();
  }
  const safeSymbols = normalizeSymbols(symbols).filter((symbol) => /^[A-Z0-9._-]+$/.test(symbol));
  if (safeSymbols.length === 0) {
    return new Map();
  }
  const quotedSymbols = safeSymbols.map((symbol) => `'${symbol.replaceAll("'", "''")}'`).join(",");
  const sql = `
WITH ranked AS (
  SELECT symbol, date, close,
    LAG(close) OVER (PARTITION BY symbol ORDER BY date) AS prev_close,
    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
  FROM daily_prices
  WHERE symbol IN (${quotedSymbols})
)
SELECT symbol, date, close, prev_close FROM ranked WHERE rn = 1;
`;
  const result = spawnSyncFn("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    timeout: 3000
  });
  if (result.error || result.status !== 0) {
    return new Map();
  }
  try {
    const rows = JSON.parse(String(result.stdout ?? "[]"));
    return new Map(
      rows.map((row) => {
        const price = toFiniteNumber(row?.close);
        const previousClose = toFiniteNumber(row?.prev_close);
        const pctChange =
          price !== null && previousClose
            ? Math.round(((price - previousClose) / previousClose) * 10000) / 100
            : null;
        return [
          String(row?.symbol ?? "").toUpperCase(),
          {
            symbol: String(row?.symbol ?? "").toUpperCase(),
            price,
            pctChange,
            quoteTime: trimText(row?.date),
            quoteTier: "reference_close",
            ...labelQuoteFreshness({
              quoteTier: "reference_close",
              quoteTime: trimText(row?.date),
              now
            }),
            source: "market_lake_daily_prices",
            error: null
          }
        ];
      })
    );
  } catch {
    return new Map();
  }
}

export async function refreshMarketProxyQuotes({
  portfolioRoot = resolvePortfolioRoot(),
  symbols = DEFAULT_SYMBOLS,
  ttlMs = DEFAULT_TTL_MS,
  force = false,
  now = new Date(),
  quoteFetcher = getStockQuote,
  spawnSyncFn = spawnSync
} = {}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const paths = resolveMarketProxyQuotePaths(portfolioRoot, manifest);
  const normalizedSymbols = normalizeSymbols(symbols);
  const existing = await readJsonOrDefault(paths.quoteSnapshotPath, null);
  if (!force && existing && isSnapshotFresh(existing, now, ttlMs)) {
    return {
      ...existing,
      status: "skipped_fresh",
      refreshed: false
    };
  }

  const referenceQuotes = readReferenceQuotesFromMarketLake({
    dbPath: paths.marketLakeDbPath,
    symbols: normalizedSymbols,
    now,
    spawnSyncFn
  });

  const quotes = [];
  for (const symbol of normalizedSymbols) {
    try {
      const quote = await quoteFetcher(providerCodeForSymbol(symbol), symbol);
      const normalized = normalizeQuote({ symbol, quote, now });
      if (normalized.quoteTier === "missing" && referenceQuotes.has(symbol)) {
        quotes.push(referenceQuotes.get(symbol));
      } else {
        quotes.push(normalized);
      }
    } catch (error) {
      quotes.push(referenceQuotes.get(symbol) ?? missingQuote(symbol, error?.message ?? error));
    }
  }

  const payload = {
    generatedAt: now.toISOString(),
    asOf: formatShanghaiDate(now),
    ttlMs,
    status: quotes.some((item) => item.quoteTier !== "missing") ? "ready" : "missing",
    refreshed: true,
    symbols: normalizedSymbols,
    coverage: summarizeCoverage(quotes),
    quotes
  };
  await writeJsonAtomic(paths.quoteSnapshotPath, payload);
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      latest_market_proxy_quote_snapshot: paths.quoteSnapshotPath
    }
  });
  return payload;
}

export async function loadMarketProxyQuoteSnapshot({
  portfolioRoot = resolvePortfolioRoot(),
  manifest = null
} = {}) {
  const resolvedManifest = manifest ?? (await readManifestState(buildPortfolioPath(portfolioRoot, "state-manifest.json")));
  const paths = resolveMarketProxyQuotePaths(portfolioRoot, resolvedManifest);
  return readJsonOrDefault(paths.quoteSnapshotPath, null);
}
