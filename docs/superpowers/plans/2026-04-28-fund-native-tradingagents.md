# Fund-Native TradingAgents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a low-change TradingAgents fund-native compatibility mode so `/advice` can show fund-specific TradingAgents-style analysis for deep-dive funds using fund purchase/redemption semantics.

**Architecture:** Keep the external TradingAgents market/bucket graph as-is. Add local fund-native context, prompt pack, output contract, runner, cache, and UI integration that follow the original TradingAgents role topology but operate on `fund:<code>` research contexts. The new path remains read-only and only runs for deep-dive/manual funds.

**Tech Stack:** Node.js ESM, `node --test`, existing GLM/DeepSeek OpenAI-compatible HTTP provider chain, JSON snapshots under `portfolio/data`, dashboard served by `portfolio/scripts/serve_funds_live_dashboard.mjs`.

---

## File Structure

- Create `portfolio/scripts/lib/fund_native_context.mjs`
  - Builds canonical `FundResearchContext` from existing decision snapshot rows.
  - Wraps existing `buildFundTradingAgentsContext` but exposes cleaner fund-native fields.

- Create `portfolio/scripts/lib/fund_native_output.mjs`
  - Normalizes provider JSON into stable fund-native contract.
  - Sanitizes stock-style execution phrases into fund申购/赎回语义.

- Create `portfolio/scripts/lib/fund_native_prompt_pack.mjs`
  - Builds the fund-native TradingAgents role prompt pack.
  - Preserves original role topology: market/social/news/fundamentals, bull/bear, manager, trader, risk reviewers, portfolio manager.

- Create `portfolio/scripts/lib/fund_native_tradingagents.mjs`
  - Runs fund-native analysis over selected contexts.
  - Uses provider chain from `tradingagents_bridge.json`.
  - Persists/loads `data/fund_native_analysis_snapshot.json`.

- Create tests:
  - `portfolio/scripts/lib/fund_native_context.test.mjs`
  - `portfolio/scripts/lib/fund_native_output.test.mjs`
  - `portfolio/scripts/lib/fund_native_prompt_pack.test.mjs`
  - `portfolio/scripts/lib/fund_native_tradingagents.test.mjs`

- Create CLI:
  - `portfolio/scripts/run_fund_native_tradingagents.mjs`

- Modify:
  - `portfolio/scripts/serve_funds_live_dashboard.mjs`
    - Add `/api/fund-native-analysis`.
    - Load fund-native snapshot in `/api/trading-decision` payload.
    - Render fund-native result in `详情` before old fund-live fallback.
  - `portfolio/scripts/serve_funds_live_dashboard.test.mjs`
    - Add route/payload assertions.

---

### Task 1: Add FundResearchContext Builder

**Files:**
- Create: `portfolio/scripts/lib/fund_native_context.mjs`
- Test: `portfolio/scripts/lib/fund_native_context.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `portfolio/scripts/lib/fund_native_context.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFundNativeContext,
  buildFundNativeContextsFromDecision
} from "./fund_native_context.mjs";

const baseFund = {
  fundCode: "019736",
  fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
  bucket: "GLB_MOM",
  bucketLabel: "全球动量",
  amountCny: 12345.67,
  holdingPnl: -456.78,
  dayPnl: 12.34,
  confirmationState: "normal_lag",
  tradeStance: "observe",
  factorProfile: {
    primaryFactor: "US_TECH",
    primaryFactorLabel: "美股科技",
    secondaryFactors: ["US_SEMI"],
    proxySymbols: ["QQQ"]
  },
  researchProfile: {
    fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
    analysisTemplate: "qdii_index_fund",
    fundCompany: "宝盈基金",
    manager: "张三",
    fundSize: "2.3亿元",
    fees: "申购费0.12%",
    lookthrough: {
      status: "ready",
      topHoldings: [{ name: "NVIDIA", weightPct: 8.1 }]
    }
  },
  researchProfileQuality: {
    status: "ready",
    oneLine: "资料已同步 / 经理已同步 / 重仓已穿透"
  },
  deepDiveTrigger: {
    level: "high",
    reasons: ["loss_widening"],
    reasonLabels: ["高波亏损仓"]
  }
};

const decision = {
  status: "risk_watch",
  riskLight: "green",
  marketDataTierLabel: "前收参考 · 非实时",
  bucketActions: [
    {
      bucket: "GLB_MOM",
      verdict: "observe_only",
      rating: "HOLD",
      confidence: 0.62,
      reasonSummary: "美股科技维持观察",
      proxySymbols: ["QQQ"]
    }
  ],
  fundAnalyses: [baseFund],
  portfolioAnalysis: {
    exposureSummary: [{ bucket: "GLB_MOM", weightPct: 20, targetPct: 18 }],
    factorExposureSummary: [{ factor: "US_TECH", weightPct: 18, exposureCny: 50000 }],
    deepDiveCandidates: [baseFund]
  }
};

test("buildFundNativeContext maps a deep-dive fund into fund-native target context", () => {
  const context = buildFundNativeContext({ candidate: baseFund, decisionSnapshot: decision });

  assert.equal(context.targetType, "fund");
  assert.equal(context.targetId, "fund:019736");
  assert.equal(context.fundCode, "019736");
  assert.equal(context.fundTemplate, "qdii_index_fund");
  assert.equal(context.holding.amountCny, 12345.67);
  assert.equal(context.factorContext.primaryFactor, "US_TECH");
  assert.equal(context.marketContext.bucket, "GLB_MOM");
  assert.equal(context.marketContext.bucketVerdict, "observe_only");
  assert.equal(context.guardrails.reviewOnly, true);
  assert.equal(context.guardrails.canWriteLedger, false);
  assert.equal(context.guardrails.canGenerateOrder, false);
  assert.ok(context.promptContext.includes("宝盈纳斯达克100"));
  assert.ok(context.promptContext.includes("QDII/指数"));
});

test("buildFundNativeContextsFromDecision returns deep-dive candidates by default", () => {
  const contexts = buildFundNativeContextsFromDecision({ decisionSnapshot: decision, scope: "deep_dive", limit: 4 });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].targetId, "fund:019736");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_context.test.mjs
```

Expected: FAIL with module not found for `fund_native_context.mjs`.

- [ ] **Step 3: Implement context builder**

Create `portfolio/scripts/lib/fund_native_context.mjs`:

```js
import { buildFundTradingAgentsContext } from "./fund_tradingagents_adapter.mjs";

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? null : Math.round(numeric * 100) / 100;
}

function findBucketAction(bucketActions = [], bucket) {
  const key = trimText(bucket);
  return asArray(bucketActions).find((item) => trimText(item?.bucket) === key) ?? null;
}

function templateLabel(template) {
  switch (trimText(template)) {
    case "qdii_index_fund":
      return "QDII/指数";
    case "qdii_active_fund":
      return "QDII/主动";
    case "qdii_commodity_fund":
      return "QDII/商品";
    case "qdii_fof_fund":
      return "QDII/FOF";
    case "index_fund":
      return "指数基金";
    case "active_equity_fund":
      return "主动权益";
    case "defensive_fund":
      return "防守/固收";
    default:
      return "通用基金";
  }
}

function buildPromptContext({ candidate = {}, researchProfile = {}, factorProfile = {}, bucketAction = null } = {}) {
  const fundName = trimText(researchProfile?.fundName) ?? trimText(candidate?.fundName) ?? trimText(candidate?.fundCode) ?? "未知基金";
  const template = trimText(researchProfile?.analysisTemplate);
  const topHoldings = asArray(researchProfile?.lookthrough?.topHoldings)
    .slice(0, 6)
    .map((item) => trimText(item?.name) ?? trimText(item?.symbol))
    .filter(Boolean)
    .join(" / ");
  return [
    `基金：${fundName}`,
    `类型：${templateLabel(template)}`,
    `基金经理：${trimText(researchProfile?.manager) ?? "未加载"}`,
    `基金公司：${trimText(researchProfile?.fundCompany) ?? "未加载"}`,
    `规模：${trimText(researchProfile?.fundSize) ?? "未加载"}`,
    `费率：${trimText(researchProfile?.fees) ?? "未加载"}`,
    `重仓：${topHoldings || "未加载"}`,
    `因子：${trimText(factorProfile?.primaryFactorLabel) ?? trimText(factorProfile?.primaryFactor) ?? "未映射"}`,
    `代理资产：${asArray(factorProfile?.proxySymbols).join(" / ") || "未配置"}`,
    `桶方向：${trimText(bucketAction?.verdict) ?? "无桶信号"}`,
    `当前持仓：${roundMoney(candidate?.amountCny) ?? "--"} 元`,
    `持有盈亏：${roundMoney(candidate?.holdingPnl) ?? "--"} 元`,
    `确认状态：${trimText(candidate?.confirmationState) ?? "unknown"}`
  ].join("\n");
}

export function buildFundNativeContext({ candidate = {}, decisionSnapshot = {} } = {}) {
  const fundAnalyses = asArray(decisionSnapshot?.fundAnalyses);
  const bucketActions = asArray(decisionSnapshot?.bucketActions);
  const portfolioAnalysis = decisionSnapshot?.portfolioAnalysis ?? {};
  const bucketAction = findBucketAction(bucketActions, candidate?.bucket);
  const researchProfile = candidate?.researchProfile ?? {};
  const factorProfile = candidate?.factorProfile ?? {};
  const adapterContext = buildFundTradingAgentsContext({
    candidate,
    fundAnalyses,
    bucketActions,
    portfolioAnalysis,
    decisionSnapshot
  });

  const fundCode = trimText(candidate?.fundCode);
  const fundName = trimText(researchProfile?.fundName) ?? trimText(candidate?.fundName) ?? fundCode;
  const fundTemplate = trimText(researchProfile?.analysisTemplate) ?? "generic_fund";

  return {
    targetType: "fund",
    targetId: fundCode ? `fund:${fundCode}` : "fund:unknown",
    fundCode,
    fundName,
    fundTemplate,
    source: "TradingAgents fund-native compatibility context",
    adapterContext,
    holding: {
      amountCny: roundMoney(candidate?.amountCny),
      holdingPnl: roundMoney(candidate?.holdingPnl),
      dayPnl: roundMoney(candidate?.dayPnl),
      confirmationState: trimText(candidate?.confirmationState) ?? "unknown",
      tradeStance: trimText(candidate?.tradeStance)
    },
    researchProfile,
    researchProfileQuality: candidate?.researchProfileQuality ?? null,
    factorContext: {
      primaryFactor: trimText(factorProfile?.primaryFactor),
      primaryFactorLabel: trimText(factorProfile?.primaryFactorLabel),
      secondaryFactors: asArray(factorProfile?.secondaryFactors),
      proxySymbols: asArray(factorProfile?.proxySymbols),
      styleTags: asArray(factorProfile?.styleTags),
      region: trimText(factorProfile?.region),
      confidence: toFiniteNumber(factorProfile?.confidence)
    },
    peerContext: {
      peerFunds: asArray(adapterContext?.peerFunds),
      peerGroup: trimText(factorProfile?.primaryFactorLabel) ?? trimText(factorProfile?.primaryFactor),
      representativeCandidate: Boolean(candidate?.peerRole?.representativeCandidate)
    },
    marketContext: {
      bucket: trimText(candidate?.bucket),
      bucketLabel: trimText(candidate?.bucketLabel),
      bucketVerdict: trimText(bucketAction?.verdict),
      bucketRating: trimText(bucketAction?.rating),
      proxySymbols: asArray(bucketAction?.proxySymbols).length > 0 ? asArray(bucketAction?.proxySymbols) : asArray(factorProfile?.proxySymbols),
      marketDataTierLabel: trimText(decisionSnapshot?.marketDataTierLabel ?? decisionSnapshot?.decisionContext?.marketDataTierLabel)
    },
    triggerContext: {
      level: trimText(candidate?.deepDiveTrigger?.level),
      reasons: asArray(candidate?.deepDiveTrigger?.reasons),
      reasonLabels: asArray(candidate?.deepDiveTrigger?.reasonLabels)
    },
    guardrails: {
      reviewOnly: true,
      canWriteLedger: false,
      canGenerateOrder: false,
      confirmedNavState: trimText(decisionSnapshot?.confirmedNavState ?? decisionSnapshot?.diagnostics?.confirmedNavState),
      forbidStockIntradayLanguage: true
    },
    promptContext: buildPromptContext({ candidate, researchProfile, factorProfile, bucketAction })
  };
}

export function buildFundNativeContextsFromDecision({ decisionSnapshot = {}, scope = "deep_dive", limit = 4 } = {}) {
  const source = scope === "all"
    ? asArray(decisionSnapshot?.fundAnalyses)
    : asArray(decisionSnapshot?.portfolioAnalysis?.deepDiveCandidates ?? decisionSnapshot?.deepDiveCandidates);
  return source
    .slice(0, Math.max(1, Number(limit) || 4))
    .map((candidate) => buildFundNativeContext({ candidate, decisionSnapshot }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_context.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/lib/fund_native_context.mjs portfolio/scripts/lib/fund_native_context.test.mjs
git commit -m "feat: add fund-native context builder"
```

---

### Task 2: Add Fund-Native Output Contract and Sanitizer

**Files:**
- Create: `portfolio/scripts/lib/fund_native_output.mjs`
- Test: `portfolio/scripts/lib/fund_native_output.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `portfolio/scripts/lib/fund_native_output.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFundNativeAnalysis,
  sanitizeFundExecutionLanguage
} from "./fund_native_output.mjs";

const context = {
  fundCode: "019736",
  fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
  fundTemplate: "qdii_index_fund"
};

test("sanitizeFundExecutionLanguage rewrites stock intraday wording", () => {
  assert.equal(sanitizeFundExecutionLanguage("建议开盘市价卖出并设置止损线"), "建议尾盘前复核赎回并设置复核条件");
  assert.equal(sanitizeFundExecutionLanguage("跌破支撑后立即清仓"), "跌破支撑后进入清仓赎回复核");
});

test("normalizeFundNativeAnalysis maps provider JSON into stable fund contract", () => {
  const result = normalizeFundNativeAnalysis({
    parsed: {
      verdict: "SELL",
      riskLight: "yellow",
      confidence: 0.82,
      oneLine: "建议开盘市价卖出并设置止损线",
      styleEnvironment: { label: "中性偏弱", reason: "纳指高波" },
      fundQuality: { label: "可用", reason: "指数工具清晰" },
      lookThrough: { label: "暴露清晰", reason: "重仓美股科技" },
      peerRole: { label: "代表候选", reason: "同类中资料较完整" },
      riskReview: { riskLight: "yellow", notes: ["QDII 滞后"] },
      uncertainties: ["前收参考"],
      rawEvidence: "long markdown"
    },
    context,
    provider: "glm"
  });

  assert.equal(result.fundCode, "019736");
  assert.equal(result.mode, "fund_native");
  assert.equal(result.verdict, "partial_redeem_review");
  assert.equal(result.tradeDirection, "sell");
  assert.equal(result.execution.executionIntent, "review_only");
  assert.equal(result.execution.fundExecutionStyle, "end_of_day_t1_review");
  assert.ok(result.oneLine.includes("尾盘前复核赎回"));
  assert.ok(!result.oneLine.includes("市价"));
  assert.equal(result.riskLight, "yellow");
  assert.equal(result.confidence, 0.82);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_output.test.mjs
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement output normalizer**

Create `portfolio/scripts/lib/fund_native_output.mjs`:

```js
function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, Math.round(numeric * 100) / 100));
}

export function sanitizeFundExecutionLanguage(value) {
  let text = String(value ?? "");
  const replacements = [
    [/开盘市价卖出/g, "尾盘前复核赎回"],
    [/市价卖出/g, "复核赎回"],
    [/市价买入/g, "复核申购"],
    [/开盘买入/g, "尾盘前复核申购"],
    [/盘中止损/g, "止损式赎回复核"],
    [/止损线/g, "复核条件"],
    [/立即清仓/g, "进入清仓赎回复核"],
    [/清仓卖出/g, "清仓赎回复核"],
    [/挂单/g, "手动复核"],
    [/日内交易/g, "基金申购赎回复核"]
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function normalizeRiskLight(value) {
  const text = String(value ?? "").toLowerCase();
  if (["red", "high", "高", "红"].includes(text)) return "red";
  if (["yellow", "medium", "中", "黄"].includes(text)) return "yellow";
  return "green";
}

function normalizeVerdict(value) {
  const text = String(value ?? "").toLowerCase();
  if (["buy", "申购", "增配", "subscribe", "add"].some((key) => text.includes(key))) {
    return { verdict: "subscribe_review", tradeDirection: "buy", label: "可考虑买入" };
  }
  if (["sell", "减仓", "赎回", "reduce"].some((key) => text.includes(key))) {
    return { verdict: "partial_redeem_review", tradeDirection: "sell", label: "可考虑卖出一部分" };
  }
  if (["clear", "exit", "清仓", "退出"].some((key) => text.includes(key))) {
    return { verdict: "full_redeem_review", tradeDirection: "sell", label: "可考虑退出" };
  }
  if (["replace", "switch", "替换"].some((key) => text.includes(key))) {
    return { verdict: "replace_review", tradeDirection: "switch", label: "可考虑替换" };
  }
  if (["deep", "深看", "review"].some((key) => text.includes(key))) {
    return { verdict: "deep_dive", tradeDirection: "hold", label: "深看" };
  }
  if (["block", "pause", "暂停"].some((key) => text.includes(key))) {
    return { verdict: "pause_action", tradeDirection: "blocked", label: "今日暂停动作" };
  }
  return { verdict: "hold", tradeDirection: "hold", label: "先不动" };
}

function normalizeSection(value, fallbackLabel) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      label: sanitizeFundExecutionLanguage(trimText(value.label) ?? fallbackLabel),
      reason: sanitizeFundExecutionLanguage(trimText(value.reason) ?? "暂无说明")
    };
  }
  return {
    label: fallbackLabel,
    reason: sanitizeFundExecutionLanguage(trimText(value) ?? "暂无说明")
  };
}

export function normalizeFundNativeAnalysis({ parsed = {}, context = {}, provider = "unknown", rawText = "" } = {}) {
  const verdict = normalizeVerdict(parsed.verdict ?? parsed.tradeDirection ?? parsed.action);
  const oneLine = sanitizeFundExecutionLanguage(
    trimText(parsed.oneLine) ?? trimText(parsed.summary) ?? `${context.fundName ?? context.fundCode ?? "该基金"}：${verdict.label}`
  );
  return {
    fundCode: context.fundCode ?? null,
    fundName: context.fundName ?? null,
    mode: "fund_native",
    provider,
    status: "success",
    template: context.fundTemplate ?? "generic_fund",
    verdict: verdict.verdict,
    verdictLabel: verdict.label,
    tradeDirection: verdict.tradeDirection,
    riskLight: normalizeRiskLight(parsed.riskLight ?? parsed.riskLevel),
    confidence: clampConfidence(parsed.confidence),
    oneLine,
    styleEnvironment: normalizeSection(parsed.styleEnvironment, "风格环境待确认"),
    fundQuality: normalizeSection(parsed.fundQuality, "基金质量待确认"),
    lookThrough: normalizeSection(parsed.lookThrough ?? parsed.lookthrough, "持仓穿透待确认"),
    peerRole: normalizeSection(parsed.peerRole, "同类角色待确认"),
    riskReview: {
      riskLight: normalizeRiskLight(parsed.riskReview?.riskLight ?? parsed.riskLight),
      notes: asArray(parsed.riskReview?.notes ?? parsed.riskNotes).map(sanitizeFundExecutionLanguage).slice(0, 6)
    },
    execution: {
      executionIntent: "review_only",
      fundExecutionStyle: "end_of_day_t1_review",
      suggestedAmountRangeCny: parsed.execution?.suggestedAmountRangeCny ?? null,
      timingNote: sanitizeFundExecutionLanguage(
        trimText(parsed.execution?.timingNote) ?? "如执行，应在尾盘前复核，并按基金申购/赎回净值确认。"
      )
    },
    uncertainties: asArray(parsed.uncertainties).map(sanitizeFundExecutionLanguage).slice(0, 8),
    rawEvidence: trimText(parsed.rawEvidence) ?? trimText(rawText) ?? ""
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_output.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/lib/fund_native_output.mjs portfolio/scripts/lib/fund_native_output.test.mjs
git commit -m "feat: normalize fund-native analysis output"
```

---

### Task 3: Add Fund-Native TradingAgents Prompt Pack

**Files:**
- Create: `portfolio/scripts/lib/fund_native_prompt_pack.mjs`
- Test: `portfolio/scripts/lib/fund_native_prompt_pack.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `portfolio/scripts/lib/fund_native_prompt_pack.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildFundNativeMessages } from "./fund_native_prompt_pack.mjs";

const context = {
  fundCode: "019736",
  fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
  fundTemplate: "qdii_index_fund",
  promptContext: "基金：宝盈纳斯达克100\n类型：QDII/指数\n代理资产：QQQ",
  guardrails: { reviewOnly: true }
};

test("buildFundNativeMessages contains original TradingAgents role topology with fund semantics", () => {
  const messages = buildFundNativeMessages({ context });
  const joined = messages.map((item) => item.content).join("\n");

  assert.equal(messages[0].role, "system");
  assert.ok(joined.includes("Fund Style Analyst"));
  assert.ok(joined.includes("Theme Sentiment Analyst"));
  assert.ok(joined.includes("Fund Profile Analyst"));
  assert.ok(joined.includes("Keep/Add Advocate"));
  assert.ok(joined.includes("Reduce/Replace Advocate"));
  assert.ok(joined.includes("Fund Allocation Reviewer"));
  assert.ok(joined.includes("Fund Committee Decision"));
  assert.ok(joined.includes("申购"));
  assert.ok(joined.includes("赎回"));
  assert.ok(joined.includes("review_only"));
  assert.ok(joined.includes("JSON"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_prompt_pack.test.mjs
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement prompt pack**

Create `portfolio/scripts/lib/fund_native_prompt_pack.mjs`:

```js
function stringifyContext(context = {}) {
  return JSON.stringify(context, null, 2);
}

export function buildFundNativeMessages({ context = {} } = {}) {
  const system = `你是 TradingAgents 的基金原生兼容模式。你保留原 TradingAgents 多角色交易委员会结构，但分析对象是中国基金，不是股票。你必须使用基金申购/赎回/尾盘复核语言，所有输出都是 review_only，不写账本、不生成订单。`;

  const rolePack = `
请按以下 TradingAgents 基金化角色完成分析，并最后只输出一个 JSON 对象：

1. Fund Style Analyst：判断基金所属风格/地区/因子环境是否顺风，例如 A 股成长、美股科技、黄金、港股红利、债券防守。
2. Theme Sentiment Analyst：判断主题热度、同类拥挤度、资金偏好和重复暴露。
3. Macro/Event Analyst：判断宏观、市场事件、QDII 时区/汇率/前收参考对基金的影响。
4. Fund Profile Analyst：分析基金经理、基金公司、规模、费率、类型、最新季报重仓；指数基金不要胡乱评价基金经理能力。
5. Keep/Add Advocate：论证维持、可考虑买入、追加申购或继续观察的理由。
6. Reduce/Replace Advocate：论证可考虑卖出一部分、清仓赎回、替换或暂停动作的理由。
7. Fund Research Judge：总结基金是否值得继续留在组合、进入深看或进入动作备选。
8. Fund Allocation Reviewer：把结论转成基金配置动作，只能使用：可考虑买入、先不动、深看、可考虑卖出一部分、可考虑退出、可考虑替换、今日暂停动作。
9. Growth Allocation Risk View：评估高波进攻仓位能否承担。
10. Defense / NAV Confirmation View：评估确认净值、QDII 滞后、资料陈旧、亏损扩大和现金防线。
11. Balanced Allocation View：评估仓位是否已足、是否重复暴露、是否只适合观察。
12. Fund Committee Decision：输出最终基金委员会结论。

禁止使用股票盘中执行语言：市价、开盘清仓、盘中止损、挂单、盘口、日内交易。可以使用基金语言：申购、追加申购、部分赎回、清仓赎回、止损式减仓、尾盘前复核、T+1/T+2 确认。

输出必须是 JSON：
{
  "verdict": "申购候选|维持|深看|部分赎回候选|清仓赎回候选|替换候选|暂停动作",
  "riskLight": "green|yellow|red",
  "confidence": 0.0,
  "oneLine": "一句话结论",
  "styleEnvironment": { "label": "...", "reason": "..." },
  "fundQuality": { "label": "...", "reason": "..." },
  "lookThrough": { "label": "...", "reason": "..." },
  "peerRole": { "label": "...", "reason": "..." },
  "riskReview": { "riskLight": "green|yellow|red", "notes": ["..."] },
  "execution": { "suggestedAmountRangeCny": null, "timingNote": "尾盘前复核，按基金净值确认" },
  "uncertainties": ["..."],
  "rawEvidence": "保留各角色要点的 Markdown 摘要"
}`;

  const user = `基金研究上下文如下：\n\n${context.promptContext ?? stringifyContext(context)}\n\n完整结构化上下文：\n${stringifyContext(context)}`;

  return [
    { role: "system", content: system },
    { role: "user", content: `${rolePack}\n\n${user}` }
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_prompt_pack.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/lib/fund_native_prompt_pack.mjs portfolio/scripts/lib/fund_native_prompt_pack.test.mjs
git commit -m "feat: add fund-native TradingAgents prompt pack"
```

---

### Task 4: Add Fund-Native Runner and Snapshot Persistence

**Files:**
- Create: `portfolio/scripts/lib/fund_native_tradingagents.mjs`
- Test: `portfolio/scripts/lib/fund_native_tradingagents.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `portfolio/scripts/lib/fund_native_tradingagents.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistFundNativeAnalysisSnapshot,
  resolveFundNativeAnalysisPath,
  runFundNativeTradingAgents
} from "./fund_native_tradingagents.mjs";

const decisionSnapshot = {
  accountId: "main",
  status: "risk_watch",
  riskLight: "green",
  bucketActions: [{ bucket: "GLB_MOM", verdict: "observe_only", proxySymbols: ["QQQ"] }],
  fundAnalyses: [],
  portfolioAnalysis: {
    deepDiveCandidates: [
      {
        fundCode: "019736",
        fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
        bucket: "GLB_MOM",
        amountCny: 10000,
        factorProfile: { primaryFactor: "US_TECH", proxySymbols: ["QQQ"] },
        researchProfile: { fundName: "宝盈纳斯达克100指数发起(QDII)A人民币", analysisTemplate: "qdii_index_fund" }
      }
    ]
  }
};

test("runFundNativeTradingAgents uses fake provider and returns normalized snapshot", async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "部分赎回候选",
              riskLight: "yellow",
              confidence: 0.7,
              oneLine: "可考虑卖出一部分，尾盘前复核。",
              styleEnvironment: { label: "中性", reason: "前收参考" },
              fundQuality: { label: "可用", reason: "指数工具" },
              lookThrough: { label: "清晰", reason: "美股科技" },
              peerRole: { label: "代表候选", reason: "同类核心" },
              riskReview: { riskLight: "yellow", notes: ["QDII 滞后"] },
              uncertainties: ["前收参考"],
              rawEvidence: "## Fund Committee Decision"
            })
          }
        }
      ]
    })
  });

  const snapshot = await runFundNativeTradingAgents({
    decisionSnapshot,
    bridgeConfig: {
      providerChain: {
        primary: [{ provider: "glm", backendUrl: "https://example.test/v4", deepThinkModel: "glm-5.1", quickThinkModel: "glm-5" }]
      }
    },
    env: { ZHIPU_API_KEY: "test-key" },
    fetchFn,
    scope: "deep_dive",
    limit: 1,
    now: new Date("2026-04-28T08:00:00.000Z")
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.analyses[0].fundCode, "019736");
  assert.equal(snapshot.analyses[0].provider, "glm");
  assert.equal(snapshot.analyses[0].verdict, "partial_redeem_review");
});

test("persistFundNativeAnalysisSnapshot writes canonical snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fund-native-"));
  try {
    const snapshot = { status: "ready", analyses: [] };
    const outputPath = await persistFundNativeAnalysisSnapshot({ portfolioRoot: root, snapshot });
    assert.equal(outputPath, resolveFundNativeAnalysisPath(root));
    const saved = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(saved.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_tradingagents.test.mjs
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement runner**

Create `portfolio/scripts/lib/fund_native_tradingagents.mjs`:

```js
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFundNativeContextsFromDecision } from "./fund_native_context.mjs";
import { normalizeFundNativeAnalysis } from "./fund_native_output.mjs";
import { buildFundNativeMessages } from "./fund_native_prompt_pack.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function providerAttemptsFromConfig(config = {}) {
  const chain = config?.providerChain ?? {};
  return [...asArray(chain.primary), ...asArray(chain.fallback)].map((item) => ({
    provider: String(item.provider ?? item.llmProvider ?? "glm").toLowerCase(),
    backendUrl: item.backendUrl ?? item.baseUrl ?? "https://api.z.ai/api/paas/v4",
    model: item.deepThinkModel ?? item.quickThinkModel ?? item.model ?? "glm-5.1"
  }));
}

function apiKeyForProvider(provider, env = process.env) {
  if (provider === "deepseek") {
    return env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY_POOL?.split(",")?.[0] ?? null;
  }
  return env.ZHIPU_API_KEY ?? env.ZHIPU_API_KEY_POOL?.split(",")?.[0] ?? null;
}

function chatUrl(baseUrl) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function extractJsonObject(text) {
  const source = String(text ?? "").trim();
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error("fund_native_json_parse_failed");
  }
}

async function callProvider({ context, providerAttempt, apiKey, fetchFn = fetch, timeoutMs = 90000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(chatUrl(providerAttempt.backendUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: providerAttempt.model,
        messages: buildFundNativeMessages({ context }),
        temperature: 0.2
      })
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`provider_http_${response.status}:${responseText.slice(0, 200)}`);
    }
    const envelope = JSON.parse(responseText);
    const content = envelope?.choices?.[0]?.message?.content ?? envelope?.choices?.[0]?.text ?? "";
    return { rawText: content, parsed: extractJsonObject(content) };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveFundNativeAnalysisPath(portfolioRoot) {
  return path.join(portfolioRoot, "data", "fund_native_analysis_snapshot.json");
}

export async function loadFundNativeAnalysisSnapshot({ portfolioRoot } = {}) {
  try {
    return JSON.parse(await readFile(resolveFundNativeAnalysisPath(portfolioRoot), "utf8"));
  } catch {
    return null;
  }
}

export async function persistFundNativeAnalysisSnapshot({ portfolioRoot, snapshot } = {}) {
  const outputPath = resolveFundNativeAnalysisPath(portfolioRoot);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return outputPath;
}

export async function runFundNativeTradingAgents({
  decisionSnapshot = {},
  bridgeConfig = {},
  env = process.env,
  fetchFn = fetch,
  scope = "deep_dive",
  limit = 4,
  now = new Date()
} = {}) {
  const contexts = buildFundNativeContextsFromDecision({ decisionSnapshot, scope, limit });
  const providerAttempts = providerAttemptsFromConfig(bridgeConfig);
  const analyses = [];
  const providerAttempted = [];

  for (const context of contexts) {
    let completed = null;
    for (const providerAttempt of providerAttempts) {
      const apiKey = apiKeyForProvider(providerAttempt.provider, env);
      const attempt = {
        provider: providerAttempt.provider,
        model: providerAttempt.model,
        fundCode: context.fundCode,
        status: apiKey ? "attempted" : "missing_key"
      };
      providerAttempted.push(attempt);
      if (!apiKey) continue;
      try {
        const raw = await callProvider({ context, providerAttempt, apiKey, fetchFn });
        completed = normalizeFundNativeAnalysis({
          parsed: raw.parsed,
          context,
          provider: providerAttempt.provider,
          rawText: raw.rawText
        });
        attempt.status = "success";
        break;
      } catch (error) {
        attempt.status = "failed";
        attempt.error = trimText(error?.message) ?? "provider_failed";
      }
    }
    analyses.push(completed ?? {
      fundCode: context.fundCode,
      fundName: context.fundName,
      mode: "fund_native",
      status: "failed",
      verdict: "pause_action",
      verdictLabel: "今日暂停动作",
      oneLine: "基金原生 TradingAgents 未完成，当前为降级观察。",
      execution: { executionIntent: "review_only", fundExecutionStyle: "end_of_day_t1_review" }
    });
  }

  const successCount = analyses.filter((item) => item.status === "success").length;
  return {
    generatedAt: now.toISOString(),
    mode: "fund_native",
    source: "TradingAgents fund-native compatibility mode",
    status: contexts.length === 0 ? "empty" : successCount === contexts.length ? "ready" : successCount > 0 ? "partial" : "failed",
    scope,
    count: analyses.length,
    successCount,
    providerAttempted,
    analyses
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test portfolio/scripts/lib/fund_native_tradingagents.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portfolio/scripts/lib/fund_native_tradingagents.mjs portfolio/scripts/lib/fund_native_tradingagents.test.mjs
git commit -m "feat: run fund-native TradingAgents snapshots"
```

---

### Task 5: Add Fund-Native CLI

**Files:**
- Create: `portfolio/scripts/run_fund_native_tradingagents.mjs`

- [ ] **Step 1: Create CLI wrapper**

Create `portfolio/scripts/run_fund_native_tradingagents.mjs`:

```js
#!/usr/bin/env node
import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { loadTradingAgentsBridgeConfig, loadTradingDecisionSnapshot } from "./lib/tradingagents_decision.mjs";
import {
  persistFundNativeAnalysisSnapshot,
  runFundNativeTradingAgents
} from "./lib/fund_native_tradingagents.mjs";

function parseArgs(argv) {
  const result = { scope: "deep_dive", limit: "4" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const accountId = resolveAccountId(args.user ?? args.account ?? "main");
  const portfolioRoot = resolvePortfolioRoot({ user: accountId, portfolioRoot: args["portfolio-root"] });
  const decisionSnapshot = await loadTradingDecisionSnapshot({ portfolioRoot, accountId });
  const bridgeConfig = await loadTradingAgentsBridgeConfig();
  const snapshot = await runFundNativeTradingAgents({
    decisionSnapshot,
    bridgeConfig,
    scope: String(args.scope ?? "deep_dive"),
    limit: Number(args.limit ?? 4)
  });
  const outputPath = await persistFundNativeAnalysisSnapshot({ portfolioRoot, snapshot });
  const result = { portfolioRoot, accountId, outputPath, snapshot };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 2: Smoke test CLI with missing keys**

Run:

```bash
node portfolio/scripts/run_fund_native_tradingagents.mjs \
  --portfolio-root /Users/yinshiwei/codex/tz-main-simplified/portfolio \
  --user main \
  --scope deep_dive \
  --limit 1
```

Expected: command exits 0. If keys are missing or provider fails, snapshot status is `failed` or `partial`, not a thrown process error.

- [ ] **Step 3: Commit**

```bash
git add portfolio/scripts/run_fund_native_tradingagents.mjs
git commit -m "feat: add fund-native TradingAgents CLI"
```

---

### Task 6: Wire API and Trading Decision Payload

**Files:**
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Test: `portfolio/scripts/serve_funds_live_dashboard.test.mjs`

- [ ] **Step 1: Add dashboard test for fund-native payload**

In `portfolio/scripts/serve_funds_live_dashboard.test.mjs`, add a test near existing `/api/fund-live-analysis` route coverage:

```js
test("trading decision payload includes fund-native analysis snapshot", async () => {
  const fundNativeAnalysis = {
    generatedAt: "2026-04-28T08:00:00.000Z",
    status: "ready",
    mode: "fund_native",
    count: 1,
    analyses: [
      {
        fundCode: "019736",
        fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
        status: "success",
        verdictLabel: "可考虑卖出一部分",
        oneLine: "基金原生主脑建议尾盘前复核赎回。"
      }
    ]
  };

  const harness = await startDashboardTestServer({
    loadFundNativeAnalysisSnapshotFn: async () => fundNativeAnalysis
  });
  try {
    const response = await fetch(`${harness.baseUrl}/api/trading-decision?account=main`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.fundNativeAnalysis.status, "ready");
    assert.equal(payload.fundNativeAnalysis.analyses[0].fundCode, "019736");
  } finally {
    await harness.close();
  }
});
```

If `startDashboardTestServer` uses a different helper name, place the same assertions into the existing server factory test pattern in this file.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: FAIL because `loadFundNativeAnalysisSnapshotFn` is not injected or payload lacks `fundNativeAnalysis`.

- [ ] **Step 3: Add imports and dependency injection**

In `portfolio/scripts/serve_funds_live_dashboard.mjs`, add imports beside fund-live analyzer imports:

```js
import {
  loadFundNativeAnalysisSnapshot,
  persistFundNativeAnalysisSnapshot,
  runFundNativeTradingAgents
} from "./lib/fund_native_tradingagents.mjs";
```

In the server factory default dependency object, add:

```js
loadFundNativeAnalysisSnapshotFn = loadFundNativeAnalysisSnapshot,
persistFundNativeAnalysisSnapshotFn = persistFundNativeAnalysisSnapshot,
runFundNativeTradingAgentsFn = runFundNativeTradingAgents,
```

- [ ] **Step 4: Add snapshot to `/api/trading-decision` payload**

Near current fund-live analysis loading in `/api/trading-decision`, add:

```js
const fundNativeAnalysis = await loadFundNativeAnalysisSnapshotFn({ portfolioRoot });
```

Then include it in `sendJson` payload:

```js
fundNativeAnalysis: fundNativeAnalysis ?? {
  generatedAt: new Date().toISOString(),
  mode: "fund_native",
  source: "TradingAgents fund-native compatibility mode",
  status: "missing",
  count: 0,
  analyses: []
},
```

- [ ] **Step 5: Add `/api/fund-native-analysis` route**

Add route near `/api/fund-live-analysis`:

```js
if (requestUrl.pathname === "/api/fund-native-analysis") {
  const availableAccounts = await listAvailableAccountsFn();
  const accountId = pickValidAccountId(
    requestUrl.searchParams.get("account"),
    availableAccounts,
    activeAccountId
  );
  const portfolioRoot =
    accountId === activeAccountId
      ? activePortfolioRoot
      : resolvePortfolioRoot({ user: accountId });
  const shouldRefresh = requestUrl.searchParams.get("refresh") === "1";
  let payload = shouldRefresh
    ? await runFundNativeTradingAgentsFn({
        decisionSnapshot: await loadTradingDecisionSnapshotFn({ portfolioRoot, accountId }),
        bridgeConfig: await loadTradingAgentsBridgeConfigFn(),
        scope: String(requestUrl.searchParams.get("scope") || "deep_dive"),
        limit: parseBoundedInt(requestUrl.searchParams.get("limit"), 4, { min: 1, max: 8 })
      })
    : await loadFundNativeAnalysisSnapshotFn({ portfolioRoot });
  if (shouldRefresh) {
    await persistFundNativeAnalysisSnapshotFn({ portfolioRoot, snapshot: payload });
  }
  payload = payload ?? {
    generatedAt: new Date().toISOString(),
    mode: "fund_native",
    source: "TradingAgents fund-native compatibility mode",
    status: "missing",
    count: 0,
    analyses: []
  };
  sendJson(response, 200, { ...payload, refreshed: shouldRefresh });
  return;
}
```

Use the exact existing function names for `loadTradingDecisionSnapshotFn` and `loadTradingAgentsBridgeConfigFn`; if the server uses different local variable names, adapt only the names, not the route behavior.

- [ ] **Step 6: Run route tests**

Run:

```bash
node --test portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add portfolio/scripts/serve_funds_live_dashboard.mjs portfolio/scripts/serve_funds_live_dashboard.test.mjs
git commit -m "feat: expose fund-native TradingAgents analysis"
```

---

### Task 7: Render Fund-Native Results in `/advice` Details

**Files:**
- Modify: `portfolio/scripts/serve_funds_live_dashboard.mjs`
- Test: `portfolio/scripts/serve_funds_live_dashboard.test.mjs`

- [ ] **Step 1: Add page render assertion**

Add or update HTML render test in `portfolio/scripts/serve_funds_live_dashboard.test.mjs`:

```js
test("advice page detail prefers fund-native TradingAgents result label", async () => {
  const html = renderAdvicePageForTest({
    payload: {
      portfolioAnalysis: {
        deepDiveCandidates: [
          { fundCode: "019736", fundName: "宝盈纳斯达克100指数发起(QDII)A人民币" }
        ]
      },
      fundNativeAnalysis: {
        status: "ready",
        analyses: [
          {
            fundCode: "019736",
            status: "success",
            verdictLabel: "可考虑卖出一部分",
            oneLine: "基金原生主脑建议尾盘前复核赎回。",
            styleEnvironment: { label: "中性", reason: "前收参考" },
            fundQuality: { label: "可用", reason: "指数工具" },
            lookThrough: { label: "清晰", reason: "美股科技" },
            peerRole: { label: "代表候选", reason: "同类核心" },
            riskReview: { notes: ["QDII 滞后"] },
            execution: { timingNote: "尾盘前复核，按基金净值确认。" }
          }
        ]
      }
    }
  });

  assert.match(html, /基金原生主脑/);
  assert.match(html, /可考虑卖出一部分/);
  assert.doesNotMatch(html, /深看详情 \/ 白话版/);
});
```

If no `renderAdvicePageForTest` exists, add a browser-side unit test around the existing renderer function used for deep dive candidates instead of introducing a new public helper.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: FAIL until UI reads `fundNativeAnalysis`.

- [ ] **Step 3: Add browser-side lookup by fund code**

Inside the browser script in `serve_funds_live_dashboard.mjs`, near current `fundLiveRows` map creation, add:

```js
const fundNativeRows = Array.isArray(payload?.fundNativeAnalysis?.analyses) ? payload.fundNativeAnalysis.analyses : [];
const nativeByCode = new Map(fundNativeRows.map((item) => [String(item?.fundCode ?? ""), item]));
```

Pass `nativeByCode` into the deep-dive rendering function, or read it from the payload inside that function.

- [ ] **Step 4: Render fund-native detail before old fund-live fallback**

Inside the `详情` rendering for each deep-dive candidate, add:

```js
const native = nativeByCode.get(String(item?.fundCode ?? ""));
const nativeHtml = native && native.status === "success"
  ? '<div class="detail-block">' +
      '<div class="detail-title">基金原生主脑</div>' +
      '<div class="row-title">' + escapeHtml(native.verdictLabel || native.verdict || '基金结论') + '</div>' +
      '<div class="row-sub">' + escapeHtml(native.oneLine || '暂无一句话结论。') + '</div>' +
      '<div class="chip-row">' +
        '<span class="row-chip">风格：' + escapeHtml(native.styleEnvironment?.label || '--') + '</span>' +
        '<span class="row-chip">质量：' + escapeHtml(native.fundQuality?.label || '--') + '</span>' +
        '<span class="row-chip">穿透：' + escapeHtml(native.lookThrough?.label || '--') + '</span>' +
        '<span class="row-chip">同类：' + escapeHtml(native.peerRole?.label || '--') + '</span>' +
      '</div>' +
      '<div class="row-sub">' + escapeHtml(native.execution?.timingNote || '尾盘前复核，按基金净值确认。') + '</div>' +
    '</div>'
  : '<div class="detail-block"><div class="detail-title">基金原生主脑</div><div class="row-sub">基金原生主脑未完成，当前展示本地降级观察。</div></div>';
```

Put `nativeHtml` before existing fund-live/plain detail content.

- [ ] **Step 5: Add refresh button behavior**

Add a small button near existing `深看基金` button:

```html
<button class="mini-button" type="button" id="fundNativeBtn">基金原生主脑</button>
```

Add JS element lookup:

```js
fundNativeBtn: document.getElementById("fundNativeBtn"),
```

Add refresh function:

```js
async function refreshFundNativeAnalysis() {
  elements.fundNativeBtn.disabled = true;
  elements.fundNativeBtn.textContent = "基金主脑运行中";
  try {
    const url = new URL('/api/fund-native-analysis', window.location.origin);
    url.searchParams.set('account', activeAccountId || 'main');
    url.searchParams.set('refresh', '1');
    url.searchParams.set('scope', 'deep_dive');
    url.searchParams.set('limit', '4');
    await fetchJson(url.toString());
    await refreshAdvice();
  } finally {
    elements.fundNativeBtn.disabled = false;
    elements.fundNativeBtn.textContent = "基金原生主脑";
  }
}

elements.fundNativeBtn.addEventListener('click', refreshFundNativeAnalysis);
```

Use existing helper names for `fetchJson`, `refreshAdvice`, and `activeAccountId` as found in the file.

- [ ] **Step 6: Run page tests**

Run:

```bash
node --test portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add portfolio/scripts/serve_funds_live_dashboard.mjs portfolio/scripts/serve_funds_live_dashboard.test.mjs
git commit -m "feat: render fund-native brain details"
```

---

### Task 8: Full Targeted Regression and Manual Smoke

**Files:**
- No code changes unless tests fail.

- [ ] **Step 1: Run fund-native tests**

```bash
node --test \
  portfolio/scripts/lib/fund_native_context.test.mjs \
  portfolio/scripts/lib/fund_native_output.test.mjs \
  portfolio/scripts/lib/fund_native_prompt_pack.test.mjs \
  portfolio/scripts/lib/fund_native_tradingagents.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 2: Run existing trading/fund dashboard regression**

```bash
node --test \
  portfolio/scripts/lib/fund_live_analyzer.test.mjs \
  portfolio/scripts/lib/fund_research_profiles.test.mjs \
  portfolio/scripts/lib/tradingagents_decision.test.mjs \
  portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 3: Run CLI smoke**

```bash
node portfolio/scripts/run_fund_native_tradingagents.mjs \
  --portfolio-root /Users/yinshiwei/codex/tz-main-simplified/portfolio \
  --user main \
  --scope deep_dive \
  --limit 1
```

Expected: writes `portfolio/data/fund_native_analysis_snapshot.json`. Provider failure is acceptable only if snapshot records `status=failed` and does not throw.

- [ ] **Step 4: Restart dashboard**

```bash
node portfolio/scripts/open_funds_live_dashboard.mjs \
  --open false \
  --route /advice \
  --portfolioRoot /Users/yinshiwei/codex/tz-main-simplified/portfolio \
  --user main
```

Expected: service starts on `http://127.0.0.1:8766`.

- [ ] **Step 5: API smoke**

```bash
curl -s 'http://127.0.0.1:8766/api/trading-decision?account=main' | python3 - <<'PY'
import json, sys
payload = json.load(sys.stdin)
print(payload.get('fundNativeAnalysis', {}).get('status'))
print(len(payload.get('fundNativeAnalysis', {}).get('analyses', [])))
PY
```

Expected: prints a valid status such as `ready`, `partial`, `failed`, or `missing`, and a numeric count.

- [ ] **Step 6: Final commit if any regression fixes were needed**

```bash
git status --short
git add <only files changed for this task>
git commit -m "fix: stabilize fund-native TradingAgents integration"
```

Only run the commit command if there are actual fixes.

---

## Self-Review

- Spec coverage:
  - Fund-native context: Task 1.
  - Fund action semantics and sanitizer: Task 2.
  - TradingAgents role topology with fund semantics: Task 3.
  - Snapshot runner/cache: Task 4 and Task 5.
  - `/api/trading-decision` and `/api/fund-native-analysis`: Task 6.
  - `/advice` detail display and manual trigger: Task 7.
  - Tests and manual smoke: Task 8.

- Placeholder scan:
  - The plan intentionally avoids `TBD` and undefined behavior.
  - Task 6 and Task 7 mention adapting helper names only where the existing test harness function name may differ; the route behavior and code blocks are explicit.

- Type consistency:
  - `FundResearchContext` fields from Task 1 match Task 3 prompt usage and Task 4 runner usage.
  - `normalizeFundNativeAnalysis` fields from Task 2 match Task 7 UI fields.
  - Snapshot field `fundNativeAnalysis` is used consistently in API and UI tasks.
