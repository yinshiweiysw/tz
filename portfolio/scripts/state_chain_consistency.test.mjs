import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { materializePortfolioRoot } from "./lib/portfolio_state_materializer.mjs";

test("materializePortfolioRoot aligns execution_ledger as_of_snapshot_date with portfolio_state snapshot_date", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "state-chain-align-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "snapshots"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "ledger"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
  ]);

  await writeFile(
    path.join(portfolioRoot, "snapshots", "latest_raw.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-03",
        currency: "CNY",
        summary: {
          total_fund_assets: 13000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
          effective_exposure_after_pending_sell: 13000,
          yesterday_profit: 0,
          holding_profit: 200,
          cumulative_profit: 200,
          available_cash_cny: 5000,
          total_portfolio_assets_cny: 18000,
        },
        raw_account_snapshot: {
          total_fund_assets: 13000,
        },
        cash_ledger: {
          available_cash_cny: 5000,
          pending_buy_confirm_cny: 0,
          pending_sell_to_arrive_cny: 0,
        },
        positions: [
          {
            name: "测试债基",
            amount: 10000,
            holding_pnl: 200,
            holding_pnl_rate_pct: 2,
            category: "偏债混合",
            status: "active",
            execution_type: "OTC",
            code: "016482",
            symbol: "016482",
            fund_code: "016482",
          },
          {
            name: "测试场内ETF",
            amount: 3000,
            shares: 1000,
            sellable_shares: 1000,
            cost_price: 3,
            category: "美股场内代理",
            status: "active",
            execution_type: "EXCHANGE",
            symbol: "513100",
            ticker: "513100",
          },
          {
            name: "已卖出基金",
            amount: 0,
            holding_pnl: 0,
            holding_pnl_rate_pct: 0,
            category: "A股宽基",
            status: "user_confirmed_sold",
            execution_type: "OTC",
            code: "007339",
            symbol: "007339",
            fund_code: "007339",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(portfolioRoot, "ledger", "execution_ledger.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        account_id: "main",
        as_of_snapshot_date: "2026-03-30",
        created_at: "2026-04-07T01:00:00.000Z",
        updated_at: "2026-04-07T01:00:00.000Z",
        entries: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await materializePortfolioRoot({
    portfolioRoot,
    accountId: "main",
    referenceDate: "2026-04-03",
    seedMissing: false,
  });

  const portfolioState = JSON.parse(await readFile(path.join(portfolioRoot, "state", "portfolio_state.json"), "utf8"));
  const executionLedger = JSON.parse(await readFile(path.join(portfolioRoot, "ledger", "execution_ledger.json"), "utf8"));

  assert.equal(portfolioState.snapshot_date, "2026-04-03");
  assert.equal(executionLedger.as_of_snapshot_date, portfolioState.snapshot_date);
});

test("materialized latest.json stays a pure OTC compatibility view", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "state-chain-compat-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "snapshots"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "ledger"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
  ]);

  await writeFile(
    path.join(portfolioRoot, "snapshots", "latest_raw.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-03",
        currency: "CNY",
        summary: {
          total_fund_assets: 13000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
          effective_exposure_after_pending_sell: 13000,
          yesterday_profit: 0,
          holding_profit: 200,
          cumulative_profit: 200,
          available_cash_cny: 5000,
          total_portfolio_assets_cny: 18000,
        },
        raw_account_snapshot: {
          total_fund_assets: 13000,
        },
        cash_ledger: {
          available_cash_cny: 5000,
          pending_buy_confirm_cny: 0,
          pending_sell_to_arrive_cny: 0,
        },
        positions: [
          {
            name: "测试债基",
            amount: 10000,
            holding_pnl: 200,
            holding_pnl_rate_pct: 2,
            category: "偏债混合",
            status: "active",
            execution_type: "OTC",
            code: "016482",
            symbol: "016482",
            fund_code: "016482",
          },
          {
            name: "测试场内ETF",
            amount: 3000,
            shares: 1000,
            sellable_shares: 1000,
            cost_price: 3,
            category: "美股场内代理",
            status: "active",
            execution_type: "EXCHANGE",
            symbol: "513100",
            ticker: "513100",
          },
          {
            name: "已卖出基金",
            amount: 0,
            holding_pnl: 0,
            holding_pnl_rate_pct: 0,
            category: "A股宽基",
            status: "user_confirmed_sold",
            execution_type: "OTC",
            code: "007339",
            symbol: "007339",
            fund_code: "007339",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(portfolioRoot, "ledger", "execution_ledger.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        account_id: "main",
        as_of_snapshot_date: "2026-04-03",
        created_at: "2026-04-07T01:00:00.000Z",
        updated_at: "2026-04-07T01:00:00.000Z",
        entries: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await materializePortfolioRoot({
    portfolioRoot,
    accountId: "main",
    referenceDate: "2026-04-03",
    seedMissing: false,
  });

  const latestCompat = JSON.parse(await readFile(path.join(portfolioRoot, "latest.json"), "utf8"));
  assert.deepEqual(
    latestCompat.positions.map((item) => ({ name: item.name, execution_type: item.execution_type, status: item.status })),
    [{ name: "测试债基", execution_type: "OTC", status: "active" }]
  );
});
