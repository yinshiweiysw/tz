function parseTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeTradingAdviceFreshness(rawSnapshot = {}, { now = new Date(), staleAfterHours = 36 } = {}) {
  const referenceMs = parseTimestamp(rawSnapshot?.generatedAt) ?? parseTimestamp(rawSnapshot?.asOf);
  if (referenceMs === null) {
    return {
      freshnessLabel: "unknown",
      isStale: false,
      ageHours: null,
      asOf: String(rawSnapshot?.asOf ?? "").trim() || null
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now ?? ""));
  const ageHours = Number.isFinite(nowMs) ? Number(((nowMs - referenceMs) / 3_600_000).toFixed(2)) : null;
  const isStale = ageHours !== null && ageHours > Number(staleAfterHours ?? 36);

  return {
    freshnessLabel: isStale ? "stale" : "fresh",
    isStale,
    ageHours,
    asOf: String(rawSnapshot?.asOf ?? rawSnapshot?.generatedAt ?? "").trim() || null
  };
}

export function applyTradingAdviceGuardrails(
  rawSnapshot = {},
  { bucketSuggestions = [], fundSuggestions = [], blockedSuggestions = [], now = new Date(), staleAfterHours = 36 } = {}
) {
  const freshness = computeTradingAdviceFreshness(rawSnapshot, {
    now,
    staleAfterHours
  });

  const topLevelStatus = freshness.isStale
    ? "stale"
    : bucketSuggestions.length === 0 && fundSuggestions.length === 0
      ? "blocked"
      : "advisory_only";

  const decorate = (item) => ({
    ...item,
    guardrailStatus: freshness.isStale ? "stale" : "advisory_only"
  });

  return {
    status: topLevelStatus,
    freshness,
    bucketSuggestions: bucketSuggestions.map(decorate),
    fundSuggestions: fundSuggestions.map(decorate),
    blockedSuggestions: blockedSuggestions.map((item) => ({
      ...item,
      guardrailStatus: "blocked"
    }))
  };
}
