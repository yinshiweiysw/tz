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
import {
  buildUnifiedResearchSections,
  flattenResearchSections
} from "./lib/research_brain_render.mjs";
import {
  buildReportSessionInheritanceLines,
  buildReportSessionRecord,
  readReportSessionMemory,
  updateReportSessionMemory,
  writeReportSessionMemory
} from "./lib/report_session_memory.mjs";
import { selectInstitutionalStories } from "./lib/research_story_filter.mjs";
import { buildMarketPulseSessionContext } from "./lib/report_session_context.mjs";
import {
  annotateMarketQuote,
  formatMarketQuoteLine,
  getComparableChangePercent
} from "./lib/market_schedule_guard.mjs";
import {
  buildExternalSourceStatusLines,
  resolveQuoteFetchTimeoutMs,
  runGuardedFetch,
  summarizeGuardedBatch
} from "./lib/report_market_fetch_guard.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { round } from "./lib/format_utils.mjs";
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

const QUOTE_FETCH_TIMEOUT_MS = 5_000;
const AUX_FETCH_TIMEOUT_MS = 6_000;

function parseArgs(argv) {
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
  return ["morning", "noon", "close"].includes(session) ? session : "close";
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
  return formatMarketQuoteLine(label, quote);
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
  return selectInstitutionalStories(items, {
    limit,
    focusKeywords: telegraphKeywords,
    authoritativeKeywords: authoritativeHeadlineKeywords,
    minScore: 1
  });
}

function selectHeadlines(items, limit = 4) {
  return selectInstitutionalStories(items, {
    limit,
    focusKeywords: headlineKeywords,
    authoritativeKeywords: authoritativeHeadlineKeywords,
    minScore: 24
  });
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
  const averageA = average([
    getComparableChangePercent(sh, { includeReferenceClose: true }),
    getComparableChangePercent(hs300, { includeReferenceClose: true })
  ]);
  const boardAverage = average((boards ?? []).slice(0, 3).map((item) => Number(item.bd_zdf)));
  const parts = [];

  if (session === "morning") {
    if ((getComparableChangePercent(es, { includeReferenceClose: true }) ?? 0) > 0.3 || (getComparableChangePercent(nq, { includeReferenceClose: true }) ?? 0) > 0.3) {
      parts.push("隔夜外盘偏强");
    } else if ((getComparableChangePercent(es, { includeReferenceClose: true }) ?? 0) < -0.3 || (getComparableChangePercent(nq, { includeReferenceClose: true }) ?? 0) < -0.3) {
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

  const hsiMove = getComparableChangePercent(hsi);
  const hsTechMove = getComparableChangePercent(hsTech);
  if ((hsTechMove ?? 0) <= -2 || ((hsiMove ?? 0) < 0 && (hsTechMove ?? 0) < 0)) {
    parts.push("港股高波偏弱");
  }

  const goldSignal =
    getComparableChangePercent(londonGold, { includeReferenceClose: true }) ??
    getComparableChangePercent(gold, { includeReferenceClose: true }) ??
    0;

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
  const hs300Move = getComparableChangePercent(hs300, { includeReferenceClose: true });
  const hsTechMove = getComparableChangePercent(hsTech);
  const esMove = getComparableChangePercent(es, { includeReferenceClose: true });
  const nqMove = getComparableChangePercent(nq, { includeReferenceClose: true });
  const goldSignal =
    getComparableChangePercent(londonGold, { includeReferenceClose: true }) ??
    getComparableChangePercent(gold, { includeReferenceClose: true }) ??
    0;

  const onshoreWeak = (hs300Move ?? 0) <= -1 || (hsTechMove ?? 0) <= -2;
  const offshoreWeak = (esMove ?? 0) <= -0.3 || (nqMove ?? 0) <= -0.3;
  const riskOff = onshoreWeak || offshoreWeak;
  const stabilization =
    (hs300Move ?? 0) > -0.5 &&
    (hsTechMove ?? 0) > -1 &&
    (esMove ?? 0) > -0.2 &&
    (nqMove ?? 0) > -0.2;

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

function buildAllowedActions(quotes, { session, decisionContract } = {}) {
  const riskState = evaluateRiskState(quotes);

  if (decisionContract && !decisionContract.tradingAllowed) {
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

function buildBlockedActions(quotes, { decisionContract } = {}) {
  const riskState = evaluateRiskState(quotes);
  const blocked = [
    "禁止盘中追涨杀跌",
    "禁止把单条快讯直接转成加仓指令"
  ];

  if (riskState.riskOff) {
    blocked.push("禁止左侧硬接高波主题与重仓抄底");
  }

  if (decisionContract && !decisionContract.tradingAllowed) {
    blocked.push("禁止在研究主脑门禁未放行时下达新增交易");
  }

  return blocked;
}

function buildSpeculativeDiscipline(quotes, { decisionContract } = {}) {
  if (decisionContract && !decisionContract.tradingAllowed) {
    return "研究主脑未放行前，博弈仓仅允许纸面推演，不执行新增实盘试单。";
  }

  const riskState = evaluateRiskState(quotes);
  if (riskState.riskOff) {
    return "博弈仓只保留侦察仓，单笔小额、先定证伪，失效即退。";
  }

  return "博弈仓允许试单但必须遵守仓位上限，触发失败时优先减仓而非补仓。";
}

function normalizeResearchDecisionContract(researchBrain) {
  const readiness = researchBrain?.decision_readiness ?? {};
  return {
    level: String(readiness?.level ?? "unknown").trim() || "unknown",
    analysisAllowed: readiness?.analysis_allowed === true,
    tradingAllowed: readiness?.trading_allowed === true,
    reasons: Array.isArray(readiness?.reasons) ? readiness.reasons.filter(Boolean) : []
  };
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
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%，沪深300 ${formatSigned(getComparableChangePercent(hs300, { includeReferenceClose: true }), "%")}，创业板指 ${formatSigned(getComparableChangePercent(chinext, { includeReferenceClose: true }), "%")}；这部分是当前账户最核心的骨架与主要方向仓。`
      );
      continue;
    }

    if (bucket.bucketKey === "GLB_MOM" || bucket.bucketKey === "TACTICAL") {
      const hkMoveText =
        hsTech?.quote_usage === "previous_close_reference" ||
        hsTech?.quote_usage === "closed_market_reference"
          ? `港股休市，上一交易日恒生科技指数 ${formatSigned(
              getComparableChangePercent(hsTech, { includeReferenceClose: true }),
              "%"
            )}`
          : `恒生科技指数 ${formatSigned(
              getComparableChangePercent(hsTech, { includeReferenceClose: true }),
              "%"
            )}`;
      lines.push(
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%，${hkMoveText}；这是当前账户里弹性最高、也最需要单独盯住的风险腿。`
      );
      continue;
    }

    if (bucket.bucketKey === "HEDGE") {
      lines.push(
        `- ${bucket.label}占已投资仓位 ${bucket.weightPct}%，伦敦金 ${formatSigned(getComparableChangePercent(londonGold, { includeReferenceClose: true }), "%")} / 上金所Au99.99 ${formatSigned(getComparableChangePercent(gold, { includeReferenceClose: true }), "%")}；黄金更偏对冲腿。`
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

function buildResearchGuardLines(researchBrain) {
  if (!researchBrain) {
    return [
      "- 研究会话：--。",
      "- 决策状态：--。",
      "- 风险说明：研究主脑缺失，当前仅可做低置信度观察。",
      "- 覆盖降级：研究覆盖未知域不完整，以下结论仅作低置信度参考。",
      "- 新鲜度/覆盖概览：freshness=--，coverage=--。"
    ];
  }

  const freshnessStatus = String(researchBrain?.freshness_guard?.overall_status ?? "--").trim() || "--";
  const coverageStatus = String(researchBrain?.coverage_guard?.overall_status ?? "--").trim() || "--";
  const session = String(researchBrain?.meta?.market_session ?? "--").trim() || "--";
  const decisionContract = normalizeResearchDecisionContract(researchBrain);
  const staleDependencies = Array.isArray(researchBrain?.freshness_guard?.stale_dependencies)
    ? researchBrain.freshness_guard.stale_dependencies
        .map((item) => item?.label ?? item?.key ?? null)
        .filter(Boolean)
    : [];
  const missingDependencies = Array.isArray(researchBrain?.freshness_guard?.missing_dependencies)
    ? researchBrain.freshness_guard.missing_dependencies
        .map((item) => item?.label ?? item?.key ?? null)
        .filter(Boolean)
    : [];
  const weakCoverageDomains = Array.isArray(researchBrain?.coverage_guard?.weak_domains)
    ? researchBrain.coverage_guard.weak_domains
        .map((item) =>
          typeof item === "string"
            ? item
            : item?.domain ?? item?.key ?? item?.label ?? null
        )
        .filter(Boolean)
    : [];
  const normalizeSentence = (value) => String(value ?? "").trim().replace(/[。.!?]+$/u, "");
  const riskLines =
    decisionContract.reasons.length > 0
      ? decisionContract.reasons.map((reason) => `- 风险说明：${normalizeSentence(reason)}。`)
      : ["- 风险说明：无显式门禁风险。"];
  const coverageLines =
    weakCoverageDomains.length > 0
      ? weakCoverageDomains.map(
          (domain) => `- 覆盖降级：${normalizeSentence(domain)} 域不完整，以下结论仅作低置信度参考。`
        )
      : ["- 覆盖降级：无。"];

  return [
    `- 研究会话：${session}。`,
    `- 决策状态：${decisionContract.level}（分析${decisionContract.analysisAllowed ? "可用" : "受限"}，交易${
      decisionContract.tradingAllowed ? "可执行" : "受限"
    }）。`,
    ...riskLines,
    ...coverageLines,
    `- 新鲜度/覆盖概览：freshness=${freshnessStatus}，coverage=${coverageStatus}。`,
    `- 数据缺口：stale=${staleDependencies.length > 0 ? staleDependencies.join("、") : "无"}；missing=${
      missingDependencies.length > 0 ? missingDependencies.join("、") : "无"
    }。`
  ];
}

function selectResearchBrainForRender(researchBrain, failedRefreshSteps) {
  void failedRefreshSteps;
  return researchBrain ?? null;
}

function selectResearchBrainForDecision(researchBrain, failedRefreshSteps) {
  if (failedRefreshSteps?.has?.("research_brain")) {
    return null;
  }

  return researchBrain ?? null;
}

function buildFreshnessLines({ portfolioState, freshness, refresh }) {
  const refreshedTargets = (refresh.refreshedTargets ?? []).filter(
    (target) => target !== "research_brain"
  );
  const skippedTargets = (refresh.skippedTargets ?? []).filter(
    (target) => target !== "research_brain"
  );
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

  if (refresh.triggered && refreshedTargets.length > 0) {
    lines.push(`- 本次生成前已自动刷新：${refreshedTargets.join("、")}。`);
  } else if (refresh.mode === "never" && skippedTargets.length > 0) {
    lines.push(`- 本次未自动刷新：${skippedTargets.join("、")} 仍按现有快照输出。`);
  }

  for (const entry of freshness?.entries ?? []) {
    if (entry.key === "latest_snapshot" || entry.key === "research_brain") {
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
const sessionContext = buildMarketPulseSessionContext({
  session,
  dateText: briefDate
});
const config = sessionContext;
const portfolioRoot = resolvePortfolioRoot(options);
const reportOptions = {
  ...options,
  now: sessionContext.referenceNow.toISOString()
};
const { manifest, payloads, freshness, refresh, paths } = await ensureReportContext({
  portfolioRoot,
  options: reportOptions
});
const failedRefreshSteps = new Set(
  (refresh?.errors ?? []).map((entry) => entry?.step).filter(Boolean)
);
const riskDashboardUsable = Boolean(payloads.riskDashboard) && !failedRefreshSteps.has("risk_dashboard");
const riskDashboard = riskDashboardUsable ? payloads.riskDashboard : {};
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
  const [quoteResults, boardsResult, telegraphsResult] = await Promise.all([
    Promise.all(
      [...aShareIndexConfigs, ...hongKongIndexConfigs, ...asiaReferenceConfigs, ...globalConfigs].map((item) =>
        runGuardedFetch({
          source: `quote:${item.code}`,
          label: item.label,
          timeoutMs: resolveQuoteFetchTimeoutMs(item.code, QUOTE_FETCH_TIMEOUT_MS),
          task: () => getStockQuote(item.code)
        })
      )
    ),
    runGuardedFetch({
      source: "boards",
      label: "热点板块",
      timeoutMs: AUX_FETCH_TIMEOUT_MS,
      task: () => getHotBoards({ boardType: "industry", limit: 5 })
    }),
    runGuardedFetch({
      source: "telegraphs",
      label: "市场电报",
      timeoutMs: AUX_FETCH_TIMEOUT_MS,
      task: () => getMarketTelegraph(40)
    })
  ]);

  const now = sessionContext.referenceNow;
  const successfulQuotes = quoteResults
    .filter((item) => item.ok)
    .map((item) =>
      annotateMarketQuote({
        code: item.data?.stockCode,
        quote: item.data,
        now
      })
    );
  const boards = boardsResult.ok ? boardsResult.data : { items: [] };
  const telegraphs = telegraphsResult.ok ? telegraphsResult.data : [];
  const externalSourceStatusLines = buildExternalSourceStatusLines([
    summarizeGuardedBatch({
      source: "quotes",
      label: "行情报价",
      results: quoteResults
    }),
    boardsResult,
    telegraphsResult
  ]);
  const selectedHeadlines = selectHeadlines(telegraphs ?? [], 4);
  const selectedTelegraphs = selectTelegraphs(telegraphs ?? [], 6);
  const portfolioMap = buildPortfolioMap(riskDashboard, successfulQuotes, freshness, bucketConfigMap);
  const freshnessLines = buildFreshnessLines({ portfolioState, freshness, refresh });
  const activeResearchBrain = selectResearchBrainForRender(payloads.researchBrain, failedRefreshSteps);
  const decisionResearchBrain = selectResearchBrainForDecision(
    payloads.researchBrain,
    failedRefreshSteps
  );
  const sessionMemory = await readReportSessionMemory(paths.reportSessionMemoryPath);
  const currentSessionRecord = activeResearchBrain
    ? buildReportSessionRecord({
        tradeDate: briefDate,
        session,
        reportType: "market_pulse",
        researchBrain: activeResearchBrain
      })
    : null;
  const sessionTraceLines = currentSessionRecord
    ? buildReportSessionInheritanceLines({
        memory: sessionMemory,
        tradeDate: briefDate,
        session,
        currentRecord: currentSessionRecord
      })
    : ["- 会话继承：研究主脑缺失，当前无法建立跨时段验证链。"];
  const updatedSessionMemory = currentSessionRecord
    ? updateReportSessionMemory(sessionMemory, currentSessionRecord)
    : sessionMemory;
  const researchGuardLines = buildResearchGuardLines(activeResearchBrain);
  const decisionContract = normalizeResearchDecisionContract(decisionResearchBrain);
  const marketTone = buildTone(successfulQuotes, boards.items ?? [], session);
  const renderResearchSections = buildUnifiedResearchSections({
    researchBrain: activeResearchBrain,
    cnMarketSnapshot: payloads.cnMarketSnapshot,
    researchGuardLines
  });
  const decisionDeskSection = buildUnifiedResearchSections({
    researchBrain: decisionResearchBrain,
    cnMarketSnapshot: payloads.cnMarketSnapshot,
    researchGuardLines
  }).find((item) => item.heading === "## Desk Action Conclusion");
  const researchSectionLines = flattenResearchSections(
    renderResearchSections.map((section) =>
      section.heading === "## Desk Action Conclusion" && decisionDeskSection
        ? { ...section, lines: decisionDeskSection.lines }
        : section
    )
  );
  const speculativeDisciplineLines = buildSpeculativeDisciplineBlock(
    buildSpeculativeDiscipline(successfulQuotes, { decisionContract })
  );
  const riskState = evaluateRiskState(successfulQuotes);

  const lines = [
    `# ${briefDate} ${config.title}`,
    "",
    "## 一句话结论",
    "",
    `- ${marketTone}`,
    `- ${config.hint}`,
    ...(!decisionContract.tradingAllowed
      ? [
          `- ⚠️ 研究主脑决策门禁未放行（level=${decisionContract.level}${
            decisionContract.reasons.length > 0 ? `；reasons=${decisionContract.reasons.join("、")}` : ""
          }），本页仅用于看盘与复盘，不作为新增下单依据。`
        ]
      : []),
    ...(externalSourceStatusLines.length > 0 ? ["", ...externalSourceStatusLines] : []),
    "",
    ...researchSectionLines,
    "",
    "## 会话主线跟踪",
    "",
    ...sessionTraceLines,
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
    ...(
      riskDashboardUsable
        ? portfolioMap.length > 0
          ? portfolioMap
          : ["- 暂无组合映射数据"]
        : ["- ⚠️ 风险仪表盘当前缺失或本轮刷新失败，本节不沿用旧风控盘输出组合映射结论。"]
    ),
    "",
    `## ${config.actionLabel}`,
    "",
    `- 会话执行阈值：${
      !decisionContract.tradingAllowed
        ? "研究主脑未放行，当前会话仅允许观察与计划更新。"
        : riskState.stabilization
          ? "指数与外盘具备企稳条件，可按计划小步执行。"
          : "指数与外盘未形成共振企稳，默认维持观察与防守。"
    }`,
    "- 若会话中出现新增风险警报，先更新日志与交易卡，再考虑动作。"
  ];

  await writeReportSessionMemory(paths.reportSessionMemoryPath, updatedSessionMemory);
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

  if (manifest?.canonical_entrypoints) {
    await updateManifestCanonicalEntrypoints({
      manifestPath,
      baseManifest: manifest,
      entries:
        session === "morning"
          ? { latest_morning_market_pulse: outputPath }
          : session === "noon"
            ? { latest_noon_market_pulse: outputPath }
            : { latest_close_market_pulse: outputPath }
    });
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
