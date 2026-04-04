import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalPortfolioView,
  selectCanonicalPortfolioPayload
} from "./portfolio_canonical_view.mjs";

test("selectCanonicalPortfolioPayload prefers portfolio_state over latest_compat payload", () => {
  const selected = selectCanonicalPortfolioPayload({
    latestView: {
      sourceKind: "portfolio_state",
      sourcePath: "/tmp/state/portfolio_state.json",
      payload: { snapshot_date: "2026-04-03", summary: { available_cash_cny: 12345 } }
    },
    latestCompat: { snapshot_date: "2026-04-02", summary: { available_cash_cny: 99999 } }
  });

  assert.equal(selected.payload.summary.available_cash_cny, 12345);
  assert.equal(selected.sourceKind, "portfolio_state");
});

test("buildCanonicalPortfolioView keeps explicit time semantics and compatibility marker", () => {
  const canonical = buildCanonicalPortfolioView({
    payload: {
      snapshot_date: "2026-04-03",
      strategy_effective_date: "2026-04-03",
      generated_at: "2026-04-03T10:00:00.000Z",
      summary: { available_cash_cny: 11111 }
    },
    sourceKind: "portfolio_state",
    sourcePath: "/tmp/state/portfolio_state.json",
    latestCompatSnapshotDate: "2026-04-02"
  });

  assert.equal(canonical.summary.available_cash_cny, 11111);
  assert.deepEqual(canonical.time_semantics, {
    snapshot_date: "2026-04-03",
    strategy_effective_date: "2026-04-03",
    generated_at: "2026-04-03T10:00:00.000Z",
    compatibility_snapshot_date: "2026-04-02"
  });
  assert.equal(canonical.compatibility_mode, "portfolio_state_primary");
});
