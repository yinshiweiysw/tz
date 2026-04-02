import { readFile } from "node:fs/promises";
import { buildPortfolioPath, resolvePortfolioRoot } from "./account_root.mjs";

export function resolveDefaultOpportunityMasterPath(portfolioRoot = resolvePortfolioRoot()) {
  return buildPortfolioPath(portfolioRoot, "config", "opportunity_master.json");
}

export const defaultOpportunityMasterPath = resolveDefaultOpportunityMasterPath();
const ALLOWED_ACTION_BIAS_DEFAULTS = new Set(["研究观察"]);

function normalizeTradableProxy(proxy = {}) {
  return {
    symbol: String(proxy.symbol ?? "").trim(),
    name: String(proxy.name ?? "").trim(),
    account_scope: Array.isArray(proxy.account_scope) ? proxy.account_scope : []
  };
}

export function normalizeOpportunityTheme(theme = {}) {
  const actionBiasDefault = String(theme.action_bias_default ?? "研究观察").trim();
  return {
    theme_name: String(theme.theme_name ?? "").trim(),
    market: String(theme.market ?? "").trim(),
    driver: String(theme.driver ?? "").trim(),
    risk_note: String(theme.risk_note ?? "").trim(),
    action_bias_default: ALLOWED_ACTION_BIAS_DEFAULTS.has(actionBiasDefault)
      ? actionBiasDefault
      : "研究观察",
    tradable_proxies: Array.isArray(theme.tradable_proxies)
      ? theme.tradable_proxies.map(normalizeTradableProxy)
      : []
  };
}

export async function loadOpportunityMaster(path = defaultOpportunityMasterPath) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  const themes = Array.isArray(payload?.themes)
    ? payload.themes
        .map(normalizeOpportunityTheme)
        .filter((theme) => theme.theme_name.length > 0)
    : [];
  const themeNameSet = new Set(themes.map((theme) => theme.theme_name));
  const requestedThemeOrder = Array.isArray(payload?.theme_order)
    ? payload.theme_order.map((name) => String(name ?? "").trim()).filter(Boolean)
    : [];
  const theme_order = [];
  for (const themeName of requestedThemeOrder) {
    if (themeNameSet.has(themeName) && !theme_order.includes(themeName)) {
      theme_order.push(themeName);
    }
  }
  if (theme_order.length === 0) {
    theme_order.push(...themes.map((theme) => theme.theme_name));
  }

  return {
    version: Number(payload?.version ?? 1),
    theme_order,
    themes
  };
}
