import { fileURLToPath } from "node:url";

import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { loadTradingAgentsBridgeConfig } from "./lib/tradingagents_bridge.mjs";
import { summarizeTradingAgentsProviderError } from "./lib/tradingagents_decision.mjs";
import {
  collectLiveSymbols,
  inspectTradingAgentsSymbolCacheCoverage,
  resolveTradingAgentsMarketLakeDbPath,
  runLiveRawSnapshot
} from "./run_tradingagents_bridge.mjs";

function parseArgs(argv) {
  const result = {};
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

function normalizeSymbols(value) {
  if (!trimText(value)) {
    return [];
  }
  return [...new Set(String(value)
    .split(",")
    .map((item) => String(item ?? "").trim().toUpperCase())
    .filter(Boolean))];
}

function resolvePrewarmPrioritySymbols(bridgeConfig = {}, providerDefaults = {}) {
  return normalizeSymbols(
    providerDefaults?.prewarmPrioritySymbols ??
      bridgeConfig?.prewarmPrioritySymbols ??
      "QQQ,SOXX,KWEB,ARKK,ASHR"
  );
}

function resolvePrewarmMaxSymbolsPerRun(rawOptions = {}, providerDefaults = {}) {
  const numeric = Number(
    rawOptions?.maxSymbols ??
      rawOptions?.["max-symbols"] ??
      providerDefaults?.prewarmMaxSymbolsPerRun ??
      1
  );
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 1;
}

export function orderTradingAgentsPrewarmTargets(targets = [], prioritySymbols = []) {
  const priorityRank = new Map(
    prioritySymbols.map((symbol, index) => [String(symbol).toUpperCase(), index])
  );
  return [...new Set(targets.map((symbol) => String(symbol ?? "").trim().toUpperCase()).filter(Boolean))]
    .sort((left, right) => {
      const leftRank = priorityRank.has(left) ? priorityRank.get(left) : Number.MAX_SAFE_INTEGER;
      const rightRank = priorityRank.has(right) ? priorityRank.get(right) : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.localeCompare(right);
    });
}

export async function runTradingAgentsPrewarm(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const loadConfig = deps.loadConfig ?? loadTradingAgentsBridgeConfig;
  const inspectCoverage = deps.inspectCoverage ?? inspectTradingAgentsSymbolCacheCoverage;
  const runSnapshot = deps.runSnapshot ?? runLiveRawSnapshot;
  const resolveMarketLakeDbPath = deps.resolveMarketLakeDbPath ?? resolveTradingAgentsMarketLakeDbPath;
  const bridgeConfig = await loadConfig(rawOptions?.configPath);
  const tradeDate = String(rawOptions?.tradeDate ?? rawOptions?.["trade-date"] ?? formatShanghaiDate()).trim();
  const providerDefaults = bridgeConfig?.providerDefaults ?? {};
  const configuredSymbols = collectLiveSymbols(bridgeConfig);
  const requestedSymbols = normalizeSymbols(rawOptions?.symbols ?? rawOptions?.symbolsCsv);
  const symbols = requestedSymbols.length > 0
    ? configuredSymbols.filter((symbol) => requestedSymbols.includes(symbol))
    : configuredSymbols;

  const initialCoverage = await inspectCoverage({
    symbols,
    tradeDate,
    providerDefaults,
    portfolioRoot
  });

  const warmTargets = orderTradingAgentsPrewarmTargets(
    [...initialCoverage.missingSymbols, ...initialCoverage.staleSymbols],
    resolvePrewarmPrioritySymbols(bridgeConfig, providerDefaults)
  ).slice(0, resolvePrewarmMaxSymbolsPerRun(rawOptions, providerDefaults));
  const warmed = [];
  const failed = [];
  const marketLakeDbPath = await resolveMarketLakeDbPath(portfolioRoot);

  for (const symbol of warmTargets) {
    try {
      const snapshot = runSnapshot({
        tradeDate,
        symbols: [symbol],
        providerDefaults,
        externalPython: String(rawOptions?.externalPython ?? "/Users/yinshiwei/codex/external/TradingAgents/.venv/bin/python"),
        marketLakeDbPath,
        portfolioRoot
      });
      warmed.push({
        symbol,
        callCount: Array.isArray(snapshot?.calls) ? snapshot.calls.length : 0,
        rating: snapshot?.calls?.[0]?.rating ?? null
      });
    } catch (error) {
      failed.push({
        symbol,
        error: summarizeTradingAgentsProviderError(error?.message ?? error, providerDefaults?.llmProvider)
      });
    }
  }

  const finalCoverage = await inspectCoverage({
    symbols,
    tradeDate,
    providerDefaults,
    portfolioRoot
  });

  return {
    portfolioRoot,
    accountId,
    tradeDate,
    requestedSymbolCount: symbols.length,
    requestedSymbols: symbols,
    warmTargetCount: warmTargets.length,
    warmTargets,
    initialCoverage: {
      freshSymbols: initialCoverage.freshSymbols,
      staleSymbols: initialCoverage.staleSymbols,
      missingSymbols: initialCoverage.missingSymbols
    },
    warmed,
    failed,
    finalCoverage: {
      freshSymbols: finalCoverage.freshSymbols,
      staleSymbols: finalCoverage.staleSymbols,
      missingSymbols: finalCoverage.missingSymbols,
      fullyFresh: finalCoverage.fullyFresh
    }
  };
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runTradingAgentsPrewarm(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${String(error?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
