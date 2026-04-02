function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeScore(value) {
  return Math.max(0, Math.min(3, Math.round(asNumber(value, 0))));
}

function normalizePenalty(value) {
  return Math.max(0, Math.round(asNumber(value, 0)));
}

export function classifyActionBias({
  expected_vs_actual_score = 0,
  technical_score = 0,
  funding_flow_score = 0,
  risk_penalty = 0
} = {}) {
  const total =
    normalizeScore(expected_vs_actual_score) +
    normalizeScore(technical_score) +
    normalizeScore(funding_flow_score) -
    normalizePenalty(risk_penalty);

  if (total >= 6) {
    return "允许确认仓";
  }
  if (total >= 4) {
    return "允许试单";
  }
  if (total >= 2) {
    return "研究观察";
  }
  return "不做";
}

export function buildOpportunityCandidate(theme = {}, inputs = {}) {
  const expectedVsActualScore = normalizeScore(inputs.expected_vs_actual_score);
  const technicalScore = normalizeScore(inputs.technical_score);
  const fundingFlowScore = normalizeScore(inputs.funding_flow_score);
  const riskPenalty = normalizePenalty(inputs.risk_penalty);
  const totalScore = expectedVsActualScore + technicalScore + fundingFlowScore - riskPenalty;

  return {
    theme_name: String(theme.theme_name ?? "").trim(),
    market: String(theme.market ?? "").trim(),
    driver: String(theme.driver ?? "").trim(),
    expected_vs_actual: String(inputs.expected_vs_actual ?? "").trim(),
    technical_state: String(inputs.technical_state ?? "").trim(),
    funding_flow_state: String(inputs.funding_flow_state ?? "").trim(),
    risk_note: String(theme.risk_note ?? "").trim(),
    tradable_proxies: Array.isArray(theme.tradable_proxies) ? theme.tradable_proxies : [],
    action_bias: classifyActionBias({
      expected_vs_actual_score: expectedVsActualScore,
      technical_score: technicalScore,
      funding_flow_score: fundingFlowScore,
      risk_penalty: riskPenalty
    }),
    total_score: totalScore
  };
}

export function rankOpportunityCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    const totalDiff = asNumber(right.total_score) - asNumber(left.total_score);
    if (totalDiff !== 0) {
      return totalDiff;
    }

    return String(left.theme_name ?? "").localeCompare(String(right.theme_name ?? ""));
  });
}
