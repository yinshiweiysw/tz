import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8767;
const defaultRefreshMs = 15_000;
const defaultWaitAttempts = 20;
const defaultWaitMs = 500;

function parseArgs(argv) {
  const result = {
    host: defaultHost,
    port: defaultPort,
    refreshMs: defaultRefreshMs,
    user: "",
    portfolioRoot: "",
    open: true
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
  const baseUrl = `http://${args.host}:${args.port}`;
  const dashboardUrl = `${baseUrl}/?account=${encodeURIComponent(accountId)}`;

  let status = "reused";
  if (!(await isDashboardReady(baseUrl))) {
    status = "launched";
    const logsDir = buildPortfolioPath(portfolioRoot, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "exchange-live-dashboard.log");
    const errPath = path.join(logsDir, "exchange-live-dashboard.err.log");
    const serverScript = fileURLToPath(new URL("./serve_exchange_live_dashboard.mjs", import.meta.url));
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
      throw new Error(`exchange live dashboard did not become ready at ${baseUrl}`);
    }
  }

  if (args.open) {
    openBrowser(dashboardUrl);
  }

  console.log(
    JSON.stringify(
      {
        status,
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
