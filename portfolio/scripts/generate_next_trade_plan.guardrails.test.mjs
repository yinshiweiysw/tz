import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs";

test("generate_next_trade_plan emits blocked_market_data when regime signals contain hard errors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "next-trade-plan-guard-"));
  const configDir = path.join(tempDir, "config");
  const dataDir = path.join(tempDir, "data");
  const signalsDir = path.join(tempDir, "signals");
  const reportsDir = path.join(tempDir, "reports");
  const stateDir = path.join(tempDir, "state");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(signalsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  const assetMasterPath = path.join(configDir, "asset_master.json");
  const accountContextPath = path.join(tempDir, "account_context.json");
  const macroStatePath = path.join(dataDir, "macro_state.json");
  const signalsPath = path.join(signalsDir, "regime_router_signals.json");
  const statePath = path.join(stateDir, "portfolio_state.json");
  const watchlistPath = path.join(tempDir, "fund-watchlist.json");
  const outputJsonPath = path.join(dataDir, "trade_plan_v4.json");
  const reportPath = path.join(reportsDir, "2026-04-07-next-trade-plan.md");

  await writeFile(
    assetMasterPath,
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A股核心", target: 0.2, min: 0.05, max: 0.25, priority_rank: 1, is_equity_like: true },
          CASH: { label: "现金", target: 0.35, min: 0.25, max: 0.4, priority_rank: 99, is_equity_like: false },
        },
        performance_benchmark: { sleeves: [{ bucket: "A_CORE", weight: 0.2 }] },
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
        available_cash_cny: 150000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    macroStatePath,
    `${JSON.stringify(
      {
        generated_at: "2026-04-07T10:00:00+08:00",
        factors: {},
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        generated_at: "2026-04-07T10:30:00+08:00",
        positions: [],
        summary: {
          total_fund_assets: 0,
          available_cash_cny: 150000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
        },
        cash_ledger: {
          available_cash_cny: 150000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    watchlistPath,
    `${JSON.stringify({ watchlist: [] }, null, 2)}\n`,
    "utf8"
  );

  await writeFile(
    signalsPath,
    `${JSON.stringify(
      {
        version: 3,
        generated_at: "2026-04-07T10:35:00+08:00",
        source: {
          asset_master: assetMasterPath,
          account_context: accountContextPath,
          macro_state: macroStatePath,
        },
        errors: [
          {
            symbol: "007339",
            message: "no such table: daily_prices",
          },
        ],
        signals: {},
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await execFileAsync("node", [
    SCRIPT_PATH,
    "--portfolio-root",
    tempDir,
    "--date",
    "2026-04-07",
    "--output-json",
    outputJsonPath,
    "--report-path",
    reportPath,
  ], {
    cwd: "/Users/yinshiwei/codex/tz",
  });

  const output = JSON.parse(await readFile(outputJsonPath, "utf8"));
  assert.equal(output?.summary?.plan_state, "blocked_market_data");
  assert.ok(Array.isArray(output?.blocking_reasons));
  assert.match(output.blocking_reasons.join("\n"), /daily_prices/i);
  assert.equal(output?.summary?.actionable_trade_count, 0);
});

test("generate_next_trade_plan accepts fresh materialized state even when raw snapshot date is older", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "next-trade-plan-fresh-state-"));
  const configDir = path.join(tempDir, "config");
  const dataDir = path.join(tempDir, "data");
  const signalsDir = path.join(tempDir, "signals");
  const reportsDir = path.join(tempDir, "reports");
  const stateDir = path.join(tempDir, "state");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(signalsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  const assetMasterPath = path.join(configDir, "asset_master.json");
  const accountContextPath = path.join(tempDir, "account_context.json");
  const macroStatePath = path.join(dataDir, "macro_state.json");
  const signalsPath = path.join(signalsDir, "regime_router_signals.json");
  const statePath = path.join(stateDir, "portfolio_state.json");
  const watchlistPath = path.join(tempDir, "fund-watchlist.json");
  const outputJsonPath = path.join(dataDir, "trade_plan_v4.json");
  const reportPath = path.join(reportsDir, "2026-04-07-next-trade-plan.md");

  await writeFile(
    assetMasterPath,
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A股核心", target: 0.2, min: 0.05, max: 0.25, priority_rank: 1, is_equity_like: true },
          CASH: { label: "现金", target: 0.35, min: 0.25, max: 0.4, priority_rank: 99, is_equity_like: false },
        },
        performance_benchmark: { sleeves: [{ bucket: "A_CORE", weight: 0.2 }] },
        assets: [],
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
        available_cash_cny: 150000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    macroStatePath,
    `${JSON.stringify(
      {
        generated_at: "2026-04-07T10:00:00+08:00",
        factors: {},
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-03",
        strategy_effective_date: "2026-04-07",
        materialization: {
          reference_date: "2026-04-07",
        },
        positions: [],
        summary: {
          total_fund_assets: 0,
          available_cash_cny: 150000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
        },
        cash_ledger: {
          available_cash_cny: 150000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    watchlistPath,
    `${JSON.stringify({ watchlist: [] }, null, 2)}\n`,
    "utf8"
  );

  await writeFile(
    signalsPath,
    `${JSON.stringify(
      {
        version: 3,
        generated_at: "2026-04-07T10:35:00+08:00",
        source: {
          asset_master: assetMasterPath,
          account_context: accountContextPath,
          macro_state: macroStatePath,
        },
        errors: [],
        signals: {},
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await execFileAsync("node", [
    SCRIPT_PATH,
    "--portfolio-root",
    tempDir,
    "--date",
    "2026-04-07",
    "--output-json",
    outputJsonPath,
    "--report-path",
    reportPath,
  ], {
    cwd: "/Users/yinshiwei/codex/tz",
  });

  const output = JSON.parse(await readFile(outputJsonPath, "utf8"));
  assert.equal(output?.plan_date, "2026-04-07");
  assert.equal(output?.summary?.actionable_trade_count, 0);
  assert.equal(output?.summary?.plan_state ?? null, null);
});

test("generate_next_trade_plan defaults plan_date to strategy_effective_date when no explicit date is passed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "next-trade-plan-default-date-"));
  const configDir = path.join(tempDir, "config");
  const dataDir = path.join(tempDir, "data");
  const signalsDir = path.join(tempDir, "signals");
  const reportsDir = path.join(tempDir, "reports");
  const stateDir = path.join(tempDir, "state");

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(signalsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  const assetMasterPath = path.join(configDir, "asset_master.json");
  const accountContextPath = path.join(tempDir, "account_context.json");
  const macroStatePath = path.join(dataDir, "macro_state.json");
  const signalsPath = path.join(signalsDir, "regime_router_signals.json");
  const statePath = path.join(stateDir, "portfolio_state.json");
  const watchlistPath = path.join(tempDir, "fund-watchlist.json");
  const outputJsonPath = path.join(dataDir, "trade_plan_v4.json");
  const reportPath = path.join(reportsDir, "next-trade-plan.md");

  await writeFile(
    assetMasterPath,
    `${JSON.stringify(
      {
        buckets: {
          A_CORE: { label: "A股核心", target: 0.2, min: 0.05, max: 0.25, priority_rank: 1, is_equity_like: true },
          CASH: { label: "现金", target: 0.35, min: 0.25, max: 0.4, priority_rank: 99, is_equity_like: false },
        },
        performance_benchmark: { sleeves: [{ bucket: "A_CORE", weight: 0.2 }] },
        assets: [],
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
        available_cash_cny: 150000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    macroStatePath,
    `${JSON.stringify(
      {
        generated_at: "2026-04-07T10:00:00+08:00",
        factors: {},
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-03",
        strategy_effective_date: "2026-04-07",
        materialization: {
          reference_date: "2026-04-07",
        },
        positions: [],
        summary: {
          total_fund_assets: 0,
          available_cash_cny: 150000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
        },
        cash_ledger: {
          available_cash_cny: 150000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(watchlistPath, `${JSON.stringify({ watchlist: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    signalsPath,
    `${JSON.stringify(
      {
        version: 3,
        generated_at: "2026-04-07T10:35:00+08:00",
        source: {
          asset_master: assetMasterPath,
          account_context: accountContextPath,
          macro_state: macroStatePath,
        },
        errors: [],
        signals: {},
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await execFileAsync("node", [
    SCRIPT_PATH,
    "--portfolio-root",
    tempDir,
    "--output-json",
    outputJsonPath,
    "--report-path",
    reportPath,
  ], {
    cwd: "/Users/yinshiwei/codex/tz",
  });

  const output = JSON.parse(await readFile(outputJsonPath, "utf8"));
  assert.equal(output?.plan_date, "2026-04-07");
});
