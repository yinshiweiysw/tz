import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { runDashboardStateBuild } from "./build_dashboard_state.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8766;
const defaultRefreshMs = 30_000;
const defaultWaitAttempts = 20;
const defaultWaitMs = 500;

function parseArgs(argv) {
  const result = {
    host: defaultHost,
    port: defaultPort,
    refreshMs: defaultRefreshMs,
    user: "",
    portfolioRoot: "",
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
  existingReady = false
} = {}) {
  if (restart && listeningPidCount > 0) {
    return "recycle";
  }
  if (existingReady) {
    return "reuse";
  }
  return "launch";
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
  const dashboardStateResult = await runDashboardStateBuild({
    user: accountId,
    portfolioRoot,
    refreshMs: args.refreshMs
  });
  const baseUrl = `http://${args.host}:${args.port}`;
  const dashboardUrl = `${baseUrl}/?account=${encodeURIComponent(accountId)}`;

  const existingHealth = await fetchDashboardHealth(baseUrl, accountId);
  const existingReady = existingHealth.ready;
  const listeningPids = findListeningPids(args.port);
  const startupAction = resolveStartupAction({
    restart: args.restart,
    listeningPidCount: listeningPids.length,
    existingReady
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
        dashboardStateResult,
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
