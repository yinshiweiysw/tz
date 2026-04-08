import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot, workspaceRoot } from "./lib/account_root.mjs";
import {
  buildDualTradePlanPayload,
  buildOpportunitySummary,
  renderDualTradePlanMarkdown
} from "./lib/dual_trade_plan_render.mjs";
import { buildPortfolioStatePaths, loadCanonicalPortfolioState } from "./lib/portfolio_state_view.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const FRESHNESS_GUARD_MAX_LAG_HOURS = 48;

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

async function readJsonOrNull(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function currentShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDateOnlyAtShanghaiClose(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${String(value).slice(0, 10)}T15:00:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveReferenceTime(planDate, hasDateOverride) {
  if (hasDateOverride && planDate) {
    return parseDateOnlyAtShanghaiClose(planDate);
  }

  return new Date();
}

function resolvePlanningDate({ explicitDate, portfolioState }) {
  return String(
    explicitDate ||
      portfolioState?.strategy_effective_date ||
      portfolioState?.materialization?.reference_date ||
      portfolioState?.snapshot_date ||
      currentShanghaiDate()
  ).slice(0, 10);
}

function summarizeSignalDates(regimeSignals) {
  const candidates = Object.values(regimeSignals?.signals ?? {})
    .map(
      (signal) =>
        parseDateOnlyAtShanghaiClose(
          signal?.execution_context?.price_date ?? signal?.technical_snapshot?.as_of_date ?? null
        )
    )
    .filter(Boolean)
    .sort((left, right) => right.getTime() - left.getTime());

  return candidates[0] ?? null;
}

function summarizePortfolioStateTimestamp(portfolioState) {
  return (
    parseDateOnlyAtShanghaiClose(
      portfolioState?.strategy_effective_date ??
        portfolioState?.materialization?.reference_date ??
        portfolioState?.snapshot_date ??
        null
    ) ?? parseTimestamp(portfolioState?.generated_at)
  );
}

function resolveArtifactFreshness({
  label,
  payload,
  generatedAt,
  effectiveTimestamp,
  required = true
}) {
  if (!payload) {
    return {
      label,
      generatedAt: null,
      effectiveTimestamp: null,
      status: required ? "missing" : "optional_missing",
      lagHours: null
    };
  }

  return {
    label,
    generatedAt,
    effectiveTimestamp: effectiveTimestamp ?? generatedAt,
    status: "ok",
    lagHours: null
  };
}

function computeLagHours(referenceTime, effectiveTimestamp) {
  if (!referenceTime || !effectiveTimestamp) {
    return null;
  }

  return (referenceTime.getTime() - effectiveTimestamp.getTime()) / (1000 * 60 * 60);
}

function normalizeResolvedPath(filePath) {
  return filePath ? path.resolve(filePath) : null;
}

function validateDependencyPaths({ assetMasterPath, accountContextPath, macroStatePath, regimeSignals }) {
  const source = regimeSignals?.source ?? {};
  const mismatches = [];

  const expectations = [
    ["asset_master", assetMasterPath],
    ["account_context", accountContextPath],
    ["macro_state", macroStatePath]
  ];

  for (const [key, expectedPath] of expectations) {
    const actualPath = normalizeResolvedPath(source?.[key]);
    const expectedResolved = normalizeResolvedPath(expectedPath);
    if (!actualPath || !expectedResolved || actualPath !== expectedResolved) {
      mismatches.push(`${key}: expected=${expectedResolved ?? "missing"} actual=${actualPath ?? "missing"}`);
    }
  }

  return mismatches;
}

function buildCanonicalPaths(portfolioRoot, manifest) {
  const canonical = manifest?.canonical_entrypoints ?? {};
  const statePaths = buildPortfolioStatePaths(portfolioRoot, manifest);

  return {
    portfolioStatePath: statePaths.portfolioStatePath,
    latestCompatPath: statePaths.latestCompatPath,
    accountContextPath: canonical.account_context ?? buildPortfolioPath(portfolioRoot, "account_context.json"),
    watchlistPath: canonical.fund_watchlist ?? buildPortfolioPath(portfolioRoot, "fund-watchlist.json"),
    assetMasterPath: canonical.asset_master ?? buildPortfolioPath(portfolioRoot, "config", "asset_master.json"),
    macroStatePath: canonical.latest_macro_state ?? buildPortfolioPath(portfolioRoot, "data", "macro_state.json"),
    regimeSignalsPath:
      canonical.latest_regime_router_signals ??
      buildPortfolioPath(portfolioRoot, "signals", "regime_router_signals.json"),
    opportunityPoolPath:
      canonical.latest_opportunity_pool_json ?? buildPortfolioPath(portfolioRoot, "data", "opportunity_pool.json"),
    speculativePlanPath:
      canonical.latest_speculative_plan_json ?? buildPortfolioPath(portfolioRoot, "data", "speculative_plan.json"),
    outputJsonPath:
      canonical.latest_trade_plan_v4_json ?? buildPortfolioPath(portfolioRoot, "data", "trade_plan_v4.json")
  };
}

function buildFatalMessage(details) {
  const detailBlock =
    details.length > 0
      ? `\n- ${details.join("\n- ")}`
      : "";
  return `🚨 致命风控拦截：底层量化信号已过期 (滞后 > 48小时)！为防止实盘盲下，已强制终止交易预案生成！${detailBlock}`;
}

function deriveSignalBlockingState(regimeSignals) {
  const upstreamErrors = Array.isArray(regimeSignals?.errors) ? regimeSignals.errors : [];
  const reasons = upstreamErrors
    .map((item) => {
      const symbol = String(item?.symbol ?? "").trim();
      const message = String(item?.message ?? "").trim();
      if (!symbol && !message) {
        return "";
      }
      return symbol ? `${symbol}: ${message || "unknown upstream signal error"}` : message;
    })
    .filter(Boolean);

  return {
    blocked: reasons.length > 0,
    planState: reasons.length > 0 ? "blocked_market_data" : "ready",
    reasons,
  };
}

function buildBlockedTradePlanPayload({
  planDate,
  accountId,
  paths,
  portfolioStateView,
  riskBudget,
  macroState,
  regimeSignals,
  blockingReasons,
}) {
  const generatedAt = new Date().toISOString();
  return {
    version: 3,
    account_id: accountId,
    plan_date: planDate,
    generated_at: generatedAt,
    layer_role: "trade_planner_v6_dual_track",
    source: {
      portfolio_snapshot: portfolioStateView.sourcePath ?? paths.portfolioStatePath,
      portfolio_snapshot_source_kind: portfolioStateView.sourceKind ?? "unknown",
      account_context: paths.accountContextPath,
      watchlist: paths.watchlistPath,
      asset_master: paths.assetMasterPath,
      macro_state: paths.macroStatePath,
      regime_router_signals: paths.regimeSignalsPath,
    },
    risk_budget: riskBudget ?? {},
    macro_snapshot: {
      one_liner: "上游市场数据存在硬错误，今日交易计划已被风控阻断。",
      hs300_erp_pct: macroState?.factors?.hs300_erp?.value_pct ?? null,
      cn_10y_yield_pct: macroState?.cn_10y_cgb_yield?.value_pct ?? null,
    },
    summary: {
      plan_state: "blocked_market_data",
      actionable_trade_count: 0,
      suppressed_trade_count: 0,
      gross_buy_cny: 0,
      gross_sell_cny: 0,
      net_cash_impact_cny: 0,
    },
    trades: [],
    suppressed: [],
    upstream_signal_errors: Array.isArray(regimeSignals?.errors) ? regimeSignals.errors : [],
    blocking_reasons: blockingReasons,
  };
}

function renderBlockedTradePlanMarkdown({ planDate, blockingReasons }) {
  const reasons = Array.isArray(blockingReasons) ? blockingReasons : [];
  const lines = [
    `# ${planDate || "Next"} Trade Plan`,
    "",
    "## 状态",
    "",
    "- 交易计划已阻断：上游市场数据不可用，系统按 fail-closed 停止生成实盘指令。",
    "",
    "## 阻断原因",
    "",
  ];

  if (reasons.length === 0) {
    lines.push("- 未提供详细原因。");
  } else {
    for (const reason of reasons) {
      lines.push(`- ${reason}`);
    }
  }

  lines.push("", "## 执行结果", "", "- 今日不生成任何买卖指令。", "");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(args);
  const portfolioRoot = resolvePortfolioRoot(options);
  const accountId = resolveAccountId(options);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readJsonOrNull(manifestPath);
  const paths = buildCanonicalPaths(portfolioRoot, manifest);
  const portfolioStateView = await loadCanonicalPortfolioState({ portfolioRoot, manifest });

  const [portfolioState, assetMaster, macroState, regimeSignals, opportunityPool, speculativePlan] = await Promise.all([
    Promise.resolve(portfolioStateView.payload),
    readJsonOrNull(paths.assetMasterPath),
    readJsonOrNull(paths.macroStatePath),
    readJsonOrNull(paths.regimeSignalsPath),
    readJsonOrNull(paths.opportunityPoolPath),
    readJsonOrNull(paths.speculativePlanPath)
  ]);

  const planDate = resolvePlanningDate({
    explicitDate: options.date,
    portfolioState
  });
  const referenceTime = resolveReferenceTime(planDate, Boolean(options.date));
  const freshnessItems = [
    resolveArtifactFreshness({
      label: "portfolio_snapshot",
      payload: portfolioState,
      generatedAt: summarizePortfolioStateTimestamp(portfolioState),
      effectiveTimestamp: summarizePortfolioStateTimestamp(portfolioState)
    }),
    resolveArtifactFreshness({
      label: "macro_state",
      payload: macroState,
      generatedAt: parseTimestamp(macroState?.generated_at),
      effectiveTimestamp: parseTimestamp(macroState?.generated_at)
    }),
    resolveArtifactFreshness({
      label: "regime_router_signals",
      payload: regimeSignals,
      generatedAt: parseTimestamp(regimeSignals?.generated_at),
      effectiveTimestamp: summarizeSignalDates(regimeSignals) ?? parseTimestamp(regimeSignals?.generated_at)
    })
  ];

  const fatalReasons = [];

  if (!assetMaster?.buckets || !assetMaster?.performance_benchmark?.sleeves) {
    fatalReasons.push("asset_master.json 缺少 buckets 或 performance_benchmark.sleeves，无法保证 SSOT 完整。");
  }

  const dependencyMismatches = validateDependencyPaths({
    assetMasterPath: paths.assetMasterPath,
    accountContextPath: paths.accountContextPath,
    macroStatePath: paths.macroStatePath,
    regimeSignals
  });
  if (dependencyMismatches.length > 0) {
    fatalReasons.push(`regime_router_signals.json 依赖指纹与当前运行时不一致：${dependencyMismatches.join(" | ")}`);
  }

  for (const item of freshnessItems) {
    if (item.status === "missing") {
      fatalReasons.push(`${item.label} 缺失，交易大脑无法确认底层数据来源。`);
      continue;
    }

    const lagHours = computeLagHours(referenceTime, item.effectiveTimestamp);
    item.lagHours = lagHours;
    if (lagHours === null) {
      fatalReasons.push(`${item.label} 缺少有效时间戳，无法执行 freshness guard。`);
      continue;
    }

    if (lagHours > FRESHNESS_GUARD_MAX_LAG_HOURS) {
      fatalReasons.push(
        `${item.label} 最新有效时间为 ${item.effectiveTimestamp.toISOString()}，相对参考时点滞后 ${lagHours.toFixed(2)} 小时。`
      );
    }
  }

  if (fatalReasons.length > 0) {
    throw new Error(buildFatalMessage(fatalReasons));
  }

  const outputJsonPath = options["output-json"] || paths.outputJsonPath;
  const reportPath =
    options["report-path"] ||
    buildPortfolioPath(portfolioRoot, "reports", `${planDate}-next-trade-plan-regime-v4.md`);

  await mkdir(path.dirname(outputJsonPath), { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });

  const signalBlocking = deriveSignalBlockingState(regimeSignals);
  if (signalBlocking.blocked) {
    const blockedPayload = buildBlockedTradePlanPayload({
      planDate,
      accountId,
      paths,
      portfolioStateView,
      riskBudget: regimeSignals?.risk_budget ?? {},
      macroState,
      regimeSignals,
      blockingReasons: signalBlocking.reasons,
    });
    const blockedMarkdown = renderBlockedTradePlanMarkdown({
      planDate,
      blockingReasons: signalBlocking.reasons,
    });
    const enhancedPayload = buildDualTradePlanPayload({
      corePayload: blockedPayload,
      speculativePlan,
      opportunityPool: opportunityPool ?? {}
    });
    const enhancedMarkdown = renderDualTradePlanMarkdown({
      planDate,
      coreMarkdown: blockedMarkdown,
      speculativePlan,
      opportunitySummary: buildOpportunitySummary(opportunityPool ?? {})
    });

    await Promise.all([
      writeFile(outputJsonPath, `${JSON.stringify(enhancedPayload, null, 2)}\n`, "utf8"),
      writeFile(reportPath, `${enhancedMarkdown.trimEnd()}\n`, "utf8")
    ]);
    return;
  }

  const tradeGeneratorPath = buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "trade_generator.py");
  const commandArgs = [
    tradeGeneratorPath,
    "--user",
    accountId,
    "--date",
    planDate,
    "--portfolio-state",
    portfolioStateView.sourcePath ?? paths.portfolioStatePath,
    "--account-context",
    paths.accountContextPath,
    "--watchlist",
    paths.watchlistPath,
    "--asset-master",
    paths.assetMasterPath,
    "--macro-state",
    paths.macroStatePath,
    "--signals",
    paths.regimeSignalsPath,
    "--output-json",
    outputJsonPath,
    "--report-path",
    reportPath
  ];

  const { stdout, stderr } = await execFileAsync("python3", commandArgs, {
    cwd: workspaceRoot,
    maxBuffer: 1024 * 1024 * 8
  });

  if (stderr?.trim()) {
    process.stderr.write(`${stderr.trim()}\n`);
  }

  if (stdout?.trim()) {
    process.stdout.write(`${stdout.trim()}\n`);
  }

  const [corePayload, coreMarkdown] = await Promise.all([
    JSON.parse(await readFile(outputJsonPath, "utf8")),
    readFile(reportPath, "utf8")
  ]);

  const opportunitySummary = buildOpportunitySummary(opportunityPool ?? {});
  const enhancedPayload = buildDualTradePlanPayload({
    corePayload,
    speculativePlan,
    opportunityPool: opportunityPool ?? {}
  });
  const enhancedMarkdown = renderDualTradePlanMarkdown({
    planDate,
    coreMarkdown,
    speculativePlan,
    opportunitySummary
  });

  await Promise.all([
    writeFile(outputJsonPath, `${JSON.stringify(enhancedPayload, null, 2)}\n`, "utf8"),
    writeFile(reportPath, `${enhancedMarkdown.trimEnd()}\n`, "utf8")
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exit(1);
});
