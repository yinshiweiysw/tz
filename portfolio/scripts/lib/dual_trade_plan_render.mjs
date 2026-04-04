function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatPercent(value) {
  return `${(asNumber(value, 0) * 100).toFixed(2)}%`;
}

function formatCurrency(value) {
  return `${asNumber(value, 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} 元`;
}

function normalizeCandidate(candidate = {}) {
  const firstProxy = asArray(candidate.tradable_proxies)[0] ?? {};
  return {
    theme_name: String(candidate.theme_name ?? "").trim(),
    action_bias: String(candidate.action_bias ?? "").trim(),
    total_score: asNumber(candidate.total_score, 0),
    tradable_proxy_symbols: asArray(candidate.tradable_proxies)
      .map((proxy) => String(proxy?.symbol ?? "").trim())
      .filter(Boolean),
    tradable_proxy_name: String(firstProxy.name ?? "").trim()
  };
}

function normalizeLineCollection(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }

  return text
    .split(/[；;]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatActionCollection(value, fallback) {
  const lines = normalizeLineCollection(value);
  return lines.length > 0 ? lines.join("；") : fallback;
}

function ensureBulletLine(line) {
  const text = String(line ?? "").trim();
  if (!text) {
    return "";
  }

  return /^[-*]\s+/u.test(text) ? text : `- ${text}`;
}

function isSpeculativeBudgetLine(line) {
  return /^[-*]\s*(风险预算上限|博弈仓上限|剩余预算)：/u.test(String(line ?? "").trim());
}

function hasStructuredPlan(payload) {
  return Boolean(payload && typeof payload === "object");
}

function resolveSpeculativeDataState(speculativePlan) {
  if (!hasStructuredPlan(speculativePlan)) {
    return "missing";
  }

  const instructions = asArray(speculativePlan.instructions);
  return instructions.length > 0 ? "available" : "empty";
}

function formatSpeculativeInstruction(item = {}, index = 0) {
  const symbol = String(item.symbol ?? "").trim();
  const instrument = String(item.instrument_name ?? item.theme_name ?? "").trim();
  const amount = formatCurrency(item.suggested_amount_cny);
  const trigger = String(item.trigger_reason ?? item.trigger_source ?? "待补充").trim();
  const exitRule = String(item.exit_rule ?? "按纪律退出").trim();
  const invalidation = String(item.invalidation ?? "").trim();

  const parts = [
    `${index + 1}. ${symbol || "N/A"} ${instrument}`,
    `建议试单：${amount}`,
    `触发：${trigger}`,
    `退出：${exitRule}`
  ];

  if (invalidation) {
    parts.push(`证伪：${invalidation}`);
  }

  return parts.join("｜");
}

function normalizeCoreMarkdown(markdown = "") {
  let source = String(markdown ?? "").trim();
  if (!source) {
    return "";
  }

  const coreHeader = "## 主系统计划";
  const speculativeHeader = "\n## 博弈系统计划";
  const coreStart = source.indexOf(coreHeader);
  const speculativeStart = source.indexOf(speculativeHeader);

  if (coreStart >= 0 && speculativeStart > coreStart) {
    const inner = source.slice(coreStart + coreHeader.length, speculativeStart).trim();
    const innerLines = inner.split("\n");
    while (innerLines.length > 0 && !innerLines[0].trim()) {
      innerLines.shift();
    }
    if (innerLines[0]?.startsWith("> 以下为 Python 主系统原始输出")) {
      innerLines.shift();
    }
    source = innerLines.join("\n").trim();
  }

  const lines = source.split("\n");
  if (lines[0].startsWith("# ")) {
    source = lines.slice(1).join("\n").trim();
  }

  return source;
}

export function buildOpportunitySummary(opportunityPool = {}, maxCandidates = 3) {
  const candidates = asArray(opportunityPool?.candidates)
    .map((candidate) => normalizeCandidate(candidate))
    .sort((left, right) => right.total_score - left.total_score);
  const limit = Math.max(1, Number(maxCandidates) || 3);
  const topCandidates = candidates.slice(0, limit);
  const trialAllowedThemes = candidates
    .filter((candidate) => candidate.action_bias === "允许试单")
    .map((candidate) => candidate.theme_name)
    .filter(Boolean);

  return {
    as_of: String(opportunityPool?.as_of ?? "").slice(0, 10) || null,
    top_candidates: topCandidates,
    trial_allowed_themes: trialAllowedThemes
  };
}

export function buildInstitutionalActionLines({
  thesis = "",
  expectationGap = "",
  allowedActions = [],
  blockedActions = [],
  tradePermission = "",
  blockedOrder = ""
} = {}) {
  const thesisLine =
    String(thesis ?? "").trim() || "暂无清晰主线，先以风险控制和跟踪观察为主。";
  const expectationGapLine =
    String(expectationGap ?? "").trim() || "暂无显著预期差，保持耐心等待错配信号。";
  const normalizedTradePermission = String(tradePermission ?? "").trim();

  if (normalizedTradePermission === "blocked" || normalizedTradePermission === "research_invalid") {
    return [
      `- 今日主线：${thesisLine}`,
      `- 当前预期差：${expectationGapLine}`,
      "- 允许动作：仅允许观察与记录，不生成交易指令",
      `- 禁止动作：${String(blockedOrder ?? "").trim() || "研究闸门未通过，当前禁止生成交易指令。"}`
    ];
  }

  const allowedLine = formatActionCollection(
    allowedActions,
    "仅允许按既定计划小步执行，默认先观察后行动。"
  );
  const blockedLine = formatActionCollection(
    blockedActions,
    "禁止脱离交易计划的临时加仓与情绪化追单。"
  );
  return [
    `- 今日主线：${thesisLine}`,
    `- 当前预期差：${expectationGapLine}`,
    `- 允许动作：${allowedLine}`,
    `- 禁止动作：${blockedLine}`
  ];
}

export function buildSpeculativeDisciplineBlock(discipline = "") {
  const text =
    String(discipline ?? "").trim() || "当前无新增博弈触发，维持观察并等待下一次信号确认。";
  return [`- 博弈系统纪律：${text}`];
}

export function extractSpeculativeConclusionLines(lines = []) {
  const normalized = asArray(lines)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .filter((line) => !isSpeculativeBudgetLine(line));
  const explicitConclusions = normalized.filter((line) =>
    ["当前无触发的左侧博弈机会", "博弈计划数据缺失", "当前触发指令数"].some((marker) =>
      line.includes(marker)
    )
  );

  if (explicitConclusions.length > 0) {
    return explicitConclusions.map((line) => ensureBulletLine(line));
  }

  const instructions = normalized.filter((line) => /^\d+\./u.test(line));
  if (instructions.length > 0) {
    return [
      "- 当前存在博弈触发指令，按双轨计划明细执行。",
      `- 首条指令：${instructions[0]}`
    ];
  }

  return ["- 当前未检测到博弈系统可执行结论，默认维持观察。"];
}

export function buildDualTradePlanPayload({
  corePayload = {},
  speculativePlan = null,
  opportunityPool = {}
} = {}) {
  const dataState = resolveSpeculativeDataState(speculativePlan);

  return {
    ...corePayload,
    core_trade_plan: {
      plan_date: String(corePayload?.plan_date ?? "").slice(0, 10) || null,
      generated_at: corePayload?.generated_at ?? null,
      summary: corePayload?.summary ?? null,
      trades: asArray(corePayload?.trades),
      suppressed: asArray(corePayload?.suppressed),
      upstream_signal_errors: asArray(corePayload?.upstream_signal_errors)
    },
    speculative_trade_plan: {
      system: String(speculativePlan?.system ?? "left_speculative_sleeve"),
      as_of: String(speculativePlan?.as_of ?? "").slice(0, 10) || null,
      generated_at: speculativePlan?.generated_at ?? null,
      data_state: dataState,
      budget_context: speculativePlan?.budget_context ?? {},
      trigger_sources_supported: asArray(speculativePlan?.trigger_sources_supported),
      instructions: asArray(speculativePlan?.instructions)
    },
    opportunity_summary: buildOpportunitySummary(opportunityPool)
  };
}

export function renderDualTradePlanMarkdown({
  planDate = "",
  coreMarkdown = "",
  speculativePlan = null,
  opportunitySummary = null
} = {}) {
  const dataState = resolveSpeculativeDataState(speculativePlan);
  const budget = speculativePlan?.budget_context ?? {};
  const instructions = asArray(speculativePlan?.instructions);
  const summary = opportunitySummary ?? { top_candidates: [], trial_allowed_themes: [] };
  const topCandidates = asArray(summary.top_candidates)
    .map((candidate) => {
      const name = String(candidate.theme_name ?? "").trim();
      const bias = String(candidate.action_bias ?? "").trim();
      const score = asNumber(candidate.total_score, 0);
      return `${name}(${bias || "待定"}, ${score})`;
    })
    .filter(Boolean);
  const trialThemes = asArray(summary.trial_allowed_themes).filter(Boolean);
  const coreBlock = normalizeCoreMarkdown(coreMarkdown);
  const reportDate = String(planDate ?? "").slice(0, 10);

  return [
    `# ${reportDate || "Next"} Dual Trade Plan`,
    "",
    "## 主系统计划",
    "",
    "> 以下为 Python 主系统原始输出（原文保留）",
    "",
    coreBlock || "- 主系统原文缺失。",
    "",
    "## 博弈系统计划",
    `- 风险预算上限：${formatPercent(budget.max_pct)}`,
    `- 博弈仓上限：${formatCurrency(budget.sleeve_cap_cny)}`,
    `- 剩余预算：${formatCurrency(budget.remaining_budget_cny)}`,
    dataState === "missing"
      ? "- 博弈计划数据缺失：speculative_plan.json 不存在或读取失败，当前不将其视为有效空计划。"
      : instructions.length > 0
      ? `- 当前触发指令数：${instructions.length}`
      : "- 当前无触发的左侧博弈机会（speculative_plan.instructions 为空）。",
    ...instructions.map((item, index) => formatSpeculativeInstruction(item, index)),
    "",
    "## 机会池摘要",
    topCandidates.length > 0
      ? `- Top candidates：${topCandidates.join("、")}`
      : "- Top candidates：暂无可用候选。",
    trialThemes.length > 0
      ? `- 允许试单主题：${trialThemes.join("、")}`
      : "- 允许试单主题：暂无。"
  ].join("\n");
}
