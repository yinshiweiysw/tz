import { resolveFundQuoteSessionMode } from "./fund_market_session_policy.mjs";

import { round } from "./format_utils.mjs";

function toNumberOrNull(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric, digits) : null;
}

function isSameDate(left, right) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  return Boolean(leftText && rightText && leftText === rightText);
}

function isSameText(left, right) {
  return String(left ?? "").trim() !== "" && String(left ?? "").trim() === String(right ?? "").trim();
}

function isSnapshotFreshForAccounting(snapshotDate = null, today = null) {
  return isSameText(snapshotDate, today);
}

function resolveQuoteMode({
  quoteDate = null,
  today = null,
  updateTime = null,
  sessionPolicy = null,
  now = new Date()
} = {}) {
  return resolveFundQuoteSessionMode({
    quoteDate,
    today,
    updateTime,
    sessionPolicy,
    now
  });
}

export function shouldUseConfirmedSnapshotDisplay({
  confirmedNavState = null,
  confirmedTargetDate = null,
  snapshotDate = null
} = {}) {
  return (
    String(confirmedNavState ?? "").trim() === "confirmed_nav_ready" &&
    isSameText(confirmedTargetDate, snapshotDate)
  );
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

export function resolveValuationLabel({ quoteFresh = false, quoteMode = null } = {}) {
  const resolvedMode = quoteMode ?? (quoteFresh ? "live_estimate" : "confirmed_nav");
  if (resolvedMode === "live_estimate") {
    return "盘中估值";
  }
  if (resolvedMode === "reference_only") {
    return "最近确认净值";
  }
  if (resolvedMode === "close_reference" || resolvedMode === "today_close") {
    return "收盘参考";
  }
  return "确认净值";
}

export function resolveQuoteStatusDisplay({
  quoteFresh = false,
  quoteMode = null,
  quoteDate = null,
  updateTime = null
} = {}) {
  const resolvedMode = quoteMode ?? (quoteFresh ? "live_estimate" : "confirmed_nav");
  if (resolvedMode === "live_estimate") {
    return {
      text: "盘中估值",
      tone: "flat"
    };
  }

  if (resolvedMode === "reference_only") {
    return {
      text: "参考涨跌",
      tone: "flat"
    };
  }

  if (resolvedMode === "close_reference" || resolvedMode === "today_close") {
    return {
      text: "收盘参考",
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

export function resolveLatestConfirmedLabel({
  quoteMode = null,
  confirmedNavDate = null
} = {}) {
  const resolvedMode = String(quoteMode ?? "").trim();
  const confirmedDateText = String(confirmedNavDate ?? "").trim();

  if (resolvedMode !== "confirmed_nav" || !confirmedDateText) {
    return null;
  }

  return `最近确认 ${confirmedDateText}`;
}

export function deriveTodayPnlDisplay({
  quoteDate = null,
  today = null,
  updateTime = null,
  confirmedChangePct = null,
  confirmedDailyPnl = null,
  sessionPolicy = null,
  now = new Date()
} = {}) {
  const quoteMode = resolveQuoteMode({ quoteDate, today, updateTime, sessionPolicy, now });
  const quoteFresh = quoteMode === "live_estimate";
  const quoteCurrent = quoteMode === "live_estimate" || quoteMode === "close_reference";

  return {
    quoteFresh,
    quoteCurrent,
    quoteMode,
    displayedChangePct: quoteCurrent ? toNumberOrNull(confirmedChangePct) : null,
    displayedDailyPnl: quoteCurrent ? toNumberOrNull(confirmedDailyPnl) : null
  };
}

export function deriveEstimatedPnlDisplay({
  quoteDate = null,
  today = null,
  updateTime = null,
  intradayChangePct = null,
  estimatedDailyPnl = null,
  referenceChangePct = null,
  referenceDailyPnl = null,
  observationKind = null,
  sessionPolicy = null,
  now = new Date()
} = {}) {
  if (observationKind === "reference_only") {
    return {
      quoteFresh: false,
      quoteCurrent: false,
      quoteMode: "reference_only",
      displayedChangePct: toNumberOrNull(referenceChangePct),
      displayedDailyPnl: toNumberOrNull(referenceDailyPnl)
    };
  }

  const quoteMode = resolveQuoteMode({ quoteDate, today, updateTime, sessionPolicy, now });
  const quoteFresh = quoteMode === "live_estimate";
  const quoteCurrent = quoteMode === "live_estimate" || quoteMode === "close_reference";

  return {
    quoteFresh,
    quoteCurrent,
    quoteMode,
    displayedChangePct: quoteCurrent ? toNumberOrNull(intradayChangePct) : null,
    displayedDailyPnl: quoteCurrent ? toNumberOrNull(estimatedDailyPnl) : null
  };
}

export function deriveOvernightCarryDisplay({
  quoteDate = null,
  today = null,
  updateTime = null,
  intradayChangePct = null,
  estimatedDailyPnl = null,
  pendingReferenceDate = null,
  expectedConfirmedDate = null,
  sessionPolicy = null,
  now = new Date()
} = {}) {
  const quoteMode = resolveQuoteMode({ quoteDate, today, updateTime, sessionPolicy, now });
  const profile = String(sessionPolicy?.profile ?? "").trim();
  const quoteDateText = String(quoteDate ?? "").trim();
  const todayText = String(today ?? "").trim();

  if (profile !== "global_qdii" || quoteMode !== "confirmed_nav" || !quoteDateText || quoteDateText !== todayText) {
    return {
      overnightCarryChangePct: null,
      overnightCarryPnl: null,
      overnightCarryLabel: null,
      overnightCarryReferenceDate: null
    };
  }

  const pendingReferenceDateText = String(pendingReferenceDate ?? expectedConfirmedDate ?? "").trim();

  return {
    overnightCarryChangePct: toNumberOrNull(intradayChangePct),
    overnightCarryPnl: toNumberOrNull(estimatedDailyPnl),
    overnightCarryLabel: pendingReferenceDateText
      ? `待确认收益 对应 ${pendingReferenceDateText}`
      : "待确认收益",
    overnightCarryReferenceDate: pendingReferenceDateText || null
  };
}

export function applyTodayPnlToBaseValue({
  quoteDate = null,
  today = null,
  updateTime = null,
  baseValue = null,
  todayPnl = null,
  sessionPolicy = null,
  now = new Date()
} = {}) {
  const baseNumeric = Number(baseValue);
  if (!Number.isFinite(baseNumeric)) {
    return null;
  }

  const displayedTodayPnl = deriveTodayPnlDisplay({
    quoteDate,
    today,
    updateTime,
    sessionPolicy,
    now,
    confirmedDailyPnl: todayPnl
  }).displayedDailyPnl;

  return round(baseNumeric + Number(displayedTodayPnl ?? 0));
}

export function shouldApplyEstimatedPnlOverlay(
  snapshotDate = null,
  quoteDate = null,
  today = null,
  updateTime = null,
  { useConfirmedSnapshotDisplay = false, sessionPolicy = null, now = new Date(), observationKind = null } = {}
) {
  if (useConfirmedSnapshotDisplay) {
    return false;
  }

  if (observationKind === "reference_only") {
    return false;
  }

  if (!isSnapshotFreshForAccounting(snapshotDate, today)) {
    return false;
  }

  const quoteText = String(quoteDate ?? "").trim();
  const quoteMode = resolveQuoteMode({ quoteDate, today, updateTime, sessionPolicy, now });

  if (!quoteText) {
    return false;
  }

  if (quoteMode === "live_estimate" || quoteMode === "close_reference") {
    return true;
  }

  return false;
}

export function summarizeTodayPnl(rows = [], totalFundAssetsRaw = 0) {
  const currentRows = rows.filter(
    (row) =>
      row?.accountingOverlayAllowed !== false &&
      row?.snapshotFreshForAccounting !== false &&
      (row?.quoteCurrent === true || (row?.quoteCurrent === undefined && row?.quoteFresh === true)) &&
      Number.isFinite(Number(row?.estimatedPnl))
  );

  if (currentRows.length === 0) {
    return {
      estimatedDailyPnl: null,
      estimatedDailyPnlRatePct: null
    };
  }

  const estimatedDailyPnlRaw = currentRows.reduce((sum, row) => sum + Number(row?.estimatedPnl ?? 0), 0);

  return {
    estimatedDailyPnl: toNumberOrNull(estimatedDailyPnlRaw),
    estimatedDailyPnlRatePct:
      Number(totalFundAssetsRaw) > 0
        ? toNumberOrNull((estimatedDailyPnlRaw / Number(totalFundAssetsRaw)) * 100)
        : null
  };
}

export function summarizeObservationTodayPnl(rows = [], totalFundAssetsRaw = 0) {
  const currentRows = rows.filter(
    (row) =>
      (row?.quoteCurrent === true || (row?.quoteCurrent === undefined && row?.quoteFresh === true)) &&
      Number.isFinite(Number(row?.estimatedPnl))
  );

  if (currentRows.length === 0) {
    return {
      estimatedDailyPnl: null,
      estimatedDailyPnlRatePct: null
    };
  }

  const estimatedDailyPnlRaw = currentRows.reduce((sum, row) => sum + Number(row?.estimatedPnl ?? 0), 0);

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
