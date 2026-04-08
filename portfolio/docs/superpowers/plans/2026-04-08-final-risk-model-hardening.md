# Final Risk Model Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the remaining risk-model correctness items by fixing trailing drawdown semantics, portfolio drawdown aggregation, and covariance output shrinkage while preserving the conservative product decisions for fund estimates and unsettled sell cash.

**Architecture:** Keep the existing contracts for fund observation and pre-flight cash settlement unchanged. Upgrade the Python signal layer so drawdowns are computed from full-history peaks, upgrade the portfolio risk layer so only downside drawdowns affect the gate, and upgrade quant metrics output to publish both raw sample covariance and a labeled diagonal-shrinkage proxy for auditability.

**Tech Stack:** Python, Node.js test runner, pandas, existing portfolio scripts

---

### Task 1: Trailing Peak Drawdown

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.py`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test("compute_recent_max_drawdown tracks drawdown against full-history peaks across the trailing window", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util
import json
import pandas as pd

spec = importlib.util.spec_from_file_location("generate_fund_signals_matrix", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

series = pd.Series([120.0, 100.0, 80.0, 75.0])
max_dd, current_dd = module.compute_recent_max_drawdown(series, 2)
print(json.dumps({"max_dd": max_dd, "current_dd": current_dd}, ensure_ascii=False))
    `,
  ]);

  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.max_dd, -37.5);
  assert.equal(payload.current_dd, -37.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.test.mjs`
Expected: FAIL because `compute_recent_max_drawdown()` still measures from the in-window peak only.

- [ ] **Step 3: Write minimal implementation**

```python
def compute_recent_max_drawdown(nav_series: pd.Series, window: int) -> tuple[float | None, float | None]:
    clean = nav_series.dropna()
    if clean.empty:
        return None, None

    full_drawdown = clean / clean.cummax() - 1.0
    recent_drawdown = full_drawdown.tail(window)
    current_drawdown = recent_drawdown.iloc[-1] if not recent_drawdown.empty else None
    max_drawdown = recent_drawdown.min() if not recent_drawdown.empty else None
    return (
        round_or_none(max_drawdown * 100 if max_drawdown is not None else None, 2),
        round_or_none(current_drawdown * 100 if current_drawdown is not None else None, 2),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.py /Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.test.mjs
git commit -m "fix: use trailing peak drawdown in signal matrix"
```

### Task 2: Downside-Only Portfolio Drawdown Gate

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test("buildPortfolioRiskState ignores positive drawdown values and aggregates downside exposure only", () => {
  const result = buildPortfolioRiskState({
    positions: [
      { name: "易方达沪深300ETF联接C", fund_code: "007339", amount: 10000, status: "active", category: "A股宽基" },
      { name: "博时标普500ETF联接(QDII)C", fund_code: "006075", amount: 10000, status: "active", category: "美股指数/QDII" }
    ],
    signalMatrix: {
      signals: {
        "007339": { name: "易方达沪深300ETF联接C", indicators: { current_drawdown_60d_percent: 20, max_drawdown_60d_percent: 20 } },
        "006075": { name: "博时标普500ETF联接(QDII)C", indicators: { current_drawdown_60d_percent: -20, max_drawdown_60d_percent: -24 } }
      }
    },
    assetMaster: buildAssetMasterFixture()
  });

  assert.equal(result.weighted_current_drawdown_60d_percent, -10);
  assert.equal(result.current_drawdown_pct, 0.1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.test.mjs`
Expected: FAIL because the current implementation allows positive values to offset downside drawdown.

- [ ] **Step 3: Write minimal implementation**

```javascript
function normalizeDrawdownPercent(value) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.min(numeric, 0);
}

const currentDrawdown = normalizeDrawdownPercent(signal?.indicators?.current_drawdown_60d_percent);
const maxDrawdown = normalizeDrawdownPercent(signal?.indicators?.max_drawdown_60d_percent);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_risk_state.test.mjs
git commit -m "fix: clamp portfolio drawdown proxy to downside only"
```

### Task 3: Quant Covariance Shrinkage Proxy

**Files:**
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test("calculate_quant_metrics publishes raw and shrunk annualized covariance matrices", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util
import json
import pandas as pd

spec = importlib.util.spec_from_file_location("calculate_quant_metrics", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

series_map = {
  "A": pd.Series([100.0, 110.0, 99.0], name="A"),
  "B": pd.Series([100.0, 105.0, 115.5], name="B"),
}
returns = module.build_returns_frame(series_map, 2)
payload = module.compute_covariance_payload(returns)
print(json.dumps(payload, ensure_ascii=False))
    `.trim(),
  ]);

  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.method, "diagonal_shrinkage_proxy");
  assert.equal(payload.raw_sample.A.B, -1.26);
  assert.ok(Math.abs(payload.shrunk.A.B) < Math.abs(payload.raw_sample.A.B));
  assert.ok(payload.shrinkage_intensity > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.test.mjs`
Expected: FAIL because `compute_covariance_payload()` does not exist yet and only raw covariance is emitted today.

- [ ] **Step 3: Write minimal implementation**

```python
def compute_covariance_payload(position_returns: pd.DataFrame) -> dict[str, Any]:
    raw_cov = position_returns.cov() * ANNUALIZATION_DAYS
    asset_count = len(position_returns.columns)
    sample_count = len(position_returns.index)
    shrinkage_intensity = round(min(0.35, asset_count / max(sample_count, 1) * 0.25), 6)
    diagonal_cov = pd.DataFrame(
        np.diag(np.diag(raw_cov.to_numpy())),
        index=raw_cov.index,
        columns=raw_cov.columns,
    )
    shrunk_cov = raw_cov * (1.0 - shrinkage_intensity) + diagonal_cov * shrinkage_intensity
    return {
        "method": "diagonal_shrinkage_proxy",
        "shrinkage_intensity": shrinkage_intensity,
        "raw_sample": to_nested_matrix(raw_cov),
        "shrunk": to_nested_matrix(shrunk_cov),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py /Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.test.mjs
git commit -m "feat: publish shrunk covariance proxy alongside raw sample matrix"
```
