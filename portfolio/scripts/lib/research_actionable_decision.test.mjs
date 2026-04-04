import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchActionableDecision } from "./research_actionable_decision.mjs";

test("buildResearchActionableDecision allows portfolio and watchlist actions when readiness is ready", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    eventDriver: { status: "active_market_driver", primary_driver: "港股科技修复" },
    flowMacroRadar: { liquidity_regime: "risk_on", confidence: 0.82 },
    portfolioState: { positions: [{ code: "968012", bucket: "港股参与仓" }] },
    opportunityPool: {
      candidates: [
        { theme: "港股科技", action_bias: "watch", why_now: "南向承接增强" },
        { theme: "创新药", action_bias: "watch", why_now: "资金回流" }
      ]
    }
  });

  assert.equal(result.desk_conclusion.trade_permission, "allowed");
  assert.equal(result.portfolio_actions.length, 1);
  assert.ok(result.new_watchlist_actions.length <= 3);
});

test("buildResearchActionableDecision does not derive portfolio actions from legacy holdings only", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    eventDriver: { status: "active_market_driver", primary_driver: "A股核心修复" },
    flowMacroRadar: { liquidity_regime: "risk_on", confidence: 0.75 },
    portfolioState: {
      holdings: [
        {
          code: "007339",
          fund_name: "易方达沪深300ETF联接C"
        }
      ]
    },
    opportunityPool: {}
  });

  assert.equal(result.portfolio_actions.length, 0);
});

test("buildResearchActionableDecision restricts action language when readiness is degraded", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "analysis_degraded", analysis_allowed: true, trading_allowed: false },
    eventDriver: { status: "watch_only", primary_driver: "消息待验证" },
    flowMacroRadar: { liquidity_regime: "neutral", confidence: 0.42 },
    portfolioState: {},
    opportunityPool: {}
  });

  assert.equal(result.desk_conclusion.trade_permission, "restricted");
  assert.match(result.desk_conclusion.one_sentence_order ?? "", /条件/);
});

test("buildResearchActionableDecision blocks trading when readiness is blocked", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "trading_blocked", analysis_allowed: true, trading_allowed: false },
    eventDriver: { status: "active_market_driver", primary_driver: "地缘冲突" },
    flowMacroRadar: { liquidity_regime: "stress", confidence: 0.9 },
    portfolioState: {},
    opportunityPool: {}
  });

  assert.equal(result.desk_conclusion.trade_permission, "blocked");
  assert.equal(result.portfolio_actions.length, 0);
});

test("buildResearchActionableDecision maps real opportunity-pool candidate fields into watchlist actions", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    eventDriver: { status: "active_market_driver", primary_driver: "港股科技修复" },
    flowMacroRadar: { liquidity_regime: "risk_on", confidence: 0.8 },
    portfolioState: {},
    opportunityPool: {
      candidates: [
        {
          theme_name: "港股科技",
          expected_vs_actual: "事件和资金共振开始增强。"
        }
      ]
    }
  });

  assert.equal(result.new_watchlist_actions[0].theme, "港股科技");
  assert.match(result.new_watchlist_actions[0].why_now ?? "", /资金|事件/);
});

test("buildResearchActionableDecision derives portfolio actions from portfolio_state positions", () => {
  const result = buildResearchActionableDecision({
    decisionReadiness: { level: "ready", analysis_allowed: true, trading_allowed: true },
    eventDriver: { status: "active_market_driver", primary_driver: "A股核心修复" },
    flowMacroRadar: { liquidity_regime: "risk_on", confidence: 0.75 },
    portfolioState: {
      positions: [
        {
          fund_code: "007339",
          fund_name: "易方达沪深300ETF联接C"
        }
      ]
    },
    opportunityPool: {}
  });

  assert.equal(result.portfolio_actions[0].target_key, "007339");
});
