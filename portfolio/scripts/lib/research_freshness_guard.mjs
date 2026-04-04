const STATUS = {
  OK: "ok",
  STALE: "stale",
  MISSING: "missing",
  OPTIONAL_MISSING: "optional_missing"
};

function toLagHours(now, effectiveTimestamp) {
  if (effectiveTimestamp === null || effectiveTimestamp === undefined) {
    return null;
  }

  const effectiveTime = new Date(effectiveTimestamp);
  if (Number.isNaN(effectiveTime.getTime())) {
    return null;
  }

  const lagHours = (now.getTime() - effectiveTime.getTime()) / (1000 * 60 * 60);
  return Number(lagHours.toFixed(6));
}

function parseEffectiveTimestamp(rawTimestamp) {
  if (rawTimestamp === undefined || rawTimestamp === null) {
    return { effectiveTimestamp: null, hasValue: false, isValid: false };
  }

  if (typeof rawTimestamp === "string" && rawTimestamp.trim() === "") {
    return { effectiveTimestamp: null, hasValue: true, isValid: false };
  }

  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return { effectiveTimestamp: rawTimestamp, hasValue: true, isValid: false };
  }

  return { effectiveTimestamp: rawTimestamp, hasValue: true, isValid: true };
}

function normalizeDependency(now, sessionInfo, dependency) {
  const required = dependency.required !== false;
  const timestampState = parseEffectiveTimestamp(dependency.effective_timestamp);
  const effectiveTimestamp = timestampState.effectiveTimestamp;
  const lagHours = timestampState.isValid ? toLagHours(now, effectiveTimestamp) : null;
  const policy = sessionInfo?.policy ?? {};
  const tradeDate = sessionInfo?.tradeDate ?? null;

  let status = STATUS.OK;
  let reason = "fresh";

  if (timestampState.hasValue && !timestampState.isValid) {
    status = required ? STATUS.MISSING : STATUS.OPTIONAL_MISSING;
    reason = "invalid_timestamp";
  } else if (!timestampState.hasValue) {
    status = required ? STATUS.MISSING : STATUS.OPTIONAL_MISSING;
    reason = required ? "missing_required" : "missing_optional";
  } else if (
    policy.domesticTradeDateMustMatch &&
    dependency.trade_date &&
    tradeDate &&
    dependency.trade_date !== tradeDate
  ) {
    status = STATUS.STALE;
    reason = "trade_date_mismatch";
  } else if (
    Number.isFinite(dependency.max_lag_hours) &&
    Number.isFinite(lagHours) &&
    lagHours > dependency.max_lag_hours
  ) {
    status = STATUS.STALE;
    reason = "lag_exceeded";
  }

  return {
    key: dependency.key,
    label: dependency.label,
    status,
    effective_timestamp: effectiveTimestamp,
    lag_hours: lagHours,
    required,
    reason
  };
}

export function buildResearchFreshnessGuard({
  now = new Date(),
  sessionInfo,
  dependencies = []
} = {}) {
  const normalizedDependencies = dependencies.map((dependency) =>
    normalizeDependency(now, sessionInfo, dependency)
  );
  const staleDependencies = normalizedDependencies.filter(
    (dependency) => dependency.status === STATUS.STALE
  );
  const missingDependencies = normalizedDependencies.filter(
    (dependency) => dependency.status === STATUS.MISSING
  );

  const overallStatus = missingDependencies.length
    ? STATUS.MISSING
    : staleDependencies.length
      ? STATUS.STALE
      : STATUS.OK;

  return {
    overall_status: overallStatus,
    dependencies: normalizedDependencies,
    stale_dependencies: staleDependencies,
    missing_dependencies: missingDependencies
  };
}
