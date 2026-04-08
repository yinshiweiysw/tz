/**
 * validate_python_output.mjs
 *
 * Schema validation for the 3 most critical Python-to-JS JSON contracts:
 *   1. signals_matrix.json          (generate_fund_signals_matrix.py)
 *   2. cn_market_snapshot            (generate_cn_market_snapshot.py)
 *   3. quant_metrics_engine.json    (calculate_quant_metrics.py)
 *
 * Every validator returns { valid: true } or { valid: false, errors: [...] }.
 * Validators never throw -- they only warn and return a result object.
 */

// ---------------------------------------------------------------------------
// Schema version bookkeeping
// ---------------------------------------------------------------------------

/**
 * Current expected schema versions.  When a Python producer bumps its format,
 * update the corresponding entry here.
 */
export const SCHEMA_VERSIONS = {
  signals_matrix: "1.0",
  cn_market_snapshot: "1.0",
  quant_metrics_engine: "1.0",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireField(data, path) {
  const errors = [];
  const value = path.reduce((acc, key) => (acc != null ? acc[key] : undefined), data);
  if (value === undefined || value === null) {
    errors.push(`missing required field: ${path.join(".")}`);
  }
  return errors;
}

function requireObject(data, path) {
  const errors = [];
  const value = path.reduce((acc, key) => (acc != null ? acc[key] : undefined), data);
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`expected object at: ${path.join(".")}`);
  }
  return errors;
}

function requireArray(data, path) {
  const errors = [];
  const value = path.reduce((acc, key) => (acc != null ? acc[key] : undefined), data);
  if (!Array.isArray(value)) {
    errors.push(`expected array at: ${path.join(".")}`);
  }
  return errors;
}

function checkMeta(data, schemaName) {
  const errors = [];
  const meta = data?._meta;
  const expectedVersion = SCHEMA_VERSIONS[schemaName];

  if (meta === undefined || meta === null) {
    // _meta is optional for backwards compatibility -- just note it.
    return errors;
  }

  if (meta.schema_version !== undefined && meta.schema_version !== expectedVersion) {
    errors.push(
      `_meta.schema_version is "${meta.schema_version}", expected "${expectedVersion}"`
    );
  }

  if (meta.generated_at !== undefined) {
    const parsed = Date.parse(meta.generated_at);
    if (Number.isNaN(parsed)) {
      errors.push(`_meta.generated_at is not a valid ISO timestamp: "${meta.generated_at}"`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// signals_matrix.json
// ---------------------------------------------------------------------------

/**
 * Validate a signals_matrix payload produced by generate_fund_signals_matrix.py.
 *
 * Required top-level fields:
 *   - version (number)
 *   - generated_at (string)
 *   - signals (object)
 *   - errors (array)
 */
export function validateSignalsMatrix(data) {
  const errors = [];

  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, errors: ["payload is not an object"] };
  }

  errors.push(...requireField(data, ["version"]));
  errors.push(...requireField(data, ["generated_at"]));
  errors.push(...requireObject(data, ["signals"]));
  errors.push(...requireArray(data, ["errors"]));

  errors.push(...checkMeta(data, "signals_matrix"));

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// cn_market_snapshot
// ---------------------------------------------------------------------------

/**
 * Validate a cn_market_snapshot payload produced by generate_cn_market_snapshot.py.
 *
 * Required top-level fields:
 *   - version (number)
 *   - trade_date (string)
 *   - generated_at (string)
 *   - status (string, one of "ok" | "partial" | "dependency_missing")
 *   - sections (object)
 */
export function validateCnMarketSnapshot(data) {
  const errors = [];

  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, errors: ["payload is not an object"] };
  }

  errors.push(...requireField(data, ["version"]));
  errors.push(...requireField(data, ["trade_date"]));
  errors.push(...requireField(data, ["generated_at"]));
  errors.push(...requireField(data, ["status"]));

  const validStatuses = ["ok", "partial", "dependency_missing"];
  if (data.status !== undefined && !validStatuses.includes(data.status)) {
    errors.push(`status "${data.status}" is not one of: ${validStatuses.join(", ")}`);
  }

  errors.push(...requireObject(data, ["sections"]));

  errors.push(...checkMeta(data, "cn_market_snapshot"));

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// quant_metrics_engine.json
// ---------------------------------------------------------------------------

/**
 * Validate a quant_metrics_engine payload produced by calculate_quant_metrics.py.
 *
 * Required top-level fields:
 *   - account_id (string)
 *   - generated_at (string)
 *   - lookback_days (number)
 *   - portfolio_snapshot (object)
 *   - matrices (object)
 *   - risk_model (object)
 *   - errors (array)
 *   - brinson_attribution (object)
 */
export function validateQuantMetrics(data) {
  const errors = [];

  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, errors: ["payload is not an object"] };
  }

  errors.push(...requireField(data, ["account_id"]));
  errors.push(...requireField(data, ["generated_at"]));
  errors.push(...requireField(data, ["lookback_days"]));
  errors.push(...requireObject(data, ["portfolio_snapshot"]));
  errors.push(...requireObject(data, ["matrices"]));
  errors.push(...requireObject(data, ["risk_model"]));
  errors.push(...requireArray(data, ["errors"]));
  errors.push(...requireObject(data, ["brinson_attribution"]));

  // Spot-check a few nested fields that consumers rely on.
  errors.push(...requireField(data, ["matrices", "correlation_matrix"]));
  errors.push(...requireField(data, ["risk_model", "portfolio_annualized_volatility_pct"]));
  errors.push(...requireField(data, ["portfolio_snapshot", "active_symbols"]));

  errors.push(...checkMeta(data, "quant_metrics_engine"));

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Generic dispatcher
// ---------------------------------------------------------------------------

const VALIDATORS = {
  signals_matrix: validateSignalsMatrix,
  cn_market_snapshot: validateCnMarketSnapshot,
  quant_metrics_engine: validateQuantMetrics,
};

/**
 * Validate an arbitrary Python output by schema name.
 *
 * @param {any} data - The parsed JSON payload.
 * @param {"signals_matrix" | "cn_market_snapshot" | "quant_metrics_engine"} schemaName
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validatePythonOutput(data, schemaName) {
  const validator = VALIDATORS[schemaName];
  if (!validator) {
    return {
      valid: false,
      errors: [`unknown schema name: "${schemaName}" (expected one of: ${Object.keys(VALIDATORS).join(", ")})`],
    };
  }
  return validator(data);
}
