import { getComparableChangePercent } from "./market_schedule_guard.mjs";

function findMove(rows = [], pattern) {
  const row = rows.find((item) => pattern.test(String(item?.label ?? "")));
  return getComparableChangePercent(row);
}

export function buildResearchGoldFactorModel({
  marketSnapshot = {},
  eventDriver = {}
} = {}) {
  const goldMove = findMove(marketSnapshot?.commodities ?? [], /金/u);
  const oilMove = findMove(marketSnapshot?.commodities ?? [], /油/u);
  const usdMove = findMove(marketSnapshot?.rates_fx ?? [], /美元/u);
  const equityMove = findMove(
    [
      ...(Array.isArray(marketSnapshot?.global_indices) ? marketSnapshot.global_indices : []),
      ...(Array.isArray(marketSnapshot?.hong_kong_indices) ? marketSnapshot.hong_kong_indices : [])
    ],
    /纳斯|标普|恒生|指数/u
  );

  const secondaryGoldDrivers = [];
  let dominantGoldDriver = "mixed_inputs";
  let goldRegime = "unclear";
  let goldActionBias = "observe";
  const goldRiskNotes = [];

  if (Number.isFinite(goldMove) && goldMove > 0 && Number.isFinite(usdMove) && usdMove < 0) {
    dominantGoldDriver = "usd_liquidity_tailwind";
    goldRegime = "macro_liquidity_bid";
    goldActionBias = "buy_on_pullback_only";
    goldRiskNotes.push("美元走弱抬升金价弹性，但若美元反抽，黄金短线回撤会放大。");
  }

  if (Number.isFinite(goldMove) && goldMove < 0 && Number.isFinite(usdMove) && usdMove > 0 && Number.isFinite(equityMove) && equityMove < 0) {
    dominantGoldDriver = "liquidity_deleveraging";
    goldRegime = "forced_liquidation";
    goldActionBias = "avoid_chasing_dip";
    goldRiskNotes.push("黄金下跌并非单纯避险失效，更可能是流动性挤兑下的被动卖出。");
  }

  if (Number.isFinite(goldMove) && goldMove > 0 && Number.isFinite(equityMove) && equityMove < 0) {
    secondaryGoldDrivers.push("defensive_bid");
  }

  if (Number.isFinite(goldMove) && goldMove > 0 && Number.isFinite(oilMove) && oilMove > 0) {
    secondaryGoldDrivers.push("commodity_inflation_pass_through");
  } else if (Number.isFinite(goldMove) && goldMove > 0 && Number.isFinite(oilMove) && oilMove < 0) {
    secondaryGoldDrivers.push("geopolitics_residual_bid");
    secondaryGoldDrivers.push("oil_disinflation_real_rate_relief");
  }

  if (
    Number.isFinite(goldMove) &&
    goldMove > 0 &&
    Number.isFinite(equityMove) &&
    equityMove > 0 &&
    Number.isFinite(oilMove) &&
    oilMove < 0
  ) {
    secondaryGoldDrivers.push("risk_on_without_gold_breakdown");
    goldRiskNotes.push("黄金与权益同步上涨，更像美元/利率/流动性重定价，而非单一避险交易。");
  }

  if (String(eventDriver?.driver_type ?? "").includes("geopolitics")) {
    secondaryGoldDrivers.push("headline_geopolitics_overlay");
  }

  return {
    dominantGoldDriver,
    secondaryGoldDrivers: [...new Set(secondaryGoldDrivers)],
    goldRegime,
    goldActionBias,
    goldRiskNotes
  };
}
