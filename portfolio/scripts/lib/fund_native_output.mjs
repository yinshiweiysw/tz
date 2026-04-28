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
  if (["clear", "exit", "清仓", "退出"].some((key) => text.includes(key))) {
    return { verdict: "full_redeem_review", tradeDirection: "sell", label: "可考虑退出" };
  }
  if (["sell", "减仓", "赎回", "reduce"].some((key) => text.includes(key))) {
    return { verdict: "partial_redeem_review", tradeDirection: "sell", label: "可考虑卖出一部分" };
  }
  if (["buy", "申购", "增配", "subscribe", "add"].some((key) => text.includes(key))) {
    return { verdict: "subscribe_review", tradeDirection: "buy", label: "可考虑买入" };
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
