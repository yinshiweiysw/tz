import { readFile } from "node:fs/promises";

import { buildPortfolioPath, resolvePortfolioRoot } from "./account_root.mjs";

export function resolveDefaultIpsConstraintsPath(portfolioRoot = resolvePortfolioRoot()) {
  return buildPortfolioPath(portfolioRoot, "config", "ips_constraints.json");
}

export const defaultIpsConstraintsPath = resolveDefaultIpsConstraintsPath();

function normalizePct(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1) {
    return fallback;
  }
  return numeric;
}

export function normalizeIpsConstraints(payload = {}) {
  return {
    drawdown: {
      reEvaluatePct: normalizePct(payload?.drawdown?.re_evaluate_pct, 0.08),
      hardStopPct: normalizePct(payload?.drawdown?.hard_stop_pct, 0.12)
    },
    concentration: {
      singleFundMaxPct: normalizePct(payload?.concentration?.single_fund_max_pct, 0.1),
      singleThemeMaxPct: normalizePct(payload?.concentration?.single_theme_max_pct, 0.15),
      highCorrelationMaxPct: normalizePct(payload?.concentration?.high_correlation_max_pct, 0.25)
    },
    cashFloorPct: normalizePct(payload?.cash_floor_pct, 0.15),
    speculativeCapPct: normalizePct(payload?.speculative_cap_pct, 0.15),
    rebalanceTriggerDeviationPct: normalizePct(payload?.rebalance_trigger_deviation_pp, 0.05)
  };
}

export async function loadIpsConstraints(path = defaultIpsConstraintsPath) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  return normalizeIpsConstraints(payload);
}
