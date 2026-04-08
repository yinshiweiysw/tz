function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function valuesAlmostEqual(left, right, epsilon = 1e-8) {
  if (left === null || right === null || left === undefined || right === undefined) {
    return false;
  }
  return Math.abs(Number(left) - Number(right)) <= epsilon;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}

function pickEstimateCandidate(secondaryEstimate, legacyQuote, primaryQuote) {
  const candidates = [
    secondaryEstimate
      ? {
          source: normalizeText(secondaryEstimate?.source) || "secondary",
          valuation:
            toNullableNumber(
              secondaryEstimate?.intradayValuation ?? secondaryEstimate?.valuation ?? secondaryEstimate?.value
            ),
          valuationChangePercent:
            toNullableNumber(
              secondaryEstimate?.intradayChangePercent ??
                secondaryEstimate?.valuationChangePercent ??
                secondaryEstimate?.changePercent
            ),
          valuationTime: pickFirst(
            secondaryEstimate?.intradayValuationTime,
            secondaryEstimate?.valuationTime,
            secondaryEstimate?.quoteTime
          )
        }
      : null,
    legacyQuote
      ? {
          source: "legacy",
          valuation: toNullableNumber(legacyQuote?.valuation),
          valuationChangePercent: toNullableNumber(legacyQuote?.valuationChangePercent),
          valuationTime: pickFirst(legacyQuote?.valuationTime)
        }
      : null,
    primaryQuote
      ? {
          source: "primary",
          valuation: toNullableNumber(primaryQuote?.valuation),
          valuationChangePercent: toNullableNumber(primaryQuote?.valuationChangePercent),
          valuationTime: pickFirst(primaryQuote?.valuationTime)
        }
      : null
  ].filter(Boolean);

  return candidates.find((candidate) => candidate.valuation !== null) ?? null;
}

function isIndexLikeName(name) {
  return /ETF联接|指数|沪深300|中证|国证|恒生|H股|纳指|纳斯达克|标普|日经|罗素|创业板|科创|红利|黄金ETF/i.test(
    normalizeText(name)
  );
}

export function inferFundTypeHint({ name = null } = {}) {
  const text = normalizeText(name);
  if (!text) {
    return "unknown";
  }
  if (/债|货币|短债|中短债|理财|现金/i.test(text)) {
    return "bond_like";
  }
  if (isIndexLikeName(text)) {
    return "index_like";
  }
  return "active_like";
}

function isMirroredConfirmedNavEstimate({ fundTypeHint, candidate, confirmedNav }) {
  if (fundTypeHint !== "index_like") {
    return false;
  }
  if (!candidate || candidate.valuation === null || !normalizeText(candidate.valuationTime)) {
    return false;
  }

  return (
    valuesAlmostEqual(candidate.valuation, confirmedNav) &&
    (candidate.valuationChangePercent === null ||
      valuesAlmostEqual(candidate.valuationChangePercent, 0))
  );
}

export function classifyFundObservation({
  name = null,
  primaryQuote = null,
  legacyQuote = null,
  historyQuote = null,
  secondaryEstimate = null
} = {}) {
  const fundTypeHint = inferFundTypeHint({ name });
  const confirmedNavDate = pickFirst(
    primaryQuote?.netValueDate,
    legacyQuote?.netValueDate,
    historyQuote?.netValueDate
  );
  const confirmedNav = pickFirst(
    toNullableNumber(primaryQuote?.netValue),
    toNullableNumber(legacyQuote?.netValue),
    toNullableNumber(historyQuote?.netValue)
  );
  const confirmedChangePercent = toNullableNumber(primaryQuote?.growthRate);
  const candidate = pickEstimateCandidate(secondaryEstimate, legacyQuote, primaryQuote);
  const mirroredConfirmedNav = isMirroredConfirmedNavEstimate({
    fundTypeHint,
    candidate,
    confirmedNav
  });
  const useIntradayEstimate = Boolean(candidate && !mirroredConfirmedNav);

  return {
    fundTypeHint,
    observationKind: useIntradayEstimate ? "intraday_estimate" : "confirmed_only",
    confirmedNavDate: confirmedNavDate ?? null,
    confirmedNav: confirmedNav ?? null,
    confirmedChangePercent: confirmedChangePercent ?? null,
    intradayValuation: useIntradayEstimate ? candidate?.valuation ?? null : null,
    intradayChangePercent: useIntradayEstimate ? candidate?.valuationChangePercent ?? null : null,
    intradayValuationTime: useIntradayEstimate ? candidate?.valuationTime ?? null : null,
    intradaySource: useIntradayEstimate ? candidate?.source ?? null : null,
    compatibility: {
      valuation: useIntradayEstimate ? candidate?.valuation ?? null : null,
      valuationChangePercent: useIntradayEstimate ? candidate?.valuationChangePercent ?? null : null,
      valuationTime: useIntradayEstimate ? candidate?.valuationTime ?? null : null
    },
    sourceDiagnostics: {
      primary: {
        available: Boolean(primaryQuote),
        hasEstimate: toNullableNumber(primaryQuote?.valuation) !== null
      },
      legacy: {
        available: Boolean(legacyQuote),
        hasEstimate: toNullableNumber(legacyQuote?.valuation) !== null,
        isMirroredConfirmedNav: mirroredConfirmedNav
      },
      secondary: {
        available: Boolean(secondaryEstimate),
        trusted: Boolean(secondaryEstimate && useIntradayEstimate && candidate?.source !== "legacy" && candidate?.source !== "primary"),
        source: normalizeText(secondaryEstimate?.source) || null
      }
    }
  };
}
