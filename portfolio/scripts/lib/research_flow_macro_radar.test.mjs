import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchFlowMacroRadar } from "./research_flow_macro_radar.mjs";

test("buildResearchFlowMacroRadar returns risk_on regime when yields ease and capital flows confirm", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: { fed_watch: { implied_cut_probability_next_meeting: 68 } },
    marketSnapshot: {
      commodities: [
        { label: "伦敦金", change_pct: 0.5 },
        { label: "WTI原油", change_pct: 1.2 }
      ],
      rates_fx: [
        { label: "美元指数", change_pct: -0.6 },
        { label: "美国10Y国债", change_pct: -0.15 }
      ]
    },
    cnMarketSnapshot: {
      sections: {
        northbound_flow: { latest_summary_net_buy_100m_cny: 45 },
        sector_fund_flow: { top_inflow_sectors: ["券商"] }
      }
    },
    hkFlowSnapshot: {
      southbound_net_buy_100m_hkd: 33,
      hk_tech_relative_strength: 1.4
    }
  });

  assert.equal(result.liquidity_regime, "risk_on");
  assert.ok(result.confidence >= 0.75);
});

test("buildResearchFlowMacroRadar returns stress regime when oil/gold spike with USD strength", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {},
    marketSnapshot: {
      commodities: [
        { label: "伦敦金", change_pct: 1.6 },
        { label: "WTI原油", change_pct: 3.8 }
      ],
      rates_fx: [
        { label: "美元指数", change_pct: 0.9 },
        { label: "美国10Y国债", change_pct: 0.08 }
      ]
    },
    cnMarketSnapshot: { sections: {} },
    hkFlowSnapshot: {}
  });

  assert.equal(result.liquidity_regime, "stress");
  assert.ok(result.confidence >= 0.5);
});

test("buildResearchFlowMacroRadar degrades confidence when anchors missing", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {},
    marketSnapshot: { commodities: [], rates_fx: [] },
    cnMarketSnapshot: { sections: {} },
    hkFlowSnapshot: {}
  });

  assert.equal(result.liquidity_regime, "neutral");
  assert.ok(result.confidence < 0.5);
});

test("buildResearchFlowMacroRadar supports persisted pct_change rows and derives hk relative strength from live indices", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {},
    marketSnapshot: {
      hong_kong_indices: [
        { label: "恒生指数", pct_change: 0.3 },
        { label: "恒生科技", pct_change: 1.4 }
      ],
      commodities: [{ label: "COMEX黄金", pct_change: 0.2 }],
      rates_fx: [
        { label: "美元指数", pct_change: -0.4 },
        { label: "美国10Y国债", pct_change: -0.1 }
      ]
    },
    cnMarketSnapshot: {
      sections: {
        northbound_flow: { latest_summary_net_buy_100m_cny: 20 }
      }
    },
    hkFlowSnapshot: {}
  });

  assert.equal(result.liquidity_regime, "risk_on");
  assert.equal(result.hong_kong_flows.hk_tech_relative_strength, 1.1);
});

test("buildResearchFlowMacroRadar ignores Hong Kong previous-close references when the market is closed", () => {
  const result = buildResearchFlowMacroRadar({
    macroState: {},
    marketSnapshot: {
      hong_kong_indices: [
        {
          label: "恒生指数",
          pct_change: -0.7,
          quote_usage: "previous_close_reference"
        },
        {
          label: "恒生科技",
          pct_change: -1.63,
          quote_usage: "previous_close_reference"
        }
      ],
      commodities: [],
      rates_fx: []
    },
    cnMarketSnapshot: { sections: {} },
    hkFlowSnapshot: {}
  });

  assert.equal(result.hong_kong_flows.hk_tech_relative_strength, null);
});
