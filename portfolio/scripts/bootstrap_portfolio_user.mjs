import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPortfolioPath, defaultPortfolioRoot, portfolioUsersRoot } from "./lib/account_root.mjs";
import { materializePortfolioRoot } from "./lib/portfolio_state_materializer.mjs";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    result[token.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }

  return result;
}

function resolveDate(dateArg) {
  if (dateArg) {
    return dateArg;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function safeSymlink(targetPath, linkPath) {
  try {
    await symlink(targetPath, linkPath);
    return { created: true, linkPath, targetPath };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { created: false, linkPath, targetPath };
    }
    throw error;
  }
}

const options = parseArgs(args);
const user = String(options.user ?? "").trim();

if (!user) {
  throw new Error("Missing required --user <account_id>.");
}

const today = resolveDate(options.date);
const userRoot = path.join(portfolioUsersRoot, user);
const sharedManifest = JSON.parse(await readFile(buildPortfolioPath(defaultPortfolioRoot, "state-manifest.json"), "utf8"));

const dirs = [
  userRoot,
  buildPortfolioPath(userRoot, "analysis"),
  buildPortfolioPath(userRoot, "cn_market_snapshots"),
  buildPortfolioPath(userRoot, "daily_briefs"),
  buildPortfolioPath(userRoot, "dashboards"),
  buildPortfolioPath(userRoot, "data"),
  buildPortfolioPath(userRoot, "holdings"),
  buildPortfolioPath(userRoot, "journal", "daily"),
  buildPortfolioPath(userRoot, "ledger"),
  buildPortfolioPath(userRoot, "market_briefs"),
  buildPortfolioPath(userRoot, "market_pulses"),
  buildPortfolioPath(userRoot, "reports"),
  buildPortfolioPath(userRoot, "scorecards", "weekly"),
  buildPortfolioPath(userRoot, "signals"),
  buildPortfolioPath(userRoot, "snapshots"),
  buildPortfolioPath(userRoot, "state"),
  buildPortfolioPath(userRoot, "trade_cards"),
  buildPortfolioPath(userRoot, "transactions")
];

for (const dir of dirs) {
  await mkdir(dir, { recursive: true });
}

const symlinkResults = [];
symlinkResults.push(
  await safeSymlink(
    buildPortfolioPath(defaultPortfolioRoot, "config"),
    buildPortfolioPath(userRoot, "config")
  )
);
symlinkResults.push(
  await safeSymlink(
    buildPortfolioPath(defaultPortfolioRoot, "templates"),
    buildPortfolioPath(userRoot, "templates")
  )
);
symlinkResults.push(
  await safeSymlink(
    buildPortfolioPath(defaultPortfolioRoot, "data", "market_lake.db"),
    buildPortfolioPath(userRoot, "data", "market_lake.db")
  )
);
symlinkResults.push(
  await safeSymlink(
    buildPortfolioPath(defaultPortfolioRoot, "data", "macro_radar.json"),
    buildPortfolioPath(userRoot, "data", "macro_radar.json")
  )
);
symlinkResults.push(
  await safeSymlink(
    buildPortfolioPath(defaultPortfolioRoot, "signals", "index_valuation_matrix.json"),
    buildPortfolioPath(userRoot, "signals", "index_valuation_matrix.json")
  )
);

const latestRaw = {
  account_id: user,
  snapshot_date: today,
  currency: "CNY",
  source_images: [],
  summary: {
    basis: "only_current_holdings",
    total_fund_assets: 0,
    pending_buy_confirm: 0,
    pending_sell_to_arrive: 0,
    effective_exposure_after_pending_sell: 0,
    yesterday_profit: 0,
    holding_profit: 0,
    cumulative_profit: 0,
    performance_precision: "manual_seed_pending_first_real_snapshot"
  },
  raw_account_snapshot: {
    total_fund_assets: 0,
    pending_buy_confirm: 0,
    pending_sell_to_arrive: 0,
    effective_exposure_after_pending_sell: 0
  },
  performance_snapshot: {},
  positions: [],
  exposure_summary: {
    qdii_amount: 0,
    qdii_weight_pct: 0,
    hong_kong_related_amount: 0,
    hong_kong_related_weight_pct: 0,
    us_related_amount: 0,
    us_related_weight_pct: 0,
    a_share_amount: 0,
    a_share_weight_pct: 0,
    gold_amount: 0,
    gold_weight_pct: 0,
    bond_mixed_amount: 0,
    bond_mixed_weight_pct: 0,
    commodity_amount: 0,
    commodity_weight_pct: 0
  },
  recognition_notes: [
    `账户 ${user} 于 ${today} 创建骨架，等待首次 latest_raw.json / watchlist / account_context 录入。`
  ],
  related_files: {
    latest_snapshot: buildPortfolioPath(userRoot, "latest.json"),
    latest_raw_snapshot: buildPortfolioPath(userRoot, "snapshots", "latest_raw.json"),
    execution_ledger: buildPortfolioPath(userRoot, "ledger", "execution_ledger.json"),
    portfolio_state: buildPortfolioPath(userRoot, "state", "portfolio_state.json"),
    fund_watchlist: buildPortfolioPath(userRoot, "fund-watchlist.json"),
    account_context: buildPortfolioPath(userRoot, "account_context.json")
  },
  cash_ledger: {
    available_cash_cny: 0,
    pending_buy_confirm_cny: 0,
    pending_sell_to_arrive_cny: 0
  },
  snapshot_meta: {
    source_kind: "bootstrap_seed",
    seeded_at: new Date().toISOString()
  }
};

const executionLedger = {
  schema_version: 1,
  account_id: user,
  as_of_snapshot_date: today,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  entries: [],
  notes: [
    `账户 ${user} 于 ${today} 初始化 execution_ledger，等待后续手工交易或平台确认写入。`
  ]
};

const watchlist = {
  account_id: user,
  as_of: today,
  basis: "manual_seed_empty",
  watchlist: []
};

const accountContext = {
  account_id: user,
  as_of: today,
  reported_cash_estimate_cny: 0,
  reported_total_assets_range_cny: {
    min: 0,
    max: 0
  },
  notes: [
    "Bootstrap placeholder. Replace with the friend's real total assets / cash before generating trade plans."
  ]
};

const stateManifest = {
  version: 1,
  account_id: user,
  portfolio_root: userRoot,
  canonical_entrypoints: {
    latest_snapshot: buildPortfolioPath(userRoot, "latest.json"),
    latest_raw_snapshot: buildPortfolioPath(userRoot, "snapshots", "latest_raw.json"),
    execution_ledger: buildPortfolioPath(userRoot, "ledger", "execution_ledger.json"),
    portfolio_state: buildPortfolioPath(userRoot, "state", "portfolio_state.json"),
    fund_watchlist: buildPortfolioPath(userRoot, "fund-watchlist.json"),
    account_context: buildPortfolioPath(userRoot, "account_context.json"),
    risk_dashboard: buildPortfolioPath(userRoot, "risk_dashboard.json"),
    latest_daily_brief: buildPortfolioPath(userRoot, "daily_briefs", `${today}-brief.md`),
    latest_fund_signals_matrix: buildPortfolioPath(userRoot, "signals", "signals_matrix.json"),
    latest_macro_state: buildPortfolioPath(userRoot, "data", "macro_state.json"),
    latest_regime_router_signals: buildPortfolioPath(userRoot, "signals", "regime_router_signals.json"),
    latest_quant_metrics_engine: buildPortfolioPath(userRoot, "data", "quant_metrics_engine.json"),
    latest_performance_attribution: buildPortfolioPath(userRoot, "data", "performance_attribution.json"),
    latest_trade_plan_v4_json: buildPortfolioPath(userRoot, "data", "trade_plan_v4.json"),
    latest_trade_plan_v4_report: buildPortfolioPath(userRoot, "reports", `${today}-next-trade-plan-regime-v4.md`),
    latest_next_trade_generator: buildPortfolioPath(userRoot, "reports", `${today}-next-trade-plan-regime-v4.md`),
    asset_master: buildPortfolioPath(defaultPortfolioRoot, "config", "asset_master.json"),
    market_lake_db: buildPortfolioPath(defaultPortfolioRoot, "data", "market_lake.db"),
    latest_index_valuation_matrix: buildPortfolioPath(
      defaultPortfolioRoot,
      "signals",
      "index_valuation_matrix.json"
    ),
    latest_macro_radar:
      sharedManifest?.canonical_entrypoints?.latest_macro_radar ??
      buildPortfolioPath(defaultPortfolioRoot, "data", "macro_radar.json"),
    latest_cn_market_snapshot:
      sharedManifest?.canonical_entrypoints?.latest_cn_market_snapshot ?? null
  },
  notes: [
    "Main account remains under /portfolio and is still the default runtime root.",
    `This account is activated only when passing --user ${user} or PORTFOLIO_USER=${user}.`,
    "Shared market-wide files (asset_master, market_lake.db, macro radar, valuation matrix) are linked back to the main account.",
    "Write-side state now follows dual-ledger mode: latest_raw.json + execution_ledger.json -> portfolio_state.json -> latest.json."
  ]
};

await writeFile(
  buildPortfolioPath(userRoot, "snapshots", "latest_raw.json"),
  `${JSON.stringify(latestRaw, null, 2)}\n`,
  "utf8"
);
await writeFile(
  buildPortfolioPath(userRoot, "ledger", "execution_ledger.json"),
  `${JSON.stringify(executionLedger, null, 2)}\n`,
  "utf8"
);
await writeFile(
  buildPortfolioPath(userRoot, "fund-watchlist.json"),
  `${JSON.stringify(watchlist, null, 2)}\n`,
  "utf8"
);
await writeFile(
  buildPortfolioPath(userRoot, "account_context.json"),
  `${JSON.stringify(accountContext, null, 2)}\n`,
  "utf8"
);
await writeFile(
  buildPortfolioPath(userRoot, "state-manifest.json"),
  `${JSON.stringify(stateManifest, null, 2)}\n`,
  "utf8"
);
await writeFile(
  buildPortfolioPath(userRoot, "hypotheses.md"),
  `# ${user} hypotheses\n\n- 待补充。\n`,
  "utf8"
);
await materializePortfolioRoot({
  portfolioRoot: userRoot,
  accountId: user,
  referenceDate: today,
  seedMissing: false
});

console.log(
  JSON.stringify(
    {
      user,
      userRoot,
      createdAt: new Date().toISOString(),
      symlinks: symlinkResults,
      nextSteps: [
        `Fill ${buildPortfolioPath(userRoot, "snapshots", "latest_raw.json")} with the friend's raw holdings snapshot.`,
        `Fill ${buildPortfolioPath(userRoot, "fund-watchlist.json")} with the friend's fund list.`,
        `Update ${buildPortfolioPath(userRoot, "account_context.json")} with total assets and cash.`,
        `Run: node portfolio/scripts/materialize_portfolio_state.mjs --user ${user} --date ${today}`,
        `Run: python3 portfolio/scripts/generate_fund_signals_matrix.py --user ${user}`,
        `Run: python3 portfolio/scripts/generate_signals.py --user ${user}`,
        `Run: python3 portfolio/scripts/calculate_quant_metrics.py --user ${user}`,
        `Run: node portfolio/scripts/generate_risk_dashboard.mjs --user ${user}`,
        `Run: node portfolio/scripts/generate_next_trade_plan.mjs --user ${user} --date ${today}`,
        `Run: node portfolio/scripts/generate_daily_brief.mjs --user ${user} --date ${today}`
      ]
    },
    null,
    2
  )
);
