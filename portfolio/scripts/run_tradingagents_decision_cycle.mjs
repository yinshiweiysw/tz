import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { loadTradingAgentsBridgeConfig, loadTradingAgentsRawFixture, persistTradingAdviceArtifacts } from "./lib/tradingagents_bridge.mjs";
import {
  persistTradingDecisionArtifacts,
  summarizeTradingAgentsProviderError
} from "./lib/tradingagents_decision.mjs";
import {
  collectLiveSymbols,
  resolveTradingAgentsMarketLakeDbPath,
  runTradingAgentsBridge
} from "./run_tradingagents_bridge.mjs";

const PROVIDER_ENV_VARS = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  glm: "ZHIPU_API_KEY"
};

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

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

export function checkTradingAgentsProviderReady({ bridgeConfig = {}, env = process.env } = {}) {
  const provider = String(bridgeConfig?.providerDefaults?.llmProvider ?? "glm").trim().toLowerCase() || "glm";
  const envName = PROVIDER_ENV_VARS[provider] ?? null;
  if (envName && !trimText(env?.[envName])) {
    return {
      ready: false,
      provider,
      envName,
      error: `Missing required API key: ${envName}`
    };
  }
  return {
    ready: true,
    provider,
    envName
  };
}

export function runTradingAgentsMarketLakeRefresh({
  portfolioRoot,
  tradeDate,
  symbols = [],
  marketLakeDbPath = "",
  externalPython = "python3",
  maxStaleDays = 4,
  spawnSyncFn = spawnSync
} = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return {
      status: "skipped_no_symbols",
      triggered: false,
      symbols: []
    };
  }

  const refreshScript = fileURLToPath(new URL("./tradingagents_market_lake_refresh.py", import.meta.url));
  const result = spawnSyncFn(
    externalPython,
    [
      refreshScript,
      "--portfolio-root",
      String(portfolioRoot ?? ""),
      "--db",
      String(marketLakeDbPath ?? ""),
      "--trade-date",
      String(tradeDate ?? ""),
      "--symbols",
      symbols.join(","),
      "--max-stale-days",
      String(Math.max(0, Number(maxStaleDays) || 4))
    ],
    {
      encoding: "utf8"
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || "TradingAgents market_lake refresh failed").trim());
  }
  return parseJsonOutput(result.stdout);
}

function buildFallbackRawSnapshot({ fixture = {}, tradeDate, bridgeConfig = {}, reason } = {}) {
  return {
    ...fixture,
    generatedAt: new Date().toISOString(),
    asOf: tradeDate,
    mode: "fallback_fixture",
    source: trimText(fixture?.source) ?? "TradingAgents",
    provider: trimText(bridgeConfig?.providerDefaults?.llmProvider) ?? "glm",
    calls: Array.isArray(fixture?.calls) ? fixture.calls : [],
    fallbackReason: trimText(reason)
  };
}

function normalizeCycleProviderError(value, provider) {
  return summarizeTradingAgentsProviderError(value, provider);
}

function summarizeCycleDiagnosticError(value, provider) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const providerError = normalizeCycleProviderError(text, provider);
  if (providerError && /^(provider_|market_data_)/.test(providerError)) {
    return providerError;
  }

  if (/Traceback/i.test(text)) {
    const exceptionMarkers = [...text.matchAll(/[A-Za-z0-9_.]+(?:Error|Exception):/g)];
    if (exceptionMarkers.length > 0) {
      const marker = exceptionMarkers[exceptionMarkers.length - 1];
      const tail = text
        .slice(marker.index ?? 0)
        .replace(/\s+/g, " ")
        .trim();
      if (tail) {
        return tail.length > 240 ? `${tail.slice(0, 237)}...` : tail;
      }
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compact = lines.length > 1 ? lines[lines.length - 1] : text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

export async function runTradingAgentsDecisionCycle(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const bridgeConfig = await loadTradingAgentsBridgeConfig(rawOptions?.configPath);
  const providerName = String(bridgeConfig?.providerDefaults?.llmProvider ?? "glm").trim().toLowerCase() || "glm";
  const tradeDate = String(rawOptions?.tradeDate ?? rawOptions?.["trade-date"] ?? formatShanghaiDate()).trim();
  const mode = String(rawOptions?.mode ?? "live").trim().toLowerCase() || "live";
  const allowFallback = rawOptions?.allowFallback !== false && rawOptions?.["allow-fallback"] !== "0";
  const executeBridge = deps.runBridge ?? runTradingAgentsBridge;
  const persistDecision = deps.persistDecision ?? persistTradingDecisionArtifacts;
  const refreshMarketLake = deps.refreshMarketLake ?? runTradingAgentsMarketLakeRefresh;
  const checkProviderReady = deps.checkProviderReady ?? checkTradingAgentsProviderReady;
  const now = new Date();

  let rawSnapshot = null;
  let adviceSnapshot = null;
  let bridgeResult = null;
  let providerError = null;
  let fallbackReason = null;
  let marketDataRefresh = null;

  if (mode === "live") {
    const providerReady = checkProviderReady({
      bridgeConfig,
      env: deps.env ?? process.env
    });
    if (!providerReady.ready) {
      providerError = normalizeCycleProviderError(providerReady.error, providerReady.provider);
      fallbackReason = "missing_provider_key_using_fixture";
      marketDataRefresh = {
        status: "skipped_missing_provider_key",
        triggered: false,
        reason: providerError
      };
      if (!allowFallback) {
        throw new Error(providerError);
      }
    } else {
      try {
        marketDataRefresh = await refreshMarketLake({
          portfolioRoot,
          tradeDate,
          symbols: collectLiveSymbols(bridgeConfig),
          marketLakeDbPath: await resolveTradingAgentsMarketLakeDbPath(portfolioRoot),
          externalPython: String(
            rawOptions?.refreshPython ??
              rawOptions?.externalPython ??
              "/Users/yinshiwei/codex/external/TradingAgents/.venv/bin/python"
          ),
          maxStaleDays: Number(rawOptions?.marketDataMaxStaleDays ?? rawOptions?.["market-data-max-stale-days"]) || 4
        });
      } catch (error) {
      marketDataRefresh = {
        status: "failed",
        triggered: true,
        error: summarizeCycleDiagnosticError(error?.message ?? error, providerName)
      };
      }
    }
  }

  try {
    if (!providerError) {
      bridgeResult = await executeBridge({
        ...rawOptions,
        portfolioRoot,
        user: accountId,
        mode,
        tradeDate,
        "trade-date": tradeDate
      });
      rawSnapshot = bridgeResult?.rawSnapshot ?? null;
      adviceSnapshot = bridgeResult?.adviceSnapshot ?? null;
    }
  } catch (error) {
    providerError = normalizeCycleProviderError(String(error?.message ?? error), providerName);
    if (!allowFallback) {
      throw new Error(providerError);
    }

    fallbackReason = mode === "live" ? "live_call_failed_using_fixture" : "non_live_mode_requested";
  }

  if (providerError && !rawSnapshot) {
    rawSnapshot = buildFallbackRawSnapshot({
      fixture: await loadTradingAgentsRawFixture(),
      tradeDate,
      bridgeConfig,
      reason: providerError
    });
    const persisted = await persistTradingAdviceArtifacts({
      portfolioRoot,
      accountId,
      rawSnapshot,
      bridgeConfig,
      now
    });
    adviceSnapshot = persisted.adviceSnapshot;
    bridgeResult = {
      portfolioRoot,
      accountId,
      mode: rawSnapshot.mode,
      rawSnapshotPath: persisted.rawSnapshotPath,
      adviceSnapshotPath: persisted.adviceSnapshotPath,
      rawSnapshot,
      adviceSnapshot
    };
  }

  const persistedDecision = await persistDecision({
    portfolioRoot,
    accountId,
    rawSnapshot: rawSnapshot ?? {},
    adviceSnapshot: adviceSnapshot ?? {},
    bridgeConfig,
    diagnostics: {
      liveRequested: mode === "live",
      fallbackReason,
      providerError,
      marketDataRefresh
    },
    now
  });

  return {
    portfolioRoot,
    accountId,
    mode: rawSnapshot?.mode ?? mode,
    rawSnapshotPath: bridgeResult?.rawSnapshotPath ?? null,
    adviceSnapshotPath: bridgeResult?.adviceSnapshotPath ?? null,
    decisionSnapshotPath: persistedDecision.decisionSnapshotPath,
    adviceSnapshot,
    decisionSnapshot: persistedDecision.decisionSnapshot,
    diagnostics: {
      fallbackReason,
      providerError,
      marketDataRefresh
    }
  };
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runTradingAgentsDecisionCycle(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${String(error?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
