import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";

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

async function isDashboardReady(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilReady(url, attempts = defaultWaitAttempts, delayMs = defaultWaitMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isDashboardReady(url)) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function openBrowser(url) {
  spawn("open", [url], {
    detached: true,
    stdio: "ignore"
  }).unref();
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
  const baseUrl = `http://${args.host}:${args.port}`;
  const dashboardUrl = `${baseUrl}/?account=${encodeURIComponent(accountId)}`;

  const existingReady = await isDashboardReady(baseUrl);
  let stoppedPids = [];
  if (existingReady && args.restart) {
    stoppedPids = stopListeningProcesses(args.port);
    if (stoppedPids.length > 0) {
      await sleep(300);
    }
  }

  let status = existingReady && !args.restart ? "reused" : "launched";
  if (!(await isDashboardReady(baseUrl))) {
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

    const ready = await waitUntilReady(baseUrl);
    if (!ready) {
      throw new Error(`funds live dashboard did not become ready at ${baseUrl}`);
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
