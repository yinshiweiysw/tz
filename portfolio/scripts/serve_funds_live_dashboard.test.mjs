import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  buildLivePayload,
  buildFundsDashboardHealth,
  createFundsLiveDashboardServer,
  deriveLiveDashboardPositionSets,
  getLivePayload,
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
    assert.equal(result.disabledReason, "canonical_truth_writeback_retired");

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

test("materializeLatestMarkToMarket stays read-only even when explicit writeback flag is enabled", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-writeback-retired-"));
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
        state: "confirmed_nav_ready",
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
    assert.equal(result.disabledReason, "canonical_truth_writeback_retired");

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

test("deriveFundCardPresentation compresses qdii normal lag into fund-style badges", async () => {
  const module = await import("./serve_funds_live_dashboard.mjs");
  assert.equal(typeof module.deriveFundCardPresentation, "function");

  const presentation = module.deriveFundCardPresentation({
    sessionPolicy: {
      profile: "global_qdii"
    },
    confirmationState: "normal_lag",
    confirmationLabel: "正常滞后 · 2026-04-03确认",
    confirmationTone: "flat",
    confirmedNavDate: "2026-04-03",
    latestConfirmedLabel: "最近确认 2026-04-03",
    overnightCarryPnl: 152.74,
    overnightCarryLabel: "待确认收益 对应 2026-04-07",
    overnightCarryReferenceDate: "2026-04-07"
  });

  assert.equal(presentation.cardLatestConfirmedLabel, "确认净值 2026-04-03");
  assert.equal(presentation.cardOvernightCarryLabel, "待确认收益 · 2026-04-07");
  assert.equal(presentation.cardConfirmationLabel, null);
  assert.equal(presentation.cardQuoteStatusText, "T+2待确认");
});

test("buildLivePayload resolves fund codes from portfolio positions even when watchlist is empty", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-resolver-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-07", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 11000, max: 11000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["A_CORE"],
          fallback_bucket_key: "A_CORE",
          buckets: {
            A_CORE: {
              label: "A股核心",
              short_label: "A股",
              target: 0.2,
              min: 0.1,
              max: 0.3,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "007339",
              name: "易方达沪深300ETF联接C",
              bucket: "A_CORE",
              market: "CN",
              category: "A股宽基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              symbol: "007339",
              fund_code: "007339",
              amount: 10000,
              status: "active",
              execution_type: "OTC"
            }
          ],
          summary: {
            total_fund_assets: 10000,
            available_cash_cny: 1000,
            holding_profit: 0,
            cumulative_profit: 0
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              targetDate: "2026-04-07",
              status: "fully_confirmed",
              stats: {
                fullyConfirmedForDate: true,
                confirmedPositions: 1,
                stalePositions: 0,
                sourceCoverage: 1
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-07",
      now: new Date("2026-04-07T14:35:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "016482",
          name: "兴全恒信债券C",
          netValueDate: "2026-04-06",
          netValue: 1.0,
          confirmedNavDate: "2026-04-06",
          confirmedNav: 1.0,
          valuation: 1.002,
          intradayValuation: 1.002,
          valuationChangePercent: 0.2,
          intradayChangePercent: 0.2,
          valuationTime: "2026-04-07",
          intradayValuationTime: "2026-04-07",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });
    const targetRow = (payload.rows ?? []).find((row) => row.name === "易方达沪深300ETF联接C");

    assert.ok(targetRow);
    assert.equal(targetRow.code, "007339");
    assert.equal(targetRow.mappingSource !== "unmapped", true);
    assert.equal(payload.summary?.mappedFundCount, 1);
    assert.equal(payload.summary?.unresolvedFundCount, 0);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload downgrades index-like confirmed-only funds to reference-only rows without inflating summary pnl", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-reference-only-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-07", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 11000, max: 11000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["A_CORE"],
          fallback_bucket_key: "A_CORE",
          buckets: {
            A_CORE: {
              label: "A股核心",
              short_label: "A股",
              target: 0.2,
              min: 0.1,
              max: 0.3,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "007339",
              name: "易方达沪深300ETF联接C",
              bucket: "A_CORE",
              market: "CN",
              category: "A股宽基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "backtest_proxy_mapping.json"),
      `${JSON.stringify(
        {
          asset_proxy_mapping: {
            hs300: {
              live_symbol: "007339",
              reference_targets: ["000300.SH", "510300.SH"]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              symbol: "007339",
              fund_code: "007339",
              amount: 10000,
              holding_pnl: 0,
              status: "active",
              execution_type: "OTC"
            }
          ],
          summary: {
            total_fund_assets: 10000,
            available_cash_cny: 1000,
            holding_profit: 0,
            cumulative_profit: 0
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              targetDate: "2026-04-07",
              status: "partially_confirmed",
              stats: {
                fullyConfirmedForDate: false,
                confirmedPositions: 0,
                stalePositions: 1,
                sourceCoverage: 0
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      fundQuoteFetcher: async () => [
        {
          code: "007339",
          name: "易方达沪深300ETF联接C",
          netValueDate: "2026-04-07",
          netValue: 1.766,
          confirmedNavDate: "2026-04-07",
          confirmedNav: 1.766,
          observationKind: "confirmed_only",
          valuation: null,
          valuationChangePercent: null,
          valuationTime: null,
          growthRate: 0
        }
      ],
      referenceQuoteFetcher: async (symbol) => ({
        stockCode: symbol,
        name: symbol === "510300.SH" ? "沪深300ETF华泰柏瑞" : "沪深300",
        changePercent: symbol === "510300.SH" ? -0.18 : 0,
        quoteTime: null,
        source: "stub_reference"
      })
    });

    const targetRow = (payload.rows ?? []).find((row) => row.code === "007339");

    assert.ok(targetRow);
    assert.equal(targetRow.quoteMode, "reference_only");
    assert.equal(targetRow.changePct, -0.18);
    assert.equal(targetRow.estimatedPnl, -18);
    assert.equal(targetRow.referenceSymbol, "510300.SH");
    assert.equal(targetRow.amount, 10000);
    assert.equal(targetRow.accountingOverlayAllowed, false);
    assert.equal(payload.summary?.observationDailyPnl, null);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload prefers canonical holding cost basis over stale holding_pnl fields", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-cost-basis-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-08", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 22000, max: 22000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["A_CORE"],
          fallback_bucket_key: "A_CORE",
          buckets: {
            A_CORE: {
              label: "A股核心",
              short_label: "A股",
              target: 0.2,
              min: 0.1,
              max: 0.3,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "007339",
              name: "易方达沪深300ETF联接C",
              bucket: "A_CORE",
              market: "CN",
              category: "A股宽基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              symbol: "007339",
              fund_code: "007339",
              amount: 21000.01,
              holding_pnl: 19000.01,
              holding_pnl_rate_pct: 950,
              holding_cost_basis_cny: 21000,
              status: "active",
              execution_type: "OTC"
            }
          ],
          summary: {
            total_fund_assets: 21000.01,
            available_cash_cny: 1000,
            holding_profit: 0.01,
            cumulative_profit: 0.01,
            total_portfolio_assets_cny: 22000.01
          },
          cash_ledger: {
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-08T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              targetDate: "2026-04-07",
              status: "fully_confirmed",
              stats: {
                fullyConfirmedForDate: true,
                confirmedPositions: 1,
                stalePositions: 0,
                sourceCoverage: 1
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-08",
      now: new Date("2026-04-08T11:30:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "007339",
          name: "易方达沪深300ETF联接C",
          netValueDate: "2026-04-07",
          netValue: 1.766,
          confirmedNavDate: "2026-04-07",
          confirmedNav: 1.766,
          valuation: 1.8147,
          intradayValuation: 1.8147,
          valuationChangePercent: 2.76,
          intradayChangePercent: 2.76,
          valuationTime: "2026-04-08 11:30",
          intradayValuationTime: "2026-04-08 11:30",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });

    const targetRow = (payload.rows ?? []).find((row) => row.code === "007339");

    assert.ok(targetRow);
    assert.equal(targetRow.costBasis, 21000);
    assert.equal(targetRow.ledgerHoldingPnl, 0.01);
    assert.equal(targetRow.holdingPnl, 579.12);
    assert.equal(targetRow.holdingPnlRatePct, 2.76);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload updates observable amount from confirmed units even when accounting snapshot is stale", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-observable-amount-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-08", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 22000, max: 22000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["A_CORE"],
          fallback_bucket_key: "A_CORE",
          buckets: {
            A_CORE: {
              label: "A股核心",
              short_label: "核心",
              target: 0.2,
              min: 0.1,
              max: 0.3,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "007339",
              name: "易方达沪深300ETF联接C",
              bucket: "A_CORE",
              market: "CN",
              category: "A股宽基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              symbol: "007339",
              fund_code: "007339",
              amount: 21000.01,
              confirmed_units: 11891.28539071,
              holding_cost_basis_cny: 21000,
              holding_pnl: 0.01,
              holding_pnl_rate_pct: 0,
              status: "active",
              execution_type: "OTC",
              category: "A股宽基"
            }
          ],
          summary: {
            total_fund_assets: 21000.01,
            available_cash_cny: 1000,
            holding_profit: 0.01,
            cumulative_profit: 0.01,
            total_portfolio_assets_cny: 22000.01
          },
          cash_ledger: {
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-08",
      now: new Date("2026-04-08T10:00:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "007339",
          name: "易方达沪深300ETF联接C",
          netValueDate: "2026-04-07",
          netValue: 1.766,
          confirmedNavDate: "2026-04-07",
          confirmedNav: 1.766,
          valuation: 1.8147,
          intradayValuation: 1.8147,
          valuationChangePercent: 2.76,
          intradayChangePercent: 2.76,
          valuationTime: "2026-04-08 10:00",
          intradayValuationTime: "2026-04-08 10:00",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });

    const targetRow = (payload.rows ?? []).find((row) => row.code === "007339");

    assert.ok(targetRow);
    assert.equal(payload.accountingState, "observation_only_stale_snapshot");
    assert.equal(targetRow.quoteMode, "live_estimate");
    assert.equal(targetRow.snapshotFreshForAccounting, false);
    assert.equal(targetRow.accountingOverlayAllowed, false);
    assert.equal(targetRow.ledgerAmount, 21000.01);
    assert.equal(targetRow.amount, 21579.12);
    assert.equal(targetRow.holdingPnl, 579.12);
    assert.equal(payload.summary.totalFundAssets, 21579.12);
    assert.equal(payload.summary.estimatedCurrentFundAssets, 21579.12);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload derives ledger amount from confirmed units and confirmed nav instead of stale stored amount", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-canonical-ledger-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-08", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 22000, max: 22000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["A_CORE"],
          fallback_bucket_key: "A_CORE",
          buckets: {
            A_CORE: {
              label: "A股核心",
              short_label: "核心",
              target: 0.2,
              min: 0.1,
              max: 0.3,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "007339",
              name: "易方达沪深300ETF联接C",
              bucket: "A_CORE",
              market: "CN",
              category: "A股宽基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-08",
          positions: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              symbol: "007339",
              fund_code: "007339",
              amount: 99999,
              confirmed_units: 11891.28539071,
              holding_cost_basis_cny: 21000,
              holding_pnl: 88888,
              holding_pnl_rate_pct: 423.28,
              status: "active",
              execution_type: "OTC",
              category: "A股宽基"
            }
          ],
          summary: {
            total_fund_assets: 99999,
            available_cash_cny: 1000,
            holding_profit: 88888,
            cumulative_profit: 88888,
            total_portfolio_assets_cny: 100999
          },
          cash_ledger: {
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-08",
      now: new Date("2026-04-08T10:00:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "007339",
          name: "易方达沪深300ETF联接C",
          netValueDate: "2026-04-08",
          netValue: 1.766,
          confirmedNavDate: "2026-04-08",
          confirmedNav: 1.766,
          valuation: 1.766,
          intradayValuation: 1.766,
          valuationChangePercent: 0,
          intradayChangePercent: 0,
          valuationTime: "2026-04-08 10:00",
          intradayValuationTime: "2026-04-08 10:00",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });

    const targetRow = (payload.rows ?? []).find((row) => row.code === "007339");

    assert.ok(targetRow);
    assert.equal(targetRow.confirmedUnits, 11891.28539071);
    assert.equal(targetRow.ledgerAmount, 21000.01);
    assert.equal(targetRow.ledgerHoldingPnl, 0.01);
    assert.equal(targetRow.amount, 21000.01);
    assert.equal(payload.summary.totalFundAssets, 21000.01);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload keeps ledger amount for close_reference hk qdii rows", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-close-reference-hk-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-08", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 70414.58, max: 70414.58 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["TACTICAL"],
          fallback_bucket_key: "TACTICAL",
          buckets: {
            TACTICAL: {
              label: "战术",
              short_label: "战术",
              target: 0.1,
              min: 0,
              max: 0.2,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "023764",
              name: "华夏恒生互联网科技业ETF联接(QDII)D",
              bucket: "TACTICAL",
              market: "HK",
              category: "港股互联网/QDII"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-08",
          positions: [
            {
              name: "华夏恒生互联网科技业ETF联接(QDII)D",
              code: "023764",
              symbol: "023764",
              fund_code: "023764",
              amount: 69414.58,
              holding_pnl: -18660.23,
              holding_pnl_rate_pct: -21.19,
              holding_cost_basis_cny: 88074.81,
              confirmed_units: 111526.24574435,
              last_confirmed_nav: 0.6461,
              last_confirmed_nav_date: "2026-04-07",
              status: "active",
              execution_type: "OTC",
              market: "HK",
              category: "港股互联网/QDII"
            }
          ],
          summary: {
            total_fund_assets: 69414.58,
            available_cash_cny: 1000,
            holding_profit: -18660.23,
            cumulative_profit: -18660.23,
            total_portfolio_assets_cny: 70414.58
          },
          cash_ledger: {
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-08T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              targetDate: "2026-04-07",
              status: "partially_confirmed_normal_lag",
              stats: {
                fullyConfirmedForDate: false,
                confirmedPositions: 1,
                stalePositions: 0,
                sourceCoverage: 1
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-08",
      now: new Date("2026-04-08T18:00:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "023764",
          name: "华夏恒生互联网科技业ETF联接(QDII)D",
          netValueDate: "2026-04-07",
          netValue: 0.6461,
          confirmedNavDate: "2026-04-07",
          confirmedNav: 0.6461,
          valuation: 0.6788,
          intradayValuation: 0.6788,
          valuationChangePercent: 5.07,
          intradayChangePercent: 5.07,
          valuationTime: "2026-04-08 16:00",
          intradayValuationTime: "2026-04-08 16:00",
          growthRate: 5.07,
          observationKind: "intraday_estimate"
        }
      ]
    });

    const targetRow = (payload.rows ?? []).find((row) => row.code === "023764");

    assert.ok(targetRow);
    assert.equal(targetRow.quoteMode, "close_reference");
    assert.equal(targetRow.ledgerAmount, 72057.11);
    assert.equal(targetRow.amount, 72057.11);
    assert.equal(targetRow.ledgerHoldingPnl, -16017.7);
    assert.equal(targetRow.holdingPnl, -16017.7);
    assert.equal(targetRow.estimatedPnl, 3653.3);
    assert.equal(payload.summary.totalFundAssets, 72057.11);
    assert.equal(payload.summary.holdingProfit, -16017.7);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload falls back to inferred observable units when confirmed_units are missing", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-inferred-observable-units-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-08", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 4000, max: 4000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["INCOME"],
          fallback_bucket_key: "INCOME",
          buckets: {
            INCOME: {
              label: "红利收息",
              short_label: "红利",
              target: 0.12,
              min: 0.08,
              max: 0.15,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "021142",
              name: "华夏港股通央企红利ETF联接A",
              bucket: "INCOME",
              market: "HK",
              category: "港股红利"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "华夏港股通央企红利ETF联接A",
              code: "021142",
              symbol: "021142",
              fund_code: "021142",
              amount: 3000,
              confirmed_units: null,
              holding_cost_basis_cny: 3000,
              holding_pnl: 0,
              holding_pnl_rate_pct: 0,
              status: "active",
              execution_type: "OTC",
              category: "港股红利"
            }
          ],
          summary: {
            total_fund_assets: 3000,
            available_cash_cny: 1000,
            holding_profit: 0,
            cumulative_profit: 0,
            total_portfolio_assets_cny: 4000
          },
          cash_ledger: {
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-08",
      now: new Date("2026-04-08T15:40:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "021142",
          name: "华夏港股通央企红利ETF联接A",
          netValueDate: "2026-04-07",
          netValue: 1.452,
          confirmedNavDate: "2026-04-07",
          confirmedNav: 1.452,
          valuation: 1.467,
          intradayValuation: 1.467,
          valuationChangePercent: 1.03,
          intradayChangePercent: 1.03,
          valuationTime: "2026-04-08 15:40",
          intradayValuationTime: "2026-04-08 15:40",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });

    const targetRow = (payload.rows ?? []).find((row) => row.code === "021142");

    assert.ok(targetRow);
    assert.equal(targetRow.snapshotFreshForAccounting, false);
    assert.equal(targetRow.accountingOverlayAllowed, false);
    assert.equal(targetRow.ledgerAmount, 3000);
    assert.equal(targetRow.amount, 3030.99);
    assert.equal(targetRow.holdingPnl, 30.99);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildLivePayload derives readiness state from row confirmations when nightly status is stale source_missing", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-confirmation-sync-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-07", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 11000, max: 11000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["GLB_MOM"],
          fallback_bucket_key: "GLB_MOM",
          buckets: {
            GLB_MOM: {
              label: "全球动量",
              short_label: "全球",
              target: 0.1,
              min: 0,
              max: 0.2,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "006075",
              name: "博时标普500ETF联接(QDII)C",
              bucket: "GLB_MOM",
              market: "US",
              category: "美股指数/QDII"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "博时标普500ETF联接(QDII)C",
              code: "006075",
              symbol: "006075",
              fund_code: "006075",
              amount: 10000,
              status: "active",
              execution_type: "OTC",
              category: "美股指数/QDII"
            }
          ],
          summary: {
            total_fund_assets: 10000,
            available_cash_cny: 1000,
            holding_profit: 0,
            cumulative_profit: 0,
            total_portfolio_assets_cny: 11000
          },
          cash_ledger: {
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              success: false,
              snapshotDate: "2026-04-07",
              stats: {
                confirmedFundCount: 0,
                normalLagFundCount: 0,
                holidayDelayFundCount: 0,
                lateMissingFundCount: 0,
                sourceMissingFundCount: 1
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      fundQuoteFetcher: async () => [
        {
          code: "006075",
          name: "博时标普500ETF联接(QDII)C",
          netValueDate: "2026-04-03",
          confirmedNavDate: "2026-04-03",
          confirmedNav: 1.0,
          netValue: 1.0,
          growthRate: 0,
          observationKind: "confirmed_only"
        }
      ],
      referenceQuoteFetcher: async () => null
    });

    assert.equal(payload.rows[0]?.confirmationState, "normal_lag");
    assert.equal(payload.summary.lateMissingFundCount, 0);
    assert.equal(payload.summary.normalLagFundCount, 1);
    assert.equal(payload.readiness.confirmedNavState, "partially_confirmed_normal_lag");
    assert.equal(payload.confirmedNavStatus.state, "partially_confirmed_normal_lag");
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildFundsDashboardHealth prefers dashboard_state readiness over stale nightly status", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-health-sync-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "博时标普500ETF联接(QDII)C",
              code: "006075",
              symbol: "006075",
              fund_code: "006075",
              amount: 10000,
              status: "active",
              execution_type: "OTC"
            }
          ],
          summary: {
            total_fund_assets: 10000,
            available_cash_cny: 1000
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify({ assets: [{ symbol: "006075", name: "博时标普500ETF联接(QDII)C", bucket: "GLB_MOM" }], buckets: { GLB_MOM: { label: "全球动量" } } }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              success: false,
              snapshotDate: "2026-04-07",
              stats: {
                confirmedFundCount: 0,
                normalLagFundCount: 0,
                holidayDelayFundCount: 0,
                lateMissingFundCount: 0,
                sourceMissingFundCount: 1
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "dashboard_state.json"),
      `${JSON.stringify(
        {
          accountId: "main",
          snapshotDate: "2026-04-07",
          readiness: {
            confirmedNavState: "late_missing"
          },
          confirmedNavStatus: {
            state: "late_missing",
            targetDate: "2026-04-07"
          },
          summary: {
            confirmedFundCount: 0,
            normalLagFundCount: 0,
            lateMissingFundCount: 1,
            confirmationCoveragePct: 0
          },
          rows: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const health = await buildFundsDashboardHealth("main");
    assert.equal(health.confirmedNavState, "late_missing");
    assert.equal(health.state, "degraded");
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("buildFundsDashboardHealth marks placeholder portfolio_state as blocked without requiring watchlist", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-health-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify({ bucket_order: [], buckets: {}, assets: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          account_id: "main",
          generated_at: "2026-04-07T00:00:00.000Z",
          status: "awaiting_materialization"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const health = await buildFundsDashboardHealth("main");
    assert.equal(health.state, "blocked");
    assert.equal(health.requiredFiles.find((item) => item.kind === "portfolio_state")?.exists, true);
    assert.match(health.reasons.join(" "), /positions\[\]/i);
    assert.equal(health.optionalFiles.find((item) => item.kind === "watchlist")?.exists, false);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("health endpoint returns degraded JSON instead of 500 when watchlist is missing but core state is readable", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-health-route-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify({ bucket_order: [], buckets: {}, assets: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-06",
          positions: [],
          summary: {}
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const server = createFundsLiveDashboardServer({
      host: "127.0.0.1",
      port: 0,
      refreshMs: 15000,
      portfolioRoot
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/live-funds/health?account=main`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.state, "degraded");
    assert.equal(payload.optionalFiles.find((item) => item.kind === "watchlist")?.exists, false);

    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("live funds endpoint returns blocked JSON instead of 503 for discoverable account without state", async () => {
  const server = createFundsLiveDashboardServer({
    host: "127.0.0.1",
    port: 0,
    refreshMs: 15000,
    portfolioRoot: "/Users/yinshiwei/codex/tz/portfolio"
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/live-funds?account=wenge`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.error, "live_dashboard_blocked");
  assert.equal(payload.readiness?.state, "blocked");
  assert.equal(payload.readiness?.accountId, "wenge");

  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("buildLivePayload exposes observation pnl while keeping accounting pnl flat for stale snapshots", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-observation-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "config"), { recursive: true });
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-07", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 0,
          reported_total_assets_range_cny: { min: 50000, max: 50000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["INCOME"],
          fallback_bucket_key: "INCOME",
          buckets: {
            INCOME: {
              label: "红利收息",
              short_label: "红利",
              target: 0.1,
              min: 0.05,
              max: 0.15,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "016482",
              name: "兴全恒信债券C",
              bucket: "INCOME",
              market: "CN",
              category: "债基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-03-30",
          positions: [
            {
              name: "兴全恒信债券C",
              code: "016482",
              symbol: "016482",
              fund_code: "016482",
              amount: 50000,
              status: "active",
              execution_type: "OTC"
            }
          ],
          summary: {
            total_fund_assets: 50000,
            available_cash_cny: 0,
            holding_profit: 0,
            cumulative_profit: 0
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              success: false,
              snapshotDate: "2026-04-06",
              error: "missing latest_raw"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await buildLivePayload(15_000, "main", {
      today: "2026-04-07",
      now: new Date("2026-04-07T14:35:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "016482",
          name: "兴全恒信债券C",
          netValueDate: "2026-04-06",
          netValue: 1.0,
          confirmedNavDate: "2026-04-06",
          confirmedNav: 1.0,
          valuation: 1.002,
          intradayValuation: 1.002,
          valuationChangePercent: 0.2,
          intradayChangePercent: 0.2,
          valuationTime: "2026-04-07",
          intradayValuationTime: "2026-04-07",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });

    assert.equal(payload.accountingState, "observation_only_stale_snapshot");
    assert.equal(payload.summary?.accountingDailyPnl, 0);
    assert.equal(typeof payload.summary?.observationDailyPnl, "number");
    assert.notEqual(payload.summary?.estimatedDailyPnlMode, "accounting");
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("live funds endpoint serves dashboard_state.json without mutating tracked state files", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-readonly-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "snapshots"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    const portfolioStatePath = path.join(portfolioRoot, "state", "portfolio_state.json");
    const latestRawPath = path.join(portfolioRoot, "snapshots", "latest_raw.json");
    const accountContextPath = path.join(portfolioRoot, "account_context.json");

    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify({ bucket_order: [], buckets: {}, assets: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      portfolioStatePath,
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [],
          summary: {}
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      latestRawPath,
      `${JSON.stringify({ snapshot_date: "2026-04-07", positions: [], summary: {} }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      accountContextPath,
      `${JSON.stringify({ available_cash_cny: 1234 }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "dashboard_state.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T08:00:00.000Z",
          accountId: "main",
          portfolioRoot,
          snapshotDate: "2026-04-07",
          readiness: { state: "ready" },
          accountingState: "snapshot_fresh_for_accounting",
          summary: {
            totalPortfolioAssets: 445000,
            settledCashCny: 160000
          },
          configuration: {},
          bucketGroups: [],
          rows: [],
          pendingRows: [],
          maturedPendingRows: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const beforePortfolioState = await readFile(portfolioStatePath, "utf8");
    const beforeLatestRaw = await readFile(latestRawPath, "utf8");
    const beforeAccountContext = await readFile(accountContextPath, "utf8");

    const server = createFundsLiveDashboardServer({
      host: "127.0.0.1",
      port: 0,
      refreshMs: 15000,
      portfolioRoot
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/live-funds?account=main`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.summary.totalPortfolioAssets, 445000);
    assert.equal(await readFile(portfolioStatePath, "utf8"), beforePortfolioState);
    assert.equal(await readFile(latestRawPath, "utf8"), beforeLatestRaw);
    assert.equal(await readFile(accountContextPath, "utf8"), beforeAccountContext);
    await assert.rejects(() => readFile(path.join(portfolioRoot, "data", "live_funds_snapshot.json"), "utf8"));

    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("getLivePayload ignores persisted dashboard_state when active holdings need live quote overlay", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "funds-dashboard-stale-persisted-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true })
  ]);

  const previousPortfolioRoot = process.env.PORTFOLIO_ROOT;

  try {
    process.env.PORTFOLIO_ROOT = portfolioRoot;

    await writeFile(
      path.join(portfolioRoot, "fund-watchlist.json"),
      `${JSON.stringify({ account_id: "main", as_of: "2026-04-08", watchlist: [] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "account_context.json"),
      `${JSON.stringify(
        {
          available_cash_cny: 1000,
          reported_total_assets_range_cny: { min: 11000, max: 11000 }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "config", "asset_master.json"),
      `${JSON.stringify(
        {
          bucket_order: ["A_CORE"],
          fallback_bucket_key: "A_CORE",
          buckets: {
            A_CORE: {
              label: "A股核心",
              short_label: "A股",
              target: 0.2,
              min: 0.1,
              max: 0.3,
              priority_rank: 10
            }
          },
          assets: [
            {
              symbol: "007339",
              name: "易方达沪深300ETF联接C",
              bucket: "A_CORE",
              market: "CN",
              category: "A股宽基"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "state", "portfolio_state.json"),
      `${JSON.stringify(
        {
          account_id: "main",
          snapshot_date: "2026-04-07",
          positions: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              symbol: "007339",
              fund_code: "007339",
              amount: 10000,
              status: "active",
              execution_type: "OTC"
            }
          ],
          summary: {
            total_fund_assets: 10000,
            available_cash_cny: 1000,
            holding_profit: 0,
            cumulative_profit: 0
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-08T00:00:00.000Z",
          accounts: [
            {
              accountId: "main",
              targetDate: "2026-04-07",
              status: "partially_confirmed_normal_lag",
              stats: {
                fullyConfirmedForDate: false,
                confirmedPositions: 0,
                stalePositions: 1,
                sourceCoverage: 0
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(portfolioRoot, "data", "dashboard_state.json"),
      `${JSON.stringify(
        {
          generatedAt: "2026-04-07T15:17:00.816Z",
          accountId: "main",
          portfolioRoot,
          snapshotDate: "2026-04-07",
          readiness: { state: "degraded" },
          accountingState: "snapshot_fresh_for_accounting",
          summary: {
            totalPortfolioAssets: 11000,
            currentFundCount: 0,
            freshFundCount: 0
          },
          configuration: {},
          bucketGroups: [],
          rows: [
            {
              name: "易方达沪深300ETF联接C",
              code: "007339",
              amount: 10000,
              quoteMode: "unavailable",
              estimatedPnl: null
            }
          ],
          pendingRows: [],
          maturedPendingRows: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const payload = await getLivePayload(15_000, "main", false, {
      today: "2026-04-08",
      now: new Date("2026-04-08T10:00:00+08:00"),
      fundQuoteFetcher: async () => [
        {
          code: "007339",
          name: "易方达沪深300ETF联接C",
          netValueDate: "2026-04-07",
          netValue: 1,
          confirmedNavDate: "2026-04-07",
          confirmedNav: 1,
          valuation: 1.01,
          intradayValuation: 1.01,
          valuationChangePercent: 1,
          intradayChangePercent: 1,
          valuationTime: "2026-04-08 10:00",
          intradayValuationTime: "2026-04-08 10:00",
          growthRate: 0,
          observationKind: "intraday_estimate"
        }
      ]
    });

    assert.notEqual(payload.generatedAt, "2026-04-07T15:17:00.816Z");
    assert.equal(payload.summary.currentFundCount, 1);
    assert.equal(payload.rows[0].quoteMode, "live_estimate");
    assert.equal(payload.rows[0].estimatedPnl, 100);
  } finally {
    if (previousPortfolioRoot === undefined) {
      delete process.env.PORTFOLIO_ROOT;
    } else {
      process.env.PORTFOLIO_ROOT = previousPortfolioRoot;
    }
  }
});

test("dashboard html uses separated cash semantics labels in the top ribbon", async () => {
  const server = createFundsLiveDashboardServer({
    host: "127.0.0.1",
    port: 0,
    refreshMs: 15000,
    portfolioRoot: "/Users/yinshiwei/codex/tz/portfolio"
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/?account=main`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /已投资资产/);
  assert.match(html, /真现金/);
  assert.match(html, /流动性防线/);
  assert.match(html, /getElementById\("settledCash"\)/);
  assert.match(html, /getElementById\("liquiditySleeveAssets"\)/);
  assert.doesNotMatch(html, /getElementById\("realizedCumulativeProfit"\)/);
  assert.doesNotMatch(html, /getElementById\("pendingSellSettlement"\)/);

  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
