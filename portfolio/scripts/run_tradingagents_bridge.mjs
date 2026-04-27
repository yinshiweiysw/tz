import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { readJsonOrDefault } from "./lib/atomic_json_state.mjs";
import { readManifestState } from "./lib/manifest_state.mjs";
import {
  loadTradingAgentsBridgeConfig,
  loadTradingAgentsRawFixture,
  persistTradingAdviceArtifacts
} from "./lib/tradingagents_bridge.mjs";

const defaultExternalPython = "/Users/yinshiwei/codex/external/TradingAgents/.venv/bin/python";
const defaultProcessTimeoutMs = 15 * 60 * 1000;

function toPositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function toNonNegativeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function normalizeSelectedAnalysts(value, fallback = ["market", "social", "news", "fundamentals"]) {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  const items = raw
    .split(",")
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : fallback;
}

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function slugify(value) {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}

function parseIsoDate(value) {
  const text = trimText(value);
  if (!text) {
    return null;
  }
  const normalized = text.endsWith("Z") ? text.replace("Z", "+00:00") : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function computeAgeHours(value, now = new Date()) {
  const date = parseIsoDate(value);
  if (!date) {
    return null;
  }
  return Math.max(0, (now.getTime() - date.getTime()) / (60 * 60 * 1000));
}

function parseArgs(argv) {
  const result = {
    mode: "live"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }

  return result;
}

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function collectLiveSymbols(bridgeConfig = {}) {
  return [...new Set(
    Object.values(bridgeConfig?.bucketProxyUniverse ?? {})
      .flatMap((items) => (Array.isArray(items) ? items : []))
      .map((item) => String(item ?? "").trim().toUpperCase())
      .filter(Boolean)
  )];
}

export function resolveTradingAgentsSymbolCacheRoot({ portfolioRoot = "", env = process.env } = {}) {
  const explicit = trimText(env?.TRADINGAGENTS_SYMBOL_CACHE_DIR);
  if (explicit) {
    return explicit;
  }
  const root = trimText(portfolioRoot) ?? resolvePortfolioRoot({ portfolioRoot });
  return path.join(root, "data", "tradingagents_symbol_cache");
}

export function buildTradingAgentsSymbolCachePath({
  symbol,
  tradeDate,
  providerDefaults = {},
  portfolioRoot = "",
  env = process.env
} = {}) {
  return path.join(
    resolveTradingAgentsSymbolCacheRoot({ portfolioRoot, env }),
    slugify(tradeDate),
    slugify(providerDefaults?.llmProvider ?? "glm"),
    slugify(providerDefaults?.deepThinkModel ?? "glm-5.1"),
    slugify(providerDefaults?.quickThinkModel ?? "glm-5"),
    `${slugify(String(symbol ?? "").toUpperCase())}.json`
  );
}

export async function inspectTradingAgentsSymbolCacheCoverage({
  symbols = [],
  tradeDate,
  providerDefaults = {},
  portfolioRoot = "",
  env = process.env,
  now = new Date()
} = {}) {
  const ttlHours = toPositiveNumber(providerDefaults?.symbolCacheTtlHours, 18);
  const freshEntries = [];
  const staleEntries = [];
  const missingSymbols = [];

  for (const symbol of symbols) {
    const cachePath = buildTradingAgentsSymbolCachePath({
      symbol,
      tradeDate,
      providerDefaults,
      portfolioRoot,
      env
    });

    let payload = null;
    try {
      payload = JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      missingSymbols.push(String(symbol).toUpperCase());
      continue;
    }

    if (trimText(payload?.asOf) !== trimText(tradeDate) || !payload?.call) {
      missingSymbols.push(String(symbol).toUpperCase());
      continue;
    }

    const ageHours = computeAgeHours(payload?.generatedAt, now);
    const entry = {
      symbol: String(symbol).toUpperCase(),
      cachePath,
      ageHours,
      payload,
      call: payload.call
    };

    if (ageHours !== null && ageHours <= ttlHours) {
      freshEntries.push(entry);
    } else {
      staleEntries.push(entry);
    }
  }

  return {
    tradeDate,
    ttlHours,
    freshEntries,
    staleEntries,
    missingSymbols,
    freshSymbols: freshEntries.map((entry) => entry.symbol),
    staleSymbols: staleEntries.map((entry) => entry.symbol),
    fullyFresh: freshEntries.length === symbols.length && symbols.length > 0
  };
}

export function buildLiveRawSnapshotFromSymbolCache({
  tradeDate,
  symbols = [],
  providerDefaults = {},
  cachedEntries = [],
  now = new Date()
} = {}) {
  const bySymbol = new Map(cachedEntries.map((entry) => [entry.symbol, entry]));
  const calls = symbols
    .map((symbol) => {
      const entry = bySymbol.get(String(symbol).toUpperCase());
      if (!entry?.call) {
        return null;
      }
      const runtimeDiagnostics = {
        ...(entry.call.runtimeDiagnostics ?? {}),
        cacheStatus: "hit",
        cacheAgeHours: entry.ageHours === null ? null : Number(entry.ageHours.toFixed(2))
      };
      return {
        ...entry.call,
        runtimeDiagnostics
      };
    })
    .filter(Boolean);

  return {
    generatedAt: now.toISOString(),
    asOf: tradeDate,
    mode: "live",
    source: "TradingAgents",
    provider: String(providerDefaults?.llmProvider ?? "glm"),
    runtimeConfig: {
      requestTimeoutSeconds: toPositiveNumber(providerDefaults?.requestTimeoutSeconds, 90),
      requestMaxRetries: Math.max(0, Number(providerDefaults?.requestMaxRetries) || 0),
      selectedAnalysts: normalizeSelectedAnalysts(providerDefaults?.selectedAnalysts),
      maxTokens: Math.max(1, Number(providerDefaults?.maxTokens) || 1200),
      temperature: toNonNegativeNumber(providerDefaults?.temperature, 0.2),
      thinkingType: String(providerDefaults?.thinkingType ?? "disabled"),
      marketDataToolMaxRows: Math.max(1, Number(providerDefaults?.marketDataToolMaxRows) || 120),
      indicatorToolMaxLookbackDays: Math.max(1, Number(providerDefaults?.indicatorToolMaxLookbackDays) || 30),
      httpTransportProfile: "stable_http1_single_connection_no_keepalive",
      invokeMaxAttempts: Math.max(1, Number(providerDefaults?.invokeMaxAttempts) || 3),
      invokeBackoffSeconds: toPositiveNumber(providerDefaults?.invokeBackoffSeconds, 12),
      invokeMaxBackoffSeconds: toPositiveNumber(providerDefaults?.invokeMaxBackoffSeconds, 60),
      invokeIntervalSeconds: toNonNegativeNumber(providerDefaults?.invokeIntervalSeconds, 2),
      symbolMaxAttempts: Math.max(1, Number(providerDefaults?.symbolMaxAttempts) || 2),
      symbolBackoffSeconds: toPositiveNumber(providerDefaults?.symbolBackoffSeconds, 30),
      symbolMaxBackoffSeconds: toPositiveNumber(providerDefaults?.symbolMaxBackoffSeconds, 120),
      symbolIntervalSeconds: toNonNegativeNumber(providerDefaults?.symbolIntervalSeconds, 8),
      symbolCacheTtlHours: toPositiveNumber(providerDefaults?.symbolCacheTtlHours, 18)
    },
    runtimeDiagnostics: {
      cacheOnlyBridge: true,
      cacheHits: calls.length,
      cacheFallbacks: 0,
      liveRuns: 0,
      symbolCacheTtlHours: toPositiveNumber(providerDefaults?.symbolCacheTtlHours, 18),
      allowStaleSymbolCacheOnError: Number(providerDefaults?.allowStaleSymbolCacheOnError) === 0 ? false : true
    },
    calls
  };
}

export function runLiveRawSnapshot({
  tradeDate,
  symbols,
  providerDefaults = {},
  externalPython = defaultExternalPython,
  marketLakeDbPath = "",
  portfolioRoot = "",
  spawnSyncFn = spawnSync
} = {}) {
  const runnerScript = fileURLToPath(new URL("./run_tradingagents_raw_snapshot.py", import.meta.url));
  const processTimeoutMs = toPositiveNumber(providerDefaults?.processTimeoutMs, defaultProcessTimeoutMs);
  const result = spawnSyncFn(
    externalPython,
    [
      runnerScript,
      "--symbols",
      symbols.join(","),
      "--trade-date",
      tradeDate,
      "--provider",
      String(providerDefaults?.llmProvider ?? "glm"),
      "--deep-model",
      String(providerDefaults?.deepThinkModel ?? "glm-5.1"),
      "--quick-model",
      String(providerDefaults?.quickThinkModel ?? "glm-5"),
      "--selected-analysts",
      normalizeSelectedAnalysts(providerDefaults?.selectedAnalysts).join(","),
      "--output-language",
      String(providerDefaults?.outputLanguage ?? "Chinese"),
      "--backend-url",
      String(providerDefaults?.backendUrl ?? "https://api.z.ai/api/paas/v4/"),
      "--request-timeout-seconds",
      String(toPositiveNumber(providerDefaults?.requestTimeoutSeconds, 45)),
      "--request-max-retries",
      String(toNonNegativeInteger(providerDefaults?.requestMaxRetries, 2)),
      "--max-tokens",
      String(Math.max(1, Number(providerDefaults?.maxTokens) || 1200)),
      "--temperature",
      String(toNonNegativeNumber(providerDefaults?.temperature, 0.2)),
      "--thinking-type",
      String(providerDefaults?.thinkingType ?? "disabled"),
      "--market-data-tool-max-rows",
      String(Math.max(1, Number(providerDefaults?.marketDataToolMaxRows) || 120)),
      "--indicator-tool-max-lookback-days",
      String(Math.max(1, Number(providerDefaults?.indicatorToolMaxLookbackDays) || 30)),
      "--invoke-max-attempts",
      String(Math.max(1, Number(providerDefaults?.invokeMaxAttempts) || 3)),
      "--invoke-backoff-seconds",
      String(toPositiveNumber(providerDefaults?.invokeBackoffSeconds, 8)),
      "--invoke-max-backoff-seconds",
      String(toPositiveNumber(providerDefaults?.invokeMaxBackoffSeconds, 45)),
      "--invoke-interval-seconds",
      String(toNonNegativeNumber(providerDefaults?.invokeIntervalSeconds, 2)),
      "--symbol-max-attempts",
      String(Math.max(1, Number(providerDefaults?.symbolMaxAttempts) || 2)),
      "--symbol-backoff-seconds",
      String(toPositiveNumber(providerDefaults?.symbolBackoffSeconds, 20)),
      "--symbol-max-backoff-seconds",
      String(toPositiveNumber(providerDefaults?.symbolMaxBackoffSeconds, 90)),
      "--symbol-interval-seconds",
      String(toNonNegativeNumber(providerDefaults?.symbolIntervalSeconds, 5)),
      "--symbol-cache-ttl-hours",
      String(toPositiveNumber(providerDefaults?.symbolCacheTtlHours, 18)),
      "--allow-stale-symbol-cache-on-error",
      String(Number(providerDefaults?.allowStaleSymbolCacheOnError) === 0 ? 0 : 1),
      "--output",
      "-"
    ],
    {
      encoding: "utf8",
      timeout: processTimeoutMs,
      maxBuffer: Math.max(1024 * 1024, Number(providerDefaults?.processMaxBufferBytes) || 8 * 1024 * 1024),
      env: {
        ...process.env,
        LANGCHAIN_OPENAI_TCP_KEEPALIVE: process.env.LANGCHAIN_OPENAI_TCP_KEEPALIVE || "0",
        ...(String(portfolioRoot ?? "").trim() ? { PORTFOLIO_ROOT: String(portfolioRoot).trim() } : {}),
        ...(String(marketLakeDbPath ?? "").trim()
          ? { TRADINGAGENTS_MARKET_LAKE_DB: String(marketLakeDbPath).trim() }
          : {})
      }
    }
  );

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`TradingAgents live snapshot timed out after ${processTimeoutMs}ms`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || "TradingAgents live snapshot failed").trim());
  }

  return JSON.parse(String(result.stdout ?? "{}").trim() || "{}");
}

export async function resolveTradingAgentsMarketLakeDbPath(portfolioRoot) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  return String(
    manifest?.canonical_entrypoints?.market_lake_db ??
      buildPortfolioPath(portfolioRoot, "data", "market_lake.db")
  ).trim();
}

export async function runTradingAgentsBridge(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const mode = String(rawOptions?.mode ?? "live").trim().toLowerCase() || "live";
  let resolvedMode = mode;
  const bridgeConfig = await loadTradingAgentsBridgeConfig(rawOptions?.configPath);
  const tradeDate = String(rawOptions?.tradeDate ?? rawOptions?.["trade-date"] ?? formatShanghaiDate()).trim();

  let rawSnapshot;
  if (mode === "live") {
    const symbols = collectLiveSymbols(bridgeConfig);
    const marketLakeDbPath = await resolveTradingAgentsMarketLakeDbPath(portfolioRoot);
    const providerDefaults = bridgeConfig?.providerDefaults ?? {};
    const cacheOnly = rawOptions?.cacheOnly === true || rawOptions?.["cache-only"] === true || rawOptions?.["cache-only"] === "1";
    const cacheCoverage = await inspectTradingAgentsSymbolCacheCoverage({
      symbols,
      tradeDate,
      providerDefaults,
      portfolioRoot
    });

    if (cacheCoverage.fullyFresh) {
      rawSnapshot = buildLiveRawSnapshotFromSymbolCache({
        tradeDate,
        symbols,
        providerDefaults,
        cachedEntries: cacheCoverage.freshEntries,
        now: new Date()
      });
    } else if (cacheOnly) {
      throw new Error(
        [
          "tradingagents_symbol_cache_incomplete",
          `fresh=${cacheCoverage.freshSymbols.join(",") || "none"}`,
          `missing=${cacheCoverage.missingSymbols.join(",") || "none"}`,
          `stale=${cacheCoverage.staleSymbols.join(",") || "none"}`
        ].join(" ")
      );
    } else {
      rawSnapshot = runLiveRawSnapshot({
        tradeDate,
        symbols,
        providerDefaults,
        externalPython: String(rawOptions?.externalPython ?? defaultExternalPython),
        marketLakeDbPath,
        portfolioRoot
      });
      rawSnapshot.runtimeDiagnostics = {
        ...(rawSnapshot.runtimeDiagnostics ?? {}),
        bridgeFreshSymbolCacheHitsBeforeRun: cacheCoverage.freshEntries.length,
        bridgeMissingSymbolsBeforeRun: cacheCoverage.missingSymbols,
        bridgeStaleSymbolsBeforeRun: cacheCoverage.staleSymbols
      };
    }
  } else if (rawOptions?.rawInput || rawOptions?.["raw-input"]) {
    rawSnapshot =
      (await readJsonOrDefault(String(rawOptions?.rawInput ?? rawOptions?.["raw-input"]), null)) ??
      (await loadTradingAgentsRawFixture());
    resolvedMode = "fixture";
  } else {
    rawSnapshot = await loadTradingAgentsRawFixture();
    resolvedMode = "fixture";
  }

  if (!rawSnapshot?.generatedAt) {
    rawSnapshot.generatedAt = new Date().toISOString();
  }
  if (!rawSnapshot?.asOf) {
    rawSnapshot.asOf = tradeDate;
  }
  rawSnapshot.mode = resolvedMode === "live" ? "live" : "fixture";

  const persisted = await persistTradingAdviceArtifacts({
    portfolioRoot,
    accountId,
    rawSnapshot,
    bridgeConfig,
    now: new Date()
  });

  return {
    portfolioRoot,
    accountId,
    mode: rawSnapshot.mode,
    rawSnapshotPath: persisted.rawSnapshotPath,
    adviceSnapshotPath: persisted.adviceSnapshotPath,
    rawSnapshot,
    adviceSnapshot: persisted.adviceSnapshot
  };
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runTradingAgentsBridge(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${String(error?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
