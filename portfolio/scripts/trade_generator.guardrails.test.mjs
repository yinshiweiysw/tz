import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py";

test("trade_generator caps aggregate daily buy flow across multiple assets", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "trade-generator-guardrails-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "signals"), { recursive: true }),
  ]);

  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        positions: [],
        summary: {
          total_fund_assets: 0,
          available_cash_cny: 100000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
        },
        cash_ledger: {
          available_cash_cny: 100000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "account_context.json"),
    `${JSON.stringify(
      {
        available_cash_cny: 100000,
        reported_cash_estimate_cny: 100000,
        reported_total_assets_range_cny: { min: 100000, max: 100000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(portfolioRoot, "fund-watchlist.json"), `${JSON.stringify({ watchlist: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        bucket_order: ["A_CORE", "INCOME", "TACTICAL", "CASH"],
        buckets: {
          A_CORE: { label: "A股", target: 0.2, min: 0.1, max: 0.3, priority_rank: 1, is_equity_like: true },
          INCOME: { label: "红利", target: 0.1, min: 0.05, max: 0.15, priority_rank: 2, is_equity_like: true },
          TACTICAL: { label: "战术", target: 0.06, min: 0, max: 0.1, priority_rank: 3, is_equity_like: true },
          CASH: { label: "现金", target: 0.34, min: 0.2, max: 0.5, priority_rank: 99, is_equity_like: false },
        },
        assets: [
          { symbol: "000001", name: "测试基金一", execution_type: "OTC", bucket: "A_CORE" },
          { symbol: "000002", name: "测试基金二", execution_type: "OTC", bucket: "INCOME" },
          { symbol: "000003", name: "测试基金三", execution_type: "OTC", bucket: "TACTICAL" },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "macro_state.json"),
    `${JSON.stringify({ generated_at: "2026-04-07T10:00:00+08:00", factors: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "signals", "regime_router_signals.json"),
    `${JSON.stringify(
      {
        generated_at: "2026-04-07T10:30:00+08:00",
        risk_budget: { cash_reserve_pct: 0 },
        signals: {
          "000001": {
            symbol: "000001",
            name: "测试基金一",
            bucket: "A_CORE",
            bucket_priority_rank: 1,
            execution_type: "OTC",
            Action: "Buy",
            Weight_Target: 0.15,
            execution_context: { target_amount_cny: 15000 },
          },
          "000002": {
            symbol: "000002",
            name: "测试基金二",
            bucket: "INCOME",
            bucket_priority_rank: 2,
            execution_type: "OTC",
            Action: "Buy",
            Weight_Target: 0.15,
            execution_context: { target_amount_cny: 15000 },
          },
          "000003": {
            symbol: "000003",
            name: "测试基金三",
            bucket: "TACTICAL",
            bucket_priority_rank: 3,
            execution_type: "OTC",
            Action: "Buy",
            Weight_Target: 0.15,
            execution_context: { target_amount_cny: 15000 },
          },
        },
        errors: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const outputJson = path.join(portfolioRoot, "data", "trade_plan_v4.json");
  await execFileAsync(
    "python3",
    [SCRIPT_PATH, "--portfolio-root", portfolioRoot, "--date", "2026-04-07", "--output-json", outputJson],
    { cwd: "/Users/yinshiwei/codex/tz" }
  );

  const payload = JSON.parse(await readFile(outputJson, "utf8"));
  const buyTrades = payload.trades.filter((item) => item.execution_action === "Buy");
  const totalBuy = buyTrades.reduce((sum, item) => sum + Number(item.planned_trade_amount_cny ?? 0), 0);

  assert.equal(totalBuy, 20000);
  assert.equal(buyTrades[0]?.planned_trade_amount_cny, 15000);
  assert.equal(buyTrades[1]?.planned_trade_amount_cny, 5000);
  assert.match(
    `${buyTrades[1]?.decision_note ?? ""}\n${payload.suppressed.map((item) => item.decision_note).join("\n")}`,
    /全局|日度|剩余额度|限额/
  );
});

test("trade_generator prefers canonical portfolio_state cash semantics over stale account_context", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "trade-generator-cash-guardrails-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "signals"), { recursive: true }),
  ]);

  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        positions: [],
        summary: {
          total_portfolio_assets_cny: 320000,
          total_fund_assets: 140000,
          settled_cash_cny: 180000,
          trade_available_cash_cny: 50000,
          available_cash_cny: 180000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
        },
        cash_ledger: {
          settled_cash_cny: 180000,
          trade_available_cash_cny: 50000,
          available_cash_cny: 180000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "account_context.json"),
    `${JSON.stringify(
      {
        available_cash_cny: 180000,
        reported_cash_estimate_cny: 180000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(portfolioRoot, "fund-watchlist.json"), `${JSON.stringify({ watchlist: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify(
      {
        bucket_order: ["A_CORE", "CASH"],
        buckets: {
          A_CORE: { label: "A股", target: 0.2, min: 0.1, max: 0.3, priority_rank: 1, is_equity_like: true },
          CASH: { label: "现金", target: 0.8, min: 0.7, max: 0.9, priority_rank: 99, is_equity_like: false },
        },
        assets: [
          { symbol: "000001", name: "测试基金一", execution_type: "OTC", bucket: "A_CORE" },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "macro_state.json"),
    `${JSON.stringify({ generated_at: "2026-04-07T10:00:00+08:00", factors: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "signals", "regime_router_signals.json"),
    `${JSON.stringify(
      {
        generated_at: "2026-04-07T10:30:00+08:00",
        risk_budget: { cash_reserve_pct: 0 },
        signals: {},
        errors: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const outputJson = path.join(portfolioRoot, "data", "trade_plan_v4.json");
  await execFileAsync(
    "python3",
    [SCRIPT_PATH, "--portfolio-root", portfolioRoot, "--date", "2026-04-07", "--output-json", outputJson],
    { cwd: "/Users/yinshiwei/codex/tz" }
  );

  const payload = JSON.parse(await readFile(outputJson, "utf8"));
  assert.equal(payload.portfolio_context.total_portfolio_value_cny, 320000);
  assert.equal(payload.portfolio_context.cash_estimate_cny, 50000);
  assert.equal(
    payload.portfolio_context.cash_estimate_source,
    "portfolio_state.summary.trade_available_cash_cny"
  );
});

test("trade_generator falls back to historical T+1 holdings when sellable_shares is missing", async () => {
  const { stdout, stderr } = await execFileAsync("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3", [
    "-c",
    `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("trade_generator", "${SCRIPT_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

planner = module.TradePlanner.__new__(module.TradePlanner)
sellable = planner._resolve_sellable_shares(
    position={"shares": 1200},
    current_shares=1200,
    settlement_rule="T+1",
)
print(json.dumps({"sellable": sellable}, ensure_ascii=False))
    `,
  ]);

  assert.equal(stderr, "");
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.sellable, 1200);
});
