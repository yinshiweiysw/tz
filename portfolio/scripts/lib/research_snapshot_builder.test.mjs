import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchSnapshot } from "./research_snapshot_builder.mjs";

test("buildResearchSnapshot preserves availability and timestamps for complete payloads", () => {
  const payloads = {
    latest: {
      generated_at: "2026-04-01T09:10:00.000Z",
      snapshot_date: "2026-04-01"
    },
    riskDashboard: {
      generated_at: "2026-04-01T09:11:00.000Z",
      as_of: "2026-04-01"
    },
    macroState: {
      generated_at: "2026-04-01T09:12:00.000Z",
      as_of: "2026-04-01"
    },
    macroRadar: {
      generated_at: "2026-04-01T09:13:00.000Z",
      as_of: "2026-04-01"
    },
    regimeSignals: {
      generated_at: "2026-04-01T09:14:00.000Z",
      as_of: "2026-04-01"
    },
    opportunityPool: {
      generated_at: "2026-04-01T09:15:00.000Z",
      as_of: "2026-04-01"
    },
    performanceAttribution: {
      generated_at: "2026-04-01T09:16:00.000Z",
      as_of: "2026-04-01"
    }
  };

  const snapshot = buildResearchSnapshot({ payloads });

  assert.deepEqual(Object.keys(snapshot), [
    "portfolio_state",
    "risk_dashboard",
    "macro_state",
    "macro_radar",
    "regime_router_signals",
    "opportunity_pool",
    "performance_attribution"
  ]);

  assert.deepEqual(snapshot.portfolio_state, {
    key: "portfolio_state",
    available: true,
    generated_at: "2026-04-01T09:10:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.latest
  });
  assert.deepEqual(snapshot.risk_dashboard, {
    key: "risk_dashboard",
    available: true,
    generated_at: "2026-04-01T09:11:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.riskDashboard
  });
  assert.deepEqual(snapshot.macro_state, {
    key: "macro_state",
    available: true,
    generated_at: "2026-04-01T09:12:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.macroState
  });
  assert.deepEqual(snapshot.macro_radar, {
    key: "macro_radar",
    available: true,
    generated_at: "2026-04-01T09:13:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.macroRadar
  });
  assert.deepEqual(snapshot.regime_router_signals, {
    key: "regime_router_signals",
    available: true,
    generated_at: "2026-04-01T09:14:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.regimeSignals
  });
  assert.deepEqual(snapshot.opportunity_pool, {
    key: "opportunity_pool",
    available: true,
    generated_at: "2026-04-01T09:15:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.opportunityPool
  });
  assert.deepEqual(snapshot.performance_attribution, {
    key: "performance_attribution",
    available: true,
    generated_at: "2026-04-01T09:16:00.000Z",
    as_of: "2026-04-01",
    payload: payloads.performanceAttribution
  });
});

test("buildResearchSnapshot marks absent artifacts as unavailable without throwing", () => {
  const snapshot = buildResearchSnapshot({
    payloads: {
      latest: {
        generated_at: "2026-04-01T09:10:00.000Z",
        snapshot_date: "2026-04-01"
      }
    }
  });

  assert.equal(snapshot.portfolio_state.available, true);

  assert.deepEqual(snapshot.risk_dashboard, {
    key: "risk_dashboard",
    available: false,
    generated_at: null,
    as_of: null,
    payload: null
  });
  assert.deepEqual(snapshot.macro_state, {
    key: "macro_state",
    available: false,
    generated_at: null,
    as_of: null,
    payload: null
  });
  assert.deepEqual(snapshot.macro_radar, {
    key: "macro_radar",
    available: false,
    generated_at: null,
    as_of: null,
    payload: null
  });
  assert.deepEqual(snapshot.regime_router_signals, {
    key: "regime_router_signals",
    available: false,
    generated_at: null,
    as_of: null,
    payload: null
  });
  assert.deepEqual(snapshot.opportunity_pool, {
    key: "opportunity_pool",
    available: false,
    generated_at: null,
    as_of: null,
    payload: null
  });
  assert.deepEqual(snapshot.performance_attribution, {
    key: "performance_attribution",
    available: false,
    generated_at: null,
    as_of: null,
    payload: null
  });
});

test("buildResearchSnapshot degrades safely when payloads is null", () => {
  const snapshot = buildResearchSnapshot({ payloads: null });

  const expectedKeys = [
    "portfolio_state",
    "risk_dashboard",
    "macro_state",
    "macro_radar",
    "regime_router_signals",
    "opportunity_pool",
    "performance_attribution"
  ];

  assert.deepEqual(Object.keys(snapshot), expectedKeys);
  for (const key of expectedKeys) {
    assert.deepEqual(snapshot[key], {
      key,
      available: false,
      generated_at: null,
      as_of: null,
      payload: null
    });
  }
});
