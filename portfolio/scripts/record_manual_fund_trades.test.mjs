import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("record_manual_fund_trades refuses to use latest.json as business source when portfolio_state is missing", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "manual-trade-cli-"));
  await writeJson(path.join(portfolioRoot, "latest.json"), {
    snapshot_date: "2026-04-01",
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        fund_code: "007339",
        code: "007339",
        symbol: "007339",
        amount: 10000,
        category: "A股宽基",
        status: "active"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "fund-watchlist.json"), { watchlist: [] });
  await writeJson(path.join(portfolioRoot, "config", "asset_master.json"), {
    fallback_bucket_key: "TACTICAL",
    bucket_mapping_rules: [
      { bucket_key: "A_CORE", category_equals: ["A股宽基"], name_patterns: ["沪深300"] }
    ],
    buckets: {
      A_CORE: { label: "A股核心", min: 0.1, max: 0.3, risk_role: "core", is_equity_like: true },
      CASH: { label: "现金", min: 0.15, max: 0.5, risk_role: "cash", is_equity_like: false }
    }
  });
  await writeJson(path.join(portfolioRoot, "config", "ips_constraints.json"), {
    drawdown: { re_evaluate_pct: 0.08, hard_stop_pct: 0.12 },
    concentration: { single_fund_max_pct: 0.1, single_theme_max_pct: 0.15, high_correlation_max_pct: 0.25 },
    cash_floor_pct: 0.15
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    portfolio_risk: { current_drawdown_pct: 0.01 }
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
      "--portfolio-root",
      portfolioRoot,
      "--date",
      "2026-04-01",
      "--buy",
      "007339:1000",
      "--skip-merge",
      "true",
      "--skip-writeback",
      "true"
    ]),
    /portfolio_state\.json is required/i
  );
});

test("record_manual_fund_trades persists gate-derived metadata into transaction payload", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "manual-trade-cli-metadata-"));
  await writeJson(path.join(portfolioRoot, "state-manifest.json"), {
    version: 3,
    account_id: "main",
    canonical_entrypoints: {
      portfolio_state: path.join(portfolioRoot, "state", "portfolio_state.json")
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    account_id: "main",
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 50000,
      total_portfolio_assets_cny: 140000,
      available_cash_cny: 30000
    },
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        fund_code: "007339",
        code: "007339",
        symbol: "007339",
        amount: 10000,
        category: "A股宽基",
        status: "active"
      },
      {
        name: "工银瑞信黄金ETF联接C",
        fund_code: "000218",
        code: "000218",
        symbol: "000218",
        amount: 10000,
        category: "黄金",
        status: "active"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "snapshots", "latest_raw.json"), {
    snapshot_date: "2026-04-01",
    positions: []
  });
  await writeJson(path.join(portfolioRoot, "fund-watchlist.json"), {
    watchlist: [
      {
        code: "022502",
        name: "国泰黄金ETF联接E"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "config", "asset_master.json"), {
    fallback_bucket_key: "TACTICAL",
    fallback_theme_key: "UNCLASSIFIED",
    bucket_mapping_rules: [
      { bucket_key: "A_CORE", category_equals: ["A股宽基"], name_patterns: ["沪深300"] },
      { bucket_key: "HEDGE", category_equals: ["黄金"], name_patterns: ["黄金"] }
    ],
    theme_mapping_rules: [
      { theme_key: "CN_CORE", bucket_keys: ["A_CORE"], name_patterns: ["沪深300"] },
      { theme_key: "GOLD", bucket_keys: ["HEDGE"], name_patterns: ["黄金"] }
    ],
    buckets: {
      A_CORE: { label: "A股核心", min: 0.1, max: 0.5, risk_role: "core", is_equity_like: true },
      HEDGE: { label: "对冲仓", min: 0, max: 0.3, risk_role: "hedge", is_equity_like: false },
      CASH: { label: "现金", min: 0.15, max: 0.5, risk_role: "cash", is_equity_like: false }
    },
    themes: {
      CN_CORE: { label: "A股核心", bucket_keys: ["A_CORE"] },
      GOLD: { label: "黄金", bucket_keys: ["HEDGE"] }
    }
  });
  await writeJson(path.join(portfolioRoot, "config", "ips_constraints.json"), {
    drawdown: { re_evaluate_pct: 0.08, hard_stop_pct: 0.12 },
    concentration: { single_fund_max_pct: 0.5, single_theme_max_pct: 0.6, high_correlation_max_pct: 0.7 },
    cash_floor_pct: 0.05
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    portfolio_risk: { current_drawdown_pct: 0.01 }
  });
  await writeJson(path.join(portfolioRoot, "data", "research_brain.json"), {
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "allowed"
      }
    }
  });

  await execFileAsync(process.execPath, [
    "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
    "--portfolio-root",
    portfolioRoot,
    "--date",
    "2026-04-01",
    "--buy",
    "007339:1000",
    "--sell",
    "000218:500",
    "--convert",
    "007339:300->022502:300",
    "--skip-merge",
    "true",
    "--skip-writeback",
    "true"
  ]);

  const transactionFiles = await readdir(path.join(portfolioRoot, "transactions"));
  assert.equal(transactionFiles.length, 1);

  const payload = JSON.parse(
    await readFile(path.join(portfolioRoot, "transactions", transactionFiles[0]), "utf8")
  );
  assert.equal(payload.executed_buy_transactions[0].bucket_key, "A_CORE");
  assert.equal(payload.executed_buy_transactions[0].theme_key, "CN_CORE");
  assert.equal(payload.executed_buy_transactions[0].source_confidence, "user_dialogue_confirmed");
  assert.deepEqual(payload.executed_buy_transactions[0].fund_identity, {
    code: "007339",
    name: "易方达沪深300ETF联接C",
    user_stated_token: "007339"
  });
  assert.equal(payload.executed_sell_transactions[0].bucket_key, "HEDGE");
  assert.equal(payload.executed_sell_transactions[0].theme_key, "GOLD");
  assert.equal(payload.executed_conversion_transactions[0].from_bucket_key, "A_CORE");
  assert.equal(payload.executed_conversion_transactions[0].to_bucket_key, "HEDGE");
  assert.equal(payload.executed_conversion_transactions[0].from_theme_key, "CN_CORE");
  assert.equal(payload.executed_conversion_transactions[0].to_theme_key, "GOLD");
});

test("record_manual_fund_trades rejects buy when research trade_permission is blocked", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "manual-trade-cli-research-blocked-"));
  await writeJson(path.join(portfolioRoot, "state-manifest.json"), {
    version: 3,
    account_id: "main",
    canonical_entrypoints: {
      portfolio_state: path.join(portfolioRoot, "state", "portfolio_state.json")
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    account_id: "main",
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 50000,
      total_portfolio_assets_cny: 140000,
      available_cash_cny: 30000
    },
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        fund_code: "007339",
        code: "007339",
        symbol: "007339",
        amount: 10000,
        category: "A股宽基",
        status: "active"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "snapshots", "latest_raw.json"), {
    snapshot_date: "2026-04-01",
    positions: []
  });
  await writeJson(path.join(portfolioRoot, "fund-watchlist.json"), { watchlist: [] });
  await writeJson(path.join(portfolioRoot, "config", "asset_master.json"), {
    fallback_bucket_key: "TACTICAL",
    bucket_mapping_rules: [
      { bucket_key: "A_CORE", category_equals: ["A股宽基"], name_patterns: ["沪深300"] }
    ],
    buckets: {
      A_CORE: { label: "A股核心", min: 0.1, max: 0.5, risk_role: "core", is_equity_like: true },
      CASH: { label: "现金", min: 0.15, max: 0.5, risk_role: "cash", is_equity_like: false }
    }
  });
  await writeJson(path.join(portfolioRoot, "config", "ips_constraints.json"), {
    drawdown: { re_evaluate_pct: 0.08, hard_stop_pct: 0.12 },
    concentration: { single_fund_max_pct: 0.5, single_theme_max_pct: 0.6, high_correlation_max_pct: 0.7 },
    cash_floor_pct: 0.05
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    portfolio_risk: { current_drawdown_pct: 0.01 }
  });
  await writeJson(path.join(portfolioRoot, "data", "research_brain.json"), {
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "blocked",
        one_sentence_order: "研究闸门未通过，当前禁止生成交易指令。"
      }
    }
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
      "--portfolio-root",
      portfolioRoot,
      "--date",
      "2026-04-01",
      "--buy",
      "007339:1000",
      "--skip-merge",
      "true",
      "--skip-writeback",
      "true"
    ]),
    /research/i
  );
});

test("record_manual_fund_trades allows sell-only when research trade_permission is restricted", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "manual-trade-cli-research-restricted-"));
  await writeJson(path.join(portfolioRoot, "state-manifest.json"), {
    version: 3,
    account_id: "main",
    canonical_entrypoints: {
      portfolio_state: path.join(portfolioRoot, "state", "portfolio_state.json")
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    account_id: "main",
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 50000,
      total_portfolio_assets_cny: 140000,
      available_cash_cny: 30000
    },
    positions: [
      {
        name: "工银瑞信黄金ETF联接C",
        fund_code: "000218",
        code: "000218",
        symbol: "000218",
        amount: 10000,
        category: "黄金",
        status: "active"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "snapshots", "latest_raw.json"), {
    snapshot_date: "2026-04-01",
    positions: []
  });
  await writeJson(path.join(portfolioRoot, "fund-watchlist.json"), { watchlist: [] });
  await writeJson(path.join(portfolioRoot, "config", "asset_master.json"), {
    fallback_bucket_key: "TACTICAL",
    bucket_mapping_rules: [
      { bucket_key: "HEDGE", category_equals: ["黄金"], name_patterns: ["黄金"] }
    ],
    buckets: {
      HEDGE: { label: "对冲仓", min: 0, max: 0.3, risk_role: "hedge", is_equity_like: false },
      CASH: { label: "现金", min: 0.15, max: 0.5, risk_role: "cash", is_equity_like: false }
    }
  });
  await writeJson(path.join(portfolioRoot, "config", "ips_constraints.json"), {
    drawdown: { re_evaluate_pct: 0.08, hard_stop_pct: 0.12 },
    concentration: { single_fund_max_pct: 0.5, single_theme_max_pct: 0.6, high_correlation_max_pct: 0.7 },
    cash_floor_pct: 0.05
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    portfolio_risk: { current_drawdown_pct: 0.01 }
  });
  await writeJson(path.join(portfolioRoot, "data", "research_brain.json"), {
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "restricted"
      }
    }
  });

  await execFileAsync(process.execPath, [
    "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
    "--portfolio-root",
    portfolioRoot,
    "--date",
    "2026-04-01",
    "--sell",
    "000218:500",
    "--skip-merge",
    "true",
    "--skip-writeback",
    "true"
  ]);

  const transactionFiles = await readdir(path.join(portfolioRoot, "transactions"));
  assert.equal(transactionFiles.length, 1);
});

test("record_manual_fund_trades rejects conversion when research trade_permission is restricted", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "manual-trade-cli-research-restricted-convert-"));
  await writeJson(path.join(portfolioRoot, "state-manifest.json"), {
    version: 3,
    account_id: "main",
    canonical_entrypoints: {
      portfolio_state: path.join(portfolioRoot, "state", "portfolio_state.json")
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    account_id: "main",
    snapshot_date: "2026-04-01",
    summary: {
      total_fund_assets: 50000,
      total_portfolio_assets_cny: 140000,
      available_cash_cny: 30000
    },
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        fund_code: "007339",
        code: "007339",
        symbol: "007339",
        amount: 10000,
        category: "A股宽基",
        status: "active"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "snapshots", "latest_raw.json"), {
    snapshot_date: "2026-04-01",
    positions: []
  });
  await writeJson(path.join(portfolioRoot, "fund-watchlist.json"), {
    watchlist: [{ code: "022502", name: "国泰黄金ETF联接E" }]
  });
  await writeJson(path.join(portfolioRoot, "config", "asset_master.json"), {
    fallback_bucket_key: "TACTICAL",
    bucket_mapping_rules: [
      { bucket_key: "A_CORE", category_equals: ["A股宽基"], name_patterns: ["沪深300"] },
      { bucket_key: "HEDGE", category_equals: ["黄金"], name_patterns: ["黄金"] }
    ],
    buckets: {
      A_CORE: { label: "A股核心", min: 0.1, max: 0.5, risk_role: "core", is_equity_like: true },
      HEDGE: { label: "对冲仓", min: 0, max: 0.3, risk_role: "hedge", is_equity_like: false },
      CASH: { label: "现金", min: 0.15, max: 0.5, risk_role: "cash", is_equity_like: false }
    }
  });
  await writeJson(path.join(portfolioRoot, "config", "ips_constraints.json"), {
    drawdown: { re_evaluate_pct: 0.08, hard_stop_pct: 0.12 },
    concentration: { single_fund_max_pct: 0.5, single_theme_max_pct: 0.6, high_correlation_max_pct: 0.7 },
    cash_floor_pct: 0.05
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    portfolio_risk: { current_drawdown_pct: 0.01 }
  });
  await writeJson(path.join(portfolioRoot, "data", "research_brain.json"), {
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "restricted"
      }
    }
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      "/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs",
      "--portfolio-root",
      portfolioRoot,
      "--date",
      "2026-04-01",
      "--convert",
      "007339:300->022502:300",
      "--skip-merge",
      "true",
      "--skip-writeback",
      "true"
    ]),
    /restricted/i
  );
});
