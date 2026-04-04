import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildPortfolioPath, defaultPortfolioRoot, portfolioUsersRoot } from "./lib/account_root.mjs";
import { materializePortfolioRoot } from "./lib/portfolio_state_materializer.mjs";

export function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

export function resolveDate(dateArg, now = new Date()) {
  if (dateArg) {
    return dateArg;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function writeJsonIfMissing(filePath, payload) {
  if (await pathExists(filePath)) {
    return false;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}

async function writeTextIfMissing(filePath, content) {
  if (await pathExists(filePath)) {
    return false;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return true;
}

function buildSeedPayloads({ user, today, userRoot, defaultRoot, sharedManifest, now }) {
  const seededAt = now.toISOString();

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
      seeded_at: seededAt
    }
  };

  const executionLedger = {
    schema_version: 1,
    account_id: user,
    as_of_snapshot_date: today,
    created_at: seededAt,
    updated_at: seededAt,
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
      latest_research_brain: buildPortfolioPath(userRoot, "data", "research_brain.json"),
      latest_trade_plan_v4_json: buildPortfolioPath(userRoot, "data", "trade_plan_v4.json"),
      latest_trade_plan_v4_report: buildPortfolioPath(
        userRoot,
        "reports",
        `${today}-next-trade-plan-regime-v4.md`
      ),
      latest_next_trade_generator: buildPortfolioPath(
        userRoot,
        "reports",
        `${today}-next-trade-plan-regime-v4.md`
      ),
      asset_master: buildPortfolioPath(defaultRoot, "config", "asset_master.json"),
      ips_constraints: buildPortfolioPath(defaultRoot, "config", "ips_constraints.json"),
      market_lake_db: buildPortfolioPath(defaultRoot, "data", "market_lake.db"),
      latest_index_valuation_matrix: buildPortfolioPath(
        defaultRoot,
        "signals",
        "index_valuation_matrix.json"
      ),
      latest_macro_radar:
        sharedManifest?.canonical_entrypoints?.latest_macro_radar ??
        buildPortfolioPath(defaultRoot, "data", "macro_radar.json"),
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

  return {
    latestRaw,
    executionLedger,
    watchlist,
    accountContext,
    stateManifest,
    hypothesesContent: `# ${user} hypotheses\n\n- 待补充。\n`
  };
}

function mergeStateManifest(existingManifest, seededManifest) {
  if (!existingManifest || typeof existingManifest !== "object") {
    return seededManifest;
  }

  return {
    ...seededManifest,
    ...existingManifest,
    account_id: existingManifest.account_id ?? seededManifest.account_id,
    portfolio_root: existingManifest.portfolio_root ?? seededManifest.portfolio_root,
    canonical_entrypoints: {
      ...seededManifest.canonical_entrypoints,
      ...(existingManifest.canonical_entrypoints ?? {})
    },
    notes: Array.isArray(existingManifest.notes) ? existingManifest.notes : seededManifest.notes
  };
}

export async function bootstrapPortfolioUser({
  user,
  date,
  now = new Date(),
  defaultRoot = defaultPortfolioRoot,
  usersRoot = portfolioUsersRoot,
  materialize = materializePortfolioRoot
} = {}) {
  if (typeof user === "boolean") {
    throw new Error("Missing required --user <account_id>.");
  }

  const accountId = String(user ?? "").trim();
  if (!accountId) {
    throw new Error("Missing required --user <account_id>.");
  }

  const today = resolveDate(date, now);
  const userRoot = path.join(usersRoot, accountId);
  const sharedManifestPath = buildPortfolioPath(defaultRoot, "state-manifest.json");
  const sharedManifest = await readJsonOrNull(sharedManifestPath);

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

  const symlinks = [
    {
      targetPath: buildPortfolioPath(defaultRoot, "config"),
      linkPath: buildPortfolioPath(userRoot, "config")
    },
    {
      targetPath: buildPortfolioPath(defaultRoot, "templates"),
      linkPath: buildPortfolioPath(userRoot, "templates")
    },
    {
      targetPath: buildPortfolioPath(defaultRoot, "data", "market_lake.db"),
      linkPath: buildPortfolioPath(userRoot, "data", "market_lake.db")
    },
    {
      targetPath: buildPortfolioPath(defaultRoot, "data", "macro_radar.json"),
      linkPath: buildPortfolioPath(userRoot, "data", "macro_radar.json")
    },
    {
      targetPath: buildPortfolioPath(defaultRoot, "signals", "index_valuation_matrix.json"),
      linkPath: buildPortfolioPath(userRoot, "signals", "index_valuation_matrix.json")
    }
  ];

  const symlinkResults = [];
  for (const symlinkSpec of symlinks) {
    symlinkResults.push(await safeSymlink(symlinkSpec.targetPath, symlinkSpec.linkPath));
  }

  const seeds = buildSeedPayloads({
    user: accountId,
    today,
    userRoot,
    defaultRoot,
    sharedManifest,
    now
  });

  const latestRawPath = buildPortfolioPath(userRoot, "snapshots", "latest_raw.json");
  const executionLedgerPath = buildPortfolioPath(userRoot, "ledger", "execution_ledger.json");
  const watchlistPath = buildPortfolioPath(userRoot, "fund-watchlist.json");
  const accountContextPath = buildPortfolioPath(userRoot, "account_context.json");
  const manifestPath = buildPortfolioPath(userRoot, "state-manifest.json");
  const hypothesesPath = buildPortfolioPath(userRoot, "hypotheses.md");

  const seededLatestRaw = await writeJsonIfMissing(latestRawPath, seeds.latestRaw);
  const seededExecutionLedger = await writeJsonIfMissing(executionLedgerPath, seeds.executionLedger);
  const seededWatchlist = await writeJsonIfMissing(watchlistPath, seeds.watchlist);
  const seededAccountContext = await writeJsonIfMissing(accountContextPath, seeds.accountContext);
  const seededHypotheses = await writeTextIfMissing(hypothesesPath, seeds.hypothesesContent);

  const existingManifest = await readJsonOrNull(manifestPath);
  const mergedManifest = mergeStateManifest(existingManifest, seeds.stateManifest);
  const mergedManifestText = `${JSON.stringify(mergedManifest, null, 2)}\n`;
  const currentManifestText = existingManifest ? `${JSON.stringify(existingManifest, null, 2)}\n` : null;
  if (currentManifestText !== mergedManifestText) {
    await writeFile(manifestPath, mergedManifestText, "utf8");
  }

  if (seededLatestRaw || seededExecutionLedger) {
    await materialize({
      portfolioRoot: userRoot,
      accountId,
      referenceDate: today,
      seedMissing: false
    });
  }

  return {
    user: accountId,
    userRoot,
    createdAt: now.toISOString(),
    symlinks: symlinkResults,
    seededFiles: {
      latestRaw: seededLatestRaw,
      executionLedger: seededExecutionLedger,
      watchlist: seededWatchlist,
      accountContext: seededAccountContext,
      hypotheses: seededHypotheses
    },
    nextSteps: [
      `Fill ${latestRawPath} with the friend's raw holdings snapshot.`,
      `Fill ${watchlistPath} with the friend's fund list.`,
      `Update ${accountContextPath} with total assets and cash.`,
      `Run: node portfolio/scripts/materialize_portfolio_state.mjs --user ${accountId} --date ${today}`,
      `Run: python3 portfolio/scripts/generate_fund_signals_matrix.py --user ${accountId}`,
      `Run: python3 portfolio/scripts/generate_signals.py --user ${accountId}`,
      `Run: python3 portfolio/scripts/calculate_quant_metrics.py --user ${accountId}`,
      `Run: node portfolio/scripts/generate_risk_dashboard.mjs --user ${accountId}`,
      `Run: node portfolio/scripts/generate_next_trade_plan.mjs --user ${accountId} --date ${today}`,
      `Run: node portfolio/scripts/generate_daily_brief.mjs --user ${accountId} --date ${today}`
    ]
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  const result = await bootstrapPortfolioUser({
    user: options.user,
    date: options.date
  });
  console.log(JSON.stringify(result, null, 2));
}
