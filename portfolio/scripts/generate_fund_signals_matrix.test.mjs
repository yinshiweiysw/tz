import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.py";
const VENV_PYTHON = "/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3";

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
