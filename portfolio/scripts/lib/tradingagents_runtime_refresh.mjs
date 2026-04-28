import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePortfolioRoot } from "./account_root.mjs";

const defaultPrewarmScriptPath = fileURLToPath(
  new URL("../run_tradingagents_prewarm.mjs", import.meta.url)
);
const defaultDecisionCycleScriptPath = fileURLToPath(
  new URL("../run_tradingagents_decision_cycle.mjs", import.meta.url)
);
const defaultDebounceMs = 5 * 60 * 1000;
const defaultCacheWarmupDebounceMs = 30 * 1000;
const defaultProviderCooldownMs = 30 * 60 * 1000;

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function parseJsonOutput(text) {
  const output = String(text ?? "").trim();
  if (!output) {
    return null;
  }
  try {
    return JSON.parse(output);
  } catch {
    return {
      raw: output
    };
  }
}

function compactError(error) {
  const text = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function parseIsoDate(value) {
  const text = trimText(value);
  if (!text) {
    return null;
  }
  const normalized = text.endsWith("Z") ? text.replace("Z", "+00:00") : text;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveSnapshotFreshnessLabel(snapshot = {}) {
  return (
    trimText(snapshot?.diagnostics?.freshnessLabel) ??
    trimText(snapshot?.freshnessLabel) ??
    "unknown"
  );
}

function resolveSnapshotMode(snapshot = {}) {
  return String(snapshot?.mode ?? "").trim().toLowerCase() || "unknown";
}

function resolveSnapshotProvider(snapshot = {}) {
  const runtime = snapshot?.providerRuntime ?? snapshot?.diagnostics?.providerRuntime ?? {};
  const runtimeProvider = trimText(runtime?.providerUsed);
  if (runtimeProvider === "fallback_fixture") {
    // Fallback snapshots should warm the primary provider first; provider failover
    // is handled by the prewarm runner/provider health, not by pinning the last
    // failed live attempt forever.
    return null;
  }
  return (
    runtimeProvider ??
    trimText(snapshot?.providerUsed) ??
    trimText(snapshot?.provider) ??
    null
  );
}

function resolveSnapshotGeneratedAt(snapshot = {}) {
  return parseIsoDate(snapshot?.generatedAt ?? snapshot?.diagnostics?.generatedAt);
}

function isProviderBackoffError(value) {
  return /^provider_(rate_limited|timeout|connection_error):/i.test(String(value ?? "").trim());
}

function isCacheWarmupBackoffError(value) {
  return /^tradingagents_symbol_cache_incomplete\b/i.test(String(value ?? "").trim());
}

export function classifyTradingDecisionRefreshNeed(
  snapshot,
  {
    now = new Date(),
    tradeDate = formatShanghaiDate(now),
    providerCooldownMs = defaultProviderCooldownMs
  } = {}
) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      needsRefresh: true,
      reason: "decision_snapshot_missing"
    };
  }

  const mode = resolveSnapshotMode(snapshot);
  const providerError = trimText(snapshot?.diagnostics?.providerError);
  const providerFallbackReason =
    trimText(snapshot?.providerFallbackReason) ??
    trimText(snapshot?.providerRuntime?.providerFallbackReason) ??
    trimText(snapshot?.diagnostics?.providerRuntime?.providerFallbackReason);
  const providerRefreshReason = providerError ?? providerFallbackReason;
  if (isProviderBackoffError(providerRefreshReason)) {
    const generatedAt = resolveSnapshotGeneratedAt(snapshot);
    if (generatedAt && now.getTime() - generatedAt.getTime() < providerCooldownMs) {
      return {
        needsRefresh: false,
        reason: `provider_cooldown:${providerRefreshReason}`
      };
    }
    return {
      needsRefresh: true,
      reason: providerRefreshReason
    };
  }
  if (isCacheWarmupBackoffError(providerRefreshReason)) {
    return {
      needsRefresh: true,
      reason: providerRefreshReason
    };
  }

  if (mode !== "live") {
    return {
      needsRefresh: true,
      reason: "decision_snapshot_not_live"
    };
  }

  const asOf = trimText(snapshot?.asOf);
  if (!asOf || asOf !== tradeDate) {
    return {
      needsRefresh: true,
      reason: "decision_snapshot_out_of_date"
    };
  }

  const freshnessLabel = resolveSnapshotFreshnessLabel(snapshot);
  if (freshnessLabel !== "fresh") {
    return {
      needsRefresh: true,
      reason: `decision_snapshot_${freshnessLabel}`
    };
  }

  const fallbackReason = trimText(snapshot?.diagnostics?.fallbackReason);
  if (providerError || providerFallbackReason || fallbackReason) {
    return {
      needsRefresh: true,
      reason: providerError ?? providerFallbackReason ?? fallbackReason
    };
  }

  return {
    needsRefresh: false,
    reason: "decision_snapshot_fresh"
  };
}

function runNodeJsonScript(
  scriptPath,
  args = [],
  {
    nodeBinary = process.execPath,
    spawnFn = spawn,
    env = process.env
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(nodeBinary, [scriptPath, ...args], {
      cwd: dirname(scriptPath),
      env: {
        ...env,
        LANGCHAIN_OPENAI_TCP_KEEPALIVE: env?.LANGCHAIN_OPENAI_TCP_KEEPALIVE || "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          payload: parseJsonOutput(stdout)
        });
        return;
      }
      reject(
        new Error(
          compactError(
            stderr ||
              stdout ||
              `background_refresh_failed(code=${code ?? "unknown"}, signal=${signal ?? "none"})`
          )
        )
      );
    });
  });
}

export function createTradingAgentsBackgroundScheduler({
  nodeBinary = process.execPath,
  spawnFn = spawn,
  env = process.env,
  debounceMs = defaultDebounceMs,
  cacheWarmupDebounceMs = defaultCacheWarmupDebounceMs,
  prewarmScriptPath = defaultPrewarmScriptPath,
  decisionCycleScriptPath = defaultDecisionCycleScriptPath,
  now = () => new Date()
} = {}) {
  const states = new Map();

  function getState(accountId) {
    const key = trimText(accountId) ?? "main";
    const existing = states.get(key);
    if (existing) {
      return existing;
    }
    const next = {
      accountId: key,
      running: false,
      lastQueuedAt: null,
      lastCompletedAt: null,
      lastReason: null,
      lastError: null,
      lastSkipReason: null,
      lastResult: null,
      currentPromise: null
    };
    states.set(key, next);
    return next;
  }

  async function runRefreshChain({ accountId, portfolioRoot, tradeDate, provider, ignoreCooldown = false }) {
    const baseArgs = [
      "--portfolioRoot",
      portfolioRoot,
      "--user",
      accountId,
      "--trade-date",
      tradeDate
    ];
    const prewarmArgs = [
      ...(provider ? [...baseArgs, "--provider", provider] : baseArgs),
      ...(ignoreCooldown ? ["--ignore-cooldown", "1"] : [])
    ];

    let prewarm = null;
    try {
      prewarm = await runNodeJsonScript(prewarmScriptPath, prewarmArgs, {
        nodeBinary,
        spawnFn,
        env
      });
    } catch (error) {
      throw new Error(compactError(error));
    }

    let decision = null;
    let decisionError = null;
    try {
      decision = await runNodeJsonScript(
        decisionCycleScriptPath,
        [...baseArgs, "--mode", "live", "--cache-only", "1"],
        {
          nodeBinary,
          spawnFn,
          env
        }
      );
    } catch (error) {
      decisionError = compactError(error);
    }

    return {
      tradeDate,
      prewarm: prewarm?.payload ?? null,
      prewarmError: null,
      decision: decision?.payload ?? null,
      decisionError
    };
  }

  function schedule({
    accountId = "main",
    portfolioRoot = resolvePortfolioRoot({ user: accountId }),
    snapshot = null,
    force = false,
    reason = "background_refresh"
  } = {}) {
    const state = getState(accountId);
    const nowDate = now();
    const nowIso = nowDate.toISOString();
    const refreshNeed = force
      ? { needsRefresh: true, reason }
      : classifyTradingDecisionRefreshNeed(snapshot, {
          now: nowDate
        });

    if (!refreshNeed.needsRefresh) {
      state.lastSkipReason = refreshNeed.reason;
      return {
        scheduled: false,
        reason: refreshNeed.reason
      };
    }

    if (state.running) {
      return {
        scheduled: false,
        reason: "background_refresh_inflight"
      };
    }

    if (!force && state.lastQueuedAt) {
      const lastQueued = parseIsoDate(state.lastQueuedAt);
      const activeDebounceMs = isCacheWarmupBackoffError(refreshNeed.reason)
        ? cacheWarmupDebounceMs
        : debounceMs;
      if (lastQueued && nowDate.getTime() - lastQueued.getTime() < activeDebounceMs) {
        state.lastSkipReason = "background_refresh_debounced";
        return {
          scheduled: false,
          reason: "background_refresh_debounced"
        };
      }
    }

    state.running = true;
    state.lastQueuedAt = nowIso;
    state.lastReason = refreshNeed.reason;
    state.lastError = null;
    state.lastSkipReason = null;

    state.currentPromise = runRefreshChain({
      accountId: state.accountId,
      portfolioRoot,
      tradeDate: formatShanghaiDate(nowDate),
      provider: resolveSnapshotProvider(snapshot),
      ignoreCooldown: force
    })
      .then((result) => {
        state.lastCompletedAt = now().toISOString();
        state.lastResult = result;
        state.lastError = null;
        return result;
      })
      .catch((error) => {
        state.lastCompletedAt = now().toISOString();
        state.lastError = compactError(error);
        state.lastResult = null;
        return null;
      })
      .finally(() => {
        state.running = false;
        state.currentPromise = null;
      });

    return {
      scheduled: true,
      reason: refreshNeed.reason
    };
  }

  return {
    schedule,
    getState,
    states
  };
}
