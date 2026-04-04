import test from "node:test";
import assert from "node:assert/strict";

import { buildDialogueAnalysisContract } from "./dialogue_analysis_contract.mjs";

test("buildDialogueAnalysisContract reuses shared research sections and exposes flow validation", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      generated_at: "2026-04-03T00:10:00+08:00",
      decision_readiness: { level: "ready" },
      event_driver: {
        primary_driver: "中东地缘升级推动油价再定价",
        priced_in_assessment: "underpriced"
      },
      flow_macro_radar: {
        liquidity_regime: "neutral",
        summary: "流动性中性，需等待更清晰信号。"
      },
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "allowed",
          one_sentence_order: "允许围绕现有组合做选择性进攻。",
          must_not_do: ["不要脱离组合框架追涨"]
        },
        portfolio_actions: [
          {
            target_key: "007339",
            stance: "hold",
            execution_note: "仅在既定计划范围内执行。"
          }
        ],
        new_watchlist_actions: [
          {
            theme: "红利低波",
            stance: "watch",
            why_now: "利差仍有吸引力。"
          }
        ]
      }
    },
    cnMarketSnapshot: {
      sections: {
        southbound_flow: {
          latest_date: "2026-04-02",
          latest_summary_net_buy_100m_hkd: 198.28,
          latest_intraday_time: "16:10",
          latest_intraday_net_inflow_100m_hkd: 198.28
        }
      }
    }
  });

  assert.equal(contract.market_core.active_driver, "中东地缘升级推动油价再定价");
  assert.equal(contract.market_core.southbound_net_buy_100m_hkd, 198.28);
  assert.ok(
    contract.shared_research_sections.some(
      (section) => section.heading === "## China / HK Flow Validation"
    )
  );
  assert.ok(contract.dialogue_cues.opening_brief.includes("中东地缘升级推动油价再定价"));
});

test("buildDialogueAnalysisContract summarizes speculative overlay and first trade focus", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "allowed",
          one_sentence_order: "允许围绕现有组合做选择性进攻。",
          must_not_do: ["不要情绪化追单"]
        }
      }
    },
    speculativePlan: {
      instructions: []
    },
    tradePlan: {
      summary: {
        actionable_trade_count: 2,
        gross_buy_cny: 5000,
        gross_sell_cny: 3000
      },
      trades: [
        {
          symbol: "007339",
          execution_action: "Buy",
          planned_trade_amount_cny: 5000
        }
      ]
    }
  });

  assert.equal(contract.speculative_overlay.instruction_count, 0);
  assert.equal(contract.trade_plan_summary.actionable_trade_count, 2);
  assert.ok(contract.dialogue_cues.analyst_focus.some((line) => line.includes("007339")));
  assert.ok(contract.dialogue_cues.blocked_actions.some((line) => line.includes("不要情绪化追单")));
});
