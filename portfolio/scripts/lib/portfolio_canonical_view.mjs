function normalizeSourceKind(kind) {
  const normalized = String(kind ?? "").trim();
  return normalized || "missing";
}

function normalizePayload(payload) {
  return payload && typeof payload === "object" ? payload : {};
}

export function selectCanonicalPortfolioPayload({
  latestView = {},
  latestCompat = null
} = {}) {
  const sourceKind = normalizeSourceKind(latestView?.sourceKind);
  const latestViewPayload = normalizePayload(latestView?.payload);
  const latestCompatPayload = normalizePayload(latestCompat);

  if (sourceKind === "portfolio_state" && Object.keys(latestViewPayload).length > 0) {
    return {
      payload: latestViewPayload,
      sourceKind: "portfolio_state",
      sourcePath: latestView?.sourcePath ?? null
    };
  }

  if (Object.keys(latestCompatPayload).length > 0) {
    return {
      payload: latestCompatPayload,
      sourceKind: "latest_compat",
      sourcePath: latestView?.paths?.latestCompatPath ?? latestView?.sourcePath ?? null
    };
  }

  return {
    payload: latestViewPayload,
    sourceKind,
    sourcePath: latestView?.sourcePath ?? null
  };
}

export function buildCanonicalPortfolioView({
  payload = {},
  sourceKind = "missing",
  sourcePath = null,
  latestCompatSnapshotDate = null
} = {}) {
  const normalizedPayload = normalizePayload(payload);
  const snapshotDate = String(normalizedPayload?.snapshot_date ?? "").trim() || null;
  const strategyEffectiveDate =
    String(normalizedPayload?.strategy_effective_date ?? "").trim() || snapshotDate;
  const generatedAt =
    String(normalizedPayload?.generated_at ?? normalizedPayload?.updated_at ?? "").trim() || null;
  const compatibilitySnapshotDate =
    String(latestCompatSnapshotDate ?? "").trim() || null;
  const normalizedSourceKind = normalizeSourceKind(sourceKind);

  return {
    ...normalizedPayload,
    canonical_source: {
      kind: normalizedSourceKind,
      path: sourcePath ?? null
    },
    compatibility_mode:
      normalizedSourceKind === "portfolio_state" ? "portfolio_state_primary" : "latest_compat_fallback",
    time_semantics: {
      snapshot_date: snapshotDate,
      strategy_effective_date: strategyEffectiveDate,
      generated_at: generatedAt,
      compatibility_snapshot_date: compatibilitySnapshotDate
    }
  };
}
