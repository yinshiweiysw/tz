import test from "node:test";
import assert from "node:assert/strict";

import { buildView, deriveRiskCapitalContext } from "./generate_risk_dashboard.mjs";

test("deriveRiskCapitalContext prefers canonical cash semantics over reported cash estimates", () => {
  const context = deriveRiskCapitalContext({
    latest: {
      summary: {
        total_portfolio_assets_cny: 445000,
        total_fund_assets: 285000,
        settled_cash_cny: 160000,
        trade_available_cash_cny: 120000,
        cash_like_fund_assets_cny: 85000,
        liquidity_sleeve_assets_cny: 85000
      }
    },
    accountContext: {
      reported_cash_estimate_cny: 182616.3
    }
  });

  assert.equal(context.total_assets_cny, 445000);
  assert.equal(context.settled_cash_cny, 160000);
  assert.equal(context.trade_available_cash_cny, 120000);
  assert.equal(context.cash_like_fund_assets_cny, 85000);
  assert.equal(context.liquidity_sleeve_assets_cny, 85000);
});

test("buildView exposes denominator labels and cash semantics", () => {
  const view = buildView(
    "canonical",
    [
      { name: "易方达沪深300ETF联接C", amount: 20000, category: "A股宽基", bucket: "A_CORE" },
      { name: "兴全恒信债券C", amount: 70000, category: "偏债混合", bucket: "CASH" }
    ],
    {
      total_assets_cny: 445000,
      settled_cash_cny: 160000,
      trade_available_cash_cny: 120000,
      cash_like_fund_assets_cny: 85000,
      liquidity_sleeve_assets_cny: 85000
    }
  );

  assert.equal(view.capital_semantics.settled_cash_cny, 160000);
  assert.equal(view.capital_semantics.trade_available_cash_cny, 120000);
  assert.equal(view.capital_semantics.liquidity_sleeve_assets_cny, 85000);
  assert.equal(view.denominator_labels.bucket_weights, "pct_of_invested_assets");
  assert.equal(view.denominator_labels.cash_weights, "pct_of_total_assets");
  assert.equal(view.cash_pct_of_total_assets, 35.96);
});
