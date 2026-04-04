import { access, readdir } from "node:fs/promises";
import path from "node:path";

export const workspaceRoot = "/Users/yinshiwei/codex/tz";
export const defaultPortfolioRoot = `${workspaceRoot}/portfolio`;
export const portfolioUsersRoot = `${workspaceRoot}/portfolio_users`;

const MAIN_ACCOUNT_ALIASES = new Set(["", "main", "default", "primary", "tz"]);
const INVALID_ACCOUNT_IDS = new Set(["true", "false", "null", "undefined", "nan"]);

function normalizeAccountId(value) {
  if (typeof value === "boolean") {
    return "";
  }
  const normalized = String(value ?? "").trim();
  return INVALID_ACCOUNT_IDS.has(normalized.toLowerCase()) ? "" : normalized;
}

export function isValidDiscoverableAccountId(value) {
  return Boolean(normalizeAccountId(value));
}

export function resolvePortfolioRoot(options = {}) {
  const explicitRoot = String(
    options?.portfolioRoot ??
      options?.["portfolio-root"] ??
      options?.portfolio_root ??
      process.env.PORTFOLIO_ROOT ??
      ""
  ).trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const accountId = normalizeAccountId(
    options?.user ?? options?.account ?? process.env.PORTFOLIO_USER
  );
  if (MAIN_ACCOUNT_ALIASES.has(accountId)) {
    return defaultPortfolioRoot;
  }

  return path.join(portfolioUsersRoot, accountId);
}

export function resolveAccountId(options = {}) {
  const explicitUser = normalizeAccountId(
    options?.user ?? options?.account ?? process.env.PORTFOLIO_USER
  );
  if (explicitUser) {
    return MAIN_ACCOUNT_ALIASES.has(explicitUser) ? "main" : explicitUser;
  }

  const root = resolvePortfolioRoot(options);
  return root === defaultPortfolioRoot ? "main" : path.basename(root);
}

export function buildPortfolioPath(portfolioRoot, ...segments) {
  return path.join(portfolioRoot, ...segments);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasDiscoverableAccountState(portfolioRoot) {
  return (
    (await pathExists(buildPortfolioPath(portfolioRoot, "latest.json"))) ||
    (await pathExists(buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json"))) ||
    (await pathExists(buildPortfolioPath(portfolioRoot, "state-manifest.json")))
  );
}

export async function listDiscoveredPortfolioAccounts({ includeMain = true } = {}) {
  const accounts = [];

  if (includeMain) {
    accounts.push({
      id: "main",
      portfolioRoot: defaultPortfolioRoot
    });
  }

  let entries = [];
  try {
    entries = await readdir(portfolioUsersRoot, { withFileTypes: true });
  } catch {
    return accounts;
  }

  const userDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entry) => isValidDiscoverableAccountId(entry))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));

  for (const accountId of userDirs) {
    const portfolioRoot = path.join(portfolioUsersRoot, accountId);
    if (!(await hasDiscoverableAccountState(portfolioRoot))) {
      continue;
    }
    accounts.push({
      id: accountId,
      portfolioRoot
    });
  }

  return accounts;
}
