import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VENV_PYTHON = "/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3";

test("fund name normalization stays consistent across trading and analytics scripts", async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, [
    "-c",
    `
import importlib.util
import json

targets = {
    "trade_generator": "/Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py",
    "calculate_quant_metrics": "/Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py",
    "generate_fund_signals_matrix": "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.py",
    "generate_correlation_matrix": "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_correlation_matrix.py",
}
name = "华夏纳斯达克100ETF发起式联接(QDII)人民币A"
results = {}
for key, path in targets.items():
    spec = importlib.util.spec_from_file_location(key, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    func = getattr(module, "normalize_fund_name", None) or getattr(module, "normalize_name", None)
    results[key] = func(name)
print(json.dumps(results, ensure_ascii=False))
    `.trim(),
  ]);

  const payload = JSON.parse(stdout.trim());
  const values = Object.values(payload);
  assert.equal(new Set(values).size, 1);
  assert.equal(values[0], "华夏纳斯达克100A");
});
