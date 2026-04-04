import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  deriveLiveDashboardPositionSets,
  isAutoMarkToMarketWritebackEnabled,
  materializeLatestMarkToMarket
} from "./serve_funds_live_dashboard.mjs";

test("deriveLiveDashboardPositionSets keeps future OTC pending buys out of active positions", () => {
  const sets = deriveLiveDashboardPositionSets(
    {
      positions: [],
      pending_profit_effective_positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          amount: 4000,
          daily_pnl: 123.45,
          execution_type: "OTC",
          profit_effective_on: "2026-04-07"
        }
      ]
    },
    "2026-04-03"
  );

  assert.equal(sets.effectiveActivePositions.length, 0);
  assert.equal(sets.futurePendingPositions.length, 1);
  assert.equal(sets.futurePendingPositions[0].amount, 4000);
});

test("deriveLiveDashboardPositionSets materializes matured pending buys into active view only on effective date", () => {
  const sets = deriveLiveDashboardPositionSets(
    {
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          amount: 10000,
          daily_pnl: -50,
          execution_type: "OTC",
          status: "active"
        }
      ],
      pending_profit_effective_positions: [
        {
          name: "易方达沪深300ETF联接C",
          code: "007339",
          amount: 4000,
          daily_pnl: 999,
          execution_type: "OTC",
          profit_effective_on: "2026-04-03"
        }
      ]
    },
    "2026-04-03"
  );

  assert.equal(sets.futurePendingPositions.length, 0);
  assert.equal(sets.effectiveActivePositions.length, 1);
  assert.equal(sets.effectiveActivePositions[0].amount, 14000);
});

test("auto mark-to-market writeback is disabled by default", () => {
  assert.equal(isAutoMarkToMarketWritebackEnabled({}), false);
  assert.equal(
    isAutoMarkToMarketWritebackEnabled({ FUNDS_DASHBOARD_ENABLE_AUTO_MARK_TO_MARKET: "1" }),
    true
  );
});

test("materializeLatestMarkToMarket does not mutate raw snapshot when writeback is disabled", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-"));
  await mkdir(path.join(portfolioRoot, "snapshots"), { recursive: true });

  const rawSnapshotPath = path.join(portfolioRoot, "snapshots", "latest_raw.json");
  const originalRawSnapshot = {
    snapshot_date: "2026-04-02",
    positions: [
      {
        name: "兴全恒信债券C",
        code: "016482",
        symbol: "016482",
        fund_code: "016482",
        amount: 50000,
        holding_pnl: 0,
        holding_pnl_rate_pct: 0,
        status: "active",
        execution_type: "OTC"
      }
    ],
    summary: {
      available_cash_cny: 1000
    }
  };
  await writeFile(rawSnapshotPath, `${JSON.stringify(originalRawSnapshot, null, 2)}\n`, "utf8");

  const result = await materializeLatestMarkToMarket(
    portfolioRoot,
    {
      snapshotDate: "2026-04-02",
      generatedAt: "2026-04-03T04:00:00.000Z",
      summary: {
        availableCashCny: 1000,
        totalPortfolioAssets: 71000
      },
      rows: [
        {
          name: "兴全恒信债券C",
          code: "016482",
          amount: 70000,
          ledgerAmount: 70000,
          holdingPnl: 0,
          ledgerHoldingPnl: 0,
          holdingPnlRatePct: 0,
          ledgerHoldingPnlRatePct: 0,
          quoteDate: "2026-04-03"
        }
      ]
    }
  );

  assert.equal(result.updated, false);
  assert.equal(result.disabledReason, "auto_mark_to_market_writeback_disabled");

  const persisted = JSON.parse(await readFile(rawSnapshotPath, "utf8"));
  assert.deepEqual(persisted, originalRawSnapshot);
});

test("materializeLatestMarkToMarket refuses to advance snapshot when confirmed nav is not ready", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-confirmed-"));
  await mkdir(path.join(portfolioRoot, "snapshots"), { recursive: true });

  const previousFlag = process.env.FUNDS_DASHBOARD_ENABLE_AUTO_MARK_TO_MARKET;
  process.env.FUNDS_DASHBOARD_ENABLE_AUTO_MARK_TO_MARKET = "1";

  try {
    const rawSnapshotPath = path.join(portfolioRoot, "snapshots", "latest_raw.json");
    const originalRawSnapshot = {
      account_id: "main",
      snapshot_date: "2026-04-02",
      positions: [
        {
          name: "兴全恒信债券C",
          code: "016482",
          symbol: "016482",
          fund_code: "016482",
          amount: 50000,
          holding_pnl: 0,
          holding_pnl_rate_pct: 0,
          status: "active",
          execution_type: "OTC"
        }
      ],
      summary: {
        total_fund_assets: 50000,
        effective_exposure_after_pending_sell: 50000,
        yesterday_profit: 0,
        holding_profit: 0,
        available_cash_cny: 1000,
        total_portfolio_assets_cny: 51000
      },
      cash_ledger: {
        available_cash_cny: 1000
      }
    };
    await writeFile(rawSnapshotPath, `${JSON.stringify(originalRawSnapshot, null, 2)}\n`, "utf8");

    const result = await materializeLatestMarkToMarket(portfolioRoot, {
      snapshotDate: "2026-04-02",
      generatedAt: "2026-04-03T07:30:00.000Z",
      confirmedNavStatus: {
        state: "partially_confirmed_normal_lag",
        targetDate: "2026-04-03"
      },
      summary: {
        availableCashCny: 1000,
        totalPortfolioAssets: 71000,
        estimatedDailyPnl: 120
      },
      rows: [
        {
          name: "兴全恒信债券C",
          code: "016482",
          amount: 50120,
          ledgerAmount: 50000,
          holdingPnl: 120,
          ledgerHoldingPnl: 0,
          holdingPnlRatePct: 0.24,
          ledgerHoldingPnlRatePct: 0,
          quoteDate: "2026-04-03",
          quoteMode: "close_reference"
        }
      ]
    });

    assert.equal(result.updated, false);
    assert.equal(result.disabledReason, "confirmed_nav_not_ready_for_writeback");

    const persisted = JSON.parse(await readFile(rawSnapshotPath, "utf8"));
    assert.deepEqual(persisted, originalRawSnapshot);
  } finally {
    if (previousFlag === undefined) {
      delete process.env.FUNDS_DASHBOARD_ENABLE_AUTO_MARK_TO_MARKET;
    } else {
      process.env.FUNDS_DASHBOARD_ENABLE_AUTO_MARK_TO_MARKET = previousFlag;
    }
  }
});

test("annotateRowConfirmation exposes overseas overnight carry against current china date", async () => {
  const module = await import("./serve_funds_live_dashboard.mjs");
  assert.equal(typeof module.annotateRowConfirmation, "function");

  const annotated = module.annotateRowConfirmation(
    {
      intradayQuoteDate: "2026-04-03",
      intradayUpdateTime: "2026-04-03 04:00",
      intradayChangePct: 1.44,
      intradayEstimatedPnl: 152.74,
      quoteDate: "2026-04-03",
      quoteMode: "confirmed_nav",
      confirmedNavDate: "2026-04-01",
      sessionPolicy: {
        profile: "global_qdii",
        openTime: "09:30",
        closeTime: "15:00"
      }
    },
    {
      name: "华宝海外科技股票(QDII-LOF)C",
      category: "QDII",
      market: "US"
    },
    {
      market: "US",
      category: "QDII"
    },
    {
      confirmedTargetDate: "2026-04-02",
      currentDate: "2026-04-03"
    }
  );

  assert.equal(annotated.confirmationState, "normal_lag");
  assert.equal(annotated.expectedConfirmedDate, "2026-04-01");
  assert.equal(annotated.overnightCarryPnl, 152.74);
  assert.equal(annotated.overnightCarryLabel, "待确认收益 对应 2026-04-02");
  assert.equal(annotated.overnightCarryReferenceDate, "2026-04-02");
});
