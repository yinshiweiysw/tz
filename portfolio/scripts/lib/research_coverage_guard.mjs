const REQUIRED_DOMAINS = [
  "a_share",
  "hong_kong",
  "global_risk",
  "macro_anchors",
  "portfolio_state",
  "risk_state"
];

function evaluateMarketDomain(domainSnapshot) {
  const rows = Array.isArray(domainSnapshot?.rows) ? domainSnapshot.rows : [];
  if (rows.length === 0) {
    return "missing";
  }

  const hasOk = rows.some((row) => row?.fetch_status === "ok");
  if (!hasOk) {
    return "missing";
  }

  const allOk = rows.every((row) => row?.fetch_status === "ok");
  return allOk ? "ok" : "weak";
}

function evaluateResearchDomain(domainSnapshot) {
  return domainSnapshot?.fetch_status === "ok" ? "ok" : "missing";
}

export function buildResearchCoverageGuard({
  marketSnapshot = {},
  researchSnapshot = {}
} = {}) {
  const domains = {
    a_share: { status: evaluateMarketDomain(marketSnapshot.a_share) },
    hong_kong: { status: evaluateMarketDomain(marketSnapshot.hong_kong) },
    global_risk: { status: evaluateMarketDomain(marketSnapshot.global_risk) },
    macro_anchors: { status: evaluateMarketDomain(marketSnapshot.macro_anchors) },
    portfolio_state: { status: evaluateResearchDomain(researchSnapshot.portfolio_state) },
    risk_state: { status: evaluateResearchDomain(researchSnapshot.risk_state) }
  };

  const missingDomains = REQUIRED_DOMAINS.filter(
    (domainKey) => domains[domainKey].status === "missing"
  );
  const weakDomains = REQUIRED_DOMAINS.filter(
    (domainKey) => domains[domainKey].status === "weak"
  );

  const hasCriticalGap =
    domains.portfolio_state.status === "missing" || domains.risk_state.status === "missing";
  const hasAnyGap = missingDomains.length > 0 || weakDomains.length > 0;

  const overallStatus = hasCriticalGap ? "critical" : hasAnyGap ? "degraded" : "ok";

  return {
    overall_status: overallStatus,
    domains,
    missing_domains: missingDomains,
    weak_domains: weakDomains
  };
}
