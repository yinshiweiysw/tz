import { access, readdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const currentFilePath = fileURLToPath(import.meta.url);
const derivedWorkspaceRoot = path.resolve(path.dirname(currentFilePath), "..", "..", "..");

const PORTFOLIO_STATE_ANCHORS = [
  ["state", "portfolio_state.json"],
  ["data", "dashboard_state.json"],
  ["data", "live_funds_snapshot.json"],
  ["latest.json"],
  ["snapshots", "latest_raw.json"]
];

function countPortfolioStateAnchors(portfolioRoot) {
  return PORTFOLIO_STATE_ANCHORS.reduce(
    (count, segments) => count + (existsSync(path.join(portfolioRoot, ...segments)) ? 1 : 0),
    0
  );
}

function discoverDefaultPortfolioRoot(root) {
  const parentRoot = path.dirname(root);
  let siblingRoots = [];

  try {
    siblingRoots = readdirSync(parentRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentRoot, entry.name));
  } catch {
    siblingRoots = [];
  }

  const candidates = [root, ...siblingRoots]
    .map((candidateRoot) => path.resolve(candidateRoot))
    .filter((candidateRoot, index, items) => items.indexOf(candidateRoot) === index)
    .map((candidateRoot) => {
      const candidatePortfolioRoot = path.join(candidateRoot, "portfolio");
      const hasAssetMaster = existsSync(path.join(candidatePortfolioRoot, "config", "asset_master.json"));
      return {
        portfolioRoot: candidatePortfolioRoot,
        score: hasAssetMaster ? countPortfolioStateAnchors(candidatePortfolioRoot) : -1,
        preferred: candidateRoot === root
      };
    })
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || Number(right.preferred) - Number(left.preferred));

  return candidates[0]?.portfolioRoot ?? path.join(root, "portfolio");
}

export const workspaceRoot = path.resolve(
  String(process.env.PORTFOLIO_WORKSPACE_ROOT ?? derivedWorkspaceRoot).trim() || derivedWorkspaceRoot
);
export const defaultPortfolioRoot = discoverDefaultPortfolioRoot(workspaceRoot);
export const portfolioUsersRoot = path.join(path.dirname(defaultPortfolioRoot), "portfolio_users");

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
    accounts.push({
      id: accountId,
      portfolioRoot
    });
  }

  return accounts;
}
