# Dual Engine Trading System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有基金主骨架之上，新增全市场机会池、左侧博弈仓、双轨交易计划，以及真正具备行动导向的早午晚报体系。

**Architecture:** 保留现有 `portfolio_state -> risk/report/trade plan` 主链不动，把新增能力拆成四个独立但可串联的部件：`Opportunity Pool` 负责研究发现，`Speculative Engine` 负责把左侧博弈关进 15% 风险笼子，`generate_next_trade_plan.mjs` 负责把主系统计划与博弈计划并列输出，报告脚本负责把“主线 / 预期差 / 允许动作 / 禁止动作”渲染成机构化行动备忘录。所有新能力默认只读分析，不直接改动主持仓状态，只有走现有交易登记入口时才会落账。

**Tech Stack:** Node.js ESM、`node:test`、现有 `market-mcp` Provider、现有 `report_context` 刷新链路、JSON 文件状态仓、Markdown 模板。

---

## File Structure

### Create

- `portfolio/config/opportunity_master.json`
  研究主题清单、主题到可交易基金/ETF/代理的映射、主题级风险标签、默认研究优先级。
- `portfolio/scripts/lib/opportunity_master.mjs`
  读取和校验 `opportunity_master.json`，输出主题列表与主题代理映射。
- `portfolio/scripts/lib/opportunity_master.test.mjs`
  配置契约测试。
- `portfolio/scripts/lib/opportunity_pool.mjs`
  机会池评分、预期差识别、主题候选排序、动作偏置分类。
- `portfolio/scripts/lib/opportunity_pool.test.mjs`
  机会池分类和排序测试。
- `portfolio/scripts/generate_opportunity_pool.mjs`
  生成 `data/opportunity_pool.json` 与对应 Markdown 报告。
- `portfolio/scripts/lib/speculative_engine.mjs`
  左侧博弈触发路由、15% 上限控制、分层建仓与退出阶梯生成。
- `portfolio/scripts/lib/speculative_engine.test.mjs`
  博弈触发与仓位上限测试。
- `portfolio/scripts/generate_speculative_plan.mjs`
  基于机会池、量化信号、组合状态生成 `data/speculative_plan.json`。
- `portfolio/scripts/lib/dual_trade_plan_render.mjs`
  双轨计划 Markdown/JSON 渲染辅助函数。
- `portfolio/scripts/lib/dual_trade_plan_render.test.mjs`
  双轨计划渲染与空计划兜底测试。

### Modify

- `portfolio/config/asset_master.json`
  新增 `speculative_sleeve` 风险预算与默认退出规则。
- `portfolio/scripts/lib/asset_master.mjs`
  暴露 `speculative_sleeve` 与主桶配置统一读取函数。
- `portfolio/scripts/lib/report_context.mjs`
  把 `opportunity_pool`、`speculative_plan` 纳入 freshness / refresh 体系。
- `portfolio/scripts/generate_next_trade_plan.mjs`
  读取 `opportunity_pool.json` 与 `speculative_plan.json`，生成双轨交易计划。
- `portfolio/scripts/generate_market_pulse.mjs`
  输出“今日主线 / 当前预期差 / 允许动作 / 禁止动作 / 博弈仓纪律”。
- `portfolio/scripts/generate_market_brief.mjs`
  读取机会池并输出“主题候选池 + 可交易代理 + 行动偏置”。
- `portfolio/scripts/generate_daily_brief.mjs`
  汇总当日核心计划、博弈计划和机会池结论。
- `portfolio/scripts/create_trade_card.mjs`
  为博弈单新增系统归属、触发源、退出纪律和证伪条件。
- `portfolio/templates/market-pulse-template.md`
  新增机构化行动模块。
- `portfolio/templates/market-brief-template.md`
  新增机会池区块。
- `portfolio/templates/trade-card-template.md`
  新增 “System / Trigger / Exit / Invalidation” 区块。
- `portfolio/README.md`
  更新使用入口。
- `portfolio/SYSTEM_BLUEPRINT.md`
  更新三层 + 双引擎架构图。
- `portfolio/INVESTMENT_POLICY_STATEMENT.md`
  增补左侧博弈仓边界。
- `portfolio/DECISION_TREE.md`
  增补“核心计划 vs 博弈计划”的决策分流。

---

### Task 1: 建立 Research + Speculative 的配置契约

**Files:**
- Create: `portfolio/config/opportunity_master.json`
- Create: `portfolio/scripts/lib/opportunity_master.mjs`
- Test: `portfolio/scripts/lib/opportunity_master.test.mjs`
- Modify: `portfolio/config/asset_master.json`
- Modify: `portfolio/scripts/lib/asset_master.mjs`

- [ ] **Step 1: 先写配置契约测试**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeOpportunityTheme,
  getSpeculativeSleeveConfig
} from "./opportunity_master.mjs";

test("normalizeOpportunityTheme keeps required research fields", () => {
  const theme = normalizeOpportunityTheme({
    theme_name: "黄金",
    market: "GLOBAL",
    driver: "地缘+真实利率",
    tradable_proxies: [
      { symbol: "022502", name: "国泰黄金ETF联接E", account_scope: ["main"] }
    ],
    action_bias_default: "研究观察"
  });

  assert.equal(theme.theme_name, "黄金");
  assert.equal(theme.tradable_proxies[0].symbol, "022502");
  assert.equal(theme.action_bias_default, "研究观察");
});

test("getSpeculativeSleeveConfig clamps sleeve max at 15%", () => {
  const sleeve = getSpeculativeSleeveConfig({
    speculative_sleeve: {
      max_pct: 0.18,
      default_exit: "反弹分批止盈",
      allowed_trigger_sources: ["valuation_momentum_exhaustion"]
    }
  });

  assert.equal(sleeve.maxPct, 0.15);
  assert.equal(sleeve.defaultExit, "反弹分批止盈");
});
```

- [ ] **Step 2: 运行测试，确认当前确实失败**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/opportunity_master.test.mjs
```

Expected:

```text
not ok 1 - normalizeOpportunityTheme keeps required research fields
not ok 2 - getSpeculativeSleeveConfig clamps sleeve max at 15%
```

- [ ] **Step 3: 写入最小实现与配置文件**

`portfolio/config/opportunity_master.json`

```json
{
  "version": 1,
  "theme_order": ["黄金", "A股核心", "港股互联网", "半导体", "红利低波"],
  "themes": [
    {
      "theme_name": "黄金",
      "market": "GLOBAL",
      "driver": "地缘+真实利率",
      "risk_note": "冲突缓和时回撤会很快",
      "action_bias_default": "研究观察",
      "tradable_proxies": [
        { "symbol": "022502", "name": "国泰黄金ETF联接E", "account_scope": ["main"] }
      ]
    }
  ]
}
```

`portfolio/scripts/lib/opportunity_master.mjs`

```js
import { readFile } from "node:fs/promises";

export function normalizeOpportunityTheme(theme = {}) {
  return {
    theme_name: String(theme.theme_name ?? "").trim(),
    market: String(theme.market ?? "").trim(),
    driver: String(theme.driver ?? "").trim(),
    risk_note: String(theme.risk_note ?? "").trim(),
    action_bias_default: String(theme.action_bias_default ?? "研究观察").trim(),
    tradable_proxies: Array.isArray(theme.tradable_proxies) ? theme.tradable_proxies : []
  };
}

export async function loadOpportunityMaster(filePath) {
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  return {
    version: Number(payload.version ?? 1),
    theme_order: Array.isArray(payload.theme_order) ? payload.theme_order : [],
    themes: Array.isArray(payload.themes) ? payload.themes.map(normalizeOpportunityTheme) : []
  };
}

export function getSpeculativeSleeveConfig(assetMaster = {}) {
  const raw = assetMaster.speculative_sleeve ?? {};
  const maxPct = Math.min(Number(raw.max_pct ?? 0.15), 0.15);
  return {
    maxPct: Number.isFinite(maxPct) ? maxPct : 0.15,
    defaultExit: String(raw.default_exit ?? "反弹分批止盈"),
    allowedTriggerSources: Array.isArray(raw.allowed_trigger_sources)
      ? raw.allowed_trigger_sources
      : []
  };
}
```

`portfolio/config/asset_master.json` 追加：

```json
"speculative_sleeve": {
  "max_pct": 0.15,
  "default_exit": "反弹分批止盈",
  "scale_in_steps": [0.25, 0.35, 0.40],
  "allowed_trigger_sources": [
    "valuation_momentum_exhaustion",
    "event_dislocation",
    "manual_override"
  ]
}
```

- [ ] **Step 4: 重新跑测试，确认契约成立**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/opportunity_master.test.mjs
```

Expected:

```text
# tests 2
# pass 2
# fail 0
```

- [ ] **Step 5: 提交这一层配置基础设施**

```bash
git add portfolio/config/opportunity_master.json \
  portfolio/config/asset_master.json \
  portfolio/scripts/lib/opportunity_master.mjs \
  portfolio/scripts/lib/opportunity_master.test.mjs \
  portfolio/scripts/lib/asset_master.mjs
git commit -m "feat: add opportunity and speculative config contracts"
```

---

### Task 2: 落地 Opportunity Pool 研究发现层

**Files:**
- Create: `portfolio/scripts/lib/opportunity_pool.mjs`
- Create: `portfolio/scripts/lib/opportunity_pool.test.mjs`
- Create: `portfolio/scripts/generate_opportunity_pool.mjs`
- Modify: `portfolio/scripts/lib/report_context.mjs`
- Modify: `portfolio/scripts/generate_market_brief.mjs`

- [ ] **Step 1: 先写机会池分类测试**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
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

test("rankOpportunityCandidates sorts by total score desc", () => {
  const ranked = rankOpportunityCandidates([
    { theme_name: "黄金", total_score: 5 },
    { theme_name: "半导体", total_score: 8 }
  ]);

  assert.deepEqual(ranked.map((item) => item.theme_name), ["半导体", "黄金"]);
});
```

- [ ] **Step 2: 运行测试，确认 helper 尚不存在**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/opportunity_pool.test.mjs
```

Expected:

```text
not ok 1 - classifyActionBias upgrades to 允许试单 when expectation gap and technical support align
not ok 2 - rankOpportunityCandidates sorts by total score desc
```

- [ ] **Step 3: 实现机会池评分和生成脚本**

`portfolio/scripts/lib/opportunity_pool.mjs`

```js
export function classifyActionBias({
  expected_vs_actual_score = 0,
  technical_score = 0,
  funding_flow_score = 0,
  risk_penalty = 0
} = {}) {
  const total = expected_vs_actual_score + technical_score + funding_flow_score - risk_penalty;
  if (total >= 6) return "允许确认仓";
  if (total >= 4) return "允许试单";
  if (total >= 2) return "研究观察";
  return "不做";
}

export function rankOpportunityCandidates(candidates = []) {
  return [...candidates].sort((left, right) => Number(right.total_score ?? 0) - Number(left.total_score ?? 0));
}

export function buildOpportunityCandidate(theme, inputs = {}) {
  const expected_vs_actual_score = Number(inputs.expected_vs_actual_score ?? 0);
  const technical_score = Number(inputs.technical_score ?? 0);
  const funding_flow_score = Number(inputs.funding_flow_score ?? 0);
  const risk_penalty = Number(inputs.risk_penalty ?? 0);
  const total_score = expected_vs_actual_score + technical_score + funding_flow_score - risk_penalty;
  return {
    theme_name: theme.theme_name,
    market: theme.market,
    driver: theme.driver,
    expected_vs_actual: inputs.expected_vs_actual,
    technical_state: inputs.technical_state,
    funding_flow_state: inputs.funding_flow_state,
    risk_note: theme.risk_note,
    tradable_proxies: theme.tradable_proxies,
    action_bias: classifyActionBias({
      expected_vs_actual_score,
      technical_score,
      funding_flow_score,
      risk_penalty
    }),
    total_score
  };
}
```

`portfolio/scripts/generate_opportunity_pool.mjs`

```js
const payload = {
  generated_at: new Date().toISOString(),
  as_of: targetDate,
  source: {
    macro_state: macroStatePath,
    cn_market_snapshot: cnSnapshotPath,
    opportunity_master: opportunityMasterPath
  },
  candidates: rankOpportunityCandidates(candidates)
};
```

`portfolio/scripts/lib/report_context.mjs` 在 freshness 采集里追加：

```js
function extractOpportunityPoolAsOf(opportunityPool) {
  return (
    String(opportunityPool?.as_of ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(opportunityPool?.generated_at) ||
    null
  );
}
```

`portfolio/scripts/generate_market_brief.mjs` 增加读取与渲染：

```js
const opportunityPool = await readJsonOrNull(
  buildPortfolioPath(portfolioRoot, "data", "opportunity_pool.json")
);

const opportunityLines = (opportunityPool?.candidates ?? []).slice(0, 5).map((item) => {
  const proxy = item.tradable_proxies?.[0];
  return `- ${item.theme_name}｜${item.action_bias}｜代理：${proxy?.name ?? "暂无"}｜驱动：${item.driver}`;
});
```

- [ ] **Step 4: 跑单测 + 真实脚本 smoke test**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/opportunity_pool.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_opportunity_pool.mjs --date 2026-04-01
```

Expected:

```text
# tests 2
# pass 2
```

以及：

```text
Wrote /Users/yinshiwei/codex/tz/portfolio/data/opportunity_pool.json
Wrote /Users/yinshiwei/codex/tz/portfolio/reports/2026-04-01-opportunity-pool.md
```

- [ ] **Step 5: 提交研究发现层**

```bash
git add portfolio/scripts/lib/opportunity_pool.mjs \
  portfolio/scripts/lib/opportunity_pool.test.mjs \
  portfolio/scripts/generate_opportunity_pool.mjs \
  portfolio/scripts/lib/report_context.mjs \
  portfolio/scripts/generate_market_brief.mjs
git commit -m "feat: add opportunity pool research layer"
```

---

### Task 3: 建立 Left-side Speculative Sleeve 博弈引擎

**Files:**
- Create: `portfolio/scripts/lib/speculative_engine.mjs`
- Create: `portfolio/scripts/lib/speculative_engine.test.mjs`
- Create: `portfolio/scripts/generate_speculative_plan.mjs`
- Modify: `portfolio/scripts/create_trade_card.mjs`
- Modify: `portfolio/templates/trade-card-template.md`

- [ ] **Step 1: 先写博弈触发与上限测试**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveSpeculativeTrigger,
  computeSpeculativeBudget
} from "./speculative_engine.mjs";

test("deriveSpeculativeTrigger returns valuation_momentum_exhaustion on deep value plus bottom divergence", () => {
  const trigger = deriveSpeculativeTrigger({
    valuation_regime_primary: "extreme_undervalued",
    left_side_regime: "bottom_divergence",
    event_dislocation: false,
    manual_override: false
  });

  assert.equal(trigger.trigger_source, "valuation_momentum_exhaustion");
});

test("computeSpeculativeBudget never allows more than 15 percent of total assets", () => {
  const budget = computeSpeculativeBudget({
    total_assets_cny: 1000000,
    current_speculative_exposure_cny: 120000,
    max_pct: 0.15
  });

  assert.equal(budget.remaining_budget_cny, 30000);
});
```

- [ ] **Step 2: 跑测试，确认现在为红灯**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/speculative_engine.test.mjs
```

Expected:

```text
not ok 1 - deriveSpeculativeTrigger returns valuation_momentum_exhaustion on deep value plus bottom divergence
not ok 2 - computeSpeculativeBudget never allows more than 15 percent of total assets
```

- [ ] **Step 3: 实现博弈引擎与生成脚本**

`portfolio/scripts/lib/speculative_engine.mjs`

```js
export function deriveSpeculativeTrigger(input = {}) {
  if (input.manual_override) {
    return { trigger_source: "manual_override", trigger_label: "人工裁量增强型" };
  }
  if (input.event_dislocation) {
    return { trigger_source: "event_dislocation", trigger_label: "事件冲击错杀型" };
  }
  if (
    input.valuation_regime_primary === "extreme_undervalued" &&
    input.left_side_regime === "bottom_divergence"
  ) {
    return {
      trigger_source: "valuation_momentum_exhaustion",
      trigger_label: "估值+动量衰竭型"
    };
  }
  return null;
}

export function computeSpeculativeBudget({
  total_assets_cny,
  current_speculative_exposure_cny,
  max_pct
}) {
  const sleeve_cap_cny = Number(total_assets_cny) * Number(max_pct);
  return {
    sleeve_cap_cny,
    remaining_budget_cny: Math.max(0, Number((sleeve_cap_cny - current_speculative_exposure_cny).toFixed(2)))
  };
}

export function buildSpeculativeInstruction(candidate, budget, sleeveConfig) {
  if (!candidate?.trigger || budget.remaining_budget_cny <= 0) {
    return null;
  }

  const stepBudget = sleeveConfig.scaleInSteps[0] * budget.remaining_budget_cny;
  return {
    system: "Speculative Engine",
    theme_name: candidate.theme_name,
    trigger_source: candidate.trigger.trigger_source,
    risk_tag: "左侧试单",
    suggested_amount_cny: Number(stepBudget.toFixed(2)),
    exit_rule: sleeveConfig.defaultExit,
    invalidation: candidate.invalidation ?? "若事件逻辑被证伪或再度转入 falling_knife，则停止加仓"
  };
}
```

`portfolio/scripts/generate_speculative_plan.mjs`

```js
const payload = {
  generated_at: new Date().toISOString(),
  as_of: planDate,
  system: "Speculative Engine",
  sleeve_budget: budget,
  candidates: instructions.filter(Boolean)
};
```

`portfolio/templates/trade-card-template.md` 增加：

```md
## 🧠 交易系统归属

- System：{{system_name}}
- Trigger Source：{{trigger_source}}
- Exit Discipline：{{exit_rule}}
- Invalidation：{{invalidation}}
```

`portfolio/scripts/create_trade_card.mjs` 追加字段绑定：

```js
const systemName = optionValue(options, ["system", "system-name"], "Core Engine");
const triggerSource = optionValue(options, ["trigger-source"], "core_rebalance");
const exitRule = optionValue(options, ["exit-rule"], "按原计划持有");
const invalidation = optionValue(options, ["invalidation"], "若原始逻辑被证伪则重新评估");

const replacements = {
  "{{system_name}}": systemName,
  "{{trigger_source}}": triggerSource,
  "{{exit_rule}}": exitRule,
  "{{invalidation}}": invalidation
};
```

- [ ] **Step 4: 跑单测与脚本 smoke test**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/speculative_engine.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_speculative_plan.mjs --date 2026-04-01
```

Expected:

```text
# tests 2
# pass 2
```

以及：

```text
Wrote /Users/yinshiwei/codex/tz/portfolio/data/speculative_plan.json
```

- [ ] **Step 5: 提交博弈引擎**

```bash
git add portfolio/scripts/lib/speculative_engine.mjs \
  portfolio/scripts/lib/speculative_engine.test.mjs \
  portfolio/scripts/generate_speculative_plan.mjs \
  portfolio/scripts/create_trade_card.mjs \
  portfolio/templates/trade-card-template.md
git commit -m "feat: add speculative sleeve engine"
```

---

### Task 4: 把主系统计划升级为 Dual Trade Plan

**Files:**
- Create: `portfolio/scripts/lib/dual_trade_plan_render.mjs`
- Create: `portfolio/scripts/lib/dual_trade_plan_render.test.mjs`
- Modify: `portfolio/scripts/generate_next_trade_plan.mjs`
- Modify: `portfolio/scripts/lib/report_context.mjs`
- Modify: `portfolio/DECISION_TREE.md`

- [ ] **Step 1: 先写双轨渲染测试**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { renderDualTradePlanMarkdown } from "./dual_trade_plan_render.mjs";

test("renderDualTradePlanMarkdown prints core and speculative sections", () => {
  const markdown = renderDualTradePlanMarkdown({
    corePlan: [{ target: "007339", action: "补仓" }],
    speculativePlan: [{ target: "022502", action: "左侧试单" }]
  });

  assert.match(markdown, /## 主系统计划/);
  assert.match(markdown, /## 博弈系统计划/);
  assert.match(markdown, /022502/);
});

test("renderDualTradePlanMarkdown prints explicit no-trade line when speculative side is empty", () => {
  const markdown = renderDualTradePlanMarkdown({
    corePlan: [{ target: "007339", action: "补仓" }],
    speculativePlan: []
  });

  assert.match(markdown, /- 当前无满足纪律的左侧博弈机会/);
});
```

- [ ] **Step 2: 跑测试，确认渲染层还没落地**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dual_trade_plan_render.test.mjs
```

Expected:

```text
not ok 1 - renderDualTradePlanMarkdown prints core and speculative sections
not ok 2 - renderDualTradePlanMarkdown prints explicit no-trade line when speculative side is empty
```

- [ ] **Step 3: 实现双轨渲染并接入主脚本**

`portfolio/scripts/lib/dual_trade_plan_render.mjs`

```js
function renderPlanLines(items, emptyLine) {
  if (!Array.isArray(items) || items.length === 0) {
    return [emptyLine];
  }

  return items.map(
    (item, index) =>
      `${index + 1}. ${item.target}｜${item.action}｜${item.reason}｜资金来源：${item.funding_source}`
  );
}

export function renderDualTradePlanMarkdown({ corePlan = [], speculativePlan = [] }) {
  return [
    "# Next Trade Plan",
    "",
    "## 主系统计划",
    ...renderPlanLines(corePlan, "- 当前无需要执行的核心结构修复单。"),
    "",
    "## 博弈系统计划",
    ...renderPlanLines(speculativePlan, "- 当前无满足纪律的左侧博弈机会。")
  ].join("\n");
}
```

`portfolio/scripts/generate_next_trade_plan.mjs` 新增读取：

```js
const [portfolioState, assetMaster, macroState, regimeSignals, opportunityPool, speculativePlan] =
  await Promise.all([
    Promise.resolve(portfolioStateView.payload),
    readJsonOrNull(paths.assetMasterPath),
    readJsonOrNull(paths.macroStatePath),
    readJsonOrNull(paths.regimeSignalsPath),
    readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "opportunity_pool.json")),
    readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "speculative_plan.json"))
  ]);
```

`portfolio/scripts/lib/report_context.mjs` 再补两类 freshness：

```js
function extractSpeculativePlanAsOf(speculativePlan) {
  return (
    String(speculativePlan?.as_of ?? "").slice(0, 10) ||
    shanghaiDateFromTimestamp(speculativePlan?.generated_at) ||
    null
  );
}
```

并把最终 payload 改成：

```js
const payload = {
  generated_at: new Date().toISOString(),
  plan_date: planDate,
  core_trade_plan: corePlan,
  speculative_trade_plan: speculativePlan?.candidates ?? [],
  opportunity_summary: (opportunityPool?.candidates ?? []).slice(0, 3)
};
```

- [ ] **Step 4: 跑测试与集成命令**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dual_trade_plan_render.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --date 2026-04-01
```

Expected:

```text
# tests 2
# pass 2
```

以及：

```text
Wrote /Users/yinshiwei/codex/tz/portfolio/data/trade_plan_v4.json
Wrote /Users/yinshiwei/codex/tz/portfolio/reports/2026-04-01-next-trade-generator.md
```

- [ ] **Step 5: 提交双轨交易大脑**

```bash
git add portfolio/scripts/lib/dual_trade_plan_render.mjs \
  portfolio/scripts/lib/dual_trade_plan_render.test.mjs \
  portfolio/scripts/generate_next_trade_plan.mjs \
  portfolio/scripts/lib/report_context.mjs \
  portfolio/DECISION_TREE.md
git commit -m "feat: render dual core and speculative trade plans"
```

---

### Task 5: 重构早报 / 午报 / 晚报与市场日报为行动备忘录

**Files:**
- Modify: `portfolio/scripts/generate_market_pulse.mjs`
- Modify: `portfolio/scripts/generate_market_brief.mjs`
- Modify: `portfolio/scripts/generate_daily_brief.mjs`
- Modify: `portfolio/templates/market-pulse-template.md`
- Modify: `portfolio/templates/market-brief-template.md`

- [ ] **Step 1: 先写机构化渲染测试**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildInstitutionalActionLines } from "./dual_trade_plan_render.mjs";

test("buildInstitutionalActionLines prints thesis, expectation gap, allowed and blocked actions", () => {
  const lines = buildInstitutionalActionLines({
    main_theme: "黄金+避险",
    expectation_gap: "油价没有继续加速，但黄金仍强",
    allowed_actions: ["允许小额加黄金"],
    blocked_actions: ["禁止追高港股高波"]
  });

  assert.equal(lines[0], "- 今日主线：黄金+避险");
  assert.match(lines.join("\n"), /禁止追高港股高波/);
});
```

- [ ] **Step 2: 跑测试，确认新的行动区块还不存在**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dual_trade_plan_render.test.mjs
```

Expected:

```text
not ok 3 - buildInstitutionalActionLines prints thesis, expectation gap, allowed and blocked actions
```

- [ ] **Step 3: 把报告模板和脚本改成“结论先行”**

`portfolio/scripts/lib/dual_trade_plan_render.mjs` 追加：

```js
export function buildInstitutionalActionLines({
  main_theme,
  expectation_gap,
  allowed_actions = [],
  blocked_actions = []
}) {
  return [
    `- 今日主线：${main_theme}`,
    `- 当前预期差：${expectation_gap}`,
    ...allowed_actions.map((item) => `- 允许动作：${item}`),
    ...blocked_actions.map((item) => `- 禁止动作：${item}`)
  ];
}
```

`portfolio/templates/market-pulse-template.md` 核心区块改为：

```md
## 今日主线与操作纪律

{{institutional_action_block}}

## 博弈系统纪律

{{speculative_discipline_block}}
```

`portfolio/scripts/generate_market_pulse.mjs` 增加：

```js
const institutionalActionLines = buildInstitutionalActionLines({
  main_theme: pulseSummary.main_theme,
  expectation_gap: pulseSummary.expectation_gap,
  allowed_actions: pulseSummary.allowed_actions,
  blocked_actions: pulseSummary.blocked_actions
});
```

`portfolio/scripts/generate_market_brief.mjs` 增加：

```js
const topThemes = (opportunityPool?.candidates ?? []).slice(0, 5).map((item) => {
  const proxy = item.tradable_proxies?.[0];
  return `- ${item.theme_name}｜${item.action_bias}｜代理：${proxy?.name ?? "暂无"}｜风险：${item.risk_note}`;
});
```

- [ ] **Step 4: 跑三条报告脚本 smoke test**

Run:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date 2026-04-01 --session morning
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date 2026-04-01 --session noon
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date 2026-04-01 --session close
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs --date 2026-04-01
```

Expected:

```text
Wrote /Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-01-morning.md
Wrote /Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-01-noon.md
Wrote /Users/yinshiwei/codex/tz/portfolio/market_pulses/2026-04-01-close.md
Wrote /Users/yinshiwei/codex/tz/portfolio/market_briefs/2026-04-01-market.md
Wrote /Users/yinshiwei/codex/tz/portfolio/daily_briefs/2026-04-01-brief.md
```

- [ ] **Step 5: 提交报告重构**

```bash
git add portfolio/scripts/generate_market_pulse.mjs \
  portfolio/scripts/generate_market_brief.mjs \
  portfolio/scripts/generate_daily_brief.mjs \
  portfolio/templates/market-pulse-template.md \
  portfolio/templates/market-brief-template.md
git commit -m "feat: refactor reports into action-oriented briefing format"
```

---

### Task 6: 修正文档入口并做全链路验证

**Files:**
- Modify: `portfolio/README.md`
- Modify: `portfolio/SYSTEM_BLUEPRINT.md`
- Modify: `portfolio/INVESTMENT_POLICY_STATEMENT.md`
- Modify: `portfolio/DECISION_TREE.md`

- [ ] **Step 1: 先补文档断言清单**

```md
- README 必须能说明：
  - 如何生成 opportunity_pool
  - 如何生成 speculative_plan
  - 如何生成 dual trade plan
- SYSTEM_BLUEPRINT 必须能说明：
  - L1 / L2 / L3
  - Core Engine / Speculative Engine
- IPS 必须能说明：
  - 左侧博弈仓不超过总资产 15%
  - 不自动并入核心仓
```

- [ ] **Step 2: 更新文档正文**

`portfolio/README.md` 追加命令：

````md
```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_opportunity_pool.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_speculative_plan.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --date 2026-04-01
```
````

`portfolio/INVESTMENT_POLICY_STATEMENT.md` 增加纪律：

```md
## 左侧博弈仓纪律

1. 左侧博弈仓上限为总资产的 15%。
2. 左侧单次试单不得一笔打满，默认按 25% / 35% / 40% 分层建仓。
3. 左侧博弈仓默认退出方式为“反弹分批止盈”。
4. 左侧博弈仓不自动并入核心仓，转仓必须重新出卡。
```

- [ ] **Step 3: 做一次全链路命令验证**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/opportunity_master.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/opportunity_pool.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/speculative_engine.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dual_trade_plan_render.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_opportunity_pool.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_speculative_plan.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date 2026-04-01 --session morning
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date 2026-04-01 --session noon
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date 2026-04-01 --session close
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs --date 2026-04-01
```

Expected:

```text
所有 node --test 命令 pass；所有生成脚本均输出 Wrote ... 且不出现 stale / missing / fatal guard 报错。
```

- [ ] **Step 4: 手动核对三条业务边界**

```md
1. `opportunity_pool.json` 只生成研究结论，不改 `portfolio_state.json`
2. `speculative_plan.json` 若无预算或无纪律触发，输出空候选而不是强行给单
3. `next_trade_plan` 必须同时保留“主系统计划”和“博弈系统计划”两个标题
```

- [ ] **Step 5: 提交收尾**

```bash
git add portfolio/README.md \
  portfolio/SYSTEM_BLUEPRINT.md \
  portfolio/INVESTMENT_POLICY_STATEMENT.md \
  portfolio/DECISION_TREE.md
git commit -m "docs: document dual engine operating model"
```

---

## Implementation Order

1. 先完成 Task 1 和 Task 2，先把研究层和配置契约稳定下来。
2. 再完成 Task 3，把左侧博弈引擎独立出来，不污染主系统。
3. 再做 Task 4，把主系统计划和博弈计划并列渲染出来。
4. 最后执行 Task 5 和 Task 6，把所有报告与文档入口收敛到统一语义。

## Risk Notes

- 不要把左侧博弈仓直接映射到现有 `TACTICAL` 桶，否则会和主系统高波动仓混淆。
- 不要让 `generate_opportunity_pool.mjs` 直接写任何交易流水；它只能生成研究候选。
- 不要让 `generate_next_trade_plan.mjs` 在缺失 `speculative_plan.json` 时默默跳过；必须打印显式空计划或 freshness 提示。
- 不要在报告重构时把“总结”写得比“允许/禁止动作”更长；报告目标是行动，而不是散文。

## Self-Review

### Spec Coverage

- `Opportunity Pool`：Task 1、Task 2 覆盖。
- `Left-side Speculative Sleeve`：Task 1、Task 3 覆盖。
- `Dual Trade Plan`：Task 4 覆盖。
- `机构化早午晚报重构`：Task 5 覆盖。
- `交易卡片审计`：Task 3 覆盖。
- `文档入口与边界收敛`：Task 6 覆盖。

### Placeholder Scan

- 未使用 `TBD` / `TODO` / “类似上一任务”。
- 每个 Task 都给了文件路径、测试命令、实现骨架和提交命令。

### Type Consistency

- `speculative_sleeve.max_pct` 统一使用小数比例口径，如 `0.15`。
- `action_bias` 统一使用四档：`研究观察` / `允许试单` / `允许确认仓` / `不做`。
- `trigger_source` 统一使用三档：`valuation_momentum_exhaustion` / `event_dislocation` / `manual_override`。
- `Speculative Engine` 产物统一落在 `data/speculative_plan.json`，`generate_next_trade_plan.mjs` 只读取，不在内部重复生成。
