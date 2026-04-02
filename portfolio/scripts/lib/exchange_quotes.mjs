const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

function toNumber(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Number(number.toFixed(digits));
}

function normalizeSlashDateTime(rawValue) {
  const raw = String(rawValue ?? "").trim();
  const match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  if (!match) {
    return {
      quoteDate: null,
      quoteTime: null
    };
  }

  return {
    quoteDate: `${match[1]}-${match[2]}-${match[3]}`,
    quoteTime: match[4]
  };
}

function normalizeCompactDateTime(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!/^\d{14}$/.test(raw)) {
    return {
      quoteDate: null,
      quoteTime: null
    };
  }

  return {
    quoteDate: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
    quoteTime: `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`
  };
}

export function normalizeExchangeQuoteCode(rawTicker) {
  const input = String(rawTicker ?? "").trim();
  if (!input) {
    return null;
  }

  const upper = input.toUpperCase();

  if (/^(SH|SZ)\d{6}$/.test(upper)) {
    return upper.toLowerCase();
  }

  if (/^\d{6}\.(SH|SZ)$/.test(upper)) {
    return `${upper.endsWith(".SH") ? "sh" : "sz"}${upper.slice(0, 6)}`.toLowerCase();
  }

  if (/^HK\d{5}$/.test(upper)) {
    return upper.toLowerCase();
  }

  if (/^\d{5}\.HK$/.test(upper)) {
    return `hk${upper.slice(0, 5)}`.toLowerCase();
  }

  if (/^\d{6}$/.test(upper)) {
    if (["5", "6", "9"].includes(upper[0])) {
      return `sh${upper}`.toLowerCase();
    }
    return `sz${upper}`.toLowerCase();
  }

  return null;
}

function parseTencentQuoteLine(line) {
  const input = String(line ?? "").trim();
  const match = input.match(/^v_([^=]+)="([\s\S]*)"$/);
  if (!match) {
    return null;
  }

  const quoteCode = match[1]?.trim()?.toLowerCase();
  const fields = String(match[2] ?? "").split("~");
  if (!quoteCode || fields.length < 34) {
    return null;
  }

  let changeValueIndex = 31;
  let changePercentIndex = 32;
  let highIndex = 33;
  let lowIndex = 34;
  let dateTime = normalizeCompactDateTime(fields[30]);

  if (!dateTime.quoteDate && String(fields[30] ?? "").includes("/")) {
    dateTime = normalizeSlashDateTime(fields[30]);
  }

  return {
    quoteCode,
    symbol: String(fields[2] ?? "").trim() || quoteCode.replace(/^(sh|sz|hk|r_hk)/i, "").toUpperCase(),
    remoteName: String(fields[1] ?? "").trim() || null,
    latestPrice: toNumber(fields[3]),
    previousClose: toNumber(fields[4]),
    open: toNumber(fields[5]),
    changeValue: toNumber(fields[changeValueIndex]),
    changePercent: toNumber(fields[changePercentIndex], 2),
    high: toNumber(fields[highIndex]),
    low: toNumber(fields[lowIndex]),
    quoteDate: dateTime.quoteDate,
    quoteTime: dateTime.quoteTime,
    source: "go_stock_tencent_realtime"
  };
}

export async function fetchExchangeQuotes(rawTickers) {
  const quoteCodes = [
    ...new Set(
      (Array.isArray(rawTickers) ? rawTickers : [rawTickers])
        .map((item) => normalizeExchangeQuoteCode(item))
        .filter(Boolean)
    )
  ];

  if (quoteCodes.length === 0) {
    return new Map();
  }

  const requestUrl = `http://qt.gtimg.cn/?_=${Date.now()}&q=${quoteCodes.join(",")}`;
  const response = await fetch(requestUrl, {
    headers: {
      Host: "qt.gtimg.cn",
      Referer: "https://gu.qq.com/",
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`exchange quote request failed: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const text = new TextDecoder("gb18030").decode(buffer);
  const lines = text
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);

  const quoteMap = new Map();
  for (const line of lines) {
    const parsed = parseTencentQuoteLine(line);
    if (!parsed) {
      continue;
    }
    quoteMap.set(parsed.quoteCode, parsed);
  }

  return quoteMap;
}
