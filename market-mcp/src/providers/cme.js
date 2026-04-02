import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const CME_PRODUCT_CONFIG = {
  HF_NQ: {
    productId: 146,
    productCode: "NQ",
    stockCode: "hf_NQ",
    pageUrl: "https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.quotes.html",
    displayName: "CME E-mini Nasdaq-100 Futures"
  },
  HF_ES: {
    productId: 133,
    productCode: "ES",
    stockCode: "hf_ES",
    pageUrl: "https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.quotes.html",
    displayName: "CME E-mini S&P 500 Futures"
  }
};

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.MARKET_MCP_CHROME_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
].filter(Boolean);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const CACHE_TTL_MS = Number(process.env.MARKET_MCP_CME_CACHE_TTL_MS ?? 30_000);
const cache = new Map();
const inflight = new Map();

let browserPromise = null;
let cleanupRegistered = false;

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function toNumber(value) {
  if (value === null || value === undefined || value === "-" || value === "") {
    return null;
  }

  const normalized = String(value).replace(/,/g, "").replace(/%/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find a Chrome-compatible browser for CME delayed quotes. Set MARKET_MCP_CHROME_EXECUTABLE."
  );
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = await resolveChromeExecutable();
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check"
        ]
      });

      if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once("beforeExit", closeCmeBrowser);
        process.once("SIGINT", async () => {
          await closeCmeBrowser();
          process.exit(130);
        });
        process.once("SIGTERM", async () => {
          await closeCmeBrowser();
          process.exit(143);
        });
      }

      return browser;
    })();
  }

  return browserPromise;
}

export async function closeCmeBrowser() {
  if (!browserPromise) {
    return;
  }

  try {
    const currentBrowser = await browserPromise;
    await currentBrowser.close();
  } catch {}

  browserPromise = null;
}

function normalizeCmeFuturesCode(rawCode) {
  const input = String(rawCode ?? "").trim().toUpperCase();
  if (!input) {
    return null;
  }

  return CME_PRODUCT_CONFIG[input] ? input : null;
}

async function fetchCmeQuotePayload(productKey) {
  const product = CME_PRODUCT_CONFIG[productKey];
  if (!product) {
    throw new Error(`Unsupported CME futures code: ${productKey}`);
  }

  const cached = cache.get(productKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  const inflightRequest = inflight.get(productKey);
  if (inflightRequest) {
    return inflightRequest;
  }

  const requestPromise = (async () => {
    const browser = await getBrowser();
    const page = await browser.newPage({
      userAgent: USER_AGENT,
      locale: "en-US",
      timezoneId: "America/Chicago"
    });

    try {
      await page.goto(product.pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000
      });

      const response = await page.evaluate(async ({ productId }) => {
        const res = await fetch(`/CmeWS/mvc/quotes/v2/${productId}?isProtected`, {
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*"
          }
        });

        return {
          ok: res.ok,
          status: res.status,
          body: await res.json()
        };
      }, { productId: product.productId });

      if (!response.ok) {
        throw new Error(`CME quote request failed with status ${response.status}`);
      }

      cache.set(productKey, {
        fetchedAt: Date.now(),
        payload: response.body
      });

      return response.body;
    } finally {
      await page.close().catch(() => {});
    }
  })();

  inflight.set(productKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inflight.delete(productKey);
  }
}

export async function getCmeFuturesQuote(stockCode) {
  const productKey = normalizeCmeFuturesCode(stockCode);
  if (!productKey) {
    throw new Error(`Unsupported CME futures code: ${stockCode}`);
  }

  const product = CME_PRODUCT_CONFIG[productKey];
  const payload = await fetchCmeQuotePayload(productKey);
  const quote = payload?.quotes?.find((item) => item.isFrontMonth) ?? payload?.quotes?.[0];

  if (!quote) {
    throw new Error(`No CME delayed quote returned for ${product.stockCode}`);
  }

  const latestPrice = toNumber(quote.last);
  const previousClose = toNumber(quote.priorSettle);
  const high = toNumber(quote.high);
  const low = toNumber(quote.low);

  return compactObject({
    stockCode: product.stockCode,
    name: product.displayName,
    quoteCode: quote.quoteCode ?? product.productCode,
    latestPrice,
    previousClose,
    open: toNumber(quote.open),
    high,
    low,
    volume: toNumber(quote.volume),
    changeValue: toNumber(quote.change),
    changePercent: toNumber(quote.percentageChange),
    amplitude:
      previousClose !== null && high !== null && low !== null
        ? round(((high - low) / previousClose) * 100)
        : null,
    source: "cme_delayed",
    quoteDelayed: payload?.quoteDelayed ?? true,
    quoteDelay: payload?.quoteDelay ?? null,
    quoteTime: quote.updated ?? quote.lastUpdated ?? null,
    tradeDate: payload?.tradeDate ?? null,
    contractMonth: quote.expirationMonth ?? null
  });
}

export { normalizeCmeFuturesCode };
