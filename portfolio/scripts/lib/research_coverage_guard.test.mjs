import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchCoverageGuard } from "./research_coverage_guard.mjs";

test("missing hong kong coverage is weak and degrades overall status", () => {
  const result = buildResearchCoverageGuard({
    marketSnapshot: {
      a_share: { rows: [{ fetch_status: "ok" }] },
      hong_kong: { rows: [{ fetch_status: "ok" }, { fetch_status: "missing" }] },
      global_risk: { rows: [{ fetch_status: "ok" }] },
      macro_anchors: { rows: [{ fetch_status: "ok" }] }
    },
    researchSnapshot: {
      portfolio_state: { fetch_status: "ok" },
      risk_state: { fetch_status: "ok" }
    }
  });

  assert.equal(result.overall_status, "degraded");
  assert.equal(result.domains.hong_kong.status, "weak");
  assert.deepEqual(result.missing_domains, []);
  assert.deepEqual(result.weak_domains, ["hong_kong"]);
});

test("missing portfolio and risk state is critical", () => {
  const result = buildResearchCoverageGuard({
    marketSnapshot: {
      a_share: { rows: [{ fetch_status: "ok" }] },
      hong_kong: { rows: [{ fetch_status: "ok" }] },
      global_risk: { rows: [{ fetch_status: "ok" }] },
      macro_anchors: { rows: [{ fetch_status: "ok" }] }
    },
    researchSnapshot: {}
  });

  assert.equal(result.overall_status, "critical");
  assert.equal(result.domains.portfolio_state.status, "missing");
  assert.equal(result.domains.risk_state.status, "missing");
  assert.deepEqual(result.missing_domains, ["portfolio_state", "risk_state"]);
  assert.deepEqual(result.weak_domains, []);
});

test("fully missing market domain is reported as missing", () => {
  const result = buildResearchCoverageGuard({
    marketSnapshot: {
      a_share: { rows: [{ fetch_status: "missing" }, { fetch_status: "missing" }] },
      hong_kong: { rows: [{ fetch_status: "ok" }] },
      global_risk: { rows: [{ fetch_status: "ok" }] },
      macro_anchors: { rows: [{ fetch_status: "ok" }] }
    },
    researchSnapshot: {
      portfolio_state: { fetch_status: "ok" },
      risk_state: { fetch_status: "ok" }
    }
  });

  assert.equal(result.overall_status, "degraded");
  assert.equal(result.domains.a_share.status, "missing");
  assert.deepEqual(result.missing_domains, ["a_share"]);
  assert.deepEqual(result.weak_domains, []);
});
