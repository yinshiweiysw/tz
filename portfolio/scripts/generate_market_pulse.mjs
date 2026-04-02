import { mkdir, writeFile } from "node:fs/promises";
import { closeCmeBrowser } from "../../market-mcp/src/providers/cme.js";
import {
  getHotBoards,
  getMarketTelegraph,
  getStockQuote
} from "../../market-mcp/src/providers/stock.js";
import { buildPortfolioPath, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { buildBucketConfigMap, loadAssetMaster } from "./lib/asset_master.mjs";
import {
  buildInstitutionalActionLines,
  buildSpeculativeDisciplineBlock
} from "./lib/dual_trade_plan_render.mjs";
import { ensureReportContext } from "./lib/report_context.mjs";

const args = process.argv.slice(2);

const aShareIndexConfigs = [
  { label: "上证指数", code: "000001.SH" },
  { label: "上证50", code: "000016.SH" },
  { label: "沪深300", code: "000300.SH" },
  { label: "中证500", code: "000905.SH" },
  { label: "创业板指", code: "399006.SZ" }
];

const hongKongIndexConfigs = [
  { label: "恒生指数", code: "r_hkHSI" },
  { label: "恒生国企指数", code: "r_hkHSCEI" },
  { label: "恒生科技指数", code: "r_hkHSTECH" }
];

const asiaReferenceConfigs = [
  { label: "日经225", code: "znb_NKY" },
  { label: "首尔综合", code: "znb_KOSPI" }
];

const globalConfigs = [
  { label: "标普500期货", code: "hf_ES" },
  { label: "纳斯达克100期货", code: "hf_NQ" },
  { label: "伦敦金", code: "hf_XAU" },
  { label: "上金所Au99.99", code: "AU9999.SGE" }
];

const telegraphKeywords = [
  "中东",
  "伊朗",
  "以色列",
  "油",
  "黄金",
  "港股",
  "恒生",
  "中概",
  "美股",
  "算力",
  "AI",
  "半导体",
  "消费电子",
  "通信",
  "电池",
  "银行"
];

const headlineKeywords = [
  "中东",
  "伊朗",
  "以色列",
  "停火",
  "关税",
  "原油",
  "油价",
  "黄金",
  "美股",
  "纳指",
  "标普",
  "恒生",
  "港股",
  "央行",
  "降息",
  "加息",
  "通胀",
  "非农",
  "汇率",
  "人民币"
];

const authoritativeHeadlineKeywords = [
  "停火",
  "袭击",
  "导弹",
  "海峡",
  "油价",
  "原油",
  "降息",
  "加息",
  "通胀",
  "财政",
  "央行",
  "统计局",
  "非农",
  "关税",
  "制裁",
  "美债",
  "收益率"
];

const noisyHeadlineKeywords = [
  "盘面直播",
  "竞价看龙头",
  "局部异动",
  "双双涨停",
  "快速拉升",
  "触及涨停",
  "触及跌停",
  "概念股",
  "早盘",
  "午后",
  "尾盘",
  "资金流向"
];

const sessionConfig = {
  morning: {
    title: "金融早报",
    actionLabel: "开盘前计划",
    hint: "先看隔夜风险资产、期货和黄金，再决定今天是否允许按计划执行基金交易。"
  },
  noon: {
    title: "金融午报",
    actionLabel: "午间观察",
    hint: "先看指数跌幅是否收敛、热点是否扩散；午间默认只观察，不把短线波动直接转化成交易动作。"
  },
  close: {
    title: "金融晚报",
    actionLabel: "次日判断",
    hint: "先看收盘结构和晚间外盘，再判断次日是否允许开下一笔。"
  }
};

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

function normalizeSession(raw) {
  const session = String(raw ?? "close").trim().toLowerCase();
  return sessionConfig[session] ? session : "close";
}

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function formatSigned(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  const numeric = round(value);
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric}${suffix}`;
}

function shortText(text, max = 86) {
  const input = String(text ?? "").replace(/\s+/g, " ").trim();
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}…`;
}

function findQuote(quotes, code) {
  const target = String(code ?? "").trim().toUpperCase();
  return (
    quotes.find((item) => String(item.stockCode ?? "").trim().toUpperCase() === target) ?? null
  );
}

function formatQuoteLine(label, quote) {
  if (!quote) {
    return `- ${label}：暂无数据`;
  }

  return `- ${label}：${quote.latestPrice}（${formatSigned(quote.changePercent, "%")}）`;
}

function average(values) {
  const valid = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (valid.length === 0) {
    return null;
  }
  return round(valid.reduce((sum, item) => sum + Number(item), 0) / valid.length);
}

function scoreTelegraph(item) {
  const text = `${item.title ?? ""} ${item.content ?? ""} ${(item.subjects ?? []).join(" ")}`;
  let score = item.isImportant ? 100 : 0;

  for (const keyword of telegraphKeywords) {
    if (text.includes(keyword)) {
      score += 10;
    }
  }

  return score;
}

function scoreHeadline(item) {
  const text = `${item.title ?? ""} ${item.content ?? ""} ${(item.subjects ?? []).join(" ")}`;
  let score = item.isImportant ? 120 : 0;

  for (const keyword of headlineKeywords) {
    if (text.includes(keyword)) {
      score += 14;
    }
  }

  for (const keyword of authoritativeHeadlineKeywords) {
    if (text.includes(keyword)) {
      score += 20;
    }
  }

  for (const keyword of noisyHeadlineKeywords) {
    if (text.includes(keyword)) {
      score -= 60;
    }
  }

  if (text.includes("突发") || text.includes("最新") || text.includes("快讯")) {
    score += 8;
  }

  if (text.includes("统计局") || text.includes("央行") || text.includes("美联储")) {
    score += 16;
  }

  return score;
}

function selectTelegraphs(items, limit = 6) {
  return items
    .map((item, index) => ({ ...item, score: scoreTelegraph(item), originalIndex: index }))
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
    .slice(0, limit);
}

function selectHeadlines(items, limit = 4) {
  return items
    .map((item, index) => ({ ...item, score: scoreHeadline(item), originalIndex: index }))
    .filter((item) => {
      const text = `${item.title ?? ""} ${item.content ?? ""} ${(item.subjects ?? []).join(" ")}`;
      return !noisyHeadlineKeywords.some((keyword) => text.includes(keyword));
    })
    .filter((item) => item.score >= 40)
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
    .slice(0, limit);
}

function buildTone(quotes, boards, session) {
  const sh = findQuote(quotes, "000001.SH");
  const hs300 = findQuote(quotes, "000300.SH");
  const hsi = findQuote(quotes, "r_hkHSI");
  const hsTech = findQuote(quotes, "r_hkHSTECH");
  const es = findQuote(quotes, "hf_ES");
  const nq = findQuote(quotes, "hf_NQ");
  const londonGold = findQuote(quotes, "hf_XAU");
  const gold = findQuote(quotes, "AU9999.SGE");
  const averageA = average([sh?.changePercent, hs300?.changePercent]);
  const boardAverage = average((boards ?? []).slice(0, 3).map((item) => Number(item.bd_zdf)));
  const parts = [];

  if (session === "morning") {
    if ((es?.changePercent ?? 0) > 0.3 || (nq?.changePercent ?? 0) > 0.3) {
      parts.push("隔夜外盘偏强");
    } else if ((es?.changePercent ?? 0) < -0.3 || (nq?.changePercent ?? 0) < -0.3) {
      parts.push("隔夜外盘偏弱");
    } else {
      parts.push("隔夜外盘震荡");
    }
  }

  if (averageA !== null) {
    if (averageA >= 1) {
      parts.push("A股偏强");
    } else if (averageA <= -1) {
      parts.push("A股承压");
    } else {
      parts.push("A股偏震荡");
    }
  }

  if ((hsTech?.changePercent ?? 0) <= -2 || ((hsi?.changePercent ?? 0) < 0 && (hsTech?.changePercent ?? 0) < 0)) {
    parts.push("港股高波偏弱");
  }

  const goldSignal = londonGold?.changePercent ?? gold?.changePercent ?? 0;

  if (goldSignal >= 1) {
    parts.push("黄金偏强");
  } else if (goldSignal <= -1) {
    parts.push("黄金明显回落");
  }

  if ((boardAverage ?? 0) >= 2) {
    parts.push("热点扩散较好");
  }

  return parts.join("；") || "市场信号偏中性";
}

function evaluateRiskState(quotes) {
  const hs300 = findQuote(quotes, "000300.SH");
  const hsTech = findQuote(quotes, "r_hkHSTECH");
  const es = findQuote(quotes, "hf_ES");
  const nq = findQuote(quotes, "hf_NQ");
  const londonGold = findQuote(quotes, "hf_XAU");
  const gold = findQuote(quotes, "AU9999.SGE");
  const goldSignal = londonGold?.changePercent ?? gold?.changePercent ?? 0;

  const onshoreWeak = (hs300?.changePercent ?? 0) <= -1 || (hsTech?.changePercent ?? 0) <= -2;
  const offshoreWeak = (es?.changePercent ?? 0) <= -0.3 || (nq?.changePercent ?? 0) <= -0.3;
  const riskOff = onshoreWeak || offshoreWeak;
  const stabilization =
    (hs300?.changePercent ?? 0) > -0.5 &&
    (hsTech?.changePercent ?? 0) > -1 &&
    (es?.changePercent ?? 0) > -0.2 &&
    (nq?.changePercent ?? 0) > -0.2;

  return {
    riskOff,
    onshoreWeak,
    offshoreWeak,
    goldStrong: goldSignal >= 1,
    stabilization
  };
}

function buildExpectationGap(quotes, boards, session) {
  const riskState = evaluateRiskState(quotes);
  const boardAverage = average((boards ?? []).slice(0, 3).map((item) => Number(item.bd_zdf)));

  if (riskState.riskOff && (boardAverage ?? 0) >= 1) {
    return "指数承压但热点仍有活跃度，情绪修复与指数趋势尚未共振。";
  }

  if (!riskState.riskOff && riskState.goldStrong) {
    return "风险资产尝试修复但黄金仍偏强，说明避险溢价尚未完全回落。";
  }

  if (session === "morning" && riskState.offshoreWeak && !riskState.onshoreWeak) {
    return "隔夜外盘偏弱但A股尚未失守，开盘后需验证承接是否持续。";
  }

  return "当前主线尚未形成一致预期，需等待指数与板块扩散同步确认。";
}

function buildAllowedActions(quotes, { session, staleExecutionContext = false } = {}) {
  const riskState = evaluateRiskState(quotes);

  if (staleExecutionContext) {
    return ["仅允许观察与复盘，不新增实盘交易", "如必须处理风险，仅限缩小既有高波暴露"];
  }

  if (riskState.riskOff) {
    return ["仅允许执行防守仓和风险收缩动作", "允许计划内小额试单，但必须分批且先设退出条件"];
  }

  return [
    session === "noon"
      ? "午间仅允许调整观察清单和挂单参数，不做追价动作"
      : "允许按计划执行一笔交易，优先防守仓再看核心仓",
    "每次动作先校验仓位上限与现金缓冲，保持小步执行"
  ];
}

function buildBlockedActions(quotes, { staleExecutionContext = false } = {}) {
  const riskState = evaluateRiskState(quotes);
  const blocked = [
    "禁止盘中追涨杀跌",
    "禁止把单条快讯直接转成加仓指令"
  ];

  if (riskState.riskOff) {
    blocked.push("禁止左侧硬接高波主题与重仓抄底");
  }

  if (staleExecutionContext) {
    blocked.push("禁止在量化链路滞后时下达新增交易");
  }

  return blocked;
}

function buildSpeculativeDiscipline(quotes, { staleExecutionContext = false } = {}) {
  if (staleExecutionContext) {
    return "底层链路滞后期间，博弈仓仅允许纸面推演，不执行新增实盘试单。";
  }

  const riskState = evaluateRiskState(quotes);
  if (riskState.riskOff) {
    return "博弈仓只保留侦察仓，单笔小额、先定证伪，失效即退。";
  }

  return "博弈仓允许试单但必须遵守仓位上限，触发失败时优先减仓而非补仓。";
}

function buildPortfolioMap(riskDashboard, quotes, freshness, bucketConfigMap = {}) {
  const view = riskDashboard?.working_view ?? riskDashboard?.canonical_view ?? {};
  const weights = view?.bucket_weights_pct_of_invested_capital ?? {};
  const concentration = view?.concentration ?? {};
  const correlationStructure = view?.correlation_structure ?? {};
  const hsTech = findQuote(quotes, "r_hkHSTECH");
  const hs300 = findQuote(quotes, "000300.SH");
  const chinext = findQuote(quotes, "399006.SZ");
  const londonGold = findQuote(quotes, "hf_XAU");
  const gold = findQuote(quotes, "AU9999.SGE");
  const lines = [];
  const staleCoreKeys = new Set(["signals_matrix", "macro_radar", "risk_dashboard"]);
  const blockingStaleEntries = freshness?.entries?.filter(
    (entry) => staleCoreKeys.has(entry.key) && entry.status !== "aligned"
  ) ?? [];

  if (blockingStaleEntries.length > 0) {
    lines.push(
      `- ⚠️ 当前组合关系仅代表 ${riskDashboard?.as_of ?? "最近可用"} 收盘后的结构暴露；${blockingStaleEntries
        .map((entry) => `${entry.label} 仍停留在 ${entry.asOf ?? "未知日期"}`)
        .join("、")}，不得把这部分内容直接当成当日实时加减仓指令。`
    );
  }

  const dominantBuckets = Object.entries(weights)
    .map(([bucketKey, weightPct]) => ({
      bucketKey,
      weightPct: Number(weightPct),
      label: bucketConfigMap?.[bucketKey]?.label ?? bucketConfigMap?.[bucketKey]?.shortLabel ?? bucketKey
    }))
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct)
    .slice(0, 3);

  for (const bucket of dominantBuckets) {
    if (bucket.bucketKey === "A_CORE") {
      lines.push(
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%，沪深300 ${formatSigned(hs300?.changePercent, "%")}，创业板指 ${formatSigned(chinext?.changePercent, "%")}；这部分是当前账户最核心的骨架与主要方向仓。`
      );
      continue;
    }

    if (bucket.bucketKey === "GLB_MOM" || bucket.bucketKey === "TACTICAL") {
      lines.push(
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%，恒生科技指数 ${formatSigned(hsTech?.changePercent, "%")}；这是当前账户里弹性最高、也最需要单独盯住的风险腿。`
      );
      continue;
    }

    if (bucket.bucketKey === "HEDGE") {
      lines.push(
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%，伦敦金 ${formatSigned(londonGold?.changePercent, "%")} / 上金所Au99.99 ${formatSigned(gold?.changePercent, "%")}；黄金更偏对冲腿。`
      );
      continue;
    }

    if (bucket.bucketKey === "INCOME") {
      lines.push(
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%；这部分更偏低波防守与现金流稳定器，解读时要同时看估值与利差信号。`
      );
      continue;
    }

    if (bucket.bucketKey !== "CASH") {
      lines.push(`- ${bucket.label}占已投资仓位 ${bucket.weightPct}%；这是当前需要重点盯住的一条主风险腿。`);
    }
  }

  if ((weights.A_CORE ?? 0) <= 0) {
    lines.push("- 当前无A股核心仓，账户缺少骨架缓冲，若继续维持进攻型主动仓集中，回撤会更直接。");
  }

  if (Number.isFinite(Number(concentration?.largest_position?.weight_pct_of_invested_capital))) {
    lines.push(
      `- 当前单一最大仓为 ${concentration.largest_position.name}，占已投资仓位 ${concentration.largest_position.weight_pct_of_invested_capital}%；若这只主动基金回撤，账户净值会直接承压。`
    );
  }

  if (Number.isFinite(Number(concentration?.top3_weight_pct_of_invested_capital))) {
    lines.push(
      `- 前三大持仓合计占比 ${concentration.top3_weight_pct_of_invested_capital}%，组合分散度偏弱，更像高集中主动表达而不是均衡配置。`
    );
  }

  const highestPair = correlationStructure?.highest_abs_correlation_pair ?? null;
  if (highestPair && Number.isFinite(Number(highestPair?.abs_correlation_60d))) {
    lines.push(
      `- 组合内部最高相关的一对是 ${highestPair.left_name} 与 ${highestPair.right_name}，近60天相关系数 ${highestPair.abs_correlation_60d}；表面上是两只基金，实质上风险高度同向。`
    );
  }

  if (lines.length === 0) {
    lines.push("- 当前账户暂无可映射的主题暴露，先以持仓集中度和单基金风险为主。");
  }

  return lines;
}

function formatBoardLine(item) {
  return `- ${item?.bd_name ?? "未知板块"}：${formatSigned(item?.bd_zdf, "%")}，龙头 ${item?.nzg_name ?? "--"} ${formatSigned(item?.nzg_zdf, "%")}`;
}

function formatTelegraphLine(item) {
  const subject = (item.subjects ?? []).slice(0, 2).join(" / ");
  const prefix = subject ? `${subject}：` : "";
  return `- ${prefix}${shortText(item.title || item.content)}`;
}

function pickTelegraphTime(item) {
  return (
    item.time ||
    item.publishTime ||
    item.publishedAt ||
    item.createdAt ||
    item.dateTime ||
    ""
  );
}

function formatTelegraphHeadlineLine(item) {
  const subject = (item.subjects ?? []).slice(0, 2).join(" / ");
  const label = subject ? `[${subject}] ` : "";
  const time = pickTelegraphTime(item);
  const timePrefix = time ? `${String(time).trim()} ` : "";
  return `- ${timePrefix}${label}${shortText(item.title || item.content, 96)}`;
}

function buildFreshnessLines({ portfolioState, freshness, refresh }) {
  const lines = [
    "- 实时行情层：本次生成时直接抓取 market-mcp 实时快照，属于当前时点数据。",
    `- 组合主状态：portfolio_state.json 当前锚定为 ${portfolioState?.snapshot_date ?? "未知日期"} 收盘快照；缺失时才回退到 latest.json 兼容视图。`
  ];

  if (refresh.mode === "never") {
    lines.push("- 刷新策略：当前为只读模式，本次仅消费现有状态文件。");
  } else if (refresh.mode === "force") {
    lines.push("- 刷新策略：当前为强制刷新模式，会先重算底层状态再生成快报。");
  } else {
    lines.push("- 刷新策略：当前为按需自动刷新模式，仅在滞后/缺失或关键质量告警时重跑。");
  }

  if (refresh.triggered && refresh.refreshedTargets.length > 0) {
    lines.push(`- 本次生成前已自动刷新：${refresh.refreshedTargets.join("、")}。`);
  } else if (refresh.mode === "never" && (refresh.skippedTargets ?? []).length > 0) {
    lines.push(`- 本次未自动刷新：${refresh.skippedTargets.join("、")} 仍按现有快照输出。`);
  }

  for (const entry of freshness?.entries ?? []) {
    if (entry.key === "latest_snapshot") {
      continue;
    }

    const generatedSuffix = entry.generatedAt ? `；文件生成于 ${entry.generatedAt}` : "";
    if (entry.status === "aligned") {
      lines.push(`- ${entry.label}：已对齐到 ${entry.asOf}${generatedSuffix}`);
    } else if (entry.status === "stale") {
      lines.push(`- ⚠️ ${entry.label}：仍停留在 ${entry.asOf}${generatedSuffix}`);
    } else {
      lines.push(`- ⚠️ ${entry.label}：当前缺失，报告只能使用降级口径。`);
    }

    if (entry.qualitySummary) {
      lines.push(`- ⚠️ ${entry.label} 质量告警：${entry.qualitySummary}`);
    }
  }

  if (refresh.errors.length > 0) {
    lines.push(
      `- ⚠️ 自动刷新未完全成功：${refresh.errors
        .map((item) => `${item.step} 失败`)
        .join("、")}；本报告已对相关段落降级，不直接输出实盘级指令。`
    );
  }

  if (freshness?.hasBlockingQualityIssues) {
    lines.push("- 🚨 质量门禁提示：当前关键链路存在 fallback/degraded 状态，本快报仅用于观察，不直接转化为执行指令。");
  }

  return lines;
}

const options = parseArgs(args);
const briefDate = resolveDate(options.date);
const session = normalizeSession(options.session);
const config = sessionConfig[session];
const portfolioRoot = resolvePortfolioRoot(options);
const { manifest, payloads, freshness, refresh } = await ensureReportContext({
  portfolioRoot,
  options
});
const riskDashboard = payloads.riskDashboard ?? {};
const portfolioState = payloads.latest ?? {};
const assetMasterPath =
  manifest?.canonical_entrypoints?.asset_master ??
  buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
const assetMaster = await loadAssetMaster(assetMasterPath).catch(() => null);
const bucketConfigMap = assetMaster ? buildBucketConfigMap(assetMaster) : {};
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
const outputDir = buildPortfolioPath(portfolioRoot, "market_pulses");
const outputPath = buildPortfolioPath(outputDir, `${briefDate}-${session}.md`);

await mkdir(outputDir, { recursive: true });

try {
  const [quoteResults, boards, telegraphs] = await Promise.all([
    Promise.allSettled(
      [...aShareIndexConfigs, ...hongKongIndexConfigs, ...asiaReferenceConfigs, ...globalConfigs].map((item) =>
        getStockQuote(item.code)
      )
    ),
    getHotBoards({ boardType: "industry", limit: 5 }).catch(() => ({ items: [] })),
    getMarketTelegraph(40).catch(() => [])
  ]);

  const successfulQuotes = quoteResults
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value);
  const selectedHeadlines = selectHeadlines(telegraphs ?? [], 4);
  const selectedTelegraphs = selectTelegraphs(telegraphs ?? [], 6);
  const portfolioMap = buildPortfolioMap(riskDashboard, successfulQuotes, freshness, bucketConfigMap);
  const freshnessLines = buildFreshnessLines({ portfolioState, freshness, refresh });
  const marketTone = buildTone(successfulQuotes, boards.items ?? [], session);
  const staleExecutionContext =
    freshness.entries?.some(
      (entry) =>
        ["signals_matrix", "macro_radar", "risk_dashboard"].includes(entry.key) &&
        (entry.status !== "aligned" || entry.blocksTrade || entry.qualityStatus !== "ok")
    ) ?? false;
  const institutionalActionLines = buildInstitutionalActionLines({
    thesis: `${marketTone}；${config.hint}`,
    expectationGap: buildExpectationGap(successfulQuotes, boards.items ?? [], session),
    allowedActions: buildAllowedActions(successfulQuotes, { session, staleExecutionContext }),
    blockedActions: buildBlockedActions(successfulQuotes, { staleExecutionContext })
  });
  const speculativeDisciplineLines = buildSpeculativeDisciplineBlock(
    buildSpeculativeDiscipline(successfulQuotes, { staleExecutionContext })
  );
  const riskState = evaluateRiskState(successfulQuotes);

  const lines = [
    `# ${briefDate} ${config.title}`,
    "",
    "## 一句话结论",
    "",
    `- ${marketTone}`,
    `- ${config.hint}`,
    ...(staleExecutionContext
      ? [
          "- ⚠️ 底层量化链路仍有滞后，本页先用于看盘和识别暴露，不直接作为今天的下单依据。"
        ]
      : []),
    "",
    "## 今日主线与操作纪律",
    "",
    ...institutionalActionLines,
    "",
    "## 博弈系统纪律",
    "",
    ...speculativeDisciplineLines,
    "",
    "## 数据时点与新鲜度",
    "",
    ...freshnessLines,
    "",
    "## 指数与关键市场",
    "",
    ...aShareIndexConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    ...hongKongIndexConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    ...asiaReferenceConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    ...globalConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    "",
    "## 今日头条",
    "",
    ...(
      selectedHeadlines.length > 0
        ? selectedHeadlines.map((item) => formatTelegraphHeadlineLine(item))
        : ["- 暂无头条快讯数据"]
    ),
    "",
    "## 热点与异动",
    "",
    ...(
      (boards.items ?? []).length > 0
        ? boards.items.slice(0, 5).map((item) => formatBoardLine(item))
        : ["- 暂无板块数据"]
    ),
    "",
    "## 重点新闻整理",
    "",
    ...(
      selectedTelegraphs.length > 0
        ? selectedTelegraphs.map((item) => formatTelegraphLine(item))
        : ["- 暂无快讯数据"]
    ),
    "",
    "## 与当前组合的关系",
    "",
    ...(portfolioMap.length > 0 ? portfolioMap : ["- 暂无组合映射数据"]),
    "",
    `## ${config.actionLabel}`,
    "",
    `- 会话执行阈值：${riskState.stabilization ? "指数与外盘具备企稳条件，可按计划小步执行。" : "指数与外盘未形成共振企稳，默认维持观察与防守。"}`,
    "- 若会话中出现新增风险警报，先更新日志与交易卡，再考虑动作。"
  ];

  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

  if (manifest?.canonical_entrypoints) {
    if (session === "morning") {
      manifest.canonical_entrypoints.latest_morning_market_pulse = outputPath;
    } else if (session === "noon") {
      manifest.canonical_entrypoints.latest_noon_market_pulse = outputPath;
    } else {
      manifest.canonical_entrypoints.latest_close_market_pulse = outputPath;
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        outputPath,
        session,
        quotes: successfulQuotes.length,
        telegraphs: selectedTelegraphs.length,
        refreshedTargets: refresh.refreshedTargets,
        staleAfterRefresh: freshness.staleKeys
      },
      null,
      2
    )
  );
} finally {
  await closeCmeBrowser().catch(() => {});
}
