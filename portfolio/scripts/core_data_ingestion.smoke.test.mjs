import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.py";
const VENV_PYTHON = "/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3";

test("core_data_ingestion bootstraps the shared market lake schema on demand", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-lake-schema-"));
  const dbPath = path.join(tempDir, "market_lake.db");

  await execFileAsync("python3", [SCRIPT_PATH, "--bootstrap-schema-only", "--db", dbPath], {
    cwd: "/Users/yinshiwei/codex/tz",
  });

  const { stdout: tables } = await execFileAsync("sqlite3", [dbPath, ".tables"]);
  assert.match(tables, /daily_prices/);
  assert.match(tables, /macro_indicators/);
});

test("core_data_ingestion derives OTC universe from asset_master even when watchlist is empty", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-lake-universe-"));
  const configDir = path.join(tempDir, "config");
  await mkdir(configDir, { recursive: true });

  await writeFile(
    path.join(tempDir, "fund-watchlist.json"),
    `${JSON.stringify({ account_id: "main", watchlist: [] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(configDir, "asset_master.json"),
    `${JSON.stringify(
      {
        assets: [
          {
            symbol: "016482",
            name: "兴全恒信债券C",
            execution_type: "OTC",
            strategy_regime: {
              type: "dividend_carry",
            },
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("core_data_ingestion", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.rebind_runtime_paths(Path("${tempDir}"))
print(json.dumps(module.collect_fund_specs(), ensure_ascii=False))
    `,
  ]);

  const specs = JSON.parse(stdout.trim() || "[]");
  assert.ok(specs.some((item) => item.symbol === "016482"));
});

test("core_data_ingestion keeps ETF adjusted close separate from raw close", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util, json, pandas as pd
from datetime import date
spec = importlib.util.spec_from_file_location("core_data_ingestion", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.DailyPriceRecord.model_rebuild(_types_namespace={"date": date})
module.MAX_CN_EXCHANGE_ETF_RETRIES = 1

def fake_hist_em(symbol, period, start_date, end_date, adjust=""):
    if adjust == "":
        return pd.DataFrame([{"日期":"2026-04-01","开盘":10.0,"最高":10.5,"最低":9.8,"收盘":10.0,"成交量":1000}])
    if adjust == "qfq":
        return pd.DataFrame([{"日期":"2026-04-01","开盘":9.0,"最高":9.4,"最低":8.8,"收盘":9.0,"成交量":1000}])
    raise ValueError(f"unexpected adjust={adjust}")

module.ak.fund_etf_hist_em = fake_hist_em
records = module.build_cn_exchange_etf_records({"symbol":"513100","provider":"akshare","asset_type":"cn_exchange_etf"})
record = records[0]
print(json.dumps({"close": record.close, "adj_close": record.adj_close}, ensure_ascii=False))
    `,
  ]);

  const record = JSON.parse(stdout.trim());
  assert.equal(record.close, 10);
  assert.equal(record.adj_close, 9);
});

test("core_data_ingestion derives historical OTC universe from holdings snapshots even without watchlist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-lake-historical-universe-"));
  const configDir = path.join(tempDir, "config");
  const holdingsDir = path.join(tempDir, "holdings");
  await mkdir(configDir, { recursive: true });
  await mkdir(holdingsDir, { recursive: true });

  await writeFile(
    path.join(tempDir, "fund-watchlist.json"),
    `${JSON.stringify({ account_id: "main", watchlist: [] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(configDir, "asset_master.json"),
    `${JSON.stringify({ assets: [] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(holdingsDir, "2026-03-01.json"),
    `${JSON.stringify(
      {
        positions: [
          {
            fund_code: "123456",
            name: "历史基金A",
            amount: 1000,
            status: "inactive",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("core_data_ingestion", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.rebind_runtime_paths(Path("${tempDir}"))
print(json.dumps(module.collect_fund_specs(), ensure_ascii=False))
    `,
  ]);

  const specs = JSON.parse(stdout.trim() || "[]");
  assert.ok(specs.some((item) => item.symbol === "123456" && String(item.source_tags || "").includes("historical_snapshot")));
});

test("core_data_ingestion derives non-flat OHLC for OTC NAV history", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util, json, pandas as pd
from datetime import date
spec = importlib.util.spec_from_file_location("core_data_ingestion", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.DailyPriceRecord.model_rebuild(_types_namespace={"date": date})

module.ak.fund_open_fund_info_em = lambda symbol, indicator: pd.DataFrame([
    {"净值日期":"2026-04-01","单位净值":1.00},
    {"净值日期":"2026-04-02","单位净值":1.10},
])

records = module.build_fund_records({"symbol":"025209","provider":"akshare","asset_type":"cn_fund","name":"测试基金"}, "单位净值走势")
second = records[1]
print(json.dumps({"open": second.open, "high": second.high, "low": second.low, "close": second.close}, ensure_ascii=False))
    `,
  ]);

  const second = JSON.parse(stdout.trim());
  assert.equal(second.open, 1);
  assert.equal(second.high, 1.1);
  assert.equal(second.low, 1);
  assert.equal(second.close, 1.1);
});

test("core_data_ingestion preserves fresher daily price rows when a lower-quality source arrives later", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util, json, sqlite3, tempfile
from datetime import date

spec = importlib.util.spec_from_file_location("core_data_ingestion", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.DailyPriceRecord.model_rebuild(_types_namespace={"date": date})

db_path = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
connection = sqlite3.connect(db_path)
module.ensure_schema(connection)

fresh = module.DailyPriceRecord(
    symbol="513100",
    date=date(2026, 4, 1),
    open=10.0,
    high=10.5,
    low=9.8,
    close=10.0,
    adj_close=9.0,
    volume=1000.0,
    provider="akshare",
    asset_type="cn_exchange_etf",
    name="纳指ETF",
    close_source="fund_etf_hist_em",
    source_tags="qfq"
)
stale = module.DailyPriceRecord(
    symbol="513100",
    date=date(2026, 4, 1),
    open=10.0,
    high=10.5,
    low=9.8,
    close=10.0,
    adj_close=10.0,
    volume=1000.0,
    provider="akshare",
    asset_type="cn_exchange_etf",
    name="纳指ETF",
    close_source="fund_etf_hist_sina",
    source_tags=None
)

module.upsert_records(connection, [fresh])
module.upsert_records(connection, [stale])
row = connection.execute(
    "SELECT close_source, adj_close, source_tags FROM daily_prices WHERE symbol='513100' AND date='2026-04-01'"
).fetchone()
connection.close()
print(json.dumps({"close_source": row[0], "adj_close": row[1], "source_tags": row[2]}, ensure_ascii=False))
    `,
  ]);

  const record = JSON.parse(stdout.trim());
  assert.equal(record.close_source, "fund_etf_hist_em");
  assert.equal(record.adj_close, 9);
  assert.equal(record.source_tags, "qfq");
});
