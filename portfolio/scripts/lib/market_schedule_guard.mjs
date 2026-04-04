import { readFileSync } from "node:fs";

const CN_HOLIDAY_PAYLOAD = JSON.parse(
  readFileSync(new URL("../../../funds/holiday.json", import.meta.url), "utf8")
);

const HK_HOLIDAY_DATES = {
  "2025": [
    "2025-01-01",
    "2025-01-29",
    "2025-01-30",
    "2025-01-31",
    "2025-04-04",
    "2025-04-18",
    "2025-04-21",
    "2025-05-01",
    "2025-05-05",
    "2025-05-31",
    "2025-07-01",
    "2025-10-01",
    "2025-10-07",
    "2025-10-29",
    "2025-12-25",
    "2025-12-26"
  ],
  "2026": [
    "2026-01-01",
    "2026-02-17",
    "2026-02-18",
    "2026-02-19",
    "2026-04-03",
    "2026-04-06",
    "2026-04-07",
    "2026-05-01",
    "2026-05-25",
    "2026-06-19",
    "2026-07-01",
    "2026-09-26",
    "2026-10-01",
    "2026-10-19",
    "2026-12-25"
  ]
};

const US_HOLIDAY_DATES = {
  "2025": [
    "2025-01-01",
    "2025-01-20",
    "2025-02-17",
    "2025-04-18",
    "2025-05-26",
    "2025-06-19",
    "2025-07-04",
    "2025-09-01",
    "2025-11-27",
    "2025-12-25"
  ],
  "2026": [
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25"
  ]
};

const MARKET_TIMEZONES = {
  CN_A: "Asia/Shanghai",
  HK: "Asia/Hong_Kong",
  US: "America/New_York"
};

const MARKET_TRADING_WINDOWS = {
  CN_A: [
    { startMinutes: 9 * 60 + 30, endMinutes: 11 * 60 + 30 },
    { startMinutes: 13 * 60, endMinutes: 15 * 60 }
  ],
  HK: [
    { startMinutes: 9 * 60 + 30, endMinutes: 12 * 60 },
    { startMinutes: 13 * 60, endMinutes: 16 * 60 }
  ],
  US: [
    { startMinutes: 9 * 60 + 30, endMinutes: 16 * 60 },
    { startMinutes: 16 * 60, endMinutes: 16 * 60 }
  ]
};

function getLocalParts(now, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  });

  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: parts.weekday,
    totalMinutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function isWeekendWeekday(weekday) {
  return weekday === "Sat" || weekday === "Sun";
}

function isCnHoliday(localDate) {
  const [year, month, day] = String(localDate ?? "").split("-");
  const yearData = CN_HOLIDAY_PAYLOAD?.data?.[year];
  if (!yearData) {
    return false;
  }

  return yearData?.[`${month}-${day}`]?.holiday === true;
}

function isHkHoliday(localDate) {
  const year = String(localDate ?? "").slice(0, 4);
  return (HK_HOLIDAY_DATES[year] ?? []).includes(localDate);
}

function isUsHoliday(localDate) {
  const year = String(localDate ?? "").slice(0, 4);
  return (US_HOLIDAY_DATES[year] ?? []).includes(localDate);
}

function resolveMarket(rawMarket) {
  const market = String(rawMarket ?? "").trim().toUpperCase();
  return MARKET_TIMEZONES[market] ? market : null;
}

function normalizeMarketHint(rawMarket) {
  const market = String(rawMarket ?? "").trim().toUpperCase();
  if (!market) {
    return null;
  }

  if (["CN", "CN_A", "ASHARE", "A_SHARE"].includes(market)) {
    return "CN_A";
  }
  if (["HK", "HONGKONG", "HONG_KONG"].includes(market)) {
    return "HK";
  }
  if (["US", "USA", "NASDAQ", "NYSE", "GLB", "GLOBAL"].includes(market)) {
    return "US";
  }

  return resolveMarket(market);
}

export function inferMarketFromCode(rawCode) {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (!code) {
    return null;
  }

  if (
    code.startsWith("R_HK") ||
    code.startsWith("HK") ||
    code.endsWith(".HK")
  ) {
    return "HK";
  }

  if (
    code.endsWith(".SH") ||
    code.endsWith(".SZ") ||
    code.endsWith(".BJ") ||
    /^(SH|SZ|BJ)\d{6}$/i.test(code) ||
    /^\d{6}$/.test(code)
  ) {
    return "CN_A";
  }

  if (
    code.endsWith(".US") ||
    code.startsWith("US") ||
    /^[A-Z]{1,6}$/.test(code)
  ) {
    return "US";
  }

  return null;
}

export function parseQuoteDate(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return null;
  }

  const isoLike = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`;
  }

  const slashLike = value.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (slashLike) {
    return `${slashLike[1]}-${slashLike[2]}-${slashLike[3]}`;
  }

  return null;
}

function classifyIntradayWindow(totalMinutes, windows) {
  const [morning, afternoon] = windows;
  if (totalMinutes < morning.startMinutes) {
    return "pre_open";
  }
  if (totalMinutes < morning.endMinutes) {
    return "open";
  }
  if (totalMinutes < afternoon.startMinutes) {
    return "lunch_break";
  }
  if (totalMinutes < afternoon.endMinutes) {
    return "open";
  }
  return "post_close";
}

export function classifyExchangeClock({ market, now = new Date() } = {}) {
  const normalizedMarket = normalizeMarketHint(market);
  if (!normalizedMarket) {
    return {
      market: null,
      localDate: null,
      localTime: null,
      isTradingDay: null,
      marketStatus: "external"
    };
  }

  const timeZone = MARKET_TIMEZONES[normalizedMarket];
  const { localDate, localTime, weekday, totalMinutes } = getLocalParts(now, timeZone);

  if (isWeekendWeekday(weekday)) {
    return {
      market: normalizedMarket,
      localDate,
      localTime,
      isTradingDay: false,
      marketStatus: "weekend_closed"
    };
  }

  const holiday =
    normalizedMarket === "CN_A"
      ? isCnHoliday(localDate)
      : normalizedMarket === "HK"
        ? isHkHoliday(localDate)
        : isUsHoliday(localDate);
  if (holiday) {
    return {
      market: normalizedMarket,
      localDate,
      localTime,
      isTradingDay: false,
      marketStatus: "holiday_closed"
    };
  }

  return {
    market: normalizedMarket,
    localDate,
    localTime,
    isTradingDay: true,
    marketStatus: classifyIntradayWindow(totalMinutes, MARKET_TRADING_WINDOWS[normalizedMarket])
  };
}

export function isTradingDateForMarket({ market, date }) {
  const normalizedMarket = normalizeMarketHint(market);
  const localDate = parseQuoteDate(date);
  if (!normalizedMarket || !localDate) {
    return false;
  }

  const base = new Date(`${localDate}T12:00:00Z`);
  if (!Number.isFinite(base.getTime())) {
    return false;
  }

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIMEZONES[normalizedMarket],
    weekday: "short"
  }).format(base);
  if (isWeekendWeekday(weekday)) {
    return false;
  }

  if (normalizedMarket === "CN_A") {
    return !isCnHoliday(localDate);
  }
  if (normalizedMarket === "HK") {
    return !isHkHoliday(localDate);
  }
  return !isUsHoliday(localDate);
}

export function findLatestTradingDateOnOrBefore({ market, date }) {
  const normalizedMarket = normalizeMarketHint(market);
  let cursor = parseQuoteDate(date);
  if (!normalizedMarket || !cursor) {
    return null;
  }

  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (isTradingDateForMarket({ market: normalizedMarket, date: cursor })) {
      return cursor;
    }
    const base = new Date(`${cursor}T12:00:00+08:00`);
    base.setUTCDate(base.getUTCDate() - 1);
    cursor = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(base);
  }

  return cursor;
}

export function findPreviousTradingDateBefore({ market, date }) {
  const current = parseQuoteDate(date);
  if (!current) {
    return null;
  }
  const base = new Date(`${current}T12:00:00+08:00`);
  base.setUTCDate(base.getUTCDate() - 1);
  const previousDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(base);
  return findLatestTradingDateOnOrBefore({ market, date: previousDate });
}

export function isComparableQuoteUsage(quoteUsage) {
  return ["live_today", "same_day_close", "same_day_reference"].includes(
    String(quoteUsage ?? "").trim()
  );
}

export function annotateMarketQuote({ code, quote = {}, market: marketHint = null, now = new Date() } = {}) {
  const market =
    normalizeMarketHint(marketHint) ??
    inferMarketFromCode(code ?? quote?.stockCode ?? quote?.quoteCode);
  const clock = classifyExchangeClock({ market, now });
  const quoteDate = parseQuoteDate(quote?.quoteDate ?? quote?.quoteTime ?? null);
  const tradingDay = clock.isTradingDay;
  const marketStatus = clock.marketStatus;

  let quoteUsage = "live_or_unclassified";
  let isLiveToday = true;
  let note = null;

  if (market) {
    if (tradingDay === false) {
      quoteUsage = quoteDate && quoteDate < clock.localDate
        ? "previous_close_reference"
        : "closed_market_reference";
      isLiveToday = false;
      note = "市场休市，以下仅可视为上一交易日或最后可用收盘参考。";
    } else if (marketStatus === "open") {
      if (quoteDate && quoteDate !== clock.localDate) {
        quoteUsage = "stale";
        isLiveToday = false;
        note = "市场已开市，但当前返回的并非当日行情。";
      } else if (!quoteDate) {
        quoteUsage = "unknown_live_status";
        isLiveToday = false;
        note = "行情缺少当日时间戳，不能确认是否为今盘。";
      } else {
        quoteUsage = "live_today";
      }
    } else if (marketStatus === "pre_open" || marketStatus === "post_close" || marketStatus === "lunch_break") {
      if (quoteDate && quoteDate === clock.localDate) {
        quoteUsage = marketStatus === "post_close" ? "same_day_close" : "same_day_reference";
        isLiveToday = marketStatus !== "pre_open";
      } else if (quoteDate && quoteDate < clock.localDate) {
        quoteUsage = "previous_close_reference";
        isLiveToday = false;
      } else {
        quoteUsage = "unknown_live_status";
        isLiveToday = false;
      }
    }
  }

  return {
    ...quote,
    market,
    market_status: marketStatus,
    market_trading_day: tradingDay,
    quote_date: quoteDate,
    quote_usage: quoteUsage,
    is_live_today: isLiveToday,
    market_note: note
  };
}

function formatSigned(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return `--${suffix}`;
  }

  const numeric = Number(Number(value).toFixed(2));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric}${suffix}`;
}

export function getComparableChangePercent(quote, { includeReferenceClose = false } = {}) {
  const changePercent = Number(quote?.changePercent ?? quote?.pct_change ?? quote?.change_pct);
  if (!Number.isFinite(changePercent)) {
    return null;
  }

  const usage = String(quote?.quote_usage ?? "").trim();
  if (
    !includeReferenceClose &&
    (usage === "previous_close_reference" ||
      usage === "closed_market_reference" ||
      usage === "stale" ||
      usage === "unknown_live_status")
  ) {
    return null;
  }

  return changePercent;
}

export function formatMarketQuoteLine(label, quote, { includeAmplitude = false } = {}) {
  if (!quote) {
    return `- ${label}：暂无数据`;
  }

  const price = quote.latestPrice ?? quote.latest_price ?? null;
  const changePercent = quote.changePercent ?? quote.pct_change ?? null;
  const amplitude = quote.amplitude ?? null;
  const usage = String(quote.quote_usage ?? "").trim();

  if (
    usage === "previous_close_reference" ||
    usage === "closed_market_reference"
  ) {
    return `- ${label}：休市（上一交易日收盘 ${price ?? "--"}，${formatSigned(changePercent, "%")}）`;
  }

  if (usage === "stale" || usage === "unknown_live_status") {
    return `- ${label}：${price ?? "--"}（非当日有效行情，${formatSigned(changePercent, "%")}）`;
  }

  if (includeAmplitude) {
    return `- ${label}：${price ?? "--"}（${formatSigned(changePercent, "%")}，振幅 ${amplitude ?? "--"}%）`;
  }

  return `- ${label}：${price ?? "--"}（${formatSigned(changePercent, "%")}）`;
}
