import { access, readFile } from "node:fs/promises";

import { buildPortfolioPath } from "./account_root.mjs";

export async function readJsonOrNull(path) {
  if (!path) {
    return null;
  }

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function buildPortfolioStatePaths(portfolioRoot, manifest = null) {
  const canonical = manifest?.canonical_entrypoints ?? {};

  return {
    portfolioStatePath:
      canonical.portfolio_state ?? buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json"),
    latestCompatPath:
      canonical.latest_compat_view ??
      canonical.latest_snapshot ??
      buildPortfolioPath(portfolioRoot, "latest.json"),
    latestRawPath:
      canonical.latest_raw_snapshot ?? buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json")
  };
}

export async function loadPreferredPortfolioState({ portfolioRoot, manifest = null }) {
  const paths = buildPortfolioStatePaths(portfolioRoot, manifest);
  const portfolioState = await readJsonOrNull(paths.portfolioStatePath);
  if (portfolioState) {
    return {
      payload: portfolioState,
      sourcePath: paths.portfolioStatePath,
      sourceKind: "portfolio_state",
      paths
    };
  }

  const latestCompat = await readJsonOrNull(paths.latestCompatPath);
  return {
    payload: latestCompat,
    sourcePath: latestCompat ? paths.latestCompatPath : null,
    sourceKind: latestCompat ? "latest_compat" : "missing",
    paths
  };
}

export async function loadCanonicalPortfolioState({ portfolioRoot, manifest = null }) {
  const paths = buildPortfolioStatePaths(portfolioRoot, manifest);
  const portfolioState = await readJsonOrNull(paths.portfolioStatePath);

  if (!portfolioState || !Array.isArray(portfolioState?.positions)) {
    throw new Error(
      `portfolio_state.json is required and must contain positions[]: ${paths.portfolioStatePath}`
    );
  }

  return {
    payload: portfolioState,
    sourcePath: paths.portfolioStatePath,
    sourceKind: "portfolio_state",
    paths
  };
}
