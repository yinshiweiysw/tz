import { fileURLToPath } from "node:url";

import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./lib/atomic_json_state.mjs";
import { loadTradingAgentsBridgeConfig } from "./lib/tradingagents_bridge.mjs";
import { summarizeTradingAgentsProviderError } from "./lib/tradingagents_decision.mjs";
import {
  collectLiveSymbols,
  inspectTradingAgentsSymbolCacheCoverage,
  resolveTradingAgentsMarketLakeDbPath,
  runLiveRawSnapshot
} from "./run_tradingagents_bridge.mjs";

const DEFAULT_PREWARM_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_PREWARM_CIRCUIT_BREAKER_TIMEOUT_THRESHOLD = 3;
const DEFAULT_PREWARM_CIRCUIT_BREAKER_COOLDOWN_MS = 2 * 60 * 60 * 1000;

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

function normalizeProviderName(value) {
  return trimText(value)?.toLowerCase() ?? null;
}

function normalizeBrainProfile(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["fast", "full"].includes(text) ? text : "full";
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

function extractTradingAgentsDiagnosticPath(value) {
  const text = String(value ?? "");
  return text.match(/\[tradingagents_diagnostic\]\s+path=([^\s]+)/)?.[1] ?? null;
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

function resolvePrewarmCooldownMs(rawOptions = {}, providerDefaults = {}) {
  const numeric = Number(
    rawOptions?.cooldownMs ??
      rawOptions?.["cooldown-ms"] ??
      providerDefaults?.prewarmCooldownMs ??
      DEFAULT_PREWARM_COOLDOWN_MS
  );
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : DEFAULT_PREWARM_COOLDOWN_MS;
}

function resolvePrewarmCircuitBreakerTimeoutThreshold(rawOptions = {}, providerDefaults = {}) {
  const numeric = Number(
    rawOptions?.circuitBreakerTimeoutThreshold ??
      rawOptions?.["circuit-breaker-timeout-threshold"] ??
      providerDefaults?.prewarmCircuitBreakerTimeoutThreshold ??
      DEFAULT_PREWARM_CIRCUIT_BREAKER_TIMEOUT_THRESHOLD
  );
  return Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : DEFAULT_PREWARM_CIRCUIT_BREAKER_TIMEOUT_THRESHOLD;
}

function resolvePrewarmCircuitBreakerCooldownMs(rawOptions = {}, providerDefaults = {}) {
  const numeric = Number(
    rawOptions?.circuitBreakerCooldownMs ??
      rawOptions?.["circuit-breaker-cooldown-ms"] ??
      providerDefaults?.prewarmCircuitBreakerCooldownMs ??
      DEFAULT_PREWARM_CIRCUIT_BREAKER_COOLDOWN_MS
  );
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.floor(numeric)
    : DEFAULT_PREWARM_CIRCUIT_BREAKER_COOLDOWN_MS;
}

function resolveProviderChainItems(bridgeConfig = {}) {
  return [
    bridgeConfig?.providerChain?.primary,
    ...(Array.isArray(bridgeConfig?.providerChain?.fallback)
      ? bridgeConfig.providerChain.fallback
      : bridgeConfig?.providerChain?.fallback
        ? [bridgeConfig.providerChain.fallback]
        : [])
  ].filter(Boolean);
}

export function resolvePrewarmProviderDefaults(bridgeConfig = {}, rawOptions = {}) {
  const baseDefaults = bridgeConfig?.providerDefaults ?? {};
  const requestedProvider = normalizeProviderName(
    rawOptions?.provider ?? rawOptions?.["provider"] ?? rawOptions?.providerUsed
  );
  if (!requestedProvider) {
    return baseDefaults;
  }
  const matched = resolveProviderChainItems(bridgeConfig).find(
    (item) => normalizeProviderName(item?.llmProvider) === requestedProvider
  );
  return {
    ...baseDefaults,
    ...(matched ?? {}),
    llmProvider: requestedProvider
  };
}

function resolvePrewarmProviderCandidates(bridgeConfig = {}, rawOptions = {}) {
  const requestedProvider = normalizeProviderName(
    rawOptions?.provider ?? rawOptions?.["provider"] ?? rawOptions?.providerUsed
  );
  if (requestedProvider) {
    return [resolvePrewarmProviderDefaults(bridgeConfig, rawOptions)];
  }
  const baseDefaults = bridgeConfig?.providerDefaults ?? {};
  const chainItems = resolveProviderChainItems(bridgeConfig);
  const rawCandidates = chainItems.length > 0 ? chainItems : [baseDefaults];
  const seen = new Set();
  return rawCandidates
    .map((item) => ({
      ...baseDefaults,
      ...(item ?? {})
    }))
    .filter((item) => {
      const key = buildTradingAgentsPrewarmProviderKey(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export function buildTradingAgentsPrewarmProviderKey(providerDefaults = {}) {
  const key = [
    normalizeProviderName(providerDefaults?.llmProvider) ?? "provider",
    trimText(providerDefaults?.deepThinkModel) ?? "deep",
    trimText(providerDefaults?.quickThinkModel) ?? "quick"
  ];
  const brainProfile = normalizeBrainProfile(providerDefaults?.brainProfile);
  if (brainProfile !== "full") {
    key.push(brainProfile);
  }
  return key.join("/");
}

export function buildTradingAgentsPrewarmLegacyProviderKey(providerDefaults = {}) {
  return [
    normalizeProviderName(providerDefaults?.llmProvider) ?? "provider",
    trimText(providerDefaults?.deepThinkModel) ?? "deep",
    trimText(providerDefaults?.quickThinkModel) ?? "quick"
  ].join("/");
}

export function resolveTradingAgentsPrewarmStatusPath(portfolioRoot) {
  return `${String(portfolioRoot ?? "").replace(/\/$/, "")}/data/tradingagents_prewarm_status.json`;
}

export async function loadTradingAgentsPrewarmStatus(portfolioRoot) {
  return readJsonOrDefault(resolveTradingAgentsPrewarmStatusPath(portfolioRoot), {
    generatedAt: null,
    providers: {}
  });
}

function parseDate(value) {
  const text = trimText(value);
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isCooldownActive(entry = {}, now = new Date()) {
  const cooldownUntil = parseDate(entry?.cooldownUntil);
  return Boolean(cooldownUntil && cooldownUntil.getTime() > now.getTime());
}

export function isTradingAgentsPrewarmCircuitBreakerActive(circuitBreaker = {}, now = new Date()) {
  if (String(circuitBreaker?.status ?? "").trim() !== "open") {
    return false;
  }
  const cooldownUntil = parseDate(circuitBreaker?.cooldownUntil);
  return Boolean(cooldownUntil && cooldownUntil.getTime() > now.getTime());
}

export function normalizeTradingAgentsPrewarmCircuitBreaker(circuitBreaker = {}, now = new Date()) {
  if (!circuitBreaker || typeof circuitBreaker !== "object") {
    return null;
  }
  const status = String(circuitBreaker?.status ?? "").trim() || "closed";
    return {
      status,
      active: isTradingAgentsPrewarmCircuitBreakerActive(circuitBreaker, now),
      reason: trimText(circuitBreaker?.reason),
      provider: trimText(circuitBreaker?.provider),
      deepModel: trimText(circuitBreaker?.deepModel),
      quickModel: trimText(circuitBreaker?.quickModel),
      brainProfile: normalizeBrainProfile(circuitBreaker?.brainProfile),
      tradeDate: trimText(circuitBreaker?.tradeDate),
    openedAt: trimText(circuitBreaker?.openedAt),
    cooldownUntil: trimText(circuitBreaker?.cooldownUntil),
    timeoutCount: Number.isFinite(Number(circuitBreaker?.timeoutCount))
      ? Number(circuitBreaker.timeoutCount)
      : 0,
    timeoutSymbols: Array.isArray(circuitBreaker?.timeoutSymbols)
      ? circuitBreaker.timeoutSymbols.map((item) => String(item ?? "").trim().toUpperCase()).filter(Boolean)
      : [],
    threshold: Number.isFinite(Number(circuitBreaker?.threshold))
      ? Number(circuitBreaker.threshold)
      : null
  };
}

function buildSlowGraphCircuitBreaker({
  previousCircuitBreaker = null,
  runtimeBySymbol = {},
  symbols = [],
  tradeDate,
  providerDefaults = {},
  now = new Date(),
  threshold = DEFAULT_PREWARM_CIRCUIT_BREAKER_TIMEOUT_THRESHOLD,
  cooldownMs = DEFAULT_PREWARM_CIRCUIT_BREAKER_COOLDOWN_MS
} = {}) {
  const activePrevious = normalizeTradingAgentsPrewarmCircuitBreaker(previousCircuitBreaker, now);
  const timeoutSymbols = symbols
    .map((symbol) => String(symbol ?? "").trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol) => {
      const runtime = runtimeBySymbol?.[symbol];
      return (
        String(runtime?.tradeDate ?? "").trim() === String(tradeDate ?? "").trim() &&
        String(runtime?.status ?? "").trim() === "timeout"
      );
    });
  const freshCount = symbols
    .map((symbol) => String(symbol ?? "").trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol) => {
      const runtime = runtimeBySymbol?.[symbol];
      return (
        String(runtime?.tradeDate ?? "").trim() === String(tradeDate ?? "").trim() &&
        String(runtime?.status ?? "").trim() === "fresh"
      );
    }).length;

  if (activePrevious?.active && activePrevious?.tradeDate === String(tradeDate ?? "").trim()) {
    return {
      ...activePrevious,
      active: true
    };
  }

  if (timeoutSymbols.length >= threshold && freshCount === 0) {
    const openedAt = activePrevious?.openedAt ?? now.toISOString();
    const cooldownUntil =
      activePrevious?.cooldownUntil && parseDate(activePrevious.cooldownUntil)?.getTime() > now.getTime()
        ? activePrevious.cooldownUntil
        : new Date(now.getTime() + cooldownMs).toISOString();
    return {
      status: "open",
      active: true,
      reason: "tradingagents_original_graph_timeout",
      provider: providerDefaults?.llmProvider ?? null,
      deepModel: providerDefaults?.deepThinkModel ?? null,
      quickModel: providerDefaults?.quickThinkModel ?? null,
      brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
      tradeDate,
      openedAt,
      cooldownUntil,
      timeoutCount: timeoutSymbols.length,
      timeoutSymbols,
      threshold
    };
  }

  return {
    status: "closed",
    active: false,
    reason: null,
    provider: providerDefaults?.llmProvider ?? null,
    deepModel: providerDefaults?.deepThinkModel ?? null,
    quickModel: providerDefaults?.quickThinkModel ?? null,
    brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
    tradeDate,
    openedAt: null,
    cooldownUntil: null,
    timeoutCount: timeoutSymbols.length,
    timeoutSymbols,
    threshold
  };
}

function normalizeFailureStatus(error) {
  const text = String(error ?? "");
  if (/^provider_timeout:/i.test(text)) {
    return "timeout";
  }
  if (/^provider_rate_limited:/i.test(text)) {
    return "rate_limited";
  }
  if (/^provider_connection_error:/i.test(text)) {
    return "connection_error";
  }
  return "failed";
}

function getProviderStatus(statusPayload = {}, providerDefaults = {}) {
  const key = buildTradingAgentsPrewarmProviderKey(providerDefaults);
  const legacyKey = buildTradingAgentsPrewarmLegacyProviderKey(providerDefaults);
  return statusPayload?.providers?.[key] ?? statusPayload?.providers?.[legacyKey] ?? null;
}

function getProviderSymbolRuntime(statusPayload = {}, providerDefaults = {}) {
  return getProviderStatus(statusPayload, providerDefaults)?.symbols ?? {};
}

function buildCoverageRuntimeMap({ coverage = {}, statusPayload = {}, providerDefaults = {}, tradeDate, symbols = [], now = new Date() } = {}) {
  const providerSymbolRuntime = getProviderSymbolRuntime(statusPayload, providerDefaults);
  const entries = new Map();
  for (const entry of coverage?.freshEntries ?? []) {
    entries.set(entry.symbol, {
      symbol: entry.symbol,
      status: "fresh",
      rating: entry?.call?.rating ?? null,
      generatedAt: entry?.payload?.generatedAt ?? null,
      ageHours: entry?.ageHours ?? null
    });
  }
  for (const entry of coverage?.staleEntries ?? []) {
    entries.set(entry.symbol, {
      symbol: entry.symbol,
      status: "stale",
      rating: entry?.call?.rating ?? null,
      generatedAt: entry?.payload?.generatedAt ?? null,
      ageHours: entry?.ageHours ?? null
    });
  }

  return symbols.map((symbol) => {
    const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
    const base = entries.get(normalizedSymbol) ?? {
      symbol: normalizedSymbol,
      status: "missing",
      rating: null,
      generatedAt: null,
      ageHours: null
    };
    const runtime = providerSymbolRuntime?.[normalizedSymbol];
    if (
      runtime &&
      trimText(runtime?.tradeDate) === trimText(tradeDate) &&
      base.status !== "fresh" &&
      ["timeout", "rate_limited", "connection_error", "failed"].includes(String(runtime?.status ?? "")) &&
      (isCooldownActive(runtime, now) || base.status === "missing")
    ) {
      return {
        ...base,
        status: runtime.status,
        error: runtime.error ?? null,
        lastAttemptAt: runtime.lastAttemptAt ?? null,
        lastFinishedAt: runtime.lastFinishedAt ?? null,
        durationMs: runtime.durationMs ?? null,
        cooldownUntil: runtime.cooldownUntil ?? null,
        diagnosticPath: runtime.diagnosticPath ?? null,
        provider: runtime.provider ?? null,
        deepModel: runtime.deepModel ?? null,
        quickModel: runtime.quickModel ?? null,
        brainProfile: normalizeBrainProfile(runtime.brainProfile)
      };
    }
    return base;
  });
}

export function orderTradingAgentsPrewarmTargets(targets = [], prioritySymbols = [], options = {}) {
  const now = options?.now ?? new Date();
  const runtimeBySymbol = options?.runtimeBySymbol ?? {};
  const ignoreCooldown = options?.ignoreCooldown === true;
  const priorityRank = new Map(
    prioritySymbols.map((symbol, index) => [String(symbol).toUpperCase(), index])
  );
  return [...new Set(targets.map((symbol) => String(symbol ?? "").trim().toUpperCase()).filter(Boolean))]
    .filter((symbol) => {
      if (ignoreCooldown) {
        return true;
      }
      const runtime = runtimeBySymbol?.[symbol];
      return !isCooldownActive(runtime, now);
    })
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
  const loadStatus = deps.loadStatus ?? loadTradingAgentsPrewarmStatus;
  const saveStatus = deps.saveStatus ?? ((root, payload) => writeJsonAtomic(resolveTradingAgentsPrewarmStatusPath(root), payload));
  const bridgeConfig = await loadConfig(rawOptions?.configPath);
  const now = rawOptions?.now instanceof Date ? rawOptions.now : new Date();
  const nowIso = now.toISOString();
  const tradeDate = String(rawOptions?.tradeDate ?? rawOptions?.["trade-date"] ?? formatShanghaiDate()).trim();
  const configuredSymbols = collectLiveSymbols(bridgeConfig);
  const requestedSymbols = normalizeSymbols(rawOptions?.symbols ?? rawOptions?.symbolsCsv);
  const symbols = requestedSymbols.length > 0
    ? configuredSymbols.filter((symbol) => requestedSymbols.includes(symbol))
    : configuredSymbols;
  const previousStatus = await loadStatus(portfolioRoot);
  const ignoreCircuitBreaker = rawOptions?.ignoreCircuitBreaker === true || rawOptions?.["ignore-circuit-breaker"] === "1";
  const providerCandidates = resolvePrewarmProviderCandidates(bridgeConfig, rawOptions);
  let selectedProvider = null;
  for (const candidateDefaults of providerCandidates) {
    const candidateCoverage = await inspectCoverage({
      symbols,
      tradeDate,
      providerDefaults: candidateDefaults,
      portfolioRoot
    });
    const candidateRuntimeBySymbol = getProviderSymbolRuntime(previousStatus, candidateDefaults);
    const candidateThreshold = resolvePrewarmCircuitBreakerTimeoutThreshold(rawOptions, candidateDefaults);
    const candidateCircuitBreaker = buildSlowGraphCircuitBreaker({
      previousCircuitBreaker: getProviderStatus(previousStatus, candidateDefaults)?.circuitBreaker,
      runtimeBySymbol: candidateRuntimeBySymbol,
      symbols,
      tradeDate,
      providerDefaults: candidateDefaults,
      now,
      threshold: candidateThreshold,
      cooldownMs: resolvePrewarmCircuitBreakerCooldownMs(rawOptions, candidateDefaults)
    });
    const candidateCanWarm = !(candidateCircuitBreaker.active && !ignoreCircuitBreaker);
    selectedProvider ??= {
      providerDefaults: candidateDefaults,
      initialCoverage: candidateCoverage,
      runtimeBySymbol: candidateRuntimeBySymbol,
      initialCircuitBreaker: candidateCircuitBreaker
    };
    if (!candidateCoverage.fullyFresh && candidateCanWarm) {
      selectedProvider = {
        providerDefaults: candidateDefaults,
        initialCoverage: candidateCoverage,
        runtimeBySymbol: candidateRuntimeBySymbol,
        initialCircuitBreaker: candidateCircuitBreaker
      };
      break;
    }
  }
  const providerDefaults = selectedProvider?.providerDefaults ?? resolvePrewarmProviderDefaults(bridgeConfig, rawOptions);
  const initialCoverage = selectedProvider?.initialCoverage ?? await inspectCoverage({
    symbols,
    tradeDate,
    providerDefaults,
    portfolioRoot
  });
  const providerKey = buildTradingAgentsPrewarmProviderKey(providerDefaults);
  const runtimeBySymbol = selectedProvider?.runtimeBySymbol ?? getProviderSymbolRuntime(previousStatus, providerDefaults);
  const circuitBreakerThreshold = resolvePrewarmCircuitBreakerTimeoutThreshold(rawOptions, providerDefaults);
  const circuitBreakerCooldownMs = resolvePrewarmCircuitBreakerCooldownMs(rawOptions, providerDefaults);
  const previousProviderStatus = previousStatus?.providers?.[providerKey] ?? {};
  const initialCircuitBreaker = selectedProvider?.initialCircuitBreaker ?? buildSlowGraphCircuitBreaker({
    previousCircuitBreaker: previousProviderStatus?.circuitBreaker,
    runtimeBySymbol,
    symbols,
    tradeDate,
    providerDefaults,
    now,
    threshold: circuitBreakerThreshold,
    cooldownMs: circuitBreakerCooldownMs
  });

  const warmTargets = initialCircuitBreaker.active && !ignoreCircuitBreaker
    ? []
    : orderTradingAgentsPrewarmTargets(
        [...initialCoverage.missingSymbols, ...initialCoverage.staleSymbols],
        resolvePrewarmPrioritySymbols(bridgeConfig, providerDefaults),
        {
          runtimeBySymbol,
          now,
          ignoreCooldown: rawOptions?.ignoreCooldown === true || rawOptions?.["ignore-cooldown"] === "1"
        }
      ).slice(0, resolvePrewarmMaxSymbolsPerRun(rawOptions, providerDefaults));
  const warmed = [];
  const failed = [];
  const marketLakeDbPath = await resolveMarketLakeDbPath(portfolioRoot);
  const cooldownMs = resolvePrewarmCooldownMs(rawOptions, providerDefaults);
  const nextStatus = {
    ...(previousStatus ?? {}),
    generatedAt: nowIso,
    accountId,
    providers: {
      ...(previousStatus?.providers ?? {})
    }
  };
  const nextProviderStatus = {
    ...(nextStatus.providers[providerKey] ?? {}),
    provider: providerDefaults?.llmProvider ?? null,
    deepModel: providerDefaults?.deepThinkModel ?? null,
    quickModel: providerDefaults?.quickThinkModel ?? null,
    brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
    tradeDate,
    circuitBreaker: initialCircuitBreaker,
    symbols: {
      ...(nextStatus.providers[providerKey]?.symbols ?? {})
    }
  };

  for (const symbol of warmTargets) {
    const symbolStartedAt = new Date();
    const symbolStartedAtIso = symbolStartedAt.toISOString();
    try {
      const snapshot = runSnapshot({
        tradeDate,
        symbols: [symbol],
        providerDefaults,
        externalPython: String(rawOptions?.externalPython ?? "/Users/yinshiwei/codex/external/TradingAgents/.venv/bin/python"),
        marketLakeDbPath,
        portfolioRoot
      });
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - symbolStartedAt.getTime();
      const warmedItem = {
        symbol,
        provider: providerDefaults?.llmProvider ?? null,
        brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
        startedAt: symbolStartedAtIso,
        finishedAt: finishedAt.toISOString(),
        durationMs,
        callCount: Array.isArray(snapshot?.calls) ? snapshot.calls.length : 0,
        rating: snapshot?.calls?.[0]?.rating ?? null,
        diagnosticPath: snapshot?.runtimeDiagnostics?.runDiagnosticPath ?? null
      };
      warmed.push(warmedItem);
      nextProviderStatus.symbols[symbol] = {
        symbol,
        tradeDate,
        provider: providerDefaults?.llmProvider ?? null,
        deepModel: providerDefaults?.deepThinkModel ?? null,
        quickModel: providerDefaults?.quickThinkModel ?? null,
        brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
        status: "fresh",
        error: null,
        lastAttemptAt: symbolStartedAtIso,
        lastFinishedAt: finishedAt.toISOString(),
        durationMs,
        cooldownUntil: null,
        callCount: warmedItem.callCount,
        rating: warmedItem.rating,
        diagnosticPath: warmedItem.diagnosticPath
      };
    } catch (error) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - symbolStartedAt.getTime();
      const summarizedError = summarizeTradingAgentsProviderError(error?.message ?? error, providerDefaults?.llmProvider);
      const status = normalizeFailureStatus(summarizedError);
      const failedItem = {
        symbol,
        provider: providerDefaults?.llmProvider ?? null,
        brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
        status,
        error: summarizedError,
        startedAt: symbolStartedAtIso,
        finishedAt: finishedAt.toISOString(),
        durationMs,
        diagnosticPath: error?.diagnosticPath ?? extractTradingAgentsDiagnosticPath(error?.message)
      };
      failed.push(failedItem);
      nextProviderStatus.symbols[symbol] = {
        symbol,
        tradeDate,
        provider: providerDefaults?.llmProvider ?? null,
        deepModel: providerDefaults?.deepThinkModel ?? null,
        quickModel: providerDefaults?.quickThinkModel ?? null,
        brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
        status,
        error: summarizedError,
        lastAttemptAt: symbolStartedAtIso,
        lastFinishedAt: finishedAt.toISOString(),
        durationMs,
        cooldownUntil: new Date(finishedAt.getTime() + cooldownMs).toISOString(),
        diagnosticPath: failedItem.diagnosticPath
      };
    }
  }
  nextProviderStatus.circuitBreaker = buildSlowGraphCircuitBreaker({
    previousCircuitBreaker: nextProviderStatus.circuitBreaker,
    runtimeBySymbol: nextProviderStatus.symbols,
    symbols,
    tradeDate,
    providerDefaults,
    now: new Date(),
    threshold: circuitBreakerThreshold,
    cooldownMs: circuitBreakerCooldownMs
  });
  nextStatus.providers[providerKey] = nextProviderStatus;

  const finalCoverage = await inspectCoverage({
    symbols,
    tradeDate,
    providerDefaults,
    portfolioRoot
  });
  const symbolRuntime = buildCoverageRuntimeMap({
    coverage: finalCoverage,
    statusPayload: nextStatus,
    providerDefaults,
    tradeDate,
    symbols,
    now
  });

  await saveStatus(portfolioRoot, nextStatus);

  return {
    portfolioRoot,
    accountId,
    tradeDate,
    provider: providerDefaults?.llmProvider ?? null,
    deepModel: providerDefaults?.deepThinkModel ?? null,
    quickModel: providerDefaults?.quickThinkModel ?? null,
    brainProfile: normalizeBrainProfile(providerDefaults?.brainProfile),
    prewarmStatusPath: resolveTradingAgentsPrewarmStatusPath(portfolioRoot),
    cooldownMs,
    circuitBreakerCooldownMs,
    circuitBreaker: nextProviderStatus.circuitBreaker,
    skippedReason: initialCircuitBreaker.active && !ignoreCircuitBreaker
      ? "tradingagents_original_graph_circuit_breaker_open"
      : null,
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
    symbolRuntime,
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
