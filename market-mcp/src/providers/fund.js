import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { http, parsePossiblyWrappedJson } from "./http.js";
import { classifyFundObservation } from "./fund_observation_policy.mjs";

const deviceId = randomUUID();
const FUND_PRIMARY_TIMEOUT_MS = 5000;
const FUND_FALLBACK_TIMEOUT_MS = 3000;
const FUND_FALLBACK_CONCURRENCY = 5;

export function buildFundPrimaryRequestOptions(params = {}) {
  return {
    params,
    timeout: FUND_PRIMARY_TIMEOUT_MS
  };
}

export function buildFundFallbackRequestOptions(params = {}, responseType = "text") {
  return {
    params,
    responseType,
    timeout: FUND_FALLBACK_TIMEOUT_MS
  };
}

function resolveDefaultWatchlistPath() {
  const portfolioRoot = String(process.env.PORTFOLIO_ROOT ?? "/Users/yinshiwei/codex/tz/portfolio").trim();
  return `${portfolioRoot}/fund-watchlist.json`;
}

function normalizeFundCodes(fundCodes) {
  return Array.isArray(fundCodes)
    ? fundCodes.map((item) => String(item).trim()).filter(Boolean)
    : String(fundCodes ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function valuesAlmostEqual(left, right, epsilon = 1e-8) {
  if (left === null || right === null || left === undefined || right === undefined) {
    return false;
  }

  return Math.abs(Number(left) - Number(right)) <= epsilon;
}

function relativeDifferencePercent(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) {
    return null;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    return null;
  }

  const denominator = Math.max(Math.abs(leftNumber), Math.abs(rightNumber), 1e-8);
  return (Math.abs(leftNumber - rightNumber) / denominator) * 100;
}

function isLateCloseSnapshot(valuationTime) {
  const text = String(valuationTime ?? "").trim();
  const match = text.match(/\b(\d{2}):(\d{2})\b/);
  if (!match) {
    return false;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }

  return hour > 15 || (hour === 15 && minute >= 0);
}

function resolveDailyChangePercent(primaryQuote, legacyQuote, valuation, netValue) {
  const legacyChange = legacyQuote?.valuationChangePercent ?? null;
  const primaryChange = primaryQuote?.valuationChangePercent ?? null;
  const growthRate = primaryQuote?.growthRate ?? null;
  const closeGapPct = relativeDifferencePercent(valuation, netValue);
  const tinyResidualEstimate =
    closeGapPct !== null &&
    closeGapPct <= 0.02 &&
    legacyChange !== null &&
    Math.abs(Number(legacyChange)) <= 0.05 &&
    growthRate !== null &&
    Math.abs(Number(growthRate) - Number(legacyChange)) >= 0.3 &&
    isLateCloseSnapshot(legacyQuote?.valuationTime ?? primaryQuote?.valuationTime);

  const closeLikeSnapshot =
    valuesAlmostEqual(valuation, netValue) &&
    valuesAlmostEqual(legacyChange, 0) &&
    growthRate !== null &&
    !valuesAlmostEqual(growthRate, 0);

  if (closeLikeSnapshot || tinyResidualEstimate) {
    return growthRate;
  }

  return legacyChange ?? primaryChange ?? growthRate ?? null;
}

function createConcurrencyLimiter(limit) {
  const maxConcurrency = Math.max(1, Number(limit) || 1);
  let activeCount = 0;
  const queue = [];

  const runNext = () => {
    if (activeCount >= maxConcurrency || queue.length === 0) {
      return;
    }

    const task = queue.shift();
    activeCount += 1;
    Promise.resolve()
      .then(task.fn)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1;
        runNext();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

function mapPrimaryFundQuote(item) {
  if (!item?.FCODE) {
    return null;
  }

  return {
    code: item.FCODE,
    name: item.SHORTNAME ?? item.FCODE,
    netValueDate: item.PDATE ?? null,
    netValue: toNullableNumber(item.NAV),
    valuation: toNullableNumber(item.GSZ),
    valuationChangePercent: toNullableNumber(item.GSZZL),
    valuationTime: item.GZTIME ?? null,
    growthRate: toNullableNumber(item.NAVCHGRT)
  };
}

async function fetchLegacyRealtimeQuote(code) {
  try {
    const response = await http.get(
      `https://fundgz.1234567.com.cn/js/${code}.js`,
      buildFundFallbackRequestOptions({
        rt: Date.now()
      })
    );

    const payload = String(response.data ?? "").trim();
    if (!payload || payload === "jsonpgz();" || payload === "jsonpgz(null);") {
      return null;
    }

    const data = parsePossiblyWrappedJson(payload);
    return {
      code,
      name: data?.name ?? code,
      netValueDate: data?.jzrq ?? null,
      netValue: toNullableNumber(data?.dwjz),
      valuation: toNullableNumber(data?.gsz),
      valuationChangePercent: toNullableNumber(data?.gszzl),
      valuationTime: data?.gztime ?? null
    };
  } catch {
    return null;
  }
}

async function fetchPingzhongdataFallback(code) {
  try {
    const response = await http.get(
      `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
      buildFundFallbackRequestOptions({
        v: Date.now()
      })
    );

    const payload = String(response.data ?? "");
    const nameMatch = payload.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
    const trendMatch = payload.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!trendMatch) {
      return null;
    }

    const trend = JSON.parse(trendMatch[1]);
    const lastPoint = Array.isArray(trend) && trend.length > 0 ? trend.at(-1) : null;
    if (!lastPoint) {
      return null;
    }

    const timestamp = toNullableNumber(lastPoint.x);
    const netValueDate =
      timestamp !== null ? new Date(timestamp).toISOString().slice(0, 10) : null;

    return {
      code,
      name: nameMatch?.[1] ?? code,
      netValueDate,
      netValue: toNullableNumber(lastPoint.y),
      valuation: null,
      valuationChangePercent: null,
      valuationTime: null
    };
  } catch {
    return null;
  }
}

export function mergeFundQuote(code, primaryQuote, legacyQuote, historyQuote) {
  const name =
    primaryQuote?.name ??
    legacyQuote?.name ??
    historyQuote?.name ??
    code;
  const observation = classifyFundObservation({
    name,
    primaryQuote,
    legacyQuote,
    historyQuote
  });
  const netValueDate = observation.confirmedNavDate;
  const netValue = observation.confirmedNav;
  const valuation = observation.compatibility.valuation;
  const valuationChangePercent = observation.compatibility.valuationChangePercent;
  const valuationTime = observation.compatibility.valuationTime;
  const growthRate = observation.confirmedChangePercent ?? primaryQuote?.growthRate ?? null;
  const estimatedDailyProfitPerUnit =
    observation.intradayValuation !== null && netValue !== null
      ? Number((valuation - netValue).toFixed(4))
      : null;

  return {
    code,
    name,
    netValueDate,
    netValue,
    valuation,
    valuationChangePercent,
    valuationTime,
    growthRate,
    estimatedDailyProfitPerUnit
    ,
    observationKind: observation.observationKind,
    fundTypeHint: observation.fundTypeHint,
    confirmedNavDate: observation.confirmedNavDate,
    confirmedNav: observation.confirmedNav,
    intradayValuation: observation.intradayValuation,
    intradayChangePercent: observation.intradayChangePercent,
    intradayValuationTime: observation.intradayValuationTime,
    intradaySource: observation.intradaySource,
    sourceDiagnostics: observation.sourceDiagnostics
  };
}

export async function searchFunds(keyword) {
  const text = String(keyword ?? "").trim();
  if (!text) {
    throw new Error("keyword is required");
  }

  const response = await http.get(
    "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx",
    {
      params: {
        m: 9,
        key: text
      },
      responseType: "text"
    }
  );

  const data = parsePossiblyWrappedJson(response.data);
  const list = data?.Datas ?? data?.datas ?? [];
  return list.map((item) => ({
    code: item.CODE,
    name: item.NAME,
    type: item.FTYPE,
    pinyin: item.PINYIN,
    id: item.ID
  }));
}

export async function getFundQuotes(fundCodes) {
  const codes = normalizeFundCodes(fundCodes);

  if (codes.length === 0) {
    throw new Error("At least one fund code is required");
  }

  let primaryQuotes = [];
  let primaryError = null;
  try {
    const { data } = await http.get(
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo",
      buildFundPrimaryRequestOptions({
        pageIndex: 1,
        pageSize: 200,
        plat: "Android",
        appType: "ttjj",
        product: "EFund",
        Version: 1,
        deviceid: deviceId,
        Fcodes: codes.join(",")
      })
    );
    primaryQuotes = (data?.Datas ?? []).map(mapPrimaryFundQuote).filter(Boolean);
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error ?? "primary_quote_failed");
  }

  const limitFallback = createConcurrencyLimiter(FUND_FALLBACK_CONCURRENCY);
  const [legacyQuotes, historyQuotes] = await Promise.all([
    Promise.all(codes.map((code) => limitFallback(() => fetchLegacyRealtimeQuote(code)))),
    Promise.all(codes.map((code) => limitFallback(() => fetchPingzhongdataFallback(code))))
  ]);

  const primaryMap = new Map(primaryQuotes.map((item) => [item.code, item]));
  const legacyMap = new Map(
    legacyQuotes.filter(Boolean).map((item) => [item.code, item])
  );
  const historyMap = new Map(
    historyQuotes.filter(Boolean).map((item) => [item.code, item])
  );

  return codes.map((code) => {
    const merged = mergeFundQuote(
      code,
      primaryMap.get(code) ?? null,
      legacyMap.get(code) ?? null,
      historyMap.get(code) ?? null
    );
    if (primaryError) {
      merged.sourceDiagnostics = {
        ...merged.sourceDiagnostics,
        primary: {
          ...(merged.sourceDiagnostics?.primary ?? {}),
          error: primaryError
        }
      };
    }
    return merged;
  });
}

export async function getFundPositionDetails(fundCode) {
  const code = String(fundCode ?? "").trim();
  if (!code) {
    throw new Error("fundCode is required");
  }

  const { data } = await http.get(
    "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition",
    {
      params: {
        FCODE: code
      }
    }
  );

  return {
    fundCode: code,
    positions: data?.Datas?.fundStocks ?? []
  };
}

export async function getFundBaseInfo(fundCode) {
  const code = String(fundCode ?? "").trim();
  if (!code) {
    throw new Error("fundCode is required");
  }

  const { data } = await http.get(
    "https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx",
    {
      params: {
        FCODE: code
      }
    }
  );

  return {
    fundCode: code,
    info: data?.Datas ?? data ?? {}
  };
}

export async function getFundManagers(fundCode) {
  const code = String(fundCode ?? "").trim();
  if (!code) {
    throw new Error("fundCode is required");
  }

  const [listResponse, detailResponse] = await Promise.all([
    http.get("https://fundmobapi.eastmoney.com/FundMApi/FundManagerList.ashx", {
      params: {
        FCODE: code,
        deviceid: "Wap",
        plat: "Wap",
        product: "EFund",
        version: "2.0.0",
        Uid: "",
        _: Date.now()
      }
    }),
    http.get("https://fundmobapi.eastmoney.com/FundMApi/FundMangerDetail.ashx", {
      params: {
        FCODE: code,
        deviceid: "Wap",
        plat: "Wap",
        product: "EFund",
        version: "2.0.0",
        Uid: "",
        _: Date.now()
      }
    })
  ]);

  return {
    fundCode: code,
    managers: listResponse.data?.Datas ?? [],
    details: detailResponse.data?.Datas ?? detailResponse.data ?? {}
  };
}

export async function getFundNetValueHistory(fundCode, chartType = "net") {
  const code = String(fundCode ?? "").trim();
  if (!code) {
    throw new Error("fundCode is required");
  }

  const endpoint =
    chartType === "yield"
      ? "https://fundmobapi.eastmoney.com/FundMApi/FundYieldDiagramNew.ashx"
      : "https://fundmobapi.eastmoney.com/FundMApi/FundNetDiagram.ashx";

  const { data } = await http.get(endpoint, {
    params: {
      FCODE: code
    }
  });

  return {
    fundCode: code,
    chartType,
    series: data?.Datas ?? data ?? []
  };
}

export async function getFundWatchlistQuotes(configPath = "") {
  const defaultWatchlistPath = resolveDefaultWatchlistPath();
  const path = String(configPath ?? "").trim() || defaultWatchlistPath;
  const raw = await readFile(path, "utf8");
  const config = JSON.parse(raw);
  const watchlist = Array.isArray(config?.watchlist) ? config.watchlist : [];
  const enabledItems = watchlist.filter((item) => item && item.enabled !== false && item.code);

  if (enabledItems.length === 0) {
    throw new Error(`No enabled fund codes found in watchlist: ${path}`);
  }

  const quotes = await getFundQuotes(enabledItems.map((item) => item.code));
  const quoteMap = new Map(quotes.map((item) => [item.code, item]));

  const items = enabledItems.map((item) => {
    const quote = quoteMap.get(item.code) ?? null;
    const approxCurrentAmountCny = Number(item.approxCurrentAmountCny ?? 0);
    const estimatedDailyPnlCny =
      quote?.valuationChangePercent !== null &&
      quote?.valuationChangePercent !== undefined &&
      Number.isFinite(approxCurrentAmountCny)
        ? Number((approxCurrentAmountCny * Number(quote.valuationChangePercent) / 100).toFixed(2))
        : null;

    return {
      code: item.code,
      name: item.name ?? quote?.name ?? item.code,
      approxCurrentAmountCny: Number.isFinite(approxCurrentAmountCny) ? approxCurrentAmountCny : null,
      note: item.note ?? null,
      netValueDate: quote?.netValueDate ?? null,
      netValue: quote?.netValue ?? null,
      valuation: quote?.valuation ?? null,
      valuationChangePercent: quote?.valuationChangePercent ?? null,
      valuationTime: quote?.valuationTime ?? null,
      growthRate: quote?.growthRate ?? null,
      estimatedDailyProfitPerUnit: quote?.estimatedDailyProfitPerUnit ?? null,
      estimatedDailyPnlCny
    };
  });

  const monitoredAmountCny = Number(
    items
      .reduce((sum, item) => sum + Number(item.approxCurrentAmountCny ?? 0), 0)
      .toFixed(2)
  );
  const estimatedDailyPnlCny = Number(
    items
      .reduce((sum, item) => sum + Number(item.estimatedDailyPnlCny ?? 0), 0)
      .toFixed(2)
  );

  return {
    configPath: path,
    watchlistDate: config?.as_of ?? null,
    monitoredFunds: items.length,
    monitoredAmountCny,
    estimatedDailyPnlCny,
    items
  };
}
