import test from "node:test";
import assert from "node:assert/strict";

import { buildDialogueAnalysisContract } from "./dialogue_analysis_contract.mjs";
import { buildReportHeadlineTape } from "./report_headline_tape.mjs";

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

test("buildDialogueAnalysisContract exposes unified agent entry snapshot for downstream analysis", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "limited",
          one_sentence_order: "允许小步试单。"
        }
      }
    },
    agentRuntimeContext: {
      generatedAt: "2026-04-08T11:26:27.761Z",
      accountId: "main",
      snapshotDate: "2026-04-08",
      portfolio: {
        settledCashCny: 52436.16,
        tradeAvailableCashCny: 52436.16,
        cashLikeFundAssetsCny: 105251.47,
        liquiditySleeveAssetsCny: 105251.47
      },
      positions: [
        {
          code: "023764",
          name: "华夏恒生互联网科技业ETF联接(QDII)D",
          observableAmount: 69414.58,
          quoteMode: "close_reference"
        }
      ]
    },
    strategyDecisionContract: {
      generatedAt: "2026-04-08T11:26:27.766Z",
      decisionReadiness: "degraded_observe_only",
      decisionReasons: ["研究覆盖不足"],
      freshness: {
        confirmedNavState: "late_missing"
      },
      cashSemantics: {
        settledCashCny: 52436.16,
        tradeAvailableCashCny: 52436.16,
        cashLikeFundAssetsCny: 105251.47,
        liquiditySleeveAssetsCny: 105251.47
      },
      regime: {
        tradePermission: "blocked",
        overallStance: "freeze"
      },
      executionGuardrails: {
        maxTotalBuyTodayCny: 20000
      },
      positionFacts: [
        {
          code: "023764",
          name: "华夏恒生互联网科技业ETF联接(QDII)D",
          amountCny: 69414.58,
          decisionValueSource: "observable",
          quoteMode: "close_reference"
        }
      ]
    },
    agentBootstrapContext: {
      entrypointIntegrity: {
        accountIdsAligned: true,
        cashSemanticsAligned: true,
        positionFactsAligned: true
      }
    }
  });

  assert.equal(contract.agent_entry_snapshot.entrypoint_integrity.accountIdsAligned, true);
  assert.equal(contract.agent_entry_snapshot.cash_semantics.tradeAvailableCashCny, 52436.16);
  assert.equal(contract.agent_entry_snapshot.strategy_snapshot.decisionReadiness, "degraded_observe_only");
  assert.deepEqual(contract.agent_entry_snapshot.strategy_snapshot.decisionReasons, ["研究覆盖不足"]);
  assert.equal(contract.agent_entry_snapshot.strategy_snapshot.tradePermission, "blocked");
  assert.equal(contract.agent_entry_snapshot.strategy_snapshot.maxTotalBuyTodayCny, 20000);
  assert.equal(contract.agent_entry_snapshot.top_positions[0].code, "023764");
  assert.equal(contract.agent_entry_snapshot.top_positions[0].decisionValueSource, "observable");
});

test("buildDialogueAnalysisContract keeps enriched top_headlines metadata for downstream market analysis", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      analysis_mode: "multi_source_confirmed",
      top_headlines: [
        {
          source: "财新",
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          published_at: "2026-04-08T13:10:00+08:00",
          marketTags: ["geopolitics", "commodities", "asia_session"],
          portfolioRelevanceScore: 7,
          sourceConfirmationCount: 3,
          crossAssetImpact: ["gold", "oil", "risk_assets"]
        }
      ]
    }
  });

  assert.equal(contract.news_context.top_headlines[0].marketTags.includes("geopolitics"), true);
  assert.equal(contract.news_context.top_headlines[0].portfolioRelevanceScore, 7);
  assert.equal(contract.news_context.top_headlines[0].sourceConfirmationCount, 3);
  assert.equal(contract.news_context.top_headlines[0].crossAssetImpact.includes("gold"), true);
});

test("buildDialogueAnalysisContract exposes event watch context for downstream analysis", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      event_watch: {
        readiness: "ready",
        tomorrow_risks: [
          {
            eventId: "us-cpi-2026-04-11",
            title: "US CPI",
            scheduledAt: "2026-04-11T20:30:00+08:00"
          }
        ],
        this_week_catalysts: [],
        deadline_watch: []
      }
    }
  });

  assert.equal(contract.market_context.event_watch.readiness, "ready");
  assert.equal(contract.market_context.event_watch.tomorrow_risks[0].eventId, "us-cpi-2026-04-11");
});

test("buildDialogueAnalysisContract exposes event_watch context and keeps it independent from telegraph headlines", () => {
  const contract = buildDialogueAnalysisContract({
    researchBrain: {
      event_watch: {
        readiness: "ready",
        summary: {
          total_high_impact_events: 3
        },
        next_event: {
          eventId: "us-cpi-2026-04",
          title: "US CPI",
          scheduledAt: "2026-04-11T20:30:00+08:00"
        },
        tomorrow_risks: [
          {
            eventId: "us-cpi-2026-04",
            title: "US CPI"
          }
        ],
        this_week_catalysts: [
          {
            eventId: "cn-cpi-2026-04",
            title: "China CPI/PPI"
          }
        ],
        deadline_watch: [
          {
            eventId: "iran-truce-expiry",
            title: "US-Iran Truce Window Expiry"
          }
        ]
      },
      top_headlines: [
        {
          source: "财联社",
          title: "盘中快讯：某板块拉升",
          published_at: "2026-04-10T14:01:00+08:00"
        }
      ]
    }
  });

  assert.equal(contract.news_context.event_watch.readiness, "ready");
  assert.equal(contract.news_context.event_watch.summary.total_high_impact_events, 3);
  assert.equal(contract.news_context.event_watch.next_event.eventId, "us-cpi-2026-04");
  assert.equal(contract.news_context.event_watch.tomorrow_risks[0].eventId, "us-cpi-2026-04");
  assert.equal(contract.news_context.top_headlines[0].title, "盘中快讯：某板块拉升");
});

test("buildReportHeadlineTape prefers event_watch as primary headline chain and keeps telegraph as auxiliary", () => {
  const tape = buildReportHeadlineTape({
    researchBrain: {
      event_watch: {
        readiness: "ready",
        tomorrow_risks: [
          {
            eventId: "us-cpi-2026-04",
            title: "US CPI",
            scheduledAt: "2026-04-11T20:30:00+08:00"
          }
        ],
        this_week_catalysts: [],
        deadline_watch: []
      }
    },
    headlineCandidates: [
      {
        title: "盘中快讯：某板块拉升"
      }
    ],
    telegraphCandidates: [
      {
        title: "港股异动"
      }
    ]
  });

  assert.equal(tape.primarySource, "event_watch");
  assert.equal(tape.primaryLines[0].includes("US CPI"), true);
  assert.equal(tape.auxiliaryLines[0].includes("港股异动"), true);
});

test("buildReportHeadlineTape degrades explicitly when event_watch is missing and does not let telegraph replace the primary chain", () => {
  const tape = buildReportHeadlineTape({
    researchBrain: {},
    headlineCandidates: [
      {
        title: "快讯：主题股拉升"
      }
    ],
    telegraphCandidates: [
      {
        title: "电报：某市场异动"
      }
    ]
  });

  assert.equal(tape.primarySource, "degraded_event_watch_missing");
  assert.equal(tape.primaryLines[0].includes("Event Watch"), true);
  assert.equal(tape.primaryLines[0].includes("降级"), true);
  assert.equal(tape.auxiliaryLines[0].includes("电报"), true);
});
