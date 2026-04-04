function hasStaleTradingDependencies(staleDependencies) {
  return staleDependencies.some((dependency) => dependency?.required !== false);
}

function hasMissingRequiredDependencies(missingDependencies) {
  return missingDependencies.length > 0;
}

function hasCriticalCoverageFailure(coverageGuard) {
  if (coverageGuard?.overall_status === "critical") {
    return true;
  }

  const missingDomains = Array.isArray(coverageGuard?.missing_domains)
    ? coverageGuard.missing_domains
    : [];

  return missingDomains.includes("portfolio_state") || missingDomains.includes("risk_state");
}

function hasDegradedCoverage(coverageGuard) {
  if (coverageGuard?.overall_status === "degraded") {
    return true;
  }

  return Array.isArray(coverageGuard?.weak_domains) && coverageGuard.weak_domains.length > 0;
}

function collectTradabilityIssues(marketDataQuality = {}) {
  const sections =
    marketDataQuality?.sections && typeof marketDataQuality.sections === "object"
      ? marketDataQuality.sections
      : {};
  const criticalKeys = new Set(["a_share_quotes", "hong_kong_quotes", "global_risk_quotes"]);
  const blockedKeys = [];
  const observeOnlyKeys = [];
  const criticalBlockedKeys = [];

  for (const [key, section] of Object.entries(sections)) {
    const tradability = String(section?.tradability_relevance ?? "").trim();
    if (tradability === "blocked") {
      blockedKeys.push(key);
      if (criticalKeys.has(key)) {
        criticalBlockedKeys.push(key);
      }
    } else if (tradability === "observe_only") {
      observeOnlyKeys.push(key);
    }
  }

  return {
    blockedKeys,
    observeOnlyKeys,
    criticalBlockedKeys
  };
}

export function deriveResearchDecisionReadiness({
  sessionInfo = {},
  freshnessGuard = {},
  coverageGuard = {},
  marketDataQuality = {}
} = {}) {
  const staleDependencies = Array.isArray(freshnessGuard.stale_dependencies)
    ? freshnessGuard.stale_dependencies
    : [];
  const missingDependencies = Array.isArray(freshnessGuard.missing_dependencies)
    ? freshnessGuard.missing_dependencies
    : [];
  const sessionConstraints = Array.isArray(sessionInfo.session_constraints)
    ? sessionInfo.session_constraints
    : [];
  const tradabilityIssues = collectTradabilityIssues(marketDataQuality);

  let level = "ready";
  let analysisAllowed = true;
  let tradingAllowed = true;
  let reasons = [];

  if (hasCriticalCoverageFailure(coverageGuard)) {
    level = "research_invalid";
    analysisAllowed = false;
    tradingAllowed = false;
    reasons = ["critical_coverage_failure"];
  } else if (hasMissingRequiredDependencies(missingDependencies)) {
    level = "trading_blocked";
    analysisAllowed = true;
    tradingAllowed = false;
    reasons = ["missing_required_dependencies"];
  } else if (hasStaleTradingDependencies(staleDependencies)) {
    level = "trading_blocked";
    analysisAllowed = true;
    tradingAllowed = false;
    reasons = ["stale_trading_dependencies"];
  } else if (tradabilityIssues.criticalBlockedKeys.length > 0) {
    level = "trading_blocked";
    analysisAllowed = true;
    tradingAllowed = false;
    reasons = ["critical_tradability_sections_blocked"];
  } else if (
    tradabilityIssues.blockedKeys.length > 0 ||
    tradabilityIssues.observeOnlyKeys.length > 0
  ) {
    level = "analysis_degraded";
    analysisAllowed = true;
    tradingAllowed = false;
    reasons = ["tradability_sections_blocked"];
  } else if (hasDegradedCoverage(coverageGuard)) {
    level = "analysis_degraded";
    analysisAllowed = true;
    tradingAllowed = false;
    reasons = ["coverage_degraded"];
  }

  return {
    level,
    analysis_allowed: analysisAllowed,
    trading_allowed: tradingAllowed,
    reasons,
    stale_dependencies: staleDependencies,
    missing_dependencies: missingDependencies,
    session_constraints: sessionConstraints,
    blocked_tradability_sections: tradabilityIssues.blockedKeys,
    observe_only_sections: tradabilityIssues.observeOnlyKeys
  };
}
