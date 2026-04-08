import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py";
const VENV_PYTHON = "/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3";

test("calculate_quant_metrics uses trailing lookback returns for Brinson portfolio legs", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "quant-metrics-lookback-"));
  const configDir = path.join(portfolioRoot, "config");
  const dataDir = path.join(portfolioRoot, "data");
  const stateDir = path.join(portfolioRoot, "state");
  const dbPath = path.join(dataDir, "market_lake.db");
  const outputPath = path.join(dataDir, "quant_metrics_engine.json");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  await writeFile(
    path.join(configDir, "asset_master.json"),
    `${JSON.stringify(
      {
        fallback_bucket_key: "A_CORE",
        bucket_order: ["A_CORE"],
        buckets: {
          A_CORE: { label: "A股核心" },
        },
        bucket_mapping_rules: [
          {
            bucket_key: "A_CORE",
            category_equals: ["A股宽基"],
            name_patterns: ["测试核心"],
          },
        ],
        performance_benchmark: {
          sleeves: {
            core: {
              bucket_weights_pct: {
                A_CORE: 100,
              },
            },
          },
        },
        portfolio_backtest: {
          bucket_representatives: {
            A_CORE: {
              symbol: "BENCH",
            },
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(portfolioRoot, "fund-watchlist.json"),
    `${JSON.stringify(
      {
        watchlist: [{ code: "POS1", name: "测试核心", enabled: true }],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(stateDir, "portfolio_state.json"),
    `${JSON.stringify(
      {
        snapshot_date: "2026-04-03",
        positions: [
          {
            name: "测试核心",
            category: "A股宽基",
            amount: 2000,
            holding_profit: 1000,
            fund_code: "POS1",
            status: "active",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await execFileAsync("python3", [
    "-c",
    `
import sqlite3
from pathlib import Path

db_path = Path("${dbPath}")
connection = sqlite3.connect(db_path)
connection.execute("""
CREATE TABLE daily_prices (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  adj_close REAL,
  volume REAL,
  provider TEXT,
  asset_type TEXT,
  name TEXT,
  close_source TEXT,
  source_tags TEXT,
  updated_at TEXT,
  PRIMARY KEY (symbol, date)
)
""")
rows = [
  ("POS1", "2026-04-01", 100.0, 100.0, 100.0, 100.0, 100.0, None, "test", "fund", "测试核心", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("POS1", "2026-04-02", 105.0, 105.0, 105.0, 105.0, 105.0, None, "test", "fund", "测试核心", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("POS1", "2026-04-03", 110.0, 110.0, 110.0, 110.0, 110.0, None, "test", "fund", "测试核心", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("BENCH", "2026-04-01", 100.0, 100.0, 100.0, 100.0, 100.0, None, "test", "index", "基准", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("BENCH", "2026-04-02", 110.0, 110.0, 110.0, 110.0, 110.0, None, "test", "index", "基准", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("BENCH", "2026-04-03", 120.0, 120.0, 120.0, 120.0, 120.0, None, "test", "index", "基准", "seed", None, "2026-04-03T10:00:00+08:00")
]
connection.executemany(
  "INSERT INTO daily_prices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  rows
)
connection.commit()
connection.close()
    `,
  ]);

  await execFileAsync(
    "python3",
    [
      SCRIPT_PATH,
      "--portfolio-root",
      portfolioRoot,
      "--db",
      dbPath,
      "--output",
      outputPath,
      "--lookback-days",
      "2",
    ],
    { cwd: "/Users/yinshiwei/codex/tz" }
  );

  const payload = JSON.parse(await readFile(outputPath, "utf8"));
  const bucket = payload.brinson_attribution.bucket_effects.find((item) => item.bucket_key === "A_CORE");

  assert.ok(bucket);
  assert.equal(payload.brinson_attribution.portfolio_return_source, "market_lake adj_close trailing 2d");
  assert.equal(payload.matrices.annualized_covariance_matrix.method, "diagonal_shrinkage_proxy");
  assert.equal(payload.risk_model.covariance_method, "diagonal_shrinkage_proxy");
  assert.equal(bucket.portfolio_return_pct, 10);
  assert.equal(bucket.benchmark_return_pct, 20);
});

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

test("calculate_quant_metrics prefers canonical holding cost basis over amount-minus-pnl inference", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("calculate_quant_metrics", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

position = {
  "amount": 21000.01,
  "holding_pnl": 19000.01,
  "holding_cost_basis_cny": 21000,
}

result = module.resolve_position_cost_basis(position, 21000.01, 19000.01)
print(json.dumps({"estimated_cost": result}, ensure_ascii=False))
    `.trim(),
  ]);

  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.estimated_cost, 21000);
});

test("calculate_quant_metrics falls back to native position fund_code when watchlist has no mapping", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "quant-metrics-native-code-"));
  const configDir = path.join(portfolioRoot, "config");
  const dataDir = path.join(portfolioRoot, "data");
  const stateDir = path.join(portfolioRoot, "state");
  const dbPath = path.join(dataDir, "market_lake.db");
  const outputPath = path.join(dataDir, "quant_metrics_engine.json");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  await writeFile(
    path.join(configDir, "asset_master.json"),
    `${JSON.stringify(
      {
        fallback_bucket_key: "A_CORE",
        bucket_order: ["A_CORE"],
        buckets: {
          A_CORE: { label: "A股核心" },
        },
        bucket_mapping_rules: [
          {
            bucket_key: "A_CORE",
            category_equals: ["A股宽基"],
            name_patterns: ["测试核心"],
          },
        ],
        performance_benchmark: {
          sleeves: {
            core: {
              bucket_weights_pct: {
                A_CORE: 100,
              },
            },
          },
        },
        portfolio_backtest: {
          bucket_representatives: {
            A_CORE: {
              symbol: "BENCH",
            },
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(portfolioRoot, "fund-watchlist.json"),
    `${JSON.stringify({ watchlist: [] }, null, 2)}\n`,
    "utf8"
  );

  await writeFile(
    path.join(stateDir, "portfolio_state.json"),
    `${JSON.stringify(
      {
        snapshot_date: "2026-04-03",
        positions: [
          {
            name: "测试核心",
            category: "A股宽基",
            amount: 2000,
            holding_profit: 1000,
            fund_code: "POS1",
            status: "active",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await execFileAsync("python3", [
    "-c",
    `
import sqlite3
from pathlib import Path

db_path = Path("${dbPath}")
connection = sqlite3.connect(db_path)
connection.execute("""
CREATE TABLE daily_prices (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  adj_close REAL,
  volume REAL,
  provider TEXT,
  asset_type TEXT,
  name TEXT,
  close_source TEXT,
  source_tags TEXT,
  updated_at TEXT,
  PRIMARY KEY (symbol, date)
)
""")
rows = [
  ("POS1", "2026-04-01", 100.0, 100.0, 100.0, 100.0, 100.0, None, "test", "fund", "测试核心", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("POS1", "2026-04-02", 105.0, 105.0, 105.0, 105.0, 105.0, None, "test", "fund", "测试核心", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("POS1", "2026-04-03", 110.0, 110.0, 110.0, 110.0, 110.0, None, "test", "fund", "测试核心", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("BENCH", "2026-04-01", 100.0, 100.0, 100.0, 100.0, 100.0, None, "test", "index", "基准", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("BENCH", "2026-04-02", 110.0, 110.0, 110.0, 110.0, 110.0, None, "test", "index", "基准", "seed", None, "2026-04-03T10:00:00+08:00"),
  ("BENCH", "2026-04-03", 120.0, 120.0, 120.0, 120.0, 120.0, None, "test", "index", "基准", "seed", None, "2026-04-03T10:00:00+08:00")
]
connection.executemany(
  "INSERT INTO daily_prices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  rows
)
connection.commit()
connection.close()
    `,
  ]);

  await execFileAsync(
    "python3",
    [
      SCRIPT_PATH,
      "--portfolio-root",
      portfolioRoot,
      "--db",
      dbPath,
      "--output",
      outputPath,
      "--lookback-days",
      "2",
    ],
    { cwd: "/Users/yinshiwei/codex/tz" }
  );

  const payload = JSON.parse(await readFile(outputPath, "utf8"));

  assert.deepEqual(payload.portfolio_snapshot.active_symbols, ["POS1"]);
});
