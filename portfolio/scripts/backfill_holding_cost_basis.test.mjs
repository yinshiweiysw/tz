import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { runHoldingCostBasisBackfill } from "./backfill_holding_cost_basis.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("runHoldingCostBasisBackfill reconstructs conversion-merged gold cost basis from historical holdings", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "holding-cost-backfill-"));
  const latestRawPath = path.join(portfolioRoot, "snapshots", "latest_raw.json");
  const portfolioStatePath = path.join(portfolioRoot, "state", "portfolio_state.json");
  const holdingPath = path.join(portfolioRoot, "holdings", "2026-03-25.json");

  await writeJson(latestRawPath, {
    snapshot_date: "2026-04-07",
    positions: [
      {
        name: "国泰黄金ETF联接E",
        code: "022502",
        symbol: "022502",
        fund_code: "022502",
        amount: 36320.63,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: []
  });
  await writeJson(portfolioStatePath, {
    snapshot_date: "2026-04-07",
    positions: [
      {
        name: "国泰黄金ETF联接E",
        code: "022502",
        symbol: "022502",
        fund_code: "022502",
        amount: 36320.63,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        status: "active",
        execution_type: "OTC"
      }
    ]
  });
  await writeJson(holdingPath, {
    snapshot_date: "2026-03-25",
    positions: [
      {
        name: "国泰黄金ETF联接E",
        code: "022502",
        amount: 2000,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        status: "active",
        execution_type: "OTC"
      },
      {
        name: "工银瑞信黄金ETF联接C",
        amount: 29320.63,
        holding_pnl: -1556.1,
        holding_pnl_rate_pct: -5.04,
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: [
      "2026-03-25 用户计划在 15:00 前将工银瑞信黄金ETF联接C 转换到国泰黄金ETF联接E，作为同主题合并；在转换确认前，当前持仓仍保留原始截图金额。"
    ]
  });

  const result = await runHoldingCostBasisBackfill({
    portfolioRoot
  });

  assert.equal(result.updatedPositions, 1);
  assert.equal(result.reviewRequired.length, 0);

  const updatedRaw = JSON.parse(await readFile(latestRawPath, "utf8"));
  const position = updatedRaw.positions[0];
  assert.equal(position.holding_cost_basis_cny, 32876.73);
  assert.equal(position.holding_pnl, 3443.9);
  assert.equal(position.holding_cost_basis_source, "historical_conversion_snapshot");
  assert.equal(position.holding_cost_basis_confidence, "high");
});

test("runHoldingCostBasisBackfill does not use undersized early snapshots for later heavily added positions", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "holding-cost-backfill-scale-"));
  const latestRawPath = path.join(portfolioRoot, "snapshots", "latest_raw.json");
  const portfolioStatePath = path.join(portfolioRoot, "state", "portfolio_state.json");
  const holdingPath = path.join(portfolioRoot, "holdings", "2026-03-25.json");

  await writeJson(latestRawPath, {
    snapshot_date: "2026-04-07",
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        code: "007339",
        symbol: "007339",
        fund_code: "007339",
        amount: 21000.01,
        holding_pnl: 19000.01,
        holding_pnl_rate_pct: 0,
        holding_cost_basis_cny: 2000,
        holding_cost_basis_source: "historical_position_snapshot",
        status: "active",
        execution_type: "OTC"
      }
    ],
    recognition_notes: []
  });
  await writeJson(portfolioStatePath, {
    snapshot_date: "2026-04-07",
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        code: "007339",
        symbol: "007339",
        fund_code: "007339",
        amount: 21000.01,
        holding_pnl: 19000.01,
        holding_pnl_rate_pct: 0,
        holding_cost_basis_cny: 2000,
        holding_cost_basis_source: "historical_position_snapshot",
        status: "active",
        execution_type: "OTC"
      }
    ]
  });
  await writeJson(holdingPath, {
    snapshot_date: "2026-03-25",
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        code: "007339",
        amount: 2000.01,
        holding_pnl: 0.01,
        holding_pnl_rate_pct: 0,
        status: "active",
        execution_type: "OTC"
      }
    ]
  });

  const result = await runHoldingCostBasisBackfill({
    portfolioRoot
  });

  assert.equal(result.updatedPositions, 0);
  assert.deepEqual(result.reviewRequired, [
    {
      code: "007339",
      name: "易方达沪深300ETF联接C"
    }
  ]);

  const updatedRaw = JSON.parse(await readFile(latestRawPath, "utf8"));
  assert.equal(updatedRaw.positions[0].holding_cost_basis_cny, 21000.01);
  assert.equal(updatedRaw.positions[0].holding_pnl, 0);
  assert.equal(updatedRaw.positions[0].holding_cost_basis_source, "snapshot_seed_amount");
});
