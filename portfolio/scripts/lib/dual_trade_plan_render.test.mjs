import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDualTradePlanPayload,
  buildInstitutionalActionLines,
  buildOpportunitySummary,
  buildSpeculativeDisciplineBlock,
  extractSpeculativeConclusionLines,
  renderDualTradePlanMarkdown
} from "./dual_trade_plan_render.mjs";

test("buildInstitutionalActionLines renders action memo lines without mixing speculative discipline", () => {
  const lines = buildInstitutionalActionLines({
    thesis: "A股核心与红利防守成为今日主线",
    expectationGap: "指数修复弱于主题活跃度，市场对风险偏好修复仍有分歧",
    allowedActions: ["仅允许按计划小步试单", "优先防守仓再看核心仓"],
    blockedActions: ["禁止盘中追涨", "禁止脱离计划临时加仓"],
    speculativeDiscipline: "博弈仓只保留侦察仓"
  });

  assert.deepEqual(lines, [
    "- 今日主线：A股核心与红利防守成为今日主线",
    "- 当前预期差：指数修复弱于主题活跃度，市场对风险偏好修复仍有分歧",
    "- 允许动作：仅允许按计划小步试单；优先防守仓再看核心仓",
    "- 禁止动作：禁止盘中追涨；禁止脱离计划临时加仓"
  ]);
  assert.equal(lines.some((line) => line.includes("博弈系统纪律")), false);
});

test("buildInstitutionalActionLines suppresses executable wording when trade permission is blocked", () => {
  const lines = buildInstitutionalActionLines({
    thesis: "中东地缘升级推动油价再定价",
    expectationGap: "风险溢价仍在抬升",
    allowedActions: ["主系统优先处理 核心仓 / 招商量化精选股票A / 5,000.00 元，状态：可执行"],
    blockedActions: ["禁止跳过 trade card / journal 直接下单"],
    tradePermission: "blocked",
    blockedOrder: "研究闸门未通过，当前禁止生成交易指令。"
  });

  assert.deepEqual(lines, [
    "- 今日主线：中东地缘升级推动油价再定价",
    "- 当前预期差：风险溢价仍在抬升",
    "- 允许动作：仅允许观察与记录，不生成交易指令",
    "- 禁止动作：研究闸门未通过，当前禁止生成交易指令。"
  ]);
  assert.equal(lines.some((line) => line.includes("可执行")), false);
});

test("buildSpeculativeDisciplineBlock renders standalone speculative discipline section lines", () => {
  const lines = buildSpeculativeDisciplineBlock("博弈仓允许试单但必须先设证伪");
  assert.deepEqual(lines, ["- 博弈系统纪律：博弈仓允许试单但必须先设证伪"]);
});

test("extractSpeculativeConclusionLines keeps real speculative conclusion and drops budget lines", () => {
  const lines = extractSpeculativeConclusionLines([
    "- 风险预算上限：15.00%",
    "- 博弈仓上限：66,364.17 元",
    "- 剩余预算：66,364.17 元",
    "- 当前无触发的左侧博弈机会（speculative_plan.instructions 为空）。"
  ]);

  assert.deepEqual(lines, ["- 当前无触发的左侧博弈机会（speculative_plan.instructions 为空）。"]);
});

test("extractSpeculativeConclusionLines does not treat budget-only lines as speculative conclusion", () => {
  const lines = extractSpeculativeConclusionLines([
    "- 风险预算上限：15.00%",
    "- 博弈仓上限：66,364.17 元",
    "- 剩余预算：66,364.17 元"
  ]);

  assert.deepEqual(lines, ["- 当前未检测到博弈系统可执行结论，默认维持观察。"]);
});

test("renderDualTradePlanMarkdown prints dual-track titles and empty speculative fallback", () => {
  const markdown = renderDualTradePlanMarkdown({
    planDate: "2026-04-01",
    coreMarkdown: "## 第一笔计划\n- 买入 007339",
    speculativePlan: {
      budget_context: {
        max_pct: 0.15,
        sleeve_cap_cny: 60000,
        remaining_budget_cny: 60000
      },
      instructions: []
    },
    opportunitySummary: {
      trial_allowed_themes: ["红利低波"]
    }
  });

  assert.match(markdown, /## 主系统计划/);
  assert.match(markdown, /## 博弈系统计划/);
  assert.match(markdown, /第一笔计划/);
  assert.match(markdown, /当前无触发的左侧博弈机会/);
  assert.match(markdown, /风险预算上限：15\.00%/);
});

test("renderDualTradePlanMarkdown removes duplicated core h1 title when embedding core markdown", () => {
  const markdown = renderDualTradePlanMarkdown({
    planDate: "2026-04-01",
    coreMarkdown: "# 2026-04-01 Next Trade Plan\n\n## 第一笔计划\n- 买入 007339",
    speculativePlan: {
      budget_context: {
        max_pct: 0.15,
        sleeve_cap_cny: 60000,
        remaining_budget_cny: 60000
      },
      instructions: []
    },
    opportunitySummary: {
      trial_allowed_themes: []
    }
  });

  assert.doesNotMatch(markdown, /^# 2026-04-01 Next Trade Plan/m);
  assert.match(markdown, /## 第一笔计划/);
});

test("renderDualTradePlanMarkdown unwraps already dual-rendered markdown before embedding", () => {
  const markdown = renderDualTradePlanMarkdown({
    planDate: "2026-04-01",
    coreMarkdown: [
      "# 2026-04-01 Dual Trade Plan",
      "",
      "## 主系统计划",
      "",
      "> 以下为 Python 主系统原始输出（原文保留）",
      "",
      "# 2026-04-01 Next Trade Plan",
      "",
      "## 第一笔计划",
      "- 买入 007339",
      "",
      "## 博弈系统计划",
      "- 当前无触发的左侧博弈机会"
    ].join("\n"),
    speculativePlan: {
      budget_context: {
        max_pct: 0.15,
        sleeve_cap_cny: 60000,
        remaining_budget_cny: 60000
      },
      instructions: []
    },
    opportunitySummary: {
      trial_allowed_themes: []
    }
  });

  assert.doesNotMatch(markdown, /^# 2026-04-01 Next Trade Plan$/m);
  assert.match(markdown, /## 第一笔计划/);
  assert.match(markdown, /^## 博弈系统计划$/m);
});

test("buildDualTradePlanPayload adds explicit dual-track fields", () => {
  const payload = buildDualTradePlanPayload({
    corePayload: {
      plan_date: "2026-04-01",
      summary: { executable_trade_count: 2 }
    },
    speculativePlan: {
      system: "left_speculative_sleeve",
      instructions: []
    },
    opportunityPool: {
      candidates: []
    }
  });

  assert.equal(payload.plan_date, "2026-04-01");
  assert.ok(payload.core_trade_plan);
  assert.ok(payload.speculative_trade_plan);
  assert.ok(payload.opportunity_summary);
});

test("buildDualTradePlanPayload marks missing speculative input instead of pretending current-day empty plan", () => {
  const payload = buildDualTradePlanPayload({
    corePayload: {
      plan_date: "2026-04-01"
    },
    speculativePlan: null,
    opportunityPool: {
      candidates: []
    }
  });

  assert.equal(payload.speculative_trade_plan.as_of, null);
  assert.equal(payload.speculative_trade_plan.data_state, "missing");
});

test("buildOpportunitySummary extracts top candidates and trial themes", () => {
  const summary = buildOpportunitySummary({
    as_of: "2026-04-01",
    candidates: [
      { theme_name: "黄金", action_bias: "不做", total_score: 1, tradable_proxies: [{ symbol: "022502" }] },
      {
        theme_name: "红利低波",
        action_bias: "允许试单",
        total_score: 5,
        tradable_proxies: [{ symbol: "007443" }]
      },
      {
        theme_name: "A股核心",
        action_bias: "允许试单",
        total_score: 4,
        tradable_proxies: [{ symbol: "007339" }]
      }
    ]
  });

  assert.equal(summary.as_of, "2026-04-01");
  assert.equal(summary.top_candidates.length, 3);
  assert.deepEqual(summary.trial_allowed_themes, ["红利低波", "A股核心"]);
  assert.equal(summary.top_candidates[0].theme_name, "红利低波");
});

test("renderDualTradePlanMarkdown prints explicit missing-data warning for absent speculative plan", () => {
  const markdown = renderDualTradePlanMarkdown({
    planDate: "2026-04-01",
    coreMarkdown: "## 第一笔计划\n- 买入 007339",
    speculativePlan: null,
    opportunitySummary: {
      trial_allowed_themes: []
    }
  });

  assert.match(markdown, /博弈计划数据缺失/);
});
