function compareDateStrings(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function sortTradeDates(days = {}) {
  return Object.keys(days)
    .filter(Boolean)
    .sort(compareDateStrings);
}

function evaluateValidation(referenceRecord, targetRecord) {
  if (!referenceRecord || !targetRecord) {
    return {
      status: "pending",
      note: "链路尚未完整生成。"
    };
  }

  if (
    referenceRecord.primary_driver === targetRecord.primary_driver &&
    referenceRecord.liquidity_regime === targetRecord.liquidity_regime
  ) {
    return {
      status: "hit",
      note: "主线与流动性状态保持一致。"
    };
  }

  if (referenceRecord.primary_driver === targetRecord.primary_driver) {
    return {
      status: "partial",
      note: "主线一致，但流动性或动作梯度发生变化。"
    };
  }

  return {
    status: "miss",
    note: "盘后主线已偏离盘前假设。"
  };
}

function evaluateNextDayBias(closeRecord, nextMorningRecord) {
  if (!closeRecord) {
    return {
      status: "pending",
      note: "缺少收盘偏置记录。"
    };
  }

  if (!nextMorningRecord) {
    return {
      status: "pending",
      note: "尚无下一交易日早盘记录。"
    };
  }

  const bias = String(closeRecord.next_bias ?? "").trim();
  const nextPermission = String(nextMorningRecord.trade_permission ?? "").trim();
  const nextDriver = String(nextMorningRecord.primary_driver ?? "").trim();
  const closeDriver = String(closeRecord.primary_driver ?? "").trim();

  const isHit =
    (bias === "blocked" && nextPermission === "blocked") ||
    (bias === "prepare" && nextPermission === "allowed") ||
    (bias === "observe" && nextPermission !== "allowed");

  return {
    status: isHit ? "hit" : "miss",
    note: isHit
      ? `次日早盘动作口径与偏置一致（${bias} -> ${nextPermission}）。`
      : `次日早盘动作口径未兑现收盘偏置（${bias} -> ${nextPermission}，主线 ${closeDriver || "--"} -> ${nextDriver || "--"}）。`
  };
}

function computeMetricSummary(records, selector) {
  const statuses = records
    .map(selector)
    .map((entry) => entry?.status ?? "pending");
  const settled = statuses.filter((status) => status !== "pending");
  const hitCount = settled.filter((status) => status === "hit").length;
  const partialCount = settled.filter((status) => status === "partial").length;

  return {
    settled_count: settled.length,
    hit_count: hitCount,
    partial_count: partialCount,
    miss_count: settled.filter((status) => status === "miss").length,
    hit_rate_pct:
      settled.length > 0 ? Number(((hitCount / settled.length) * 100).toFixed(2)) : null,
    effective_hit_rate_pct:
      settled.length > 0
        ? Number((((hitCount + partialCount * 0.5) / settled.length) * 100).toFixed(2))
        : null
  };
}

export function buildReportQualityScorecard(memory = {}, options = {}) {
  const asOfDate = String(options?.asOfDate ?? "").trim() || null;
  const windowSize = Math.max(1, Number(options?.windowSize) || 20);
  const days = memory?.days && typeof memory.days === "object" ? memory.days : {};
  const sortedDates = sortTradeDates(days);
  const boundedDates = (asOfDate
    ? sortedDates.filter((tradeDate) => compareDateStrings(tradeDate, asOfDate) <= 0)
    : sortedDates
  ).slice(-windowSize);

  const dailyRecords = boundedDates.map((tradeDate, index) => {
    const currentDay = days[tradeDate] ?? {};
    const nextTradeDate = boundedDates[index + 1] ?? null;
    const nextMorning = nextTradeDate ? days[nextTradeDate]?.morning ?? null : null;

    return {
      trade_date: tradeDate,
      primary_driver: currentDay?.morning?.primary_driver ?? currentDay?.close?.primary_driver ?? null,
      morning_to_noon: evaluateValidation(currentDay?.morning ?? null, currentDay?.noon ?? null),
      morning_to_close: evaluateValidation(currentDay?.morning ?? null, currentDay?.close ?? null),
      next_day_bias: evaluateNextDayBias(currentDay?.close ?? null, nextMorning),
      snapshots: {
        morning: currentDay?.morning ?? null,
        noon: currentDay?.noon ?? null,
        close: currentDay?.close ?? null
      }
    };
  });

  return {
    generated_at: new Date().toISOString(),
    as_of_date: asOfDate,
    window_size: windowSize,
    record_count: dailyRecords.length,
    daily_records: dailyRecords,
    rolling_summary: {
      morning_to_noon: computeMetricSummary(dailyRecords, (record) => record.morning_to_noon),
      morning_to_close: computeMetricSummary(dailyRecords, (record) => record.morning_to_close),
      next_day_bias: computeMetricSummary(dailyRecords, (record) => record.next_day_bias)
    }
  };
}

export function buildAnalysisHitRateSummary(scorecard = {}) {
  const summary = scorecard?.rolling_summary ?? {};
  return {
    as_of_date: scorecard?.as_of_date ?? null,
    window_size: scorecard?.window_size ?? null,
    morning_to_noon: summary.morning_to_noon ?? computeMetricSummary([], () => null),
    morning_to_close: summary.morning_to_close ?? computeMetricSummary([], () => null),
    next_day_bias: summary.next_day_bias ?? computeMetricSummary([], () => null)
  };
}
