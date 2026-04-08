import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchDashboardHealth,
  isDashboardReady,
  resolveStartupAction,
  waitUntilPortFree
} from "./open_funds_live_dashboard.mjs";

test("fetchDashboardHealth reads /api/live-funds/health and returns blocked state details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/live-funds\/health\?account=main$/);
    return {
      ok: true,
      async json() {
        return {
          state: "blocked",
          reasons: ["portfolio_state.json is missing positions[]"]
        };
      }
    };
  };

  try {
    const result = await fetchDashboardHealth("http://127.0.0.1:8766", "main");
    assert.equal(result.ready, false);
    assert.equal(result.health?.state, "blocked");
    assert.match(result.reason ?? "", /positions\[\]/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isDashboardReady accepts degraded-but-readable health state and rejects blocked state", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => {
    const next = calls.length === 0 ? "degraded" : "blocked";
    calls.push(next);
    return {
      ok: true,
      async json() {
        return {
          state: next,
          reasons: next === "blocked" ? ["missing canonical state"] : ["watchlist missing"]
        };
      }
    };
  };

  try {
    assert.equal(await isDashboardReady("http://127.0.0.1:8766", "main"), true);
    assert.equal(await isDashboardReady("http://127.0.0.1:8766", "main"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveStartupAction recycles an occupied port when restart is requested and existing server is unhealthy", () => {
  assert.equal(
    resolveStartupAction({
      restart: true,
      listeningPidCount: 1,
      existingReady: false
    }),
    "recycle"
  );
  assert.equal(
    resolveStartupAction({
      restart: false,
      listeningPidCount: 1,
      existingReady: true
    }),
    "reuse"
  );
  assert.equal(
    resolveStartupAction({
      restart: true,
      listeningPidCount: 0,
      existingReady: false
    }),
    "launch"
  );
});

test("waitUntilPortFree polls until the listener is gone", async () => {
  const sequence = [[1234], [1234], []];
  const freed = await waitUntilPortFree(8766, {
    attempts: 3,
    delayMs: 0,
    getPids: () => sequence.shift() ?? []
  });

  assert.equal(freed, true);
});
