import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchFreshnessGuard } from "./research_freshness_guard.mjs";

test("same-day required input is ok during intraday", () => {
  const now = new Date("2026-04-02T10:30:00+08:00");
  const result = buildResearchFreshnessGuard({
    now,
    sessionInfo: {
      tradeDate: "2026-04-02",
      policy: { domesticTradeDateMustMatch: true }
    },
    dependencies: [
      {
        key: "cn_quotes",
        label: "CN Quotes",
        required: true,
        effective_timestamp: "2026-04-02T10:00:00+08:00",
        trade_date: "2026-04-02",
        max_lag_hours: 2
      }
    ]
  });

  assert.equal(result.overall_status, "ok");
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].status, "ok");
  assert.equal(result.dependencies[0].lag_hours, 0.5);
  assert.equal(result.dependencies[0].reason, "fresh");
  assert.deepEqual(result.stale_dependencies, []);
  assert.deepEqual(result.missing_dependencies, []);
});

test("stale trade dependency is stale during intraday", () => {
  const now = new Date("2026-04-02T10:30:00+08:00");
  const result = buildResearchFreshnessGuard({
    now,
    sessionInfo: {
      tradeDate: "2026-04-02",
      policy: { domesticTradeDateMustMatch: true }
    },
    dependencies: [
      {
        key: "trade_tape",
        label: "Trade Tape",
        required: true,
        effective_timestamp: "2026-04-01T15:00:00+08:00",
        trade_date: "2026-04-01",
        max_lag_hours: 24
      }
    ]
  });

  assert.equal(result.overall_status, "stale");
  assert.equal(result.dependencies[0].status, "stale");
  assert.equal(result.dependencies[0].reason, "trade_date_mismatch");
  assert.equal(result.stale_dependencies.length, 1);
  assert.equal(result.missing_dependencies.length, 0);
});

test("optional gap becomes optional_missing", () => {
  const now = new Date("2026-04-02T10:30:00+08:00");
  const result = buildResearchFreshnessGuard({
    now,
    sessionInfo: {
      tradeDate: "2026-04-02",
      policy: { domesticTradeDateMustMatch: true }
    },
    dependencies: [
      {
        key: "optional_macro",
        label: "Optional Macro",
        required: false
      }
    ]
  });

  assert.equal(result.overall_status, "ok");
  assert.equal(result.dependencies[0].status, "optional_missing");
  assert.equal(result.dependencies[0].effective_timestamp, null);
  assert.equal(result.dependencies[0].lag_hours, null);
  assert.equal(result.dependencies[0].reason, "missing_optional");
  assert.equal(result.stale_dependencies.length, 0);
  assert.equal(result.missing_dependencies.length, 0);
});

test("malformed required timestamp is missing and never fresh", () => {
  const now = new Date("2026-04-02T10:30:00+08:00");
  const result = buildResearchFreshnessGuard({
    now,
    sessionInfo: {
      tradeDate: "2026-04-02",
      policy: { domesticTradeDateMustMatch: true }
    },
    dependencies: [
      {
        key: "bad_empty",
        label: "Bad Empty",
        required: true,
        effective_timestamp: ""
      },
      {
        key: "bad_text",
        label: "Bad Text",
        required: true,
        effective_timestamp: "not-a-date"
      }
    ]
  });

  assert.equal(result.overall_status, "missing");
  assert.equal(result.dependencies[0].status, "missing");
  assert.equal(result.dependencies[0].reason, "invalid_timestamp");
  assert.equal(result.dependencies[0].lag_hours, null);
  assert.equal(result.dependencies[1].status, "missing");
  assert.equal(result.dependencies[1].reason, "invalid_timestamp");
  assert.equal(result.dependencies[1].lag_hours, null);
  assert.equal(result.stale_dependencies.length, 0);
  assert.equal(result.missing_dependencies.length, 2);
});

test("valid numeric timestamp remains valid and gets lag evaluated", () => {
  const now = new Date("2026-04-02T10:30:00+08:00");
  const timestampMs = now.getTime() - 30 * 60 * 1000;
  const result = buildResearchFreshnessGuard({
    now,
    sessionInfo: {
      tradeDate: "2026-04-02",
      policy: { domesticTradeDateMustMatch: false }
    },
    dependencies: [
      {
        key: "numeric_ts",
        label: "Numeric TS",
        required: true,
        effective_timestamp: timestampMs,
        max_lag_hours: 1
      }
    ]
  });

  assert.equal(result.overall_status, "ok");
  assert.equal(result.dependencies[0].status, "ok");
  assert.equal(result.dependencies[0].reason, "fresh");
  assert.equal(result.dependencies[0].lag_hours, 0.5);
  assert.equal(result.missing_dependencies.length, 0);
  assert.equal(result.stale_dependencies.length, 0);
});

test("epoch-zero numeric timestamp is treated as valid (not missing)", () => {
  const now = new Date("1970-01-01T00:30:00Z");
  const result = buildResearchFreshnessGuard({
    now,
    sessionInfo: {
      tradeDate: "1970-01-01",
      policy: { domesticTradeDateMustMatch: false }
    },
    dependencies: [
      {
        key: "epoch_zero",
        label: "Epoch Zero",
        required: true,
        effective_timestamp: 0,
        max_lag_hours: 1
      }
    ]
  });

  assert.equal(result.overall_status, "ok");
  assert.equal(result.dependencies[0].status, "ok");
  assert.equal(result.dependencies[0].reason, "fresh");
  assert.equal(result.dependencies[0].lag_hours, 0.5);
  assert.equal(result.missing_dependencies.length, 0);
  assert.equal(result.stale_dependencies.length, 0);
});
