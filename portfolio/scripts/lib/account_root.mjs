import path from "node:path";

export const workspaceRoot = "/Users/yinshiwei/codex/tz";
export const defaultPortfolioRoot = `${workspaceRoot}/portfolio`;
export const portfolioUsersRoot = `${workspaceRoot}/portfolio_users`;

const MAIN_ACCOUNT_ALIASES = new Set(["", "main", "default", "primary", "tz"]);

function normalizeAccountId(value) {
  return String(value ?? "").trim();
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
