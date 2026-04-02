import { getFundWatchlistQuotes } from "../../../market-mcp/src/providers/fund.js";
import { buildPortfolioPath, resolvePortfolioRoot } from "./account_root.mjs";

export function resolveFundsPluginImportPath(options = {}) {
  return buildPortfolioPath(resolvePortfolioRoot(options), "funds-plugin-import.json");
}

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

export async function buildFundsPluginPayload(options = {}) {
  const portfolioRoot = resolvePortfolioRoot(options);
  const quotes = await getFundWatchlistQuotes(
    buildPortfolioPath(portfolioRoot, "fund-watchlist.json")
  ).catch(() => ({ items: [] }));

  const fundListM = quotes.items.map((item) => {
    const price = item.valuation ?? item.netValue ?? null;
    const amount = Number(item.approxCurrentAmountCny ?? 0);
    const num =
      price && Number.isFinite(amount) && amount > 0
        ? round(amount / price)
        : 0;

    return {
      code: item.code,
      num
    };
  });

  return {
    fundListM,
    isLiveUpdate: true,
    showAmount: true,
    showGains: true,
    showGSZ: true,
    showCost: false,
    showCostRate: false
  };
}
