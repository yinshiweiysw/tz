import { getComparableChangePercent } from "./market_schedule_guard.mjs";

function findMove(rows = [], matcher) {
  const row = rows.find((item) => matcher(String(item?.label ?? "")));
  return getComparableChangePercent(row);
}

function deriveHkTechRelativeStrength(marketSnapshot = {}, hkFlowSnapshot = {}) {
  const explicitStrength = Number(hkFlowSnapshot?.hk_tech_relative_strength ?? NaN);
  if (Number.isFinite(explicitStrength)) {
    return explicitStrength;
  }

  const hsiMove = findMove(marketSnapshot.hong_kong_indices ?? [], (label) => label.includes("恒生指数"));
  const hstechMove = findMove(marketSnapshot.hong_kong_indices ?? [], (label) => label.includes("恒生科技"));
  if (!Number.isFinite(hsiMove) || !Number.isFinite(hstechMove)) {
    return null;
  }

  return Number((hstechMove - hsiMove).toFixed(2));
}

export function buildResearchFlowMacroRadar({
  macroState = {},
  marketSnapshot = {},
  cnMarketSnapshot = {},
  hkFlowSnapshot = {}
} = {}) {
  const goldMove = findMove(marketSnapshot.commodities ?? [], (label) => label.includes("金"));
  const oilMove = findMove(marketSnapshot.commodities ?? [], (label) => label.includes("油"));
  const dxyMove = findMove(marketSnapshot.rates_fx ?? [], (label) => label.includes("美元"));
  const us10yMove = findMove(marketSnapshot.rates_fx ?? [], (label) =>
    label.includes("10Y") || label.includes("10年")
  );
  const northbound = Number(
    cnMarketSnapshot?.sections?.northbound_flow?.latest_summary_net_buy_100m_cny ?? NaN
  );
  const southbound = Number(hkFlowSnapshot?.southbound_net_buy_100m_hkd ?? NaN);
  const hkTechStrength = deriveHkTechRelativeStrength(marketSnapshot, hkFlowSnapshot);

  let liquidityRegime = "neutral";
  if (
    Number.isFinite(oilMove) &&
    oilMove >= 2 &&
    Number.isFinite(goldMove) &&
    goldMove >= 1 &&
    Number.isFinite(dxyMove) &&
    dxyMove > 0
  ) {
    liquidityRegime = "stress";
  } else if (
    Number.isFinite(us10yMove) &&
    us10yMove < 0 &&
    Number.isFinite(dxyMove) &&
    dxyMove < 0 &&
    ((Number.isFinite(northbound) && northbound > 0) ||
      (Number.isFinite(southbound) && southbound > 0))
  ) {
    liquidityRegime = "risk_on";
  } else if (
    Number.isFinite(northbound) &&
    northbound < 0 &&
    Number.isFinite(dxyMove) &&
    dxyMove > 0
  ) {
    liquidityRegime = "risk_off";
  }

  const knownAnchors = [goldMove, oilMove, dxyMove, us10yMove].filter((value) =>
    Number.isFinite(value)
  ).length;
  const confidence = Number(
    (Math.min(knownAnchors, 4) / 4 + (Number.isFinite(hkTechStrength) ? 0.1 : 0)).toFixed(2)
  );

  return {
    cross_asset_anchors: {
      us10y_yield: us10yMove,
      dxy: dxyMove,
      gold: goldMove,
      oil: oilMove,
      fed_cut_probability: macroState?.fed_watch?.implied_cut_probability_next_meeting ?? null,
      cpi_status: macroState?.inflation?.cpi_status ?? null,
      ppi_status: macroState?.inflation?.ppi_status ?? null
    },
    china_flows: {
      northbound,
      sector_flow: cnMarketSnapshot?.sections?.sector_fund_flow ?? {},
      a_share_breadth: cnMarketSnapshot?.sections?.market_breadth ?? null
    },
    hong_kong_flows: {
      southbound,
      hang_seng_leadership: hkFlowSnapshot?.hang_seng_leadership ?? null,
      hk_tech_relative_strength: hkTechStrength
    },
    liquidity_regime: liquidityRegime,
    confidence,
    summary:
      liquidityRegime === "stress"
        ? "地缘与通胀组合扰动；流动性偏避险。"
        : liquidityRegime === "risk_on"
        ? "流动性充裕，资金偏风险资产。"
        : "流动性中性，需等待更清晰信号。",
    alerts: []
  };
}
