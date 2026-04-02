import { mkdir, writeFile } from "node:fs/promises";
import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { loadOpportunityMaster } from "./lib/opportunity_master.mjs";
import { buildOpportunityCandidate, rankOpportunityCandidates } from "./lib/opportunity_pool.mjs";
import { readJsonOrNull } from "./lib/portfolio_state_view.mjs";

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
    return String(dateArg).slice(0, 10);
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function formatSigned(value, digits = 2, suffix = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return `--${suffix}`;
  }

  const rounded = Number(numeric.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

function pickFirstProxyName(theme) {
  const proxy = Array.isArray(theme?.tradable_proxies) ? theme.tradable_proxies[0] : null;
  return proxy?.name || proxy?.symbol || "暂无";
}

function deriveThemeSignals(theme, { macroState, cnMarketSnapshot }) {
  const themeName = String(theme?.theme_name ?? "");
  const erpBp = Number(macroState?.factors?.hs300_erp?.value_bp ?? NaN);
  const dividendSpreadBp = Number(macroState?.factors?.csi_dividend_spread?.value_bp ?? NaN);
  const tenYearYield = Number(macroState?.ten_year_cgb?.yield_pct ?? NaN);
  const macroPhase = String(cnMarketSnapshot?.sections?.macro_cycle?.phase ?? "");
  const favoredGroups = Array.isArray(cnMarketSnapshot?.sections?.macro_cycle?.favored_groups)
    ? cnMarketSnapshot.sections.macro_cycle.favored_groups
    : [];
  const northboundSummary = Number(
    cnMarketSnapshot?.sections?.northbound_flow?.latest_summary_net_buy_100m_cny ?? NaN
  );
  const northboundTrend = String(cnMarketSnapshot?.sections?.northbound_flow?.intraday_trend_label ?? "");
  const marketBreadthStatus = String(cnMarketSnapshot?.sections?.market_breadth?.status ?? "");

  let expected_vs_actual = "暂无显著预期差，先维持观察。";
  let expected_vs_actual_score = 1;
  let technical_state = "结构未出现一致性趋势，偏震荡。";
  let technical_score = 1;
  let funding_flow_state = "增量资金信号中性。";
  let funding_flow_score = 1;
  let risk_penalty = 1;

  if (themeName.includes("黄金")) {
    expected_vs_actual = Number.isFinite(tenYearYield)
      ? `10Y 国债收益率 ${formatSigned(tenYearYield, 3, "%")}，真实利率环境对黄金仍不构成强压制。`
      : "真实利率方向暂不清晰，黄金更多依赖地缘与避险情绪。";
    expected_vs_actual_score = Number.isFinite(tenYearYield) && tenYearYield <= 2.0 ? 2 : 1;
    technical_state = macroPhase === "recovery" ? "风险资产修复中，黄金短线可能高位震荡。" : "黄金趋势保持韧性。";
    technical_score = macroPhase === "recovery" ? 1 : 2;
    funding_flow_state = "北向资金对黄金主题代表性有限，资金面仅作辅助参考。";
    funding_flow_score = 1;
    risk_penalty = macroPhase === "recovery" ? 2 : 1;
  } else if (themeName.includes("A股核心")) {
    expected_vs_actual = Number.isFinite(erpBp)
      ? `沪深300 ERP ${formatSigned(erpBp, 2, "bp")}，估值与利率错位仍提供安全垫。`
      : "ERP 数据缺失，预期差暂按中性处理。";
    expected_vs_actual_score = Number.isFinite(erpBp) ? (erpBp >= 500 ? 3 : erpBp >= 350 ? 2 : 1) : 1;
    technical_state =
      macroPhase === "recovery" ? "宏观周期处于修复段，核心宽基更容易承接机构资金。" : "指数结构偏震荡。";
    technical_score = macroPhase === "recovery" ? 2 : 1;
    funding_flow_state = Number.isFinite(northboundSummary)
      ? `北向当日净流入 ${formatSigned(northboundSummary, 2, "亿")}（${northboundTrend || "趋势未知"}）。`
      : "北向流向不稳定，资金面暂按中性。";
    funding_flow_score = Number.isFinite(northboundSummary)
      ? northboundSummary > 20
        ? 3
        : northboundSummary > 0
          ? 2
          : 1
      : 1;
    risk_penalty = 1;
  } else if (themeName.includes("港股互联网")) {
    expected_vs_actual =
      macroPhase === "recovery"
        ? "修复期内高弹性资产具备交易窗口，但持续性仍需外盘验证。"
        : "情绪驱动大于基本面，预期差兑现不稳定。";
    expected_vs_actual_score = macroPhase === "recovery" ? 2 : 1;
    technical_state = "高波动风格，适合分批试单而非一次性确认仓。";
    technical_score = 1;
    funding_flow_state = Number.isFinite(northboundSummary)
      ? "南北向共振不足，资金侧以跟踪为主。"
      : "缺少稳定跨市场资金数据，先观察。";
    funding_flow_score = 1;
    risk_penalty = 2;
  } else if (themeName.includes("半导体")) {
    expected_vs_actual = favoredGroups.some((group) => String(group).includes("制造"))
      ? "宏观修复阶段偏好制造升级，产业链景气预期仍可交易。"
      : "宏观偏好尚未指向制造升级。";
    expected_vs_actual_score = favoredGroups.some((group) => String(group).includes("制造")) ? 2 : 1;
    technical_state = "板块波动放大，需等待分歧后再确认。";
    technical_score = 1;
    funding_flow_state = "板块资金流抓取存在缺口，暂不做强判断。";
    funding_flow_score = 1;
    risk_penalty = 2;
  } else if (themeName.includes("红利") || themeName.includes("低波")) {
    expected_vs_actual = Number.isFinite(dividendSpreadBp)
      ? `红利利差 ${formatSigned(dividendSpreadBp, 2, "bp")}，防守资产相对吸引力仍在。`
      : "红利利差缺失，按中性处理。";
    expected_vs_actual_score = Number.isFinite(dividendSpreadBp)
      ? dividendSpreadBp >= 250
        ? 3
        : dividendSpreadBp >= 120
          ? 2
          : 1
      : 1;
    technical_state = "防守因子稳定，适合承接组合波动。";
    technical_score = 2;
    funding_flow_state =
      Number.isFinite(northboundSummary) && northboundSummary <= 0
        ? "风险偏好未显著扩张，防守类配置仍有相对优势。"
        : "风险偏好回升时红利风格可能阶段性跑输。";
    funding_flow_score = 1;
    risk_penalty = 0;
  }

  if (marketBreadthStatus === "error") {
    risk_penalty += 1;
  }

  return {
    expected_vs_actual,
    expected_vs_actual_score,
    technical_state,
    technical_score,
    funding_flow_state,
    funding_flow_score,
    risk_penalty
  };
}

function buildMarkdownLines({ reportDate, accountId, pool }) {
  const lines = [
    `# ${reportDate} Opportunity Pool`,
    "",
    `- 账户：${accountId}`,
    `- 生成时间：${pool.generated_at}`,
    `- 候选数量：${pool.candidates.length}`,
    "",
    "## 主题候选排序",
    ""
  ];

  for (const [index, candidate] of pool.candidates.entries()) {
    lines.push(
      `- ${index + 1}. ${candidate.theme_name}（${candidate.market}）｜${candidate.action_bias}｜总分 ${candidate.total_score}｜代理 ${pickFirstProxyName(candidate)}`
    );
    lines.push(`  - 驱动：${candidate.driver || "暂无"}`);
    lines.push(`  - 预期差：${candidate.expected_vs_actual || "暂无"}`);
    lines.push(`  - 技术态：${candidate.technical_state || "暂无"}`);
    lines.push(`  - 资金态：${candidate.funding_flow_state || "暂无"}`);
    lines.push(`  - 风险：${candidate.risk_note || "暂无"}`);
  }

  return lines;
}

const options = parseArgs(args);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const reportDate = resolveDate(options.date);
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
const defaultOpportunityMasterPath = buildPortfolioPath(portfolioRoot, "config", "opportunity_master.json");
const defaultOutputJsonPath = buildPortfolioPath(portfolioRoot, "data", "opportunity_pool.json");
const defaultOutputReportPath = buildPortfolioPath(
  portfolioRoot,
  "reports",
  `${reportDate}-opportunity-pool.md`
);

const manifest = await readJsonOrNull(manifestPath);
const canonical = manifest?.canonical_entrypoints ?? {};
const opportunityMasterPath = canonical.opportunity_master ?? defaultOpportunityMasterPath;
const macroStatePath = canonical.latest_macro_state ?? buildPortfolioPath(portfolioRoot, "data", "macro_state.json");
const cnMarketSnapshotPath =
  canonical.latest_cn_market_snapshot ??
  buildPortfolioPath(portfolioRoot, "cn_market_snapshots", `${reportDate}-cn-snapshot.json`);
const outputJsonPath = options["output-json"] || canonical.latest_opportunity_pool_json || defaultOutputJsonPath;
const outputReportPath =
  options["report-path"] || canonical.latest_opportunity_pool_report || defaultOutputReportPath;

const [macroState, cnMarketSnapshot, opportunityMaster] = await Promise.all([
  readJsonOrNull(macroStatePath),
  readJsonOrNull(cnMarketSnapshotPath),
  loadOpportunityMaster(opportunityMasterPath)
]);

const orderedThemes = opportunityMaster.theme_order
  .map((themeName) =>
    opportunityMaster.themes.find((theme) => String(theme.theme_name) === String(themeName))
  )
  .filter(Boolean);
const themes = orderedThemes.length > 0 ? orderedThemes : opportunityMaster.themes;
const candidates = rankOpportunityCandidates(
  themes.map((theme) => buildOpportunityCandidate(theme, deriveThemeSignals(theme, { macroState, cnMarketSnapshot })))
);
const opportunityPool = {
  version: 1,
  as_of: reportDate,
  generated_at: new Date().toISOString(),
  account_id: accountId,
  source: {
    opportunity_master: opportunityMasterPath,
    macro_state: macroStatePath,
    cn_market_snapshot: cnMarketSnapshotPath
  },
  candidates
};
const reportLines = buildMarkdownLines({
  reportDate,
  accountId,
  pool: opportunityPool
});

await mkdir(buildPortfolioPath(portfolioRoot, "data"), { recursive: true });
await mkdir(buildPortfolioPath(portfolioRoot, "reports"), { recursive: true });
await writeFile(outputJsonPath, `${JSON.stringify(opportunityPool, null, 2)}\n`, "utf8");
await writeFile(outputReportPath, `${reportLines.join("\n")}\n`, "utf8");

if (manifest) {
  manifest.canonical_entrypoints = {
    ...(manifest.canonical_entrypoints ?? {}),
    latest_opportunity_pool_json: outputJsonPath,
    latest_opportunity_pool_report: outputReportPath
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      outputJsonPath,
      outputReportPath,
      candidates: opportunityPool.candidates.length
    },
    null,
    2
  )
);
