import { getCmeFuturesQuote, normalizeCmeFuturesCode } from "./cme.js";
import { http } from "./http.js";

function decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function requireFingerprint(fingerprint) {
  const value = String(fingerprint ?? process.env.MARKET_MCP_QGQP_B_ID ?? "").trim();
  if (!value) {
    throw new Error(
      "Missing Eastmoney fingerprint qgqp_b_id. Pass fingerprint explicitly or set MARKET_MCP_QGQP_B_ID."
    );
  }
  return value;
}

function normalizeStockCode(rawCode) {
  const stockCode = String(rawCode ?? "").trim().toUpperCase();
  if (!stockCode) {
    throw new Error("stockCode is required");
  }

  if (stockCode.includes(".")) {
    const [code, market] = stockCode.split(".");
    switch (market) {
      case "SH":
      case "SS":
        return { secid: `1.${code}`, normalized: `${code}.SH` };
      case "SZ":
      case "BJ":
        return { secid: `0.${code}`, normalized: `${code}.${market}` };
      case "HK":
        return { secid: `128.${code}`, normalized: `${code}.HK` };
      case "BK":
        return { secid: `90.${code}`, normalized: `${code}.BK` };
      default:
        return { secid: stockCode, normalized: stockCode };
    }
  }

  if (/^(SH|SZ|BJ)\d+$/.test(stockCode)) {
    const market = stockCode.slice(0, 2);
    const code = stockCode.slice(2);
    return {
      secid: `${market === "SH" ? "1" : "0"}.${code}`,
      normalized: `${code}.${market}`
    };
  }

  if (/^HK\d+$/.test(stockCode)) {
    const code = stockCode.slice(2);
    return { secid: `128.${code}`, normalized: `${code}.HK` };
  }

  if (/^\d+$/.test(stockCode)) {
    const first = stockCode[0];
    if (first === "6") {
      return { secid: `1.${stockCode}`, normalized: `${stockCode}.SH` };
    }
    if (first === "0" || first === "3" || first === "8" || first === "9") {
      return { secid: `0.${stockCode}`, normalized: `${stockCode}.SZ` };
    }
  }

  return { secid: stockCode, normalized: stockCode };
}

function normalizeTencentQuoteCode(rawCode) {
  const input = String(rawCode ?? "").trim();
  if (!input) {
    return null;
  }

  const upper = input.toUpperCase();

  if (/^R_HK[A-Z0-9]+$/.test(upper)) {
    return { quoteCode: `r_hk${upper.slice(4)}`, normalized: `r_hk${upper.slice(4)}` };
  }

  if (/^HK[A-Z0-9]+$/.test(upper)) {
    return { quoteCode: `hk${upper.slice(2)}`, normalized: `hk${upper.slice(2)}` };
  }

  if (/^US[A-Z0-9.]+$/.test(upper)) {
    return { quoteCode: `us${upper.slice(2)}`, normalized: `us${upper.slice(2)}` };
  }

  return null;
}

function normalizeTencentFuturesCode(rawCode) {
  const input = String(rawCode ?? "").trim();
  if (!input) {
    return null;
  }

  const upper = input.toUpperCase();
  if (!/^HF_[A-Z0-9]+$/.test(upper)) {
    return null;
  }

  return {
    quoteCode: `hf_${upper.slice(3)}`,
    normalized: `hf_${upper.slice(3)}`
  };
}

function normalizeSinaForeignQuoteCode(rawCode) {
  const input = String(rawCode ?? "").trim().toUpperCase();
  if (!input) {
    return null;
  }

  if (input === "HF_XAU") {
    return {
      quoteCode: "hf_XAU",
      normalized: "hf_XAU",
      referer: "https://gu.sina.cn/ft/hq/hf.php?symbol=XAU",
      type: "metal"
    };
  }

  if (/^ZNB_[A-Z0-9]+$/.test(input)) {
    const pageCode = input.slice(4);
    return {
      quoteCode: `znb_${pageCode}`,
      normalized: `znb_${pageCode}`,
      referer: `https://quotes.sina.cn/global/hq/quotes.php?from=redirect&code=${pageCode}`,
      type: "global_index"
    };
  }

  return null;
}

function normalizeWscnMarketCode(rawCode) {
  const input = String(rawCode ?? "").trim().toUpperCase();
  if (!input) {
    return null;
  }

  if (/^(AU9999|AUTD)\.SGE$/.test(input)) {
    return {
      prodCode: input,
      normalized: input
    };
  }

  return null;
}

function normalizeAdjustFlag(adjustFlag) {
  switch (String(adjustFlag ?? "").trim().toLowerCase()) {
    case "qfq":
    case "1":
      return "1";
    case "hfq":
    case "2":
      return "2";
    default:
      return "0";
  }
}

function toNumber(value, scale = 1) {
  if (value === null || value === undefined || value === "-") {
    return null;
  }
  const number = Number(value);
  if (Number.isNaN(number)) {
    return null;
  }
  return number / scale;
}

function parseKlineRow(row) {
  const [
    day,
    open,
    close,
    high,
    low,
    volume,
    amount,
    amplitude,
    changePercent,
    changeValue,
    turnoverRate
  ] = row.split(",");

  return {
    day,
    open: toNumber(open),
    close: toNumber(close),
    high: toNumber(high),
    low: toNumber(low),
    volume: toNumber(volume),
    amount: toNumber(amount),
    amplitude: toNumber(amplitude),
    changePercent: toNumber(changePercent),
    changeValue: toNumber(changeValue),
    turnoverRate: toNumber(turnoverRate)
  };
}

function parseJsonpPayload(text) {
  const input = String(text ?? "").trim();
  const start = input.indexOf("(");
  const end = input.lastIndexOf(")");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Unexpected JSONP payload");
  }
  return JSON.parse(input.slice(start + 1, end));
}

function parseTencentQuotePayload(text) {
  const input = String(text ?? "").trim();
  const start = input.indexOf('="');
  const end = input.lastIndexOf('"');
  if (start === -1 || end === -1 || end <= start + 1) {
    throw new Error("Unexpected Tencent quote payload");
  }

  const fields = input.slice(start + 2, end).split("~");
  if (fields.length < 33) {
    throw new Error("Tencent quote payload has insufficient fields");
  }

  return fields;
}

function parseTencentQuoteDateTime(rawValue) {
  const raw = String(rawValue ?? "").trim();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    return {
      quoteDate: `${compact[1]}-${compact[2]}-${compact[3]}`,
      quoteTime: `${compact[4]}:${compact[5]}:${compact[6]}`
    };
  }

  const slash = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  if (slash) {
    return {
      quoteDate: `${slash[1]}-${slash[2]}-${slash[3]}`,
      quoteTime: slash[4]
    };
  }

  return {
    quoteDate: null,
    quoteTime: null
  };
}

function parseTencentFuturesPayload(text) {
  const input = String(text ?? "").trim();
  const start = input.indexOf('="');
  const end = input.lastIndexOf('"');
  if (start === -1 || end === -1 || end <= start + 1) {
    throw new Error("Unexpected Tencent futures payload");
  }

  const fields = input.slice(start + 2, end).split(",");
  if (fields.length < 14) {
    throw new Error("Tencent futures payload has insufficient fields");
  }

  return fields;
}

function parseSinaForeignQuotePayload(text, quoteCode) {
  const input = String(text ?? "").trim();
  const start = input.indexOf('="');
  const end = input.lastIndexOf('"');
  if (start === -1 || end === -1 || end <= start + 1) {
    throw new Error(`Unexpected Sina foreign quote payload for ${quoteCode}`);
  }

  return input.slice(start + 2, end).split(",");
}

async function getTencentQuote(stockCode) {
  const normalized = normalizeTencentQuoteCode(stockCode);
  if (!normalized) {
    throw new Error(`Unsupported Tencent quote code: ${stockCode}`);
  }

  const { data } = await http.get("https://qt.gtimg.cn/q=" + normalized.quoteCode, {
    headers: {
      Referer: "https://gu.qq.com/",
      "User-Agent": "Mozilla/5.0"
    },
    responseType: "arraybuffer",
    transformResponse: [(value) => value]
  });

  const text = new TextDecoder("gbk").decode(data);
  const fields = parseTencentQuotePayload(text);
  const dateTime = parseTencentQuoteDateTime(fields[30]);

  return compactObject({
    stockCode: normalized.normalized,
    name: fields[1] || null,
    quoteCode: fields[2] || null,
    latestPrice: toNumber(fields[3]),
    previousClose: toNumber(fields[4]),
    open: toNumber(fields[5]),
    volume: toNumber(fields[6]),
    amount: toNumber(fields[7]),
    changeValue: toNumber(fields[31]),
    changePercent: toNumber(fields[32]),
    high: toNumber(fields[33]),
    low: toNumber(fields[34]),
    amplitude: null,
    source: "tencent",
    quoteDate: dateTime.quoteDate,
    quoteTime:
      dateTime.quoteDate && dateTime.quoteTime
        ? `${dateTime.quoteDate} ${dateTime.quoteTime}`
        : null
  });
}

async function getTencentFuturesQuote(stockCode) {
  const normalized = normalizeTencentFuturesCode(stockCode);
  if (!normalized) {
    throw new Error(`Unsupported Tencent futures code: ${stockCode}`);
  }

  const { data } = await http.get("https://qt.gtimg.cn/q=" + normalized.quoteCode, {
    headers: {
      Referer: "https://gu.qq.com/",
      "User-Agent": "Mozilla/5.0"
    },
    responseType: "arraybuffer",
    transformResponse: [(value) => value]
  });

  const text = new TextDecoder("gbk").decode(data);
  const fields = parseTencentFuturesPayload(text);
  const latestPrice = toNumber(fields[0]);
  const previousClose = toNumber(fields[7]);
  const changeValue =
    latestPrice !== null && previousClose !== null ? Number((latestPrice - previousClose).toFixed(2)) : null;
  const changePercent =
    latestPrice !== null && previousClose
      ? Number((((latestPrice - previousClose) / previousClose) * 100).toFixed(2))
      : toNumber(fields[1]);

  return compactObject({
    stockCode: normalized.normalized,
    name: fields[13] || null,
    quoteCode: normalized.quoteCode,
    latestPrice,
    previousClose,
    open: toNumber(fields[3]),
    high: toNumber(fields[4]),
    low: toNumber(fields[5]),
    changeValue,
    changePercent,
    amplitude:
      previousClose !== null
        ? Number((((toNumber(fields[4]) ?? 0) - (toNumber(fields[5]) ?? 0)) / previousClose * 100).toFixed(2))
        : null,
    source: "tencent_futures",
    quoteTime: fields[12] && fields[6] ? `${fields[12]} ${fields[6]}` : null
  });
}

async function getWscnCommodityQuote(stockCode) {
  const normalized = normalizeWscnMarketCode(stockCode);
  if (!normalized) {
    throw new Error(`Unsupported WSCN market code: ${stockCode}`);
  }

  const { data } = await http.get("https://api-ddc-wscn.awtmt.com/market/kline", {
    params: {
      prod_code: normalized.prodCode,
      tick_count: 2,
      period_type: 60,
      adjust_price_type: "forward",
      fields: "tick_at,open_px,close_px,high_px,low_px,pre_close_px"
    },
    headers: {
      Referer: "https://wallstreetcn.com/markets"
    }
  });

  const candle = data?.data?.candle?.[normalized.prodCode];
  const lines = candle?.lines ?? [];
  if (lines.length === 0) {
    throw new Error(`No WSCN commodity quote returned for ${normalized.normalized}`);
  }

  const latestLine = lines[lines.length - 1];
  const open = toNumber(latestLine?.[0]);
  const latestPrice = toNumber(latestLine?.[1]);
  const high = toNumber(latestLine?.[2]);
  const low = toNumber(latestLine?.[3]);
  const tickAt = latestLine?.[4] ? Number(latestLine[4]) : null;
  const previousClose = toNumber(candle?.pre_close_px);
  const changeValue =
    latestPrice !== null && previousClose !== null ? Number((latestPrice - previousClose).toFixed(2)) : null;
  const changePercent =
    latestPrice !== null && previousClose
      ? Number((((latestPrice - previousClose) / previousClose) * 100).toFixed(2))
      : null;

  return compactObject({
    stockCode: normalized.normalized,
    name: normalized.prodCode === "AU9999.SGE" ? "上金所Au99.99" : "上金所Au(T+D)",
    quoteCode: normalized.prodCode,
    latestPrice,
    previousClose,
    open,
    high,
    low,
    changeValue,
    changePercent,
    amplitude: null,
    source: "wscn_sge",
    quoteTime: tickAt ? new Date(tickAt * 1000).toISOString() : null
  });
}

async function getSinaForeignQuote(stockCode) {
  const normalized = normalizeSinaForeignQuoteCode(stockCode);
  if (!normalized) {
    throw new Error(`Unsupported Sina foreign quote code: ${stockCode}`);
  }

  const { data } = await http.get(`https://hq.sinajs.cn/list=${normalized.quoteCode}`, {
    headers: {
      Referer: normalized.referer,
      "User-Agent": "Mozilla/5.0"
    },
    responseType: "arraybuffer",
    transformResponse: [(value) => value]
  });

  const text = new TextDecoder("gbk").decode(data);
  const fields = parseSinaForeignQuotePayload(text, normalized.quoteCode);

  if (normalized.type === "metal") {
    const latestPrice = toNumber(fields[0]);
    const open = toNumber(fields[1]);
    const high = toNumber(fields[4]);
    const low = toNumber(fields[5]);
    const previousClose = toNumber(fields[7]);
    const changeValue =
      latestPrice !== null && previousClose !== null ? Number((latestPrice - previousClose).toFixed(2)) : null;
    const changePercent =
      latestPrice !== null && previousClose
        ? Number((((latestPrice - previousClose) / previousClose) * 100).toFixed(2))
        : null;
    const amplitude =
      previousClose !== null && high !== null && low !== null
        ? Number((((high - low) / previousClose) * 100).toFixed(2))
        : null;

    return compactObject({
      stockCode: normalized.normalized,
      name: fields[13] || "伦敦金",
      quoteCode: normalized.quoteCode,
      latestPrice,
      previousClose,
      open,
      high,
      low,
      changeValue,
      changePercent,
      amplitude,
      source: "sina_foreign",
      quoteTime: fields[12] && fields[6] ? `${fields[12]} ${fields[6]}` : null
    });
  }

  const latestPrice = toNumber(fields[1]);
  const changeValue = toNumber(fields[2]);
  const changePercent = toNumber(fields[3]);
  const open = toNumber(fields[8]);
  const previousClose = toNumber(fields[9]);
  const high = toNumber(fields[10]);
  const low = toNumber(fields[11]);
  const amplitude =
    previousClose !== null && high !== null && low !== null
      ? Number((((high - low) / previousClose) * 100).toFixed(2))
      : null;

  return compactObject({
    stockCode: normalized.normalized,
    name: fields[0] || normalized.quoteCode,
    quoteCode: normalized.quoteCode,
    latestPrice,
    previousClose,
    open,
    high,
    low,
    changeValue,
    changePercent,
    amplitude,
    source: "sina_global",
    quoteTime: fields[6] && fields[7] ? `${fields[6]} ${fields[7]}` : null
  });
}

export async function getStockQuote(stockCode) {
  const wscnMarket = normalizeWscnMarketCode(stockCode);
  if (wscnMarket) {
    return getWscnCommodityQuote(stockCode);
  }

  const sinaForeignQuote = normalizeSinaForeignQuoteCode(stockCode);
  if (sinaForeignQuote) {
    return getSinaForeignQuote(stockCode);
  }

  const cmeFuturesQuote = normalizeCmeFuturesCode(stockCode);
  if (cmeFuturesQuote) {
    return getCmeFuturesQuote(stockCode);
  }

  const tencentFuturesQuote = normalizeTencentFuturesCode(stockCode);
  if (tencentFuturesQuote) {
    return getTencentFuturesQuote(stockCode);
  }

  const tencentQuote = normalizeTencentQuoteCode(stockCode);
  if (tencentQuote) {
    return getTencentQuote(stockCode);
  }

  const { secid, normalized } = normalizeStockCode(stockCode);
  const { data } = await http.get("https://push2.eastmoney.com/api/qt/stock/get", {
    params: {
      secid,
      fields: "f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f171,f168,f162",
      ut: "fa5fd1943c7b386f172d6893dbfba10b",
      _: Date.now()
    },
    headers: {
      Referer: "https://quote.eastmoney.com/"
    }
  });

  const quote = data?.data;
  if (!quote) {
    throw new Error(`No quote data returned for ${normalized}`);
  }

  return {
    stockCode: normalized,
    name: quote.f58,
    quoteCode: quote.f57,
    latestPrice: toNumber(quote.f43, 100),
    open: toNumber(quote.f46, 100),
    high: toNumber(quote.f44, 100),
    low: toNumber(quote.f45, 100),
    previousClose: toNumber(quote.f60, 100),
    changeValue: toNumber(quote.f169, 100),
    changePercent: toNumber(quote.f170, 100),
    amplitude: toNumber(quote.f171, 100),
    turnoverRate: toNumber(quote.f168, 100),
    peRatio: toNumber(quote.f162, 100),
    volume: toNumber(quote.f47),
    amount: toNumber(quote.f48)
  };
}

export async function getStockKline(stockCode, klineType = "101", limit = 60, adjustFlag = "0") {
  const input = String(stockCode ?? "").trim();
  const upper = input.toUpperCase();
  const { normalized } = normalizeStockCode(stockCode);

  if (/^(SH|SZ)\d+$/i.test(input) || /^\d{6}(\.SH|\.SZ)?$/i.test(input)) {
    const symbol = upper.includes(".")
      ? `${upper.endsWith(".SH") ? "sh" : "sz"}${upper.split(".")[0]}`
      : input.toLowerCase().startsWith("sh") || input.toLowerCase().startsWith("sz")
        ? input.toLowerCase()
        : upper.startsWith("6")
          ? `sh${input}`
          : `sz${input}`;

    const scaleMap = {
      "1": "1",
      "5": "5",
      "15": "15",
      "30": "30",
      "60": "60",
      "101": "240",
      "day": "240",
      "240": "240"
    };

    const scale = scaleMap[String(klineType).toLowerCase()] ?? "240";
    const { data } = await http.get(
      "http://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData",
      {
        params: {
          symbol,
          scale,
          ma: "yes",
          datalen: limit
        }
      }
    );

    return {
      stockCode: normalized,
      source: "sina",
      klineType: scale,
      adjustFlag: "qfq",
      items: (data ?? []).map((item) => ({
        day: item.day,
        open: toNumber(item.open),
        close: toNumber(item.close),
        high: toNumber(item.high),
        low: toNumber(item.low),
        volume: toNumber(item.volume)
      }))
    };
  }

  const marketCode = upper.includes(".")
    ? `${upper.endsWith(".HK") ? "hk" : "us"}${upper.split(".")[0]}`
    : upper.startsWith("HK") || upper.startsWith("US") || upper.startsWith("GB_")
      ? input.toLowerCase().replace(/^gb_/i, "us")
      : input.toLowerCase();

  const qqKlineType =
    String(klineType).toLowerCase() === "101" ? "day" : String(klineType).toLowerCase();
  const { data } = await http.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get", {
    params: {
      param: `${marketCode},${qqKlineType},,,${limit},${normalizeAdjustFlag(adjustFlag) === "2" ? "hfq" : "qfq"}`
    }
  });

  const marketData = data?.data?.[marketCode];
  const rows = marketData?.qfqday ?? marketData?.day ?? [];
  if (!rows.length) {
    throw new Error(`No kline data returned for ${normalized}`);
  }

  return {
    stockCode: normalized,
    source: "qq",
    klineType: qqKlineType,
    adjustFlag: normalizeAdjustFlag(adjustFlag) === "2" ? "hfq" : "qfq",
    items: rows.map((row) => ({
      day: row[0],
      open: toNumber(row[1]),
      close: toNumber(row[2]),
      high: toNumber(row[3]),
      low: toNumber(row[4]),
      volume: toNumber(row[5])
    }))
  };
}

export async function getMarketTelegraph(limit = 20) {
  const { data } = await http.get("https://www.cls.cn/nodeapi/telegraphList", {
    headers: {
      Referer: "https://www.cls.cn/"
    }
  });

  const rollData = data?.data?.roll_data ?? [];
  return rollData.slice(0, limit).map((item) => ({
    title: item.title,
    content: item.content,
    source: "财联社电报",
    publishedAt: new Date(Number(item.ctime) * 1000).toISOString(),
    isImportant: item.level !== "C",
    url: item.shareurl,
    subjects: (item.subjects ?? []).map((subject) => subject.subject_name)
  }));
}

export async function getIndustryResearchReports(industryCode = "", days = 7) {
  const begin = new Date(
    Date.now() - days * (String(industryCode).trim() ? 365 : 1) * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  const { data } = await http.get("https://reportapi.eastmoney.com/report/list", {
    params: {
      industry: "*",
      industryCode: String(industryCode ?? "").trim(),
      beginTime: begin,
      endTime: end,
      pageNo: 1,
      pageSize: 50,
      p: 1,
      pageNum: 1,
      pageNumber: 1,
      qType: 1
    },
    headers: {
      Origin: "https://data.eastmoney.com",
      Referer: "https://data.eastmoney.com/report/stock.jshtml"
    }
  });

  return (data?.data ?? []).map((item) =>
    compactObject({
      title: item.title,
      industryCode: item.industryCode,
      industryName: item.industryName,
      orgSName: item.orgSName,
      publishDate: item.publishDate,
      infoCode: item.infoCode,
      rating: item.rating,
      ratingChange: item.ratingChange
    })
  );
}

export async function getIndustryReportDetail(infoCode) {
  const code = String(infoCode ?? "").trim();
  if (!code) {
    throw new Error("infoCode is required");
  }

  const { data } = await http.get("https://data.eastmoney.com/report/zw_industry.jshtml", {
    params: {
      infocode: code
    },
    headers: {
      Referer: "https://data.eastmoney.com/report/industry.jshtml"
    },
    responseType: "text"
  });

  const html = String(data ?? "");
  const titleMatch = html.match(/<div class="c-title">([\s\S]*?)<\/div>/i);
  const contentMatch = html.match(/<div class="ctx-content">([\s\S]*?)<\/div>/i);

  return {
    infoCode: code,
    title: htmlToPlainText(titleMatch?.[1] ?? ""),
    content: htmlToPlainText(contentMatch?.[1] ?? ""),
    sourceUrl: `https://data.eastmoney.com/report/zw_industry.jshtml?infocode=${encodeURIComponent(code)}`
  };
}

export async function getStockResearchReports(stockCode, days = 30) {
  const input = String(stockCode ?? "").trim();
  const cleanCode = input.includes(".")
    ? input.split(".")[0]
    : input.replace(/^(sh|sz|us_|us|gb_)/i, "");

  const begin = new Date(Date.now() - days * 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  const { data } = await http.post(
    "https://reportapi.eastmoney.com/report/list2",
    {
      code: cleanCode,
      industryCode: "*",
      beginTime: begin,
      endTime: end,
      pageNo: 1,
      pageSize: 50,
      p: 1,
      pageNum: 1,
      pageNumber: 1
    },
    {
      headers: {
        Origin: "https://data.eastmoney.com",
        Referer: "https://data.eastmoney.com/report/stock.jshtml",
        "Content-Type": "application/json"
      }
    }
  );

  return (data?.data ?? []).map((item) => ({
    title: item.title,
    stockCode: item.stockCode,
    stockName: item.stockName,
    orgSName: item.orgSName,
    industryName: item.industryName,
    publishDate: item.publishDate,
    predictThisYearEps: item.predictThisYearEps,
    predictNextYearEps: item.predictNextYearEps,
    ratingName: item.ratingName,
    ratingChange: item.ratingChange,
    infoCode: item.infoCode
  }));
}

export async function searchBoardByNaturalLanguage(words, pageSize = 50, fingerprint) {
  const keyword = String(words ?? "").trim();
  if (!keyword) {
    throw new Error("words is required");
  }

  const qgqpBId = requireFingerprint(fingerprint);
  const { data } = await http.post(
    "https://np-tjxg-b.eastmoney.com/api/smart-tag/bkc/v3/pw/search-code",
    {
      keyWord: keyword,
      pageSize,
      pageNo: 1,
      fingerprint: qgqpBId,
      gids: [],
      matchWord: "",
      timestamp: Date.now(),
      shareToGuba: false,
      requestId: "",
      needCorrect: true,
      removedConditionIdList: [],
      xcId: "",
      ownSelectAll: false,
      dxInfo: [],
      extraCondition: ""
    },
    {
      headers: {
        Host: "np-tjxg-g.eastmoney.com",
        Origin: "https://xuangu.eastmoney.com",
        Referer: "https://xuangu.eastmoney.com/",
        "Content-Type": "application/json"
      }
    }
  );

  return data;
}

export async function searchEtfByNaturalLanguage(words, pageSize = 50, fingerprint) {
  const keyword = String(words ?? "").trim();
  if (!keyword) {
    throw new Error("words is required");
  }

  const qgqpBId = requireFingerprint(fingerprint);
  const { data } = await http.post(
    "https://np-tjxg-b.eastmoney.com/api/smart-tag/etf/v3/pw/search-code",
    {
      keyWord: keyword,
      pageSize,
      pageNo: 1,
      fingerprint: qgqpBId,
      gids: [],
      matchWord: "",
      timestamp: Date.now(),
      shareToGuba: false,
      requestId: "",
      needCorrect: true,
      removedConditionIdList: [],
      xcId: "",
      ownSelectAll: false,
      dxInfo: [],
      extraCondition: ""
    },
    {
      headers: {
        Host: "np-tjxg-g.eastmoney.com",
        Origin: "https://xuangu.eastmoney.com",
        Referer: "https://xuangu.eastmoney.com/",
        "Content-Type": "application/json"
      }
    }
  );

  return data;
}

export async function getStockNotices(stockList) {
  const stockCodes = String(stockList ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.includes(".") ? item.split(".")[0] : item.replace(/^(sh|sz|us_|us|gb_)/i, "")));

  if (stockCodes.length === 0) {
    throw new Error("At least one stock code is required");
  }

  const { data } = await http.get("https://np-anotice-stock.eastmoney.com/api/security/ann", {
    params: {
      page_size: 50,
      page_index: 1,
      ann_type: "SHA,CYB,SZA,BJA,INV",
      client_source: "web",
      f_node: 0,
      stock_list: stockCodes.join(",")
    },
    headers: {
      Referer: "https://data.eastmoney.com/notices/hsa/5.html"
    }
  });

  return (data?.data?.list ?? []).map((item) => ({
    code: item.stock_code,
    shortName: item.short_name,
    title: item.title,
    noticeDate: item.notice_date,
    artCode: item.art_code,
    noticeType: item.columns?.[0]?.column_name ?? null
  }));
}

export async function getHotBoards({
  boardType = "industry",
  sort = "0",
  limit = 20,
  metric = "averatio"
} = {}) {
  if (boardType === "industry") {
    const { data } = await http.get("https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank", {
      params: {
        l: limit,
        p: 1,
        t: `01/${metric}`,
        ordertype: "",
        o: sort
      },
      headers: {
        Referer: "https://stockapp.finance.qq.com/"
      }
    });

    const list = data?.data?.diff ?? data?.data?.list ?? data?.data ?? [];
    return {
      boardType,
      sort,
      metric,
      items: Array.isArray(list) ? list : []
    };
  }

  const endpoint =
    boardType === "concept"
      ? "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk"
      : "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj";

  const params =
    boardType === "concept"
      ? { page: 1, num: limit, sort: metric, asc: 0, fenlei: sort }
      : { page: 1, num: limit, sort: metric || "netamount", asc: 0, bankuai: "", shichang: "" };

  const { data } = await http.get(endpoint, {
    params,
    headers: {
      Host: "vip.stock.finance.sina.com.cn",
      Referer: "https://finance.sina.com.cn"
    }
  });

  return {
    boardType,
    sort,
    metric,
    items: Array.isArray(data) ? data : []
  };
}

export async function getLongTigerRank(date) {
  const tradeDate = String(date ?? "").trim();
  if (!tradeDate) {
    throw new Error("date is required, format YYYY-MM-DD");
  }

  const response = await http.get("https://datacenter-web.eastmoney.com/api/data/v1/get", {
    params: {
      callback: "callback",
      sortColumns: "TURNOVERRATE,TRADE_DATE,SECURITY_CODE",
      sortTypes: "-1,-1,1",
      pageSize: "500",
      pageNumber: "1",
      reportName: "RPT_DAILYBILLBOARD_DETAILSNEW",
      columns:
        "SECURITY_CODE,SECUCODE,SECURITY_NAME_ABBR,TRADE_DATE,EXPLAIN,CLOSE_PRICE,CHANGE_RATE,BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,BILLBOARD_DEAL_AMT,ACCUM_AMOUNT,DEAL_NET_RATIO,DEAL_AMOUNT_RATIO,TURNOVERRATE,FREE_MARKET_CAP,EXPLANATION,D1_CLOSE_ADJCHRATE,D2_CLOSE_ADJCHRATE,D5_CLOSE_ADJCHRATE,D10_CLOSE_ADJCHRATE,SECURITY_TYPE_CODE",
      source: "WEB",
      client: "WEB",
      filter: `(TRADE_DATE<='${tradeDate}')(TRADE_DATE>='${tradeDate}')`
    },
    headers: {
      Referer: "https://data.eastmoney.com/stock/tradedetail.html"
    },
    responseType: "text"
  });

  const parsed = parseJsonpPayload(response.data);
  const list = parsed?.result?.data ?? [];
  return list.map((item) =>
    compactObject({
      securityCode: item.SECURITY_CODE,
      secuCode: item.SECUCODE,
      name: item.SECURITY_NAME_ABBR,
      tradeDate: item.TRADE_DATE,
      closePrice: item.CLOSE_PRICE,
      changeRate: item.CHANGE_RATE,
      turnoverRate: item.TURNOVERRATE,
      billboardNetAmount: item.BILLBOARD_NET_AMT,
      billboardBuyAmount: item.BILLBOARD_BUY_AMT,
      billboardSellAmount: item.BILLBOARD_SELL_AMT,
      explanation: item.EXPLANATION || item.EXPLAIN,
      freeMarketCap: item.FREE_MARKET_CAP,
      securityTypeCode: item.SECURITY_TYPE_CODE
    })
  );
}

export async function getHotStocks(limit = 20, marketType = "10") {
  const warmup = await http.get("https://xueqiu.com/hq#hot", {
    headers: {
      Referer: "https://xueqiu.com/"
    }
  });
  const cookie = []
    .concat(warmup.headers["set-cookie"] ?? [])
    .map((item) => String(item).split(";")[0])
    .join("; ");

  const { data } = await http.get("https://stock.xueqiu.com/v5/stock/hot_stock/list.json", {
    params: {
      page: 1,
      size: limit,
      _type: marketType,
      type: marketType
    },
    headers: {
      Origin: "https://xueqiu.com",
      Referer: "https://xueqiu.com/",
      Cookie: cookie
    }
  });

  return (data?.data?.items ?? []).map((item) =>
    compactObject({
      code: item.code,
      symbol: item.symbol,
      name: item.name,
      current: item.current,
      percent: item.percent,
      chg: item.chg,
      heat: item.value,
      heatIncrement: item.increment,
      rankChange: item.rank_change,
      exchange: item.exchange
    })
  );
}

const positiveFinanceWords = new Map([
  ["涨", 1.0], ["上涨", 2.0], ["涨停", 3.0], ["牛市", 3.0], ["反弹", 2.0], ["新高", 2.5],
  ["利好", 2.5], ["增持", 2.0], ["买入", 2.0], ["推荐", 1.5], ["看多", 2.0],
  ["盈利", 2.0], ["增长", 2.0], ["超预期", 2.5], ["强劲", 1.5], ["回升", 1.5],
  ["复苏", 2.0], ["突破", 2.0], ["创新高", 3.0], ["回暖", 1.5], ["上扬", 1.5],
  ["收益增长", 2.5], ["利润增长", 2.5], ["业绩优异", 2.5], ["潜力股", 2.0], ["强势", 1.5],
  ["大涨", 2.5], ["飙升", 3.0], ["井喷", 3.0], ["暴涨", 3.0]
]);

const negativeFinanceWords = new Map([
  ["跌", 2.0], ["下跌", 2.0], ["跌停", 3.0], ["熊市", 3.0], ["回调", 2.5], ["新低", 2.5],
  ["利空", 2.5], ["减持", 2.0], ["卖出", 2.0], ["看空", 2.0], ["亏损", 2.5], ["下滑", 2.0],
  ["萎缩", 2.0], ["不及预期", 2.5], ["疲软", 1.5], ["恶化", 2.0], ["衰退", 2.0],
  ["跌破", 2.0], ["创新低", 3.0], ["走弱", 2.5], ["下挫", 2.5], ["收益下降", 2.5],
  ["利润下滑", 2.5], ["业绩不佳", 2.5], ["垃圾股", 2.0], ["风险股", 2.0], ["弱势", 2.5],
  ["走低", 2.5], ["缩量", 2.5], ["大跌", 2.5], ["暴跌", 3.0], ["崩盘", 3.0], ["跳水", 3.0]
]);

export function analyzeStockSentiment(text) {
  const input = String(text ?? "").trim();
  if (!input) {
    throw new Error("text is required");
  }

  let positiveScore = 0;
  let negativeScore = 0;
  const hits = [];

  for (const [word, weight] of positiveFinanceWords.entries()) {
    const count = input.split(word).length - 1;
    if (count > 0) {
      positiveScore += count * weight;
      hits.push({ word, polarity: "positive", count, weight });
    }
  }

  for (const [word, weight] of negativeFinanceWords.entries()) {
    const count = input.split(word).length - 1;
    if (count > 0) {
      negativeScore += count * weight;
      hits.push({ word, polarity: "negative", count, weight });
    }
  }

  const score = Number((positiveScore - negativeScore).toFixed(2));
  let description = "中性";
  if (score > 1) {
    description = "偏积极";
  } else if (score < -1) {
    description = "偏消极";
  }

  return {
    score,
    positiveScore: Number(positiveScore.toFixed(2)),
    negativeScore: Number(negativeScore.toFixed(2)),
    description,
    matchedTerms: hits.sort((a, b) => b.count * b.weight - a.count * a.weight)
  };
}
