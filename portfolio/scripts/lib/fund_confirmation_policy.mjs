import {
  findLatestTradingDateOnOrBefore,
  findPreviousTradingDateBefore,
  isTradingDateForMarket
} from "./market_schedule_guard.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function resolveAssetIdentity({ asset = null, position = null } = {}) {
  const market = normalizeText(asset?.market ?? position?.market).toUpperCase();
  const category = normalizeText(asset?.category ?? position?.category);
  const name = normalizeText(asset?.name ?? position?.name);
  return {
    market,
    category,
    name
  };
}

function inferConfirmationProfile({ asset = null, position = null } = {}) {
  const identity = resolveAssetIdentity({ asset, position });
  const combined = `${identity.market} ${identity.category} ${identity.name}`;

  if (combined.includes("港股")) {
    return {
      profile: "hk_fund",
      market: "HK"
    };
  }

  if (
    ["US", "GLB"].includes(identity.market) ||
    /QDII|美股|海外|纳斯达克|标普|日经|商品|大宗/.test(combined)
  ) {
    return {
      profile: "global_qdii",
      market: "US"
    };
  }

  return {
    profile: "domestic",
    market: "CN_A"
  };
}

function buildLabel(state, confirmedNavDate, expectedConfirmedDate) {
  const confirmedDateText = normalizeText(confirmedNavDate);
  const expectedDateText = normalizeText(expectedConfirmedDate);

  if (state === "confirmed") {
    return confirmedDateText ? `已确认 · ${confirmedDateText}` : "已确认";
  }
  if (state === "normal_lag") {
    return confirmedDateText ? `正常滞后 · ${confirmedDateText}确认` : "正常滞后";
  }
  if (state === "holiday_delay") {
    return confirmedDateText ? `休市顺延 · ${confirmedDateText}确认` : "休市顺延";
  }
  if (state === "late_missing") {
    return expectedDateText ? `确认净值待补 · 预期${expectedDateText}` : "确认净值待补";
  }
  return "确认净值缺失";
}

export function classifyFundConfirmation({
  targetDate,
  confirmedNavDate,
  asset = null,
  position = null
} = {}) {
  const normalizedTargetDate = normalizeText(targetDate);
  const normalizedConfirmedNavDate = normalizeText(confirmedNavDate) || null;
  const profile = inferConfirmationProfile({ asset, position });

  let expectedConfirmedDate = normalizedTargetDate || null;
  let state = "confirmed";

  if (!normalizedTargetDate) {
    state = normalizedConfirmedNavDate ? "confirmed" : "source_missing";
  } else if (profile.profile === "hk_fund") {
    const latestTradingDate = findLatestTradingDateOnOrBefore({
      market: profile.market,
      date: normalizedTargetDate
    });
    expectedConfirmedDate = latestTradingDate ?? normalizedTargetDate;

    if (!normalizedConfirmedNavDate) {
      state = "source_missing";
    } else if (normalizedConfirmedNavDate === normalizedTargetDate) {
      state = "confirmed";
    } else if (
      normalizedConfirmedNavDate === expectedConfirmedDate &&
      expectedConfirmedDate !== normalizedTargetDate
    ) {
      state = "holiday_delay";
    } else if (normalizedConfirmedNavDate < expectedConfirmedDate) {
      state = "late_missing";
    } else {
      state = "confirmed";
    }
  } else if (profile.profile === "global_qdii") {
    expectedConfirmedDate = findPreviousTradingDateBefore({
      market: profile.market,
      date: normalizedTargetDate
    });

    if (!normalizedConfirmedNavDate) {
      state = "source_missing";
    } else if (normalizedConfirmedNavDate === normalizedTargetDate) {
      state = "confirmed";
    } else if (expectedConfirmedDate && normalizedConfirmedNavDate === expectedConfirmedDate) {
      state = "normal_lag";
    } else if (expectedConfirmedDate && normalizedConfirmedNavDate < expectedConfirmedDate) {
      state = "late_missing";
    } else {
      state = "confirmed";
    }
  } else {
    expectedConfirmedDate = normalizedTargetDate;
    if (!normalizedConfirmedNavDate) {
      state = "source_missing";
    } else if (normalizedConfirmedNavDate === normalizedTargetDate) {
      state = "confirmed";
    } else {
      state = "late_missing";
    }
  }

  return {
    state,
    label: buildLabel(state, normalizedConfirmedNavDate, expectedConfirmedDate),
    confirmedNavDate: normalizedConfirmedNavDate,
    expectedConfirmedDate,
    profile: profile.profile,
    market: profile.market,
    targetDate: normalizedTargetDate,
    isWithinExpectedWindow: ["confirmed", "normal_lag", "holiday_delay"].includes(state),
    usesHolidayShift:
      state === "holiday_delay" &&
      normalizedTargetDate &&
      !isTradingDateForMarket({ market: profile.market, date: normalizedTargetDate })
  };
}

export function summarizeFundConfirmationStates(rows = []) {
  const totalFundCount = rows.length;
  const counts = {
    confirmedFundCount: 0,
    normalLagFundCount: 0,
    holidayDelayFundCount: 0,
    lateMissingFundCount: 0,
    sourceMissingFundCount: 0
  };

  for (const row of rows) {
    const state = normalizeText(row?.confirmationState);
    if (state === "confirmed") {
      counts.confirmedFundCount += 1;
    } else if (state === "normal_lag") {
      counts.normalLagFundCount += 1;
    } else if (state === "holiday_delay") {
      counts.holidayDelayFundCount += 1;
    } else if (state === "late_missing") {
      counts.lateMissingFundCount += 1;
    } else if (state === "source_missing") {
      counts.sourceMissingFundCount += 1;
    }
  }

  const coveredFundCount =
    counts.confirmedFundCount + counts.normalLagFundCount + counts.holidayDelayFundCount;

  return {
    totalFundCount,
    ...counts,
    confirmationCoveragePct:
      totalFundCount > 0 ? round((coveredFundCount / totalFundCount) * 100) : null
  };
}
