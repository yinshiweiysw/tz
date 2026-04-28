import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { syncMarketTopicReports } from "./lib/market_report_sync.mjs";
import { refreshMarketProxyQuotes } from "./lib/market_proxy_quotes.mjs";
import { runDashboardStateBuild } from "./build_dashboard_state.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8766;
const defaultRefreshMs = 30_000;
const defaultWaitAttempts = 20;
const defaultWaitMs = 500;
const sensitiveRuntimeEnvKeys = [
  "ZHIPU_API_KEY",
  "ZHIPU_API_KEY_2",
  "ZHIPU_API_KEY_3",
  "ZHIPU_API_KEY_POOL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_API_KEY_2",
  "DEEPSEEK_API_KEY_POOL"
];
const keychainServicePrefix = "codex-env";
const loginShellEnvStartMarker = "__CODEX_ENV_JSON_START__";
const loginShellEnvEndMarker = "__CODEX_ENV_JSON_END__";

function parseArgs(argv) {
  const result = {
    host: defaultHost,
    port: defaultPort,
    refreshMs: defaultRefreshMs,
    user: "",
    portfolioRoot: "",
    route: "/",
    open: true,
    restart: true
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

  result.port = Number(result.port) || defaultPort;
  result.refreshMs = Number(result.refreshMs) || defaultRefreshMs;
  result.route = String(result.route || "/").startsWith("/") ? String(result.route || "/") : `/${String(result.route || "").trim()}`;
  if (typeof result.open === "string") {
    const normalized = result.open.trim().toLowerCase();
    result.open = !["0", "false", "no", "off"].includes(normalized);
  } else {
    result.open = result.open !== false;
  }
  if (typeof result.restart === "string") {
    const normalized = result.restart.trim().toLowerCase();
    result.restart = !["0", "false", "no", "off"].includes(normalized);
  } else {
    result.restart = result.restart !== false;
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchDashboardHealth(url, accountId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const healthUrl = new URL("/api/live-funds/health", `${url}/`);
    healthUrl.searchParams.set("account", accountId);
    const response = await fetch(healthUrl, {
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ready: false,
        health: null,
        reason: `HTTP ${response.status}`
      };
    }

    const health = await response.json();
    const state = String(health?.state ?? "").trim();
    return {
      ready: state === "ready" || state === "degraded",
      health,
      reason:
        state === "ready" || state === "degraded"
          ? null
          : Array.isArray(health?.reasons) && health.reasons.length > 0
            ? health.reasons.join("; ")
            : `health_state:${state || "unknown"}`
    };
  } catch {
    return {
      ready: false,
      health: null,
      reason: "dashboard_health_unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function isDashboardReady(url, accountId) {
  const result = await fetchDashboardHealth(url, accountId);
  return result.ready;
}

export async function fetchTradingDecisionStatus(url, accountId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const decisionUrl = new URL("/api/trading-decision", `${url}/`);
    decisionUrl.searchParams.set("account", accountId);
    const response = await fetch(decisionUrl, {
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        reachable: false,
        payload: null,
        reason: `HTTP ${response.status}`
      };
    }
    const payload = await response.json();
    return {
      reachable: true,
      payload,
      reason: null
    };
  } catch {
    return {
      reachable: false,
      payload: null,
      reason: "trading_decision_unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilReady(url, accountId, attempts = defaultWaitAttempts, delayMs = defaultWaitMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await fetchDashboardHealth(url, accountId);
    if (health.ready) {
      return health;
    }
    await sleep(delayMs);
  }
  return {
    ready: false,
    health: null,
    reason: "dashboard_health_timeout"
  };
}

function openBrowser(url) {
  spawn("open", [url], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

export function resolveStartupAction({
  restart = true,
  listeningPidCount = 0,
  existingReady = false,
  providerRepairNeeded = false
} = {}) {
  if (restart && listeningPidCount > 0 && providerRepairNeeded) {
    return "recycle";
  }
  if (restart && listeningPidCount > 0 && !existingReady) {
    return "recycle";
  }
  if (existingReady) {
    return "reuse";
  }
  return "launch";
}

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function parseMarkedJsonBlock(stdout, startMarker = loginShellEnvStartMarker, endMarker = loginShellEnvEndMarker) {
  const text = String(stdout ?? "");
  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return null;
  }
  const payload = text.slice(startIndex + startMarker.length, endIndex).trim();
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function mergeSensitiveEnv(baseEnv = {}, discoveredEnv = {}, keys = sensitiveRuntimeEnvKeys) {
  const next = {
    ...baseEnv
  };
  for (const key of keys) {
    if (trimText(next?.[key])) {
      continue;
    }
    const discoveredValue = trimText(discoveredEnv?.[key]);
    if (discoveredValue) {
      next[key] = discoveredValue;
    }
  }
  return next;
}

export function summarizeSensitiveEnvPresence(env = {}, keys = sensitiveRuntimeEnvKeys) {
  return Object.fromEntries(
    keys.map((key) => [key, Boolean(trimText(env?.[key]))])
  );
}

export function shouldRecycleForTradingBrainProvider({
  launcherEnv = {},
  tradingDecisionStatus = {}
} = {}) {
  const hasTradingBrainKey = sensitiveRuntimeEnvKeys.some((key) => Boolean(trimText(launcherEnv?.[key])));
  if (!hasTradingBrainKey) {
    return false;
  }
  const providerError = trimText(tradingDecisionStatus?.payload?.diagnostics?.providerError);
  const fallbackReason = trimText(tradingDecisionStatus?.payload?.diagnostics?.fallbackReason);
  return (
    /^Missing required API key: /i.test(providerError ?? "") ||
    fallbackReason === "missing_provider_key_using_fixture"
  );
}

export function readSensitiveEnvFromKeychain({
  account = process.env.USER || "codex",
  keys = sensitiveRuntimeEnvKeys,
  spawnSyncFn = spawnSync
} = {}) {
  const env = {};
  const errors = [];
  for (const key of keys) {
    const result = spawnSyncFn(
      "security",
      ["find-generic-password", "-a", String(account), "-s", `${keychainServicePrefix}:${key}`, "-w"],
      {
        encoding: "utf8"
      }
    );
    if (result.error || result.status !== 0) {
      if (result.error) {
        errors.push(`${key}: ${result.error.message}`);
      }
      continue;
    }
    const value = trimText(result.stdout);
    if (value) {
      env[key] = value;
    }
  }
  return {
    ok: Object.keys(env).length > 0 || errors.length === 0,
    env,
    reason: errors.length > 0 ? errors.join("; ") : null
  };
}

export function readSensitiveEnvFromLoginShell({
  env = process.env,
  shellPath = env?.SHELL || "zsh",
  keys = sensitiveRuntimeEnvKeys,
  spawnSyncFn = spawnSync
} = {}) {
  const pythonLines = [
    "import json, os",
    `keys = ${JSON.stringify(keys)}`,
    `print(${JSON.stringify(loginShellEnvStartMarker)})`,
    "print(json.dumps({key: os.environ.get(key) for key in keys}))",
    `print(${JSON.stringify(loginShellEnvEndMarker)})`
  ].join("; ");
  const result = spawnSyncFn(shellPath, ["-lic", `python3 -c '${pythonLines}'`], {
    encoding: "utf8",
    env
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      env: {},
      reason: trimText(result.error?.message) ?? trimText(result.stderr) ?? "login_shell_probe_failed"
    };
  }
  return {
    ok: true,
    env: parseMarkedJsonBlock(result.stdout) ?? {},
    reason: null
  };
}

function findListeningPids(port) {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], {
    encoding: "utf8"
  });
  if (result.error || result.status > 1) {
    return [];
  }

  return String(result.stdout ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function stopListeningProcesses(port) {
  const pids = findListeningPids(port);
  for (const pid of pids) {
    const result = spawnSync("kill", [String(pid)], {
      encoding: "utf8"
    });
    if (result.error) {
      throw result.error;
    }
  }
  return pids;
}

export async function waitUntilPortFree(
  port,
  { attempts = 20, delayMs = 100, getPids = findListeningPids } = {}
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((getPids(port) ?? []).length === 0) {
      return true;
    }
    await sleep(delayMs);
  }
  return (getPids(port) ?? []).length === 0;
}

function materializePendingBuys(args) {
  const materializeScript = fileURLToPath(new URL("./materialize_pending_buys.mjs", import.meta.url));
  const childArgs = [materializeScript];

  if (String(args.user ?? "").trim()) {
    childArgs.push("--user", String(args.user).trim());
  }
  if (String(args.portfolioRoot ?? "").trim()) {
    childArgs.push("--portfolioRoot", String(args.portfolioRoot).trim());
  }

  const result = spawnSync("node", childArgs, {
    cwd: path.dirname(materializeScript),
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `materialize_pending_buys failed: ${String(result.stderr || result.stdout || "").trim()}`
    );
  }

  const stdout = String(result.stdout ?? "").trim();
  if (!stdout) {
    return {
      status: "unknown"
    };
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return {
      status: "unknown",
      raw: stdout
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountId = resolveAccountId({
    user: args.user,
    portfolioRoot: args.portfolioRoot
  });
  const portfolioRoot = resolvePortfolioRoot({
    user: args.user,
    portfolioRoot: args.portfolioRoot
  });
  const materializeResult = materializePendingBuys(args);
  const marketTopicsSyncResult = await syncMarketTopicReports({
    portfolioRoot
  });
  let marketProxyQuoteRefreshResult = null;
  try {
    marketProxyQuoteRefreshResult = await refreshMarketProxyQuotes({
      portfolioRoot
    });
  } catch (error) {
    marketProxyQuoteRefreshResult = {
      status: "failed",
      refreshed: false,
      error: String(error?.message ?? error)
    };
  }
  const dashboardStateResult = await runDashboardStateBuild({
    user: accountId,
    portfolioRoot,
    refreshMs: args.refreshMs
  });
  const loginShellEnvProbe = readSensitiveEnvFromLoginShell({
    env: process.env
  });
  const keychainEnvProbe = readSensitiveEnvFromKeychain();
  const shellMergedEnv = mergeSensitiveEnv(process.env, loginShellEnvProbe.env);
  const launcherEnv = {
    ...mergeSensitiveEnv(shellMergedEnv, keychainEnvProbe.env),
    LANGCHAIN_OPENAI_TCP_KEEPALIVE: process.env.LANGCHAIN_OPENAI_TCP_KEEPALIVE || "0"
  };
  const launcherEnvPresence = {
    currentProcess: summarizeSensitiveEnvPresence(process.env),
    loginShell: summarizeSensitiveEnvPresence(loginShellEnvProbe.env),
    keychain: summarizeSensitiveEnvPresence(keychainEnvProbe.env),
    effective: summarizeSensitiveEnvPresence(launcherEnv)
  };
  const baseUrl = `http://${args.host}:${args.port}`;
  const dashboardUrl = `${baseUrl}${args.route}?account=${encodeURIComponent(accountId)}`;

  const existingHealth = await fetchDashboardHealth(baseUrl, accountId);
  const existingReady = existingHealth.ready;
  const existingTradingDecision = existingReady
    ? await fetchTradingDecisionStatus(baseUrl, accountId)
    : {
        reachable: false,
        payload: null,
        reason: "dashboard_not_ready"
      };
  const providerRepairNeeded = shouldRecycleForTradingBrainProvider({
    launcherEnv,
    tradingDecisionStatus: existingTradingDecision
  });
  const listeningPids = findListeningPids(args.port);
  const startupAction = resolveStartupAction({
    restart: args.restart,
    listeningPidCount: listeningPids.length,
    existingReady,
    providerRepairNeeded
  });
  let stoppedPids = [];
  if (startupAction === "recycle") {
    stoppedPids = stopListeningProcesses(args.port);
    if (stoppedPids.length > 0) {
      await waitUntilPortFree(args.port);
    }
  }

  let status = startupAction === "reuse" ? "reused" : "launched";
  if (!(await isDashboardReady(baseUrl, accountId))) {
    const logsDir = buildPortfolioPath(portfolioRoot, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "funds-live-dashboard.log");
    const errPath = path.join(logsDir, "funds-live-dashboard.err.log");
    const serverScript = fileURLToPath(new URL("./serve_funds_live_dashboard.mjs", import.meta.url));
    const stdoutFd = openSync(logPath, "a");
    const stderrFd = openSync(errPath, "a");

    const childArgs = [
      serverScript,
      "--host",
      String(args.host),
      "--port",
      String(args.port),
      "--refreshMs",
      String(args.refreshMs)
    ];
    if (String(args.user ?? "").trim()) {
      childArgs.push("--user", String(args.user).trim());
    }
    if (String(args.portfolioRoot ?? "").trim()) {
      childArgs.push("--portfolioRoot", String(args.portfolioRoot).trim());
    }

    spawn("node", childArgs, {
      cwd: path.dirname(serverScript),
      detached: true,
      env: launcherEnv,
      stdio: ["ignore", stdoutFd, stderrFd]
    }).unref();

    const readiness = await waitUntilReady(baseUrl, accountId);
    if (!readiness.ready) {
      throw new Error(
        `funds live dashboard did not become ready at ${baseUrl}${readiness.reason ? `: ${readiness.reason}` : ""}`
      );
    }
  }

  if (args.open) {
    openBrowser(dashboardUrl);
  }

  console.log(
    JSON.stringify(
      {
        status,
        restart: args.restart,
        stoppedPids,
        materializeResult,
        marketTopicsSyncResult,
        marketProxyQuoteRefreshResult,
        dashboardStateResult,
        tradingBrainEnv: launcherEnvPresence,
        loginShellEnvProbe: {
          ok: loginShellEnvProbe.ok,
          reason: loginShellEnvProbe.reason
        },
        keychainEnvProbe: {
          ok: keychainEnvProbe.ok,
          reason: keychainEnvProbe.reason
        },
        existingTradingDecision: {
          reachable: existingTradingDecision.reachable,
          reason: existingTradingDecision.reason,
          mode: existingTradingDecision.payload?.mode ?? null,
          status: existingTradingDecision.payload?.status ?? null,
          providerError: existingTradingDecision.payload?.diagnostics?.providerError ?? null,
          fallbackReason: existingTradingDecision.payload?.diagnostics?.fallbackReason ?? null
        },
        providerRepairNeeded,
        accountId,
        portfolioRoot,
        url: dashboardUrl,
        host: args.host,
        port: args.port,
        refreshMs: args.refreshMs
      },
      null,
      2
    )
  );
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          error: String(error?.message ?? error)
        },
        null,
        2
      )
    );
    process.exit(1);
  });
}
