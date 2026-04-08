import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSIONS,
  validateSignalsMatrix,
  validateCnMarketSnapshot,
  validateQuantMetrics,
  validatePythonOutput,
} from "./validate_python_output.mjs";

// ---------------------------------------------------------------------------
// Signals Matrix
// ---------------------------------------------------------------------------

test("validateSignalsMatrix accepts a valid payload", () => {
  const payload = {
    version: 1,
    generated_at: "2026-04-06T10:00:00+08:00",
    signals: { "000001": { code: "000001" } },
    errors: [],
  };

  const result = validateSignalsMatrix(payload);
  assert.equal(result.valid, true);
});

test("validateSignalsMatrix rejects payload missing version", () => {
  const payload = {
    generated_at: "2026-04-06T10:00:00+08:00",
    signals: {},
    errors: [],
  };

  const result = validateSignalsMatrix(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.includes("version")));
});

test("validateSignalsMatrix rejects payload missing signals", () => {
  const payload = {
    version: 1,
    generated_at: "2026-04-06T10:00:00+08:00",
    errors: [],
  };

  const result = validateSignalsMatrix(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("signals")));
});

test("validateSignalsMatrix rejects non-object payload", () => {
  const result = validateSignalsMatrix(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("not an object")));

  const result2 = validateSignalsMatrix("string");
  assert.equal(result2.valid, false);
});

test("validateSignalsMatrix warns on _meta version mismatch", () => {
  const payload = {
    version: 1,
    generated_at: "2026-04-06T10:00:00+08:00",
    signals: {},
    errors: [],
    _meta: { schema_version: "2.0", generated_at: "2026-04-06T10:00:00+08:00", source_script: "test" },
  };

  const result = validateSignalsMatrix(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("schema_version")));
});

test("validateSignalsMatrix warns on invalid _meta.generated_at", () => {
  const payload = {
    version: 1,
    generated_at: "2026-04-06T10:00:00+08:00",
    signals: {},
    errors: [],
    _meta: { schema_version: "1.0", generated_at: "not-a-date", source_script: "test" },
  };

  const result = validateSignalsMatrix(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("_meta.generated_at")));
});

test("validateSignalsMatrix passes with correct _meta", () => {
  const payload = {
    version: 1,
    generated_at: "2026-04-06T10:00:00+08:00",
    signals: {},
    errors: [],
    _meta: { schema_version: "1.0", generated_at: "2026-04-06T10:00:00+08:00", source_script: "generate_fund_signals_matrix.py" },
  };

  const result = validateSignalsMatrix(payload);
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// CN Market Snapshot
// ---------------------------------------------------------------------------

test("validateCnMarketSnapshot accepts a valid payload", () => {
  const payload = {
    version: 2,
    trade_date: "2026-04-06",
    generated_at: "2026-04-06T15:30:00+08:00",
    status: "ok",
    sections: {
      market_breadth: { total_count: 5000 },
    },
  };

  const result = validateCnMarketSnapshot(payload);
  assert.equal(result.valid, true);
});

test("validateCnMarketSnapshot accepts partial status", () => {
  const payload = {
    version: 2,
    trade_date: "2026-04-06",
    generated_at: "2026-04-06T15:30:00+08:00",
    status: "partial",
    sections: {},
  };

  const result = validateCnMarketSnapshot(payload);
  assert.equal(result.valid, true);
});

test("validateCnMarketSnapshot accepts dependency_missing status", () => {
  const payload = {
    version: 2,
    trade_date: "2026-04-06",
    generated_at: "2026-04-06T15:30:00+08:00",
    status: "dependency_missing",
    sections: {},
  };

  const result = validateCnMarketSnapshot(payload);
  assert.equal(result.valid, true);
});

test("validateCnMarketSnapshot rejects invalid status value", () => {
  const payload = {
    version: 2,
    trade_date: "2026-04-06",
    generated_at: "2026-04-06T15:30:00+08:00",
    status: "bogus",
    sections: {},
  };

  const result = validateCnMarketSnapshot(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("status")));
});

test("validateCnMarketSnapshot rejects missing required fields", () => {
  const result = validateCnMarketSnapshot({ version: 2 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("trade_date")));
  assert.ok(result.errors.some((e) => e.includes("generated_at")));
  assert.ok(result.errors.some((e) => e.includes("status")));
  assert.ok(result.errors.some((e) => e.includes("sections")));
});

test("validateCnMarketSnapshot passes with correct _meta", () => {
  const payload = {
    version: 2,
    trade_date: "2026-04-06",
    generated_at: "2026-04-06T15:30:00+08:00",
    status: "ok",
    sections: {},
    _meta: { schema_version: "1.0", generated_at: "2026-04-06T15:30:00+08:00", source_script: "generate_cn_market_snapshot.py" },
  };

  const result = validateCnMarketSnapshot(payload);
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Quant Metrics Engine
// ---------------------------------------------------------------------------

test("validateQuantMetrics accepts a valid payload", () => {
  const payload = {
    account_id: "user_test",
    generated_at: "2026-04-06T16:00:00+08:00",
    lookback_days: 60,
    portfolio_snapshot: {
      snapshot_date: "2026-04-05",
      total_market_value_cny: 100000,
      active_position_count: 5,
      active_symbols: ["000001", "000002"],
      excluded_positions_due_to_missing_history: [],
    },
    matrices: {
      correlation_matrix: {
        symbols: ["000001"],
        highest_pair: null,
        matrix: {},
      },
    },
    risk_model: {
      portfolio_annualized_volatility_pct: 12.5,
      return_observations: 60,
      position_risk_contributions: [],
      bucket_marginal_risk_contribution: [],
    },
    errors: [],
    brinson_attribution: {
      benchmark_total_return_pct: 5.0,
      total_allocation_effect_pct: 0.1,
      total_selection_effect_pct: 0.2,
      total_interaction_effect_pct: 0.0,
      total_active_effect_pct: 0.3,
      bucket_effects: [],
    },
  };

  const result = validateQuantMetrics(payload);
  assert.equal(result.valid, true);
});

test("validateQuantMetrics rejects missing account_id", () => {
  const payload = {
    generated_at: "2026-04-06T16:00:00+08:00",
    lookback_days: 60,
    portfolio_snapshot: {},
    matrices: { correlation_matrix: {} },
    risk_model: { portfolio_annualized_volatility_pct: 12.5 },
    errors: [],
    brinson_attribution: {},
  };

  const result = validateQuantMetrics(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("account_id")));
});

test("validateQuantMetrics rejects missing nested fields", () => {
  const payload = {
    account_id: "user_test",
    generated_at: "2026-04-06T16:00:00+08:00",
    lookback_days: 60,
    portfolio_snapshot: {},
    matrices: {},
    risk_model: {},
    errors: [],
    brinson_attribution: {},
  };

  const result = validateQuantMetrics(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlation_matrix")));
  assert.ok(result.errors.some((e) => e.includes("portfolio_annualized_volatility_pct")));
  assert.ok(result.errors.some((e) => e.includes("active_symbols")));
});

test("validateQuantMetrics rejects when errors is not an array", () => {
  const payload = {
    account_id: "user_test",
    generated_at: "2026-04-06T16:00:00+08:00",
    lookback_days: 60,
    portfolio_snapshot: { active_symbols: [] },
    matrices: { correlation_matrix: {} },
    risk_model: { portfolio_annualized_volatility_pct: 12.5 },
    errors: "not-array",
    brinson_attribution: {},
  };

  const result = validateQuantMetrics(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("errors")));
});

test("validateQuantMetrics passes with correct _meta", () => {
  const payload = {
    account_id: "user_test",
    generated_at: "2026-04-06T16:00:00+08:00",
    lookback_days: 60,
    portfolio_snapshot: { active_symbols: [] },
    matrices: { correlation_matrix: {} },
    risk_model: { portfolio_annualized_volatility_pct: 12.5 },
    errors: [],
    brinson_attribution: {},
    _meta: { schema_version: "1.0", generated_at: "2026-04-06T16:00:00+08:00", source_script: "calculate_quant_metrics.py" },
  };

  const result = validateQuantMetrics(payload);
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Generic dispatcher
// ---------------------------------------------------------------------------

test("validatePythonOutput dispatches to correct validator", () => {
  const signals = { version: 1, generated_at: "x", signals: {}, errors: [] };
  assert.equal(validatePythonOutput(signals, "signals_matrix").valid, true);

  const snapshot = { version: 2, trade_date: "2026-04-06", generated_at: "x", status: "ok", sections: {} };
  assert.equal(validatePythonOutput(snapshot, "cn_market_snapshot").valid, true);

  const quant = {
    account_id: "x", generated_at: "x", lookback_days: 60,
    portfolio_snapshot: { active_symbols: [] },
    matrices: { correlation_matrix: {} },
    risk_model: { portfolio_annualized_volatility_pct: 1 },
    errors: [],
    brinson_attribution: {},
  };
  assert.equal(validatePythonOutput(quant, "quant_metrics_engine").valid, true);
});

test("validatePythonOutput rejects unknown schema name", () => {
  const result = validatePythonOutput({}, "nonexistent");
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("unknown schema name")));
});

// ---------------------------------------------------------------------------
// SCHEMA_VERSIONS
// ---------------------------------------------------------------------------

test("SCHEMA_VERSIONS contains all three keys", () => {
  assert.ok("signals_matrix" in SCHEMA_VERSIONS);
  assert.ok("cn_market_snapshot" in SCHEMA_VERSIONS);
  assert.ok("quant_metrics_engine" in SCHEMA_VERSIONS);

  for (const [key, version] of Object.entries(SCHEMA_VERSIONS)) {
    assert.equal(typeof version, "string", `SCHEMA_VERSIONS.${key} should be a string`);
    assert.ok(version.length > 0, `SCHEMA_VERSIONS.${key} should not be empty`);
  }
});
