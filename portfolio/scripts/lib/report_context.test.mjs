import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalyticsFreshness,
  buildAnalyticsPaths,
  shouldBlockTradePlanRefresh,
  shouldRefreshSpeculativePlan,
  shouldRefreshTradePlan
} from "./report_context.mjs";

test("buildAnalyticsPaths exposes speculative plan path with canonical fallback", () => {
  const paths = buildAnalyticsPaths("/tmp/pf", {
    canonical_entrypoints: {}
  });

  assert.equal(paths.speculativePlanJsonPath, "/tmp/pf/data/speculative_plan.json");
});

test("buildAnalyticsFreshness includes speculative_plan entry with as_of and generated_at", () => {
  const freshness = buildAnalyticsFreshness({
    anchorDate: "2026-04-01",
    payloads: {
      latest: { snapshot_date: "2026-04-01" },
      speculativePlan: {
        as_of: "2026-04-01",
        generated_at: "2026-04-01T16:27:12.814Z"
      }
    }
  });

  const entry = freshness.entries.find((item) => item.key === "speculative_plan");
  assert.ok(entry);
  assert.equal(entry.asOf, "2026-04-01");
  assert.equal(entry.generatedAt, "2026-04-01T16:27:12.814Z");
  assert.equal(entry.status, "aligned");
});

test("buildAnalyticsFreshness flags same-day dependency drift for speculative and trade plans", () => {
  const freshness = buildAnalyticsFreshness({
    anchorDate: "2026-04-01",
    payloads: {
      latest: {
        snapshot_date: "2026-04-01",
        generated_at: "2026-04-01T15:30:00.000Z"
      },
      signalMatrix: {
        generated_at: "2026-04-01T11:00:00.000Z"
      },
      opportunityPool: {
        as_of: "2026-04-01",
        generated_at: "2026-04-01T12:00:00.000Z"
      },
      speculativePlan: {
        as_of: "2026-04-01",
        generated_at: "2026-04-01T10:00:00.000Z"
      },
      tradePlan: {
        plan_date: "2026-04-01",
        generated_at: "2026-04-01T09:00:00.000Z"
      }
    }
  });

  assert.equal(freshness.needsRefresh, true);
  assert.ok(freshness.refreshRecommendedKeys.includes("speculative_plan"));
  assert.ok(freshness.refreshRecommendedKeys.includes("trade_plan"));
});

test("shouldRefreshSpeculativePlan honors force, upstream refresh, and stale/missing freshness", () => {
  const staleFreshness = {
    staleKeys: ["speculative_plan"],
    missingKeys: [],
    refreshRecommendedKeys: ["speculative_plan"]
  };
  const cleanFreshness = {
    staleKeys: [],
    missingKeys: [],
    refreshRecommendedKeys: []
  };

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "force",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["signals_matrix"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["opportunity_pool"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: staleFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        opportunityPool: {
          generated_at: "2026-04-01T11:00:00.000Z"
        },
        signalMatrix: {
          generated_at: "2026-04-01T10:00:00.000Z"
        },
        speculativePlan: {
          generated_at: "2026-04-01T09:00:00.000Z"
        }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    false
  );
});

test("shouldRefreshTradePlan reruns when speculative or opportunity layers refreshed", () => {
  const cleanFreshness = {
    staleKeys: [],
    missingKeys: [],
    refreshRecommendedKeys: []
  };

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["regime_router_signals"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["speculative_plan"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["opportunity_pool"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        tradePlan: {
          generated_at: "2026-04-01T08:00:00.000Z"
        },
        speculativePlan: {
          generated_at: "2026-04-01T09:00:00.000Z"
        }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    false
  );
});

test("shouldBlockTradePlanRefresh blocks overwrite when speculative refresh failed", () => {
  assert.equal(
    shouldBlockTradePlanRefresh({
      speculativeRefreshRequested: true,
      refreshErrors: [{ step: "speculative_plan", message: "boom" }]
    }),
    true
  );

  assert.equal(
    shouldBlockTradePlanRefresh({
      speculativeRefreshRequested: true,
      refreshErrors: [{ step: "opportunity_pool", message: "boom" }]
    }),
    false
  );
});
