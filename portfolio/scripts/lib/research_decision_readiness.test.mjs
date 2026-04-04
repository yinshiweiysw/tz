import test from "node:test";
import assert from "node:assert/strict";

import { deriveResearchDecisionReadiness } from "./research_decision_readiness.mjs";

test("ready when freshness and coverage are clean", () => {
  const result = deriveResearchDecisionReadiness({
    sessionInfo: {
      session_constraints: [{ key: "cn_session", value: "intraday" }]
    },
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    }
  });

  assert.equal(result.level, "ready");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.stale_dependencies, []);
  assert.deepEqual(result.missing_dependencies, []);
  assert.deepEqual(result.session_constraints, [{ key: "cn_session", value: "intraday" }]);
});

test("analysis_degraded for weak coverage", () => {
  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "degraded",
      missing_domains: [],
      weak_domains: ["hong_kong"]
    }
  });

  assert.equal(result.level, "analysis_degraded");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["coverage_degraded"]);
  assert.deepEqual(result.stale_dependencies, []);
  assert.deepEqual(result.missing_dependencies, []);
  assert.deepEqual(result.session_constraints, []);
});

test("trading_blocked for stale trading inputs", () => {
  const staleDependency = {
    key: "trade_tape",
    status: "stale",
    required: true,
    reason: "trade_date_mismatch"
  };

  const result = deriveResearchDecisionReadiness({
    sessionInfo: { session_constraints: [] },
    freshnessGuard: {
      stale_dependencies: [staleDependency],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    }
  });

  assert.equal(result.level, "trading_blocked");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["stale_trading_dependencies"]);
  assert.deepEqual(result.stale_dependencies, [staleDependency]);
  assert.deepEqual(result.missing_dependencies, []);
  assert.deepEqual(result.session_constraints, []);
});

test("trading_blocked for stale dependency from real freshness guard shape", () => {
  const staleDependency = {
    key: "cn_quotes",
    label: "CN Quotes",
    status: "stale",
    effective_timestamp: "2026-04-01T15:00:00+08:00",
    lag_hours: 19.5,
    required: true,
    reason: "lag_exceeded"
  };

  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [staleDependency],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    }
  });

  assert.equal(result.level, "trading_blocked");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["stale_trading_dependencies"]);
  assert.deepEqual(result.stale_dependencies, [staleDependency]);
  assert.deepEqual(result.missing_dependencies, []);
  assert.deepEqual(result.session_constraints, []);
});

test("stale optional dependency does not force trading_blocked", () => {
  const staleOptionalDependency = {
    key: "optional_macro",
    label: "Optional Macro",
    status: "stale",
    effective_timestamp: "2026-04-01T08:00:00+08:00",
    lag_hours: 26.5,
    required: false,
    reason: "lag_exceeded"
  };

  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [staleOptionalDependency],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    }
  });

  assert.equal(result.level, "ready");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.stale_dependencies, [staleOptionalDependency]);
  assert.deepEqual(result.missing_dependencies, []);
  assert.deepEqual(result.session_constraints, []);
});

test("research_invalid for critical missing domains", () => {
  const missingDependency = {
    key: "portfolio_state",
    status: "missing"
  };

  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: [missingDependency]
    },
    coverageGuard: {
      overall_status: "critical",
      missing_domains: ["portfolio_state", "risk_state"],
      weak_domains: []
    }
  });

  assert.equal(result.level, "research_invalid");
  assert.equal(result.analysis_allowed, false);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["critical_coverage_failure"]);
  assert.deepEqual(result.stale_dependencies, []);
  assert.deepEqual(result.missing_dependencies, [missingDependency]);
  assert.deepEqual(result.session_constraints, []);
});

test("research_invalid when critical domains are missing even without critical overall status", () => {
  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: ["portfolio_state"],
      weak_domains: []
    }
  });

  assert.equal(result.level, "research_invalid");
  assert.equal(result.analysis_allowed, false);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["critical_coverage_failure"]);
  assert.deepEqual(result.stale_dependencies, []);
  assert.deepEqual(result.missing_dependencies, []);
  assert.deepEqual(result.session_constraints, []);
});

test("missing required freshness dependency does not return ready", () => {
  const missingDependency = {
    key: "trade_tape",
    label: "Trade Tape",
    status: "missing",
    required: true,
    reason: "missing_required"
  };

  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: [missingDependency]
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    }
  });

  assert.equal(result.level, "trading_blocked");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["missing_required_dependencies"]);
  assert.deepEqual(result.stale_dependencies, []);
  assert.deepEqual(result.missing_dependencies, [missingDependency]);
  assert.deepEqual(result.session_constraints, []);
});

test("non-critical blocked tradability sections downgrade trading readiness to degraded", () => {
  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    },
    marketDataQuality: {
      sections: {
        northbound_flow: {
          tradability_relevance: "blocked"
        },
        southbound_flow: {
          tradability_relevance: "usable"
        }
      }
    }
  });

  assert.equal(result.level, "analysis_degraded");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["tradability_sections_blocked"]);
});

test("critical blocked tradability sections hard-block trading readiness", () => {
  const result = deriveResearchDecisionReadiness({
    sessionInfo: {},
    freshnessGuard: {
      stale_dependencies: [],
      missing_dependencies: []
    },
    coverageGuard: {
      overall_status: "ok",
      missing_domains: [],
      weak_domains: []
    },
    marketDataQuality: {
      sections: {
        a_share_quotes: {
          tradability_relevance: "blocked"
        },
        global_risk_quotes: {
          tradability_relevance: "usable"
        }
      }
    }
  });

  assert.equal(result.level, "trading_blocked");
  assert.equal(result.analysis_allowed, true);
  assert.equal(result.trading_allowed, false);
  assert.deepEqual(result.reasons, ["critical_tradability_sections_blocked"]);
});
