function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function toNumberOrNull(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric, digits) : null;
}

function isSameDate(left, right) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  return Boolean(leftText && rightText && leftText === rightText);
}

export function resolveDisplayedDailyChangePct({
  valuationChangePercent = null,
  growthRate = null
} = {}) {
  const hasValuationChange =
    valuationChangePercent !== null &&
    valuationChangePercent !== undefined &&
    valuationChangePercent !== "";
  const valuationNumeric = Number(valuationChangePercent);
  if (hasValuationChange && Number.isFinite(valuationNumeric)) {
    return round(valuationNumeric);
  }

  const hasGrowthRate = growthRate !== null && growthRate !== undefined && growthRate !== "";
  const growthNumeric = Number(growthRate);
  return hasGrowthRate && Number.isFinite(growthNumeric) ? round(growthNumeric) : null;
}

export function resolveValuationLabel({ quoteFresh = false } = {}) {
  return quoteFresh ? "估算净值" : "确认净值";
}

export function resolveQuoteStatusDisplay({
  quoteFresh = false,
  quoteDate = null,
  updateTime = null
} = {}) {
  if (quoteFresh) {
    return {
      text: "实时估值",
      tone: "flat"
    };
  }

  const quoteDateText = String(quoteDate ?? "").trim();
  if (quoteDateText) {
    return {
      text: `${quoteDateText}净值`,
      tone: "flat"
    };
  }

  const updateTimeText = String(updateTime ?? "").trim();
  if (updateTimeText) {
    return {
      text: updateTimeText,
      tone: "flat"
    };
  }

  return {
    text: "暂无估值",
    tone: "flat"
  };
}

function compareDateStrings(left, right) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) {
    return 0;
  }
  return leftText.localeCompare(rightText);
}

export function deriveTodayPnlDisplay({
  quoteDate = null,
  today = null,
  confirmedChangePct = null,
  confirmedDailyPnl = null
} = {}) {
  const quoteFresh = isSameDate(quoteDate, today);

  return {
    quoteFresh,
    displayedChangePct: quoteFresh ? toNumberOrNull(confirmedChangePct) : null,
    displayedDailyPnl: quoteFresh ? toNumberOrNull(confirmedDailyPnl) : null
  };
}

export function applyTodayPnlToBaseValue({
  quoteDate = null,
  today = null,
  baseValue = null,
  todayPnl = null
} = {}) {
  const baseNumeric = Number(baseValue);
  if (!Number.isFinite(baseNumeric)) {
    return null;
  }

  const displayedTodayPnl = deriveTodayPnlDisplay({
    quoteDate,
    today,
    confirmedDailyPnl: todayPnl
  }).displayedDailyPnl;

  return round(baseNumeric + Number(displayedTodayPnl ?? 0));
}

export function shouldApplyEstimatedPnlOverlay(snapshotDate = null, quoteDate = null, today = null) {
  const quoteText = String(quoteDate ?? "").trim();
  const snapshotText = String(snapshotDate ?? "").trim();
  const todayText = String(today ?? "").trim();

  if (!quoteText) {
    return false;
  }

  if (quoteText && todayText && quoteText === todayText) {
    return true;
  }

  if (!snapshotText) {
    return false;
  }

  return compareDateStrings(quoteText, snapshotText) > 0;
}

export function summarizeTodayPnl(rows = [], totalFundAssetsRaw = 0) {
  const freshRows = rows.filter(
    (row) => row?.quoteFresh === true && Number.isFinite(Number(row?.estimatedPnl))
  );

  if (freshRows.length === 0) {
    return {
      estimatedDailyPnl: null,
      estimatedDailyPnlRatePct: null
    };
  }

  const estimatedDailyPnlRaw = freshRows.reduce((sum, row) => sum + Number(row?.estimatedPnl ?? 0), 0);

  return {
    estimatedDailyPnl: toNumberOrNull(estimatedDailyPnlRaw),
    estimatedDailyPnlRatePct:
      Number(totalFundAssetsRaw) > 0
        ? toNumberOrNull((estimatedDailyPnlRaw / Number(totalFundAssetsRaw)) * 100)
        : null
  };
}

export function coercePersistedTodayPnl(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric) : 0;
}
