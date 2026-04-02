function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundCurrency(value) {
  return Number(asNumber(value, 0).toFixed(2));
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value ?? "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replace(/[\s\u3000]/g, "")
    .replaceAll("(QDII)", "")
    .replaceAll("（QDII）", "")
    .replaceAll("QDII-FOF-LOF", "QDII")
    .replaceAll("QDII-LOF", "QDII")
    .replaceAll("ETF发起式联接", "")
    .replaceAll("ETF发起联接", "")
    .replaceAll("ETF联接", "")
    .replaceAll("联接", "")
    .replaceAll("发起式", "")
    .replaceAll("混合型", "混合")
    .replace(/[()［］\[\]\-_/·.]/g, "")
    .toLowerCase()
    .trim();
}

function firstScaleInStep(scaleInSteps = []) {
  const first = asNumber(Array.isArray(scaleInSteps) ? scaleInSteps[0] : 0, 0);
  if (first > 0 && first <= 1) {
    return first;
  }
  return 0.25;
}

function clampMaxPct(value) {
  const numeric = asNumber(value, 0.15);
  return Math.min(Math.max(numeric, 0), 0.15);
}

function triggerAllowed(triggerSource, sleeveConfig = {}) {
  const allowed = Array.isArray(sleeveConfig.allowedTriggerSources)
    ? sleeveConfig.allowedTriggerSources
    : [];
  if (allowed.length === 0) {
    return true;
  }
  return allowed.includes(triggerSource);
}

function candidateMatchesTheme(candidate = {}, theme = "") {
  const rawTheme = String(theme ?? "").trim();
  if (!rawTheme) {
    return false;
  }

  const themeCode = rawTheme.match(/^\d{6}$/)?.[0] ?? null;
  const tradableProxies = Array.isArray(candidate.tradable_proxies) ? candidate.tradable_proxies : [];

  if (themeCode) {
    const codes = new Set([
      candidate.symbol,
      candidate.code,
      ...tradableProxies.map((proxy) => proxy?.symbol)
    ]);
    return [...codes].some((code) => String(code ?? "").trim() === themeCode);
  }

  // Guard rail for accidental one-char/short-token triggering.
  if (rawTheme.length < 2) {
    return false;
  }

  const normalizedTheme = normalizeName(rawTheme);
  if (!normalizedTheme || normalizedTheme.length < 2) {
    return false;
  }

  const normalizedFields = new Set([
    candidate.theme_name,
    candidate.name,
    candidate.symbol,
    candidate.code,
    ...tradableProxies.flatMap((proxy) => [proxy?.symbol, proxy?.name])
  ].map((field) => normalizeName(field)).filter(Boolean));

  return normalizedFields.has(normalizedTheme);
}

function isActivePositionStatus(status) {
  const normalized = normalizeText(status);
  if (!normalized) {
    return false;
  }
  return (
    normalized === "active" ||
    normalized.startsWith("active_") ||
    normalized === "live" ||
    normalized === "running" ||
    normalized === "holding" ||
    normalized === "invested"
  );
}

function fieldContainsSpeculativeTag(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("speculative") ||
    normalized.includes("speculation") ||
    normalized.includes("left_speculative") ||
    normalized.includes("speculative_sleeve") ||
    normalized.includes("左侧") ||
    normalized.includes("博弈") ||
    normalized.includes("投机")
  );
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item ?? "")).filter(Boolean);
}

export function detectSpeculativeExposure(portfolioState = {}) {
  const positions = Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];
  let amount = 0;

  for (const position of positions) {
    if (!isActivePositionStatus(position?.status)) {
      continue;
    }

    const scalarFields = [
      position?.bucket,
      position?.category,
      position?.name,
      position?.role,
      position?.strategy_role
    ];
    const arrayFields = [
      ...asStringArray(position?.strategy_tags),
      ...asStringArray(position?.tags)
    ];
    const hasSpeculativeTag = [...scalarFields, ...arrayFields].some(fieldContainsSpeculativeTag);
    if (!hasSpeculativeTag) {
      continue;
    }

    amount += asNumber(position?.amount, 0);
  }

  if (amount <= 0) {
    return {
      amount: 0,
      note: "未识别到显式 speculative 持仓标签（如 bucket=SPECULATIVE 或 tags 含 speculative），当前按 0 处理。"
    };
  }

  return {
    amount: roundCurrency(amount),
    note: "根据持仓中的显式 speculative 标签估算当前博弈仓暴露。"
  };
}

export function deriveSpeculativeTrigger({ candidate = {}, options = {}, sleeveConfig = {} } = {}) {
  const themeName = String(candidate.theme_name ?? "").trim();
  const manualTheme = String(options.manualTheme ?? options.manual_theme ?? "").trim();
  const eventTheme = String(options.eventTheme ?? options.event_theme ?? "").trim();

  if (manualTheme && candidateMatchesTheme(candidate, manualTheme)) {
    const triggerSource = "manual_override";
    if (triggerAllowed(triggerSource, sleeveConfig)) {
      return {
        trigger_source: triggerSource,
        trigger_reason: `手动指定主题触发：${manualTheme}`,
        theme_name: themeName
      };
    }
  }

  if (eventTheme && candidateMatchesTheme(candidate, eventTheme)) {
    const triggerSource = "event_dislocation";
    if (triggerAllowed(triggerSource, sleeveConfig)) {
      return {
        trigger_source: triggerSource,
        trigger_reason: `事件驱动错杀窗口：${eventTheme}`,
        theme_name: themeName
      };
    }
  }

  if (candidate.event_dislocation === true || String(candidate.event_dislocation_reason ?? "").trim()) {
    const triggerSource = "event_dislocation";
    if (triggerAllowed(triggerSource, sleeveConfig)) {
      return {
        trigger_source: triggerSource,
        trigger_reason:
          String(candidate.event_dislocation_reason ?? "").trim() || "检测到事件错杀异动",
        theme_name: themeName
      };
    }
  }

  const leftSideRegime = String(candidate.left_side_regime ?? "").trim();
  const valuationRegime = String(candidate.valuation_regime_primary ?? "").trim();
  if (
    leftSideRegime === "bottom_divergence" &&
    ["extreme_undervalued", "undervalued"].includes(valuationRegime)
  ) {
    const triggerSource = "valuation_momentum_exhaustion";
    if (triggerAllowed(triggerSource, sleeveConfig)) {
      return {
        trigger_source: triggerSource,
        trigger_reason: `left_side_regime=${leftSideRegime} 且 valuation_regime_primary=${valuationRegime}`,
        theme_name: themeName
      };
    }
  }

  return null;
}

export function computeSpeculativeBudget({
  totalAssetsCny = 0,
  currentSpeculativeExposureCny = 0,
  sleeveConfig = {}
} = {}) {
  const maxPct = clampMaxPct(sleeveConfig.maxPct);
  const sleeveCapCny = roundCurrency(Math.max(0, asNumber(totalAssetsCny, 0) * maxPct));
  const currentExposure = roundCurrency(Math.max(0, asNumber(currentSpeculativeExposureCny, 0)));
  const availableBudget = roundCurrency(Math.max(0, sleeveCapCny - currentExposure));
  const scaleStep = firstScaleInStep(sleeveConfig.scaleInSteps);
  const suggestedAmount = roundCurrency(availableBudget * scaleStep);
  const remainingAfterTrade = roundCurrency(Math.max(0, availableBudget - suggestedAmount));

  return {
    max_pct: maxPct,
    sleeve_cap_cny: sleeveCapCny,
    current_speculative_exposure_cny: currentExposure,
    available_budget_cny: availableBudget,
    scale_in_step: scaleStep,
    suggested_amount_cny: suggestedAmount,
    remaining_after_trade_cny: remainingAfterTrade
  };
}

export function buildSpeculativeInstruction({
  asOf = "",
  candidate = {},
  trigger = {},
  budget = {},
  sleeveConfig = {}
} = {}) {
  const firstProxy = Array.isArray(candidate.tradable_proxies) ? candidate.tradable_proxies[0] : null;
  const exitRule = String(trigger.exit_rule ?? sleeveConfig.defaultExit ?? "反弹分批止盈").trim();
  const invalidation = String(
    trigger.invalidation ?? "若触发逻辑被证伪或波动继续恶化则取消执行并复盘。"
  ).trim();

  return {
    as_of: String(asOf).trim(),
    system: "left_speculative_sleeve",
    theme_name: String(candidate.theme_name ?? "").trim(),
    trigger_source: String(trigger.trigger_source ?? "").trim(),
    trigger_reason: String(trigger.trigger_reason ?? "").trim(),
    symbol: String(firstProxy?.symbol ?? candidate.symbol ?? "").trim(),
    instrument_name: String(firstProxy?.name ?? candidate.name ?? candidate.theme_name ?? "").trim(),
    suggested_amount_cny: roundCurrency(budget.suggested_amount_cny),
    available_budget_cny: roundCurrency(budget.available_budget_cny),
    sleeve_cap_cny: roundCurrency(budget.sleeve_cap_cny),
    current_speculative_exposure_cny: roundCurrency(budget.current_speculative_exposure_cny),
    remaining_after_trade_cny: roundCurrency(budget.remaining_after_trade_cny),
    max_pct: asNumber(budget.max_pct, clampMaxPct(sleeveConfig.maxPct)),
    exit_rule: exitRule,
    invalidation
  };
}
