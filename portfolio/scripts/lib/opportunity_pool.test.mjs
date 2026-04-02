import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpportunityCandidate,
  classifyActionBias,
  rankOpportunityCandidates
} from "./opportunity_pool.mjs";

test("classifyActionBias upgrades to 允许试单 when expectation gap and technical support align", () => {
  const actionBias = classifyActionBias({
    expected_vs_actual_score: 2,
    technical_score: 2,
    funding_flow_score: 1,
    risk_penalty: 0
  });

  assert.equal(actionBias, "允许试单");
});

test("classifyActionBias returns 不做 when total score is negative after risk penalty", () => {
  const actionBias = classifyActionBias({
    expected_vs_actual_score: 0,
    technical_score: 1,
    funding_flow_score: 0,
    risk_penalty: 2
  });

  assert.equal(actionBias, "不做");
});

test("rankOpportunityCandidates sorts by total score desc", () => {
  const ranked = rankOpportunityCandidates([
    { theme_name: "黄金", total_score: 5 },
    { theme_name: "半导体", total_score: 8 },
    { theme_name: "A股核心", total_score: 2 }
  ]);

  assert.deepEqual(ranked.map((item) => item.theme_name), ["半导体", "黄金", "A股核心"]);
});

test("buildOpportunityCandidate returns full normalized shape with action bias", () => {
  const candidate = buildOpportunityCandidate(
    {
      theme_name: "黄金",
      market: "GLOBAL",
      driver: "地缘+真实利率",
      risk_note: "冲突缓和时回撤会很快",
      tradable_proxies: [{ symbol: "022502", name: "国泰黄金ETF联接E", account_scope: ["main"] }]
    },
    {
      expected_vs_actual: "风险溢价仍高于历史中位",
      expected_vs_actual_score: 2,
      technical_state: "中期趋势向上，短线震荡",
      technical_score: 1,
      funding_flow_state: "资金净流入延续",
      funding_flow_score: 1,
      risk_penalty: 0
    }
  );

  assert.equal(candidate.theme_name, "黄金");
  assert.equal(candidate.market, "GLOBAL");
  assert.equal(candidate.action_bias, "允许试单");
  assert.equal(candidate.total_score, 4);
  assert.equal(candidate.tradable_proxies[0].symbol, "022502");
  assert.equal(candidate.expected_vs_actual, "风险溢价仍高于历史中位");
  assert.equal(candidate.technical_state, "中期趋势向上，短线震荡");
  assert.equal(candidate.funding_flow_state, "资金净流入延续");
});
