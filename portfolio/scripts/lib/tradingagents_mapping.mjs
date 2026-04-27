const RATING_SCORE = {
  SELL: -2,
  UNDERWEIGHT: -1,
  HOLD: 0,
  OVERWEIGHT: 1,
  BUY: 2
};

const SCORE_RATING = [
  { score: -2, rating: "SELL" },
  { score: -1, rating: "UNDERWEIGHT" },
  { score: 0, rating: "HOLD" },
  { score: 1, rating: "OVERWEIGHT" },
  { score: 2, rating: "BUY" }
];

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampConfidence(value, fallback = 0.5) {
  const numeric = toFiniteNumber(value);
  const resolved = numeric === null ? fallback : numeric;
  return Math.max(0, Math.min(1, resolved));
}

export function normalizeTradingAgentsRating(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(RATING_SCORE, normalized) ? normalized : null;
}

export function scoreTradingAgentsRating(value) {
  const normalized = normalizeTradingAgentsRating(value);
  return normalized ? RATING_SCORE[normalized] : null;
}

export function resolveRatingFromScore(score) {
  const numeric = toFiniteNumber(score);
  if (numeric === null) {
    return "HOLD";
  }

  let nearest = SCORE_RATING[0];
  for (const candidate of SCORE_RATING) {
    if (Math.abs(candidate.score - numeric) < Math.abs(nearest.score - numeric)) {
      nearest = candidate;
    }
  }
  return nearest.rating;
}

export function translateTradingAgentsRating(rating, ratingMap = {}) {
  const normalized = normalizeTradingAgentsRating(rating) ?? "HOLD";
  return String(ratingMap?.[normalized] ?? normalized).trim() || normalized;
}

export function buildBucketProxyLookup(bucketProxyUniverse = {}) {
  const lookup = new Map();
  for (const [bucket, symbols] of Object.entries(bucketProxyUniverse ?? {})) {
    for (const symbol of Array.isArray(symbols) ? symbols : []) {
      const normalized = String(symbol ?? "").trim().toUpperCase();
      if (normalized) {
        lookup.set(normalized, bucket);
      }
    }
  }
  return lookup;
}

function resolveCallConfidence(call = {}, rating, ratingConfidenceDefaults = {}) {
  const explicit = toFiniteNumber(call?.confidence);
  const source = String(call?.confidenceSource ?? "").trim();
  const defaultConfidence = clampConfidence(ratingConfidenceDefaults?.[rating], 0.5);

  if (source === "model") {
    return {
      confidence: clampConfidence(explicit, defaultConfidence),
      confidenceSource: "model"
    };
  }

  if (source === "tradingagents_rating_default") {
    return {
      confidence: defaultConfidence,
      confidenceSource: "rating_default"
    };
  }

  if (explicit === null) {
    return {
      confidence: defaultConfidence,
      confidenceSource: "rating_default"
    };
  }

  if (explicit === 0.5 && defaultConfidence !== 0.5) {
    return {
      confidence: defaultConfidence,
      confidenceSource: "rating_default"
    };
  }

  return {
    confidence: clampConfidence(explicit, defaultConfidence),
    confidenceSource: source || "explicit"
  };
}

export function aggregateTradingAgentsCallsByBucket(
  calls = [],
  { bucketProxyUniverse = {}, phase1Buckets = [], ratingConfidenceDefaults = {} } = {}
) {
  const bucketLookup = buildBucketProxyLookup(bucketProxyUniverse);
  const activeBuckets = new Set((Array.isArray(phase1Buckets) ? phase1Buckets : []).map((item) => String(item ?? "").trim()));
  const groups = new Map();
  const blocked = [];

  for (const call of Array.isArray(calls) ? calls : []) {
    const symbol = String(call?.symbol ?? "").trim().toUpperCase();
    const bucket = bucketLookup.get(symbol) ?? null;
    const rating = normalizeTradingAgentsRating(call?.rating);
    const score = scoreTradingAgentsRating(rating);

    if (!bucket) {
      blocked.push({
        symbol,
        reason: "proxy_symbol_unmapped"
      });
      continue;
    }

    if (!activeBuckets.has(bucket)) {
      blocked.push({
        symbol,
        bucket,
        reason: "bucket_not_enabled"
      });
      continue;
    }

    if (!rating || score === null) {
      blocked.push({
        symbol,
        bucket,
        reason: "rating_unreadable"
      });
      continue;
    }

    const { confidence, confidenceSource } = resolveCallConfidence(call, rating, ratingConfidenceDefaults);
    const current = groups.get(bucket) ?? {
      bucket,
      calls: [],
      weightedScoreSum: 0,
      weightSum: 0,
      confidenceSum: 0,
      confidenceSources: new Set(),
      proxySymbols: new Set(),
      theses: [],
      risks: [],
      riskJudges: [],
      investmentJudges: []
    };

    current.calls.push({
      symbol,
      rating,
      confidence,
      confidenceSource,
      thesis: String(call?.thesis ?? "").trim(),
      risks: Array.isArray(call?.risks) ? call.risks.map((item) => String(item ?? "").trim()).filter(Boolean) : [],
      riskJudge: String(call?.riskJudge ?? "").trim(),
      investmentJudge: String(call?.investmentJudge ?? "").trim(),
      decisionText: String(call?.decisionText ?? "").trim(),
      marketReport: String(call?.marketReport ?? "").trim(),
      newsReport: String(call?.newsReport ?? "").trim(),
      fundamentalsReport: String(call?.fundamentalsReport ?? "").trim(),
      sentimentReport: String(call?.sentimentReport ?? "").trim()
    });
    current.weightedScoreSum += score * confidence;
    current.weightSum += confidence;
    current.confidenceSum += confidence;
    current.confidenceSources.add(confidenceSource);
    current.proxySymbols.add(symbol);
    if (String(call?.thesis ?? "").trim()) {
      current.theses.push(String(call.thesis).trim());
    }
    if (String(call?.riskJudge ?? "").trim()) {
      current.riskJudges.push(String(call.riskJudge).trim());
    }
    if (String(call?.investmentJudge ?? "").trim()) {
      current.investmentJudges.push(String(call.investmentJudge).trim());
    }
    current.risks.push(
      ...(Array.isArray(call?.risks) ? call.risks.map((item) => String(item ?? "").trim()).filter(Boolean) : [])
    );
    groups.set(bucket, current);
  }

  const bucketSuggestions = [...groups.values()].map((group) => {
    const averageScore = group.weightSum > 0 ? group.weightedScoreSum / group.weightSum : 0;
    const rating = resolveRatingFromScore(averageScore);
    const confidence = group.calls.length > 0 ? Number((group.confidenceSum / group.calls.length).toFixed(2)) : 0.5;
    const theses = [...new Set(group.theses)].slice(0, 2);
    const risks = [...new Set(group.risks)].slice(0, 3);
    const confidenceSources = [...group.confidenceSources].filter(Boolean);

    return {
      bucket: group.bucket,
      rating,
      confidence,
      confidenceSource: confidenceSources.length === 1 ? confidenceSources[0] : confidenceSources.join("+") || null,
      proxySymbols: [...group.proxySymbols],
      reasonSummary: theses.join("；") || "暂无明确论据",
      risks,
      riskJudge: [...new Set(group.riskJudges)].slice(0, 2).join("；") || null,
      investmentJudge: [...new Set(group.investmentJudges)].slice(0, 2).join("；") || null,
      signalCount: group.calls.length,
      rawCalls: group.calls
    };
  });

  return {
    bucketSuggestions,
    blockedCalls: blocked
  };
}

export function mapBucketSuggestionsToFunds(bucketSuggestions = [], assetMaster = {}, { ratingMap = {} } = {}) {
  const assets = Array.isArray(assetMaster?.assets) ? assetMaster.assets : [];
  const suggestions = [];
  const blockedSuggestions = [];

  for (const bucketSuggestion of Array.isArray(bucketSuggestions) ? bucketSuggestions : []) {
    const bucketAssets = assets.filter((asset) => String(asset?.bucket ?? "").trim() === bucketSuggestion.bucket);
    if (bucketAssets.length === 0) {
      blockedSuggestions.push({
        bucket: bucketSuggestion.bucket,
        reason: "bucket_has_no_fund_mapping"
      });
      continue;
    }

    for (const asset of bucketAssets) {
      suggestions.push({
        fundCode: String(asset?.symbol ?? "").trim(),
        fundName: String(asset?.name ?? "").trim() || String(asset?.symbol ?? "").trim(),
        bucket: bucketSuggestion.bucket,
        verdict: translateTradingAgentsRating(bucketSuggestion.rating, ratingMap),
        rating: bucketSuggestion.rating,
        confidence: bucketSuggestion.confidence,
        confidenceSource: bucketSuggestion.confidenceSource,
        reasonSummary: bucketSuggestion.reasonSummary,
        proxySymbols: bucketSuggestion.proxySymbols,
        status: "advisory_only"
      });
    }
  }

  return {
    fundSuggestions: suggestions,
    blockedSuggestions
  };
}
