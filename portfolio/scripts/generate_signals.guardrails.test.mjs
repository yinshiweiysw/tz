import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py";
const VENV_PYTHON = "/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3";

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: "/Users/yinshiwei/codex/tz",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("generate_signals exits non-zero when the market lake misses daily_prices", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "generate-signals-guard-"));
  const configDir = path.join(tempDir, "config");
  const dataDir = path.join(tempDir, "data");
  const signalsDir = path.join(tempDir, "signals");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(signalsDir, { recursive: true }),
  ]);

  await writeFile(
    path.join(configDir, "asset_master.json"),
    `${JSON.stringify(
      {
        global_constraints: {
          max_drawdown_limit: 0.1,
          absolute_equity_cap: 0.65,
        },
        buckets: {
          A_CORE: { label: "A股核心", target: 0.2, min: 0.05, max: 0.25, priority_rank: 1, is_equity_like: true },
          CASH: { label: "现金", target: 0.35, min: 0.25, max: 0.4, priority_rank: 99, is_equity_like: false },
        },
        bucket_order: ["A_CORE", "CASH"],
        assets: [
          {
            symbol: "007339",
            name: "易方达沪深300ETF联接C",
            bucket: "A_CORE",
            execution_type: "OTC",
            strategy_regime: {
              type: "erp_mean_reversion",
              trend_filter: { momentum_lookback_months: 12, moving_average: 120 },
              risk_control: { max_atr_threshold: 0.08, kill_switch_enabled: false },
            },
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(tempDir, "account_context.json"),
    `${JSON.stringify(
      {
        available_cash_cny: 100000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(dataDir, "macro_state.json"),
    `${JSON.stringify(
      {
        generated_at: "2026-04-07T10:00:00+08:00",
        factors: {
          hs300_erp: { value_pct: 5.8 },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runProcess("python3", [
    SCRIPT_PATH,
    "--portfolio-root",
    tempDir,
    "--asset-master",
    path.join(configDir, "asset_master.json"),
    "--account-context",
    path.join(tempDir, "account_context.json"),
    "--macro-state",
    path.join(dataDir, "macro_state.json"),
    "--db",
    path.join(dataDir, "empty_market_lake.db"),
    "--output",
    path.join(signalsDir, "regime_router_signals.json"),
  ]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /daily_prices|schema incomplete/i);
});

test("SignalRouter bucket gate uses OR semantics for GLB_MOM signals", async () => {
  const script = `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("generate_signals", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

router = module.SignalRouter.__new__(module.SignalRouter)
state = router._build_bucket_signal_state([
    {
        "bucket": "GLB_MOM",
        "regime_type": "macro_momentum",
        "technical_snapshot": {
            "current_price": 110,
            "long_ma": 100,
            "signal_date": "2026-04-07",
        },
    },
    {
        "bucket": "GLB_MOM",
        "regime_type": "macro_momentum",
        "technical_snapshot": {
            "current_price": 90,
            "long_ma": 100,
            "signal_date": "2026-04-07",
        },
    },
])

print(json.dumps(state, ensure_ascii=False))
  `;

  const result = await runProcess(VENV_PYTHON, ["-c", script.trim()]);

  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(result.stdout.trim());
  assert.equal(state.GLB_MOM.trend_gate_passed, true);
  assert.equal(state.GLB_MOM.signal_count, 2);
});

test("SignalRouter prefers canonical portfolio_state total assets over stale account_context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "generate-signals-state-guard-"));
  const configDir = path.join(tempDir, "config");
  const dataDir = path.join(tempDir, "data");
  const stateDir = path.join(tempDir, "state");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  const assetMasterPath = path.join(configDir, "asset_master.json");
  const accountContextPath = path.join(tempDir, "account_context.json");
  const macroStatePath = path.join(dataDir, "macro_state.json");
  const portfolioStatePath = path.join(stateDir, "portfolio_state.json");

  await writeFile(
    assetMasterPath,
    `${JSON.stringify(
      {
        global_constraints: {
          max_drawdown_limit: 0.1,
          absolute_equity_cap: 0.65,
        },
        buckets: {
          A_CORE: { label: "A股核心", target: 0.2, min: 0.05, max: 0.25, priority_rank: 1, is_equity_like: true },
          CASH: { label: "现金", target: 0.35, min: 0.25, max: 0.4, priority_rank: 99, is_equity_like: false },
        },
        bucket_order: ["A_CORE", "CASH"],
        assets: [
          {
            symbol: "007339",
            name: "易方达沪深300ETF联接C",
            bucket: "A_CORE",
            execution_type: "OTC",
            strategy_regime: { type: "erp_mean_reversion" },
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    accountContextPath,
    `${JSON.stringify(
      {
        available_cash_cny: 180000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    portfolioStatePath,
    `${JSON.stringify(
      {
        snapshot_date: "2026-04-07",
        positions: [],
        summary: {
          total_portfolio_assets_cny: 320000,
          total_fund_assets: 140000,
          settled_cash_cny: 180000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    macroStatePath,
    `${JSON.stringify({ generated_at: "2026-04-07T10:00:00+08:00", factors: {} }, null, 2)}\n`,
    "utf8"
  );

  const script = `
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("generate_signals", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

router = module.SignalRouter(
    asset_master_path=Path("${assetMasterPath}"),
    account_context_path=Path("${accountContextPath}"),
    macro_state_path=Path("${macroStatePath}"),
    db_path=Path("${path.join(dataDir, "market_lake.db")}"),
    portfolio_state_path=Path("${portfolioStatePath}"),
)

print(json.dumps({
    "total_portfolio_value": router.total_portfolio_value,
    "source": router.total_portfolio_value_source,
}, ensure_ascii=False))
  `;

  const result = await runProcess(VENV_PYTHON, ["-c", script.trim()]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.total_portfolio_value, 320000);
  assert.equal(payload.source, "portfolio_state.summary.total_portfolio_assets_cny");
});

test("SignalRouter normalizes BJ exchange symbols to bj-prefixed go-stock tickers", async () => {
  const script = `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("generate_signals", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

captured = {}

class FakeResponse:
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return "v_bj430047=\\"51~测试~430047~12.34~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260407150000~0\\";".encode("gb18030")

def fake_urlopen(request, timeout=10):
    captured["url"] = request.full_url
    return FakeResponse()

module.urlopen = fake_urlopen
router = module.SignalRouter.__new__(module.SignalRouter)
quote = router._fetch_go_stock_exchange_quote("430047.BJ")
print(json.dumps({"url": captured["url"], "price": quote["last_price"]}, ensure_ascii=False))
  `;

  const result = await runProcess(VENV_PYTHON, ["-c", script.trim()]);

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.match(payload.url, /q=bj430047/i);
  assert.equal(payload.price, 12.34);
});
