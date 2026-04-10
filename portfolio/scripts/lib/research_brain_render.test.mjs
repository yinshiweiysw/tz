import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResearchActionDecisionLines,
  buildResearchDriverLines,
  buildResearchEventWatchLines,
  buildResearchFlowRadarLines,
  buildResearchFlowValidationLines,
  buildResearchGoldFactorLines,
  buildResearchHeadlineLines,
  buildUnifiedResearchSections,
  flattenResearchSections
} from "./research_brain_render.mjs";

test("buildResearchDriverLines renders the primary driver and pricing assessment", () => {
  const lines = buildResearchDriverLines({
    status: "active_market_driver",
    primary_driver: "特朗普关税发言触发全球再定价",
    priced_in_assessment: "underpriced",
    evidence: [{ source: "telegraph", headline: "关税升级" }]
  });

  assert.ok(lines.some((line) => line.includes("特朗普关税发言")));
  assert.ok(lines.some((line) => line.includes("underpriced")));
});

test("buildResearchFlowRadarLines renders liquidity regime and summary", () => {
  const lines = buildResearchFlowRadarLines({
    liquidity_regime: "stress",
    confidence: 0.86,
    summary: "地缘与通胀组合扰动；流动性偏避险。"
  });

  assert.ok(lines.some((line) => line.includes("stress")));
  assert.ok(lines.some((line) => line.includes("偏避险")));
});

test("buildResearchHeadlineLines renders analysis mode and top headlines", () => {
  const lines = buildResearchHeadlineLines({
    analysis_mode: "multi_source_confirmed",
    top_headlines: [
      {
        source: "Reuters",
        title: "Trump says Iran ceasefire talks continue",
        published_at: "2026-04-08T09:20:00+08:00"
      },
      {
        source: "WSJ",
        title: "Ceasefire negotiations reshape risk appetite",
        published_at: "2026-04-08T09:18:00+08:00"
      }
    ]
  });

  assert.ok(lines.some((line) => line.includes("multi_source_confirmed")));
  assert.ok(lines.some((line) => line.includes("Reuters")));
  assert.ok(lines.some((line) => line.includes("WSJ")));
});

test("buildResearchEventWatchLines renders tomorrow risks, weekly catalysts and deadline watch", () => {
  const lines = buildResearchEventWatchLines({
    readiness: "ready",
    summary: {
      total_high_impact_events: 3,
      tomorrow_risk_count: 1,
      this_week_catalyst_count: 2,
      deadline_watch_count: 1
    },
    tomorrow_risks: [
      {
        title: "China CPI/PPI",
        scheduledAt: "2026-04-11T09:30:00+08:00"
      }
    ],
    this_week_catalysts: [
      {
        title: "China CPI/PPI",
        scheduledAt: "2026-04-11T09:30:00+08:00"
      },
      {
        title: "US CPI",
        scheduledAt: "2026-04-11T20:30:00+08:00"
      }
    ],
    deadline_watch: [
      {
        title: "US-Iran Truce Window",
        scheduledAt: "2026-04-22T00:00:00+08:00",
        deadlineAt: "2026-04-24T23:59:59+08:00"
      }
    ]
  });

  assert.ok(lines.some((line) => line.includes("ready")));
  assert.ok(lines.some((line) => line.includes("明日风险")));
  assert.ok(lines.some((line) => line.includes("周内催化")));
  assert.ok(lines.some((line) => line.includes("到期窗口")));
});

test("buildResearchGoldFactorLines renders dominant driver and action bias", () => {
  const lines = buildResearchGoldFactorLines({
    dominantGoldDriver: "liquidity_deleveraging",
    secondaryGoldDrivers: ["headline_geopolitics_overlay"],
    goldRegime: "forced_liquidation",
    goldActionBias: "avoid_chasing_dip",
    goldRiskNotes: ["黄金下跌并非单纯避险失效，更可能是流动性挤兑下的被动卖出。"]
  });

  assert.ok(lines.some((line) => line.includes("liquidity_deleveraging")));
  assert.ok(lines.some((line) => line.includes("avoid_chasing_dip")));
  assert.ok(lines.some((line) => line.includes("流动性挤兑")));
});

test("buildResearchActionDecisionLines renders blocked trading explicitly", () => {
  const lines = buildResearchActionDecisionLines({
    desk_conclusion: {
      trade_permission: "blocked",
      one_sentence_order: "当前禁止生成交易指令。"
    },
    portfolio_actions: []
  });

  assert.ok(lines.some((line) => line.includes("blocked")));
  assert.ok(lines.some((line) => line.includes("禁止")));
});

test("buildResearchFlowValidationLines renders northbound and southbound validation together", () => {
  const lines = buildResearchFlowValidationLines({
    sections: {
      northbound_flow: {
        latest_summary_net_buy_100m_cny: -23.4,
        latest_intraday_net_inflow_100m_cny: -11.2
      },
      southbound_flow: {
        latest_date: "2026-04-02",
        latest_summary_net_buy_100m_hkd: 198.28,
        latest_intraday_time: "16:10",
        latest_intraday_net_inflow_100m_hkd: 198.28
      }
    }
  });

  assert.ok(lines.some((line) => line.includes("北向")));
  assert.ok(lines.some((line) => line.includes("南向")));
});

test("buildResearchFlowValidationLines suppresses degraded northbound data from flow judgement", () => {
  const lines = buildResearchFlowValidationLines(
    {
      sections: {
        northbound_flow: {
          latest_date: "2026-04-02",
          latest_summary_net_buy_100m_cny: 0,
          latest_intraday_net_inflow_100m_cny: 0,
          note: "当前北向端点可返回通道状态，但当日净流入数值回零，暂不做强解释。"
        }
      }
    },
    {
      sections: {
        northbound_flow: {
          status: "degraded",
          blocked_reason: "北向资金数值回零且日期落后于交易日，不纳入当日资金判断。"
        }
      }
    }
  );

  assert.ok(lines.some((line) => line.includes("不纳入当日资金判断")));
  assert.equal(lines.some((line) => line.includes("净买额")), false);
});

test("buildUnifiedResearchSections returns the shared research headings in stable order", () => {
  const sections = buildUnifiedResearchSections({
    researchBrain: {
      event_driver: { status: "active_market_driver", primary_driver: "中东地缘升级推动油价再定价" },
      flow_macro_radar: {
        liquidity_regime: "neutral",
        confidence: 0.85,
        summary: "流动性中性，需等待更清晰信号。"
      },
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "allowed",
          one_sentence_order: "允许围绕现有组合做选择性进攻。"
        }
      }
    },
    cnMarketSnapshot: {
      sections: {
        southbound_flow: {
          latest_date: "2026-04-02",
          latest_summary_net_buy_100m_hkd: 198.28
        }
      }
    },
    researchGuardLines: ["- 决策状态：ready。"]
  });

  assert.deepEqual(
    sections.map((item) => item.heading),
    [
      "## Institutional Research Readiness",
      "## Active Market Driver",
      "## Flow & Macro Radar",
      "## China / HK Flow Validation",
      "## Desk Action Conclusion"
    ]
  );
});

test("buildUnifiedResearchSections adds headline and gold sections when research brain includes them", () => {
  const sections = buildUnifiedResearchSections({
    researchBrain: {
      analysis_mode: "multi_source_confirmed",
      top_headlines: [
        {
          source: "Reuters",
          title: "Trump says Iran ceasefire talks continue",
          published_at: "2026-04-08T09:20:00+08:00"
        }
      ],
      gold_factor_model: {
        dominantGoldDriver: "usd_liquidity_tailwind",
        secondaryGoldDrivers: ["geopolitics_residual_bid"],
        goldRegime: "macro_liquidity_bid",
        goldActionBias: "buy_on_pullback_only",
        goldRiskNotes: ["美元走弱抬升金价弹性。"]
      },
      event_driver: { status: "active_market_driver", primary_driver: "中东停火预期重估全球风险偏好" },
      flow_macro_radar: {
        liquidity_regime: "neutral",
        confidence: 0.85,
        summary: "流动性中性，需等待更清晰信号。"
      },
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "allowed",
          one_sentence_order: "允许围绕现有组合做选择性进攻。"
        }
      }
    },
    cnMarketSnapshot: {},
    researchGuardLines: ["- 决策状态：ready。"]
  });

  assert.ok(sections.some((item) => item.heading === "## Headline Tape"));
  assert.ok(sections.some((item) => item.heading === "## Gold Factor Model"));
});

test("buildUnifiedResearchSections adds event watch section when event_watch is present", () => {
  const sections = buildUnifiedResearchSections({
    researchBrain: {
      event_watch: {
        readiness: "ready",
        summary: {
          total_high_impact_events: 1,
          tomorrow_risk_count: 1,
          this_week_catalyst_count: 1,
          deadline_watch_count: 0
        },
        tomorrow_risks: [
          {
            title: "US CPI",
            scheduledAt: "2026-04-11T20:30:00+08:00"
          }
        ],
        this_week_catalysts: [
          {
            title: "US CPI",
            scheduledAt: "2026-04-11T20:30:00+08:00"
          }
        ],
        deadline_watch: []
      }
    }
  });

  assert.ok(sections.some((item) => item.heading === "## Event Watch"));
});

test("flattenResearchSections expands headings and lines for downstream reports", () => {
  const lines = flattenResearchSections([
    { heading: "## Active Market Driver", lines: ["- 主线：中东地缘升级推动油价再定价"] },
    { heading: "## China / HK Flow Validation", lines: ["- 南向资金：2026-04-02 净买额 +198.28 亿元"] }
  ]);

  assert.ok(lines.includes("## Active Market Driver"));
  assert.ok(lines.includes("## China / HK Flow Validation"));
  assert.ok(lines.includes("- 南向资金：2026-04-02 净买额 +198.28 亿元"));
});
