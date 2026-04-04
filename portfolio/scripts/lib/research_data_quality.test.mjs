import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchDataQualityMatrix } from "./research_data_quality.mjs";

test("buildResearchDataQualityMatrix marks stale zeroed northbound flow as degraded", () => {
  const result = buildResearchDataQualityMatrix({
    tradeDate: "2026-04-03",
    session: "intraday",
    cnMarketSnapshot: {
      sections: {
        northbound_flow: {
          latest_date: "2026-04-02",
          latest_summary_net_buy_100m_cny: 0,
          latest_intraday_net_inflow_100m_cny: 0,
          note: "当前北向端点可返回通道状态，但当日净流入数值回零，暂不做强解释。"
        }
      }
    },
    marketSnapshot: {}
  });

  assert.equal(result.sections.northbound_flow.status, "degraded");
  assert.equal(result.sections.northbound_flow.tradability_relevance, "blocked");
  assert.match(result.sections.northbound_flow.blocked_reason ?? "", /回零|过期|滞后/);
  assert.ok(result.flags.includes("northbound_flow_degraded"));
});
