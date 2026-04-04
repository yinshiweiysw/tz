import { mkdir, readFile, writeFile } from "node:fs/promises";
import { closeCmeBrowser } from "../../market-mcp/src/providers/cme.js";
import {
  getHotBoards,
  getHotStocks,
  getMarketTelegraph,
  getStockQuote
} from "../../market-mcp/src/providers/stock.js";
import { buildCnMarketBriefLines, loadCnMarketSnapshotFromManifest } from "./lib/cn_market_snapshot.mjs";
import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { buildBucketConfigMap, loadAssetMaster } from "./lib/asset_master.mjs";
import { buildInstitutionalActionLines } from "./lib/dual_trade_plan_render.mjs";
import {
  buildUnifiedResearchSections,
  flattenResearchSections
} from "./lib/research_brain_render.mjs";
import {
  buildReportSessionInheritanceLines,
  buildReportSessionRecord,
  resolveReportSessionSlot,
  readReportSessionMemory,
  updateReportSessionMemory,
  writeReportSessionMemory
} from "./lib/report_session_memory.mjs";
import { selectInstitutionalStories } from "./lib/research_story_filter.mjs";
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
import { ensureReportContext } from "./lib/report_context.mjs";

const args = process.argv.slice(2);

const aShareIndexConfigs = [
  { label: "上证指数", code: "000001.SH" },
  { label: "上证50", code: "000016.SH" },
  { label: "沪深300", code: "000300.SH" },
  { label: "中证500", code: "000905.SH" },
  { label: "中证1000", code: "000852.SH" },
  { label: "深证成指", code: "399001.SZ" },
  { label: "创业板指", code: "399006.SZ" },
  { label: "北证50", code: "899050.BJ" }
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

const globalIndexConfigs = [
  { label: "标普500", code: "usINX" },
  { label: "纳斯达克100", code: "usNDX" },
  { label: "标普500期货", code: "hf_ES" },
  { label: "纳斯达克100期货", code: "hf_NQ" }
];

const commodityConfigs = [
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
  "消费电子",
  "通信",
  "拼多多",
  "美团"
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

function shortText(text, max = 80) {
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
  return formatMarketQuoteLine(label, quote, { includeAmplitude: true });
}

function average(values) {
  const valid = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (valid.length === 0) {
    return null;
  }
  return round(valid.reduce((sum, item) => sum + Number(item), 0) / valid.length);
}

function buildContextModeLines(reportContext) {
  const freshness = reportContext?.freshness ?? {};
  const refresh = reportContext?.refresh ?? {};
  const skippedTargets = (refresh.skippedTargets ?? []).filter((target) => target !== "research_brain");
  const refreshedTargets = (refresh.refreshedTargets ?? []).filter(
    (target) => target !== "research_brain"
  );
  const degradedEntries = (freshness.degradedEntries ?? []).filter(
    (entry) => entry?.key !== "research_brain"
  );
  const lines = [];

  if (refresh.mode === "never") {
    lines.push("- 数据模式：当前为只读渲染模式，本次不会自动刷新底层状态文件。");
  } else if (refresh.mode === "force") {
    lines.push("- 数据模式：当前为强制刷新模式，已优先重跑底层链路后再生成日报。");
  } else {
    lines.push("- 数据模式：当前为按需自动刷新模式，仅在缺失/滞后或关键质量告警时重跑底层链路。");
  }

  if (skippedTargets.length > 0) {
    lines.push(`- 未自动刷新的链路：${skippedTargets.join("、")}。`);
  } else if (refresh.triggered && refreshedTargets.length > 0) {
    lines.push(`- 本次已自动刷新：${refreshedTargets.join("、")}。`);
  }

  if (degradedEntries.length > 0) {
    const labels = degradedEntries.map((entry) => entry.label).join("、");
    lines.push(`- 质量提示：${labels} 存在 fallback / degraded 信号，解读时应降低置信度。`);
  }

  if ((refresh.errors ?? []).length > 0) {
    const failedSteps = refresh.errors
      .map((entry) => entry?.step)
      .filter(Boolean)
      .join("、");
    if (failedSteps) {
      lines.push(`- ⚠️ 刷新失败：${failedSteps} 未能成功更新，本次报告按降级口径输出。`);
    }
  }

  return lines;
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
  const readinessLevel = String(researchBrain?.decision_readiness?.level ?? "--").trim() || "--";
  const analysisAllowed = researchBrain?.decision_readiness?.analysis_allowed === true;
  const tradingAllowed = researchBrain?.decision_readiness?.trading_allowed === true;
  const reasons = Array.isArray(researchBrain?.decision_readiness?.reasons)
    ? researchBrain.decision_readiness.reasons.filter(Boolean)
    : [];
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
    reasons.length > 0
      ? reasons.map((reason) => `- 风险说明：${normalizeSentence(reason)}。`)
      : ["- 风险说明：无显式门禁风险。"];
  const coverageLines =
    weakCoverageDomains.length > 0
      ? weakCoverageDomains.map(
          (domain) => `- 覆盖降级：${normalizeSentence(domain)} 域不完整，以下结论仅作低置信度参考。`
        )
      : ["- 覆盖降级：无。"];

  return [
    `- 研究会话：${session}。`,
    `- 决策状态：${readinessLevel}（分析${analysisAllowed ? "可用" : "受限"}，交易${
      tradingAllowed ? "可执行" : "受限"
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

function buildOpportunityPoolFallbackLines(opportunityPool, failedRefreshSteps) {
  if (failedRefreshSteps?.has?.("opportunity_pool")) {
    return ["- ⚠️ 机会池本轮刷新失败，本节不沿用旧候选池结论。"];
  }

  if (!opportunityPool) {
    return ["- ⚠️ 机会池当前缺失，本节仅保留空白降级口径，不输出候选池结论。"];
  }

  return buildOpportunityPoolLines(opportunityPool, 5);
}

function describeMarketTone(quotes, boards) {
  const sh = findQuote(quotes, "000001.SH");
  const hs300 = findQuote(quotes, "000300.SH");
  const sz = findQuote(quotes, "399001.SZ");
  const cyb = findQuote(quotes, "399006.SZ");
  const hsi = findQuote(quotes, "r_hkHSI");
  const hscei = findQuote(quotes, "r_hkHSCEI");
  const hkTechIndex = findQuote(quotes, "r_hkHSTECH");
  const spxFuture = findQuote(quotes, "hf_ES");
  const ndxFuture = findQuote(quotes, "hf_NQ");
  const londonGold = findQuote(quotes, "hf_XAU");
  const gold = findQuote(quotes, "AU9999.SGE");
  const broadAverage = average([
    getComparableChangePercent(sh, { includeReferenceClose: true }),
    getComparableChangePercent(hs300, { includeReferenceClose: true }),
    getComparableChangePercent(sz, { includeReferenceClose: true }),
    getComparableChangePercent(cyb, { includeReferenceClose: true })
  ]);
  const boardAverage = average((boards ?? []).slice(0, 5).map((item) => Number(item.bd_zdf)));
  const descriptors = [];

  if (broadAverage !== null) {
    if (broadAverage >= 1.5) {
      descriptors.push("A股风险偏好明显回暖");
    } else if (broadAverage >= 0.5) {
      descriptors.push("A股整体偏修复");
    } else if (broadAverage <= -1) {
      descriptors.push("A股整体承压");
    } else {
      descriptors.push("A股整体偏震荡");
    }
  }

  const hkTechMove = getComparableChangePercent(hkTechIndex);
  const hsiMove = getComparableChangePercent(hsi);
  const hsceiMove = getComparableChangePercent(hscei);
  if ((hkTechMove ?? 0) > 1 && (hsiMove ?? 0) > 0 && (hsceiMove ?? 0) > 0) {
    descriptors.push("港股科技修复延续");
  } else if (
    (hkTechMove ?? 0) < 0 &&
    (hsiMove ?? 0) < 0 &&
    (hsceiMove ?? 0) < 0
  ) {
    descriptors.push("港股高波资产仍偏弱");
  }

  const goldSignal =
    getComparableChangePercent(londonGold, { includeReferenceClose: true }) ??
    getComparableChangePercent(gold, { includeReferenceClose: true }) ??
    0;

  if (goldSignal >= 1) {
    descriptors.push("避险资产仍强，说明风险并未完全出清");
  } else if (
    goldSignal <= -0.5 &&
    ((getComparableChangePercent(spxFuture, { includeReferenceClose: true }) ?? 0) > 0.3 ||
      (getComparableChangePercent(ndxFuture, { includeReferenceClose: true }) ?? 0) > 0.3)
  ) {
    descriptors.push("黄金回落而外盘期货偏强，风险偏好有所修复");
  }

  if ((boardAverage ?? 0) >= 3) {
    descriptors.push("热点板块扩散度较高");
  }

  return descriptors.length > 0 ? descriptors.join("；") : "市场信号偏中性";
}

function describeDrivers(telegraphs, boards) {
  const lines = [];
  const boardNames = (boards ?? []).slice(0, 3).map((item) => item.bd_name).filter(Boolean);

  if (boardNames.length > 0) {
    lines.push(`盘面热点集中在 ${boardNames.join("、")}`);
  }

  const telegraphText = telegraphs.map((item) => `${item.title} ${item.content} ${(item.subjects ?? []).join(" ")}`).join(" ");
  if (telegraphText.includes("中东") || telegraphText.includes("伊朗") || telegraphText.includes("油")) {
    lines.push("地缘与油价仍是风险偏好修复的重要观察变量");
  }
  if (telegraphText.includes("算力") || telegraphText.includes("AI")) {
    lines.push("算力与 AI 主线继续提供情绪催化");
  }
  if (telegraphText.includes("美股") || telegraphText.includes("中概")) {
    lines.push("外盘与中概情绪对下一交易日港股开盘仍有传导意义");
  }
  if (telegraphText.includes("黄金") || telegraphText.includes("加息") || telegraphText.includes("通胀")) {
    lines.push("黄金、通胀与利率预期仍在影响避险和成长风格之间的切换");
  }

  return lines.length > 0 ? lines.join("；") : "暂无单一主导驱动，更多是风险偏好与板块轮动共同作用";
}

function scoreTelegraph(item) {
  const text = `${item.title ?? ""} ${item.content ?? ""} ${(item.subjects ?? []).join(" ")}`;
  let score = item.isImportant ? 100 : 0;

  for (const keyword of telegraphKeywords) {
    if (text.includes(keyword)) {
      score += 12;
    }
  }

  if ((item.subjects ?? []).some((subject) => subject.includes("美股") || subject.includes("公告"))) {
    score += 6;
  }

  if (text.includes("新闻联播")) {
    score -= 60;
  }

  return score;
}

function selectTelegraphs(items, limit = 5) {
  return selectInstitutionalStories(items, {
    limit,
    focusKeywords: telegraphKeywords,
    authoritativeKeywords: ["统计局", "央行", "美联储", "非农", "关税", "制裁"],
    minScore: 1
  });
}

function formatBoardLine(item) {
  const boardChange = formatSigned(item?.bd_zdf, "%");
  const leader = item?.nzg_name ? `，龙头 ${item.nzg_name} ${formatSigned(item.nzg_zdf, "%")}` : "";
  return `- ${item?.bd_name ?? "未知板块"}：${boardChange}${leader}`;
}

function formatTelegraphLine(item) {
  const subject = (item.subjects ?? []).slice(0, 2).join(" / ");
  const prefix = subject ? `${subject}：` : "";
  const headline = shortText(item.title || item.content, 72);
  return `- ${prefix}${headline}`;
}

function formatHotStockLine(item) {
  return `- ${item.name}（${item.exchange}）：${formatSigned(item.percent, "%")}，热度 ${item.heat ?? "--"}`;
}

function listOpportunityCandidates(opportunityPool, limit = 5) {
  const candidates = Array.isArray(opportunityPool?.candidates)
    ? [...opportunityPool.candidates]
    : [];
  const safeLimit = Math.max(1, Number(limit) || 5);

  return candidates
    .sort((left, right) => Number(right?.total_score ?? 0) - Number(left?.total_score ?? 0))
    .slice(0, safeLimit);
}

function buildOpportunityPoolLines(opportunityPool, limit = 5) {
  const candidates = listOpportunityCandidates(opportunityPool, limit);
  if (candidates.length === 0) {
    return ["- 候选池为空：当前仅保留观察，不生成主题交易偏置。"];
  }

  return candidates.map((item, index) => {
    const proxies = Array.isArray(item?.tradable_proxies) ? item.tradable_proxies : [];
    const proxyLine =
      proxies.length > 0
        ? proxies
            .slice(0, 2)
            .map((proxy) => {
              const name = String(proxy?.name ?? "").trim();
              const symbol = String(proxy?.symbol ?? "").trim();
              return [name, symbol].filter(Boolean).join(" ");
            })
            .filter(Boolean)
            .join("；")
        : "暂无";
    const driver = shortText(item?.driver || item?.expected_vs_actual || "暂无驱动描述", 50);
    const risk = shortText(item?.risk_note || "暂无明确风险提示", 50);
    return `- 主题候选 ${index + 1}：${item?.theme_name ?? "未知主题"}｜行动偏置：${item?.action_bias ?? "研究观察"}｜可交易代理：${proxyLine}｜驱动：${driver}｜风险说明：${risk}`;
  });
}

function buildOpportunityMemo(opportunityPool, marketTone, marketDrivers, researchBrain) {
  const candidates = listOpportunityCandidates(opportunityPool, 5);
  const actionable = candidates.filter((item) =>
    ["允许试单", "允许确认仓"].includes(String(item?.action_bias ?? ""))
  );
  const blocked = candidates.filter((item) => String(item?.action_bias ?? "") === "不做");
  const readinessLevel = String(researchBrain?.decision_readiness?.level ?? "unknown").trim() || "unknown";
  const readinessReasons = Array.isArray(researchBrain?.decision_readiness?.reasons)
    ? researchBrain.decision_readiness.reasons.filter(Boolean)
    : [];
  const tradingAllowed = researchBrain?.decision_readiness?.trading_allowed === true;
  const leadCandidate = candidates[0];
  const thesis = !tradingAllowed
    ? `${marketTone}；研究主脑当前为 ${readinessLevel}，本次仅保留研究观察与计划修订。`
    : leadCandidate
      ? `${marketTone}；机会池当前主候选为 ${leadCandidate.theme_name}（${leadCandidate.action_bias}）。`
      : `${marketTone}；机会池暂无可执行候选，维持观察。`;
  const expectationGap = !tradingAllowed
    ? `${marketDrivers}；当前交易门禁原因：${
        readinessReasons.length > 0 ? readinessReasons.join("、") : "readiness_not_ready"
      }。`
    : leadCandidate
      ? `${marketDrivers}；主题热度与可执行偏置仍存在分层，优先按候选分数执行。`
      : `${marketDrivers}；主题线索不足，等待新的预期差触发。`;
  const allowedActions = !tradingAllowed
    ? ["仅允许主题研究、更新交易卡与候选优先级，不执行新增实盘动作"]
    : actionable.length > 0
      ? actionable.slice(0, 3).map((item) => `围绕 ${item.theme_name} 做小步执行，并优先使用候选代理`)
      : ["仅允许主题研究与计划更新，不进行主动试单"];
  const blockedActions = !tradingAllowed
    ? [
        "禁止将机会池偏置直接转化为下单动作",
        "禁止脱离研究主脑门禁在盘中新增高波主题暴露"
      ]
    : [
        ...(blocked.length > 0
          ? blocked.slice(0, 3).map((item) => `禁止在 ${item.theme_name} 主题上逆偏置强行交易`)
          : []),
        "禁止脱离候选池清单临时追逐盘中热点"
      ];

  return buildInstitutionalActionLines({
    thesis,
    expectationGap,
    allowedActions,
    blockedActions,
    speculativeDiscipline: "主题候选仅作为计划入口，博弈动作需先写 trade card、定义退出与证伪。"
  });
}

function buildPortfolioImpactLines(riskDashboard, quotes, bucketConfigMap = {}) {
  const view = riskDashboard.working_view ?? riskDashboard.canonical_view ?? {};
  const bucketWeights = view.bucket_weights_pct_of_invested_capital ?? {};
  const hsi = findQuote(quotes, "r_hkHSI");
  const hscei = findQuote(quotes, "r_hkHSCEI");
  const hkTechIndex = findQuote(quotes, "r_hkHSTECH");
  const ndxFuture = findQuote(quotes, "hf_NQ");
  const spxFuture = findQuote(quotes, "hf_ES");
  const gold = findQuote(quotes, "AU9999.SGE");
  const hs300 = findQuote(quotes, "000300.SH");
  const lines = [];
  const activeBuckets = Object.entries(bucketWeights)
    .map(([bucketKey, value]) => ({
      bucketKey,
      label: bucketConfigMap?.[bucketKey]?.label ?? bucketConfigMap?.[bucketKey]?.shortLabel ?? bucketKey,
      weightPct: Number(value)
    }))
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct)
    .slice(0, 3);

  for (const bucket of activeBuckets) {
    if (bucket.bucketKey === "A_CORE") {
      lines.push(
        `- ${bucket.label} 当前占已投资仓位 ${round(bucket.weightPct)}%；今日沪深300 ${formatSigned(getComparableChangePercent(hs300, { includeReferenceClose: true }), "%")}，这部分仍是你组合的主骨架与主要方向仓。`
      );
      continue;
    }

    if (bucket.bucketKey === "GLB_MOM" || bucket.bucketKey === "TACTICAL") {
      const hkTechText =
        hkTechIndex?.quote_usage === "previous_close_reference" ||
        hkTechIndex?.quote_usage === "closed_market_reference"
          ? `上一交易日恒生科技 ${formatSigned(
              getComparableChangePercent(hkTechIndex, { includeReferenceClose: true }),
              "%"
            )}`
          : `今日恒生科技 ${formatSigned(
              getComparableChangePercent(hkTechIndex, { includeReferenceClose: true }),
              "%"
            )}`;
      lines.push(
        `- ${bucket.label} 当前占已投资仓位 ${round(bucket.weightPct)}%；${hkTechText} / 纳指期货 ${formatSigned(getComparableChangePercent(ndxFuture, { includeReferenceClose: true }), "%")} / 标普期货 ${formatSigned(getComparableChangePercent(spxFuture, { includeReferenceClose: true }), "%")}，这部分仍是你组合里弹性最高的风险来源。`
      );
      continue;
    }

    if (bucket.bucketKey === "HEDGE") {
      lines.push(
        `- ${bucket.label} 当前占已投资仓位 ${round(bucket.weightPct)}%；今日上金所Au99.99 ${formatSigned(getComparableChangePercent(gold, { includeReferenceClose: true }), "%")}，对冲腿仍在发挥保护作用。`
      );
      continue;
    }

    if (bucket.bucketKey === "INCOME") {
      lines.push(
        `- ${bucket.label} 当前占已投资仓位 ${round(bucket.weightPct)}%；这部分更适合结合利差与估值信号来解读，当前主要承担低波防守与现金流稳定器角色。`
      );
      continue;
    }

    if (bucket.bucketKey !== "CASH") {
      lines.push(
        `- ${bucket.label} 当前占已投资仓位 ${round(bucket.weightPct)}%；这是当前组合里需要重点跟踪的一条主风险腿。`
      );
    }
  }

  if (lines.length === 0) {
    lines.push("- 当前组合暂无可识别的核心风险腿，市场日报更多作为外部环境参考。");
  }

  return lines;
}

function buildNextDayWatchLines(riskDashboard, bucketConfigMap = {}) {
  const view = riskDashboard.working_view ?? riskDashboard.canonical_view ?? {};
  const bucketWeights = view.bucket_weights_pct_of_invested_capital ?? {};
  const activeBuckets = Object.entries(bucketWeights)
    .map(([bucketKey, value]) => ({
      bucketKey,
      label: bucketConfigMap?.[bucketKey]?.label ?? bucketConfigMap?.[bucketKey]?.shortLabel ?? bucketKey,
      weightPct: Number(value)
    }))
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct);

  const lines = [];
  const hasCore = activeBuckets.some((item) => item.bucketKey === "A_CORE");
  const hasHighBeta = activeBuckets.some(
    (item) => item.bucketKey === "GLB_MOM" || item.bucketKey === "TACTICAL"
  );
  const hasHedge = activeBuckets.some((item) => item.bucketKey === "HEDGE");

  if (hasCore) {
    lines.push("- 继续观察沪深300与中证1000/创业板的强弱分化，确认资金是否仍偏核心骨架而非纯题材轮动。");
  }

  if (hasHighBeta) {
    lines.push("- 继续观察恒生科技与纳指期货是否同步修复，确认高弹性风险腿是不是进入真正的趋势延续。");
  }

  if (hasHedge) {
    lines.push("- 继续观察黄金与股指期货是否维持反向演绎；若股强金弱，说明风险偏好修复质量更高。");
  }

  if (lines.length === 0) {
    lines.push("- 继续观察沪深300、恒生科技与黄金之间的相对强弱，判断下一阶段主导风险因子。");
  }

  lines.push("- 若上证50、沪深300相对稳而中证1000、创业板明显走弱，说明资金仍偏核心防守。");
  return lines;
}

const options = parseArgs(args);
const briefDate = resolveDate(options.date);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const riskDashboardPath = buildPortfolioPath(portfolioRoot, "risk_dashboard.json");
const hypothesesPath = buildPortfolioPath(portfolioRoot, "hypotheses.md");
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
const outputDir = buildPortfolioPath(portfolioRoot, "market_briefs");
const outputPath = buildPortfolioPath(outputDir, `${briefDate}-market.md`);

await mkdir(outputDir, { recursive: true });

try {
  const reportContext = await ensureReportContext({
    portfolioRoot,
    options: {
      ...options,
      session: "close"
    }
  });
  const { manifest, payloads } = reportContext;
  const [riskDashboard, hypothesesMarkdown, quoteResults, boardsResult, telegraphsResult, hotStocksResult] = await Promise.all([
    Promise.resolve(payloads.riskDashboard ?? {}),
    readFile(hypothesesPath, "utf8").catch(() => ""),
    Promise.all(
      [...aShareIndexConfigs, ...hongKongIndexConfigs, ...globalIndexConfigs, ...commodityConfigs].map((item) =>
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
      task: () => getMarketTelegraph(20)
    }),
    runGuardedFetch({
      source: "hot_stocks",
      label: "热门股票温度",
      timeoutMs: AUX_FETCH_TIMEOUT_MS,
      task: () => getHotStocks(5, "10")
    })
  ]);
  const cnMarketSnapshot =
    payloads.cnMarketSnapshot ?? (await loadCnMarketSnapshotFromManifest(manifest));
  const assetMasterPath =
    manifest?.canonical_entrypoints?.asset_master ??
    buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
  const assetMaster = await loadAssetMaster(assetMasterPath).catch(() => null);
  const bucketConfigMap = assetMaster ? buildBucketConfigMap(assetMaster) : {};
  const failedRefreshSteps = new Set(
    (reportContext?.refresh?.errors ?? []).map((entry) => entry?.step).filter(Boolean)
  );
  const riskDashboardUsable = Boolean(payloads.riskDashboard) && !failedRefreshSteps.has("risk_dashboard");
  const opportunityPoolUsable = Boolean(payloads.opportunityPool) && !failedRefreshSteps.has("opportunity_pool");

  const now = new Date();
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
  const hotStocks = hotStocksResult.ok ? hotStocksResult.data : [];
  const externalSourceStatusLines = buildExternalSourceStatusLines([
    summarizeGuardedBatch({
      source: "quotes",
      label: "行情报价",
      results: quoteResults
    }),
    boardsResult,
    telegraphsResult,
    hotStocksResult
  ]);
  const selectedTelegraphs = selectTelegraphs(telegraphs ?? [], 5);
  const marketTone = describeMarketTone(successfulQuotes, boards.items ?? []);
  const marketDrivers = describeDrivers(selectedTelegraphs, boards.items ?? []);
  const activeRiskDashboard = riskDashboardUsable ? riskDashboard : {};
  const activeResearchBrain = selectResearchBrainForRender(payloads.researchBrain, failedRefreshSteps);
  const decisionResearchBrain = selectResearchBrainForDecision(
    payloads.researchBrain,
    failedRefreshSteps
  );
  const sessionMemory = await readReportSessionMemory(reportContext.paths.reportSessionMemoryPath);
  const currentSessionSlot = resolveReportSessionSlot({
    researchBrain: activeResearchBrain
  });
  const currentSessionRecord = activeResearchBrain
    ? buildReportSessionRecord({
        tradeDate: briefDate,
        session: currentSessionSlot,
        reportType: "market_brief",
        researchBrain: activeResearchBrain
      })
    : null;
  const sessionTraceLines = currentSessionRecord
    ? buildReportSessionInheritanceLines({
        memory: sessionMemory,
        tradeDate: briefDate,
        session: currentSessionSlot,
        currentRecord: currentSessionRecord
      })
    : ["- 会话继承：研究主脑缺失，当前无法生成日内主线归因。"];
  const updatedSessionMemory = currentSessionRecord
    ? updateReportSessionMemory(sessionMemory, currentSessionRecord)
    : sessionMemory;
  const activeOpportunityPool = opportunityPoolUsable ? payloads.opportunityPool : null;
  const portfolioImpactLines = buildPortfolioImpactLines(
    activeRiskDashboard,
    successfulQuotes,
    bucketConfigMap
  );
  const nextDayWatchLines = buildNextDayWatchLines(activeRiskDashboard, bucketConfigMap);
  const safePortfolioImpactLines = payloads.riskDashboard
    ? riskDashboardUsable
      ? portfolioImpactLines.length > 0
        ? portfolioImpactLines
        : ["- 暂无可映射的持仓代理数据"]
      : ["- ⚠️ 风险仪表盘本轮刷新失败，本节不沿用旧风控盘输出结构性映射结论。"]
    : ["- ⚠️ 风险仪表盘当前缺失或刷新失败，本节仅保留空白降级口径，不输出结构性映射结论。"];
  const safeNextDayWatchLines = payloads.riskDashboard
    ? riskDashboardUsable
      ? nextDayWatchLines
      : ["- ⚠️ 风险仪表盘本轮刷新失败，下一交易日观察清单仅保留研究层提示，不输出结构化动作偏置。"]
    : ["- ⚠️ 风险仪表盘当前缺失或刷新失败，下一交易日观察清单仅保留研究层提示，不输出结构化动作偏置。"];
  const cnMarketSupplementLines = buildCnMarketBriefLines(cnMarketSnapshot).filter(
    (line) => !line.startsWith("- 北向资金：") && !line.startsWith("- 南向资金：")
  );
  const contextModeLines = buildContextModeLines(reportContext);
  const researchGuardLines = buildResearchGuardLines(activeResearchBrain);
  const renderResearchSections = buildUnifiedResearchSections({
    researchBrain: activeResearchBrain,
    cnMarketSnapshot,
    researchGuardLines
  });
  const decisionDeskSection = buildUnifiedResearchSections({
    researchBrain: decisionResearchBrain,
    cnMarketSnapshot,
    researchGuardLines
  }).find((item) => item.heading === "## Desk Action Conclusion");
  const researchSectionLines = flattenResearchSections(
    renderResearchSections.map((section) =>
      section.heading === "## Desk Action Conclusion" && decisionDeskSection
        ? { ...section, lines: decisionDeskSection.lines }
        : section
    )
  );
  const opportunityPoolLines = buildOpportunityPoolFallbackLines(
    activeOpportunityPool,
    failedRefreshSteps
  );
  const relevantHypotheses = [];

  if (String(hypothesesMarkdown).includes("中东局势缓和预期将继续推动港股科技修复")) {
    relevantHypotheses.push("中东缓和与港股科技修复仍是当前最关键的市场假设。");
  }
  if (String(hypothesesMarkdown).includes("黄金仍应作为组合中的长期对冲与稳定器")) {
    relevantHypotheses.push("黄金强弱仍是判断风险是否真正出清的重要观察项。");
  }

  const lines = [
    `# ${briefDate} 市场日报`,
    "",
    `- 账户：${accountId}`,
    ...contextModeLines,
    "",
    ...researchSectionLines,
    "",
    "## 日内会话继承",
    "",
    ...sessionTraceLines,
    ...(externalSourceStatusLines.length > 0 ? ["", ...externalSourceStatusLines] : []),
    "",
    "## 市场温度补充",
    "",
    `- 市场定性：${marketTone}`,
    `- 驱动线索：${marketDrivers}`,
    "",
    "## 标准指数与关键市场",
    "",
    "### A股",
    "",
    ...aShareIndexConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    "",
    "### 港股",
    "",
    ...hongKongIndexConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    "",
    "### 美股与期货",
    "",
    ...globalIndexConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    "",
    "### 黄金",
    "",
    ...commodityConfigs.map((item) => formatQuoteLine(item.label, findQuote(successfulQuotes, item.code))),
    ...(
      cnMarketSupplementLines.length > 0
        ? ["", "## AkShare 中国市场补充层", "", ...cnMarketSupplementLines]
        : []
    ),
    "",
    "## 热点板块",
    "",
    ...(
      (boards.items ?? []).length > 0
        ? boards.items.slice(0, 5).map((item) => formatBoardLine(item))
        : ["- 暂无板块数据"]
    ),
    "",
    "## 关键电报",
    "",
    ...(
      selectedTelegraphs.length > 0
        ? selectedTelegraphs.map((item) => formatTelegraphLine(item))
        : ["- 暂无电报数据"]
    ),
    "",
    "## 热门股票温度",
    "",
    ...(
      (hotStocks ?? []).length > 0
        ? hotStocks.slice(0, 5).map((item) => formatHotStockLine(item))
        : ["- 暂无热股数据"]
    ),
    "",
    "## 机会池 / 主题候选",
    "",
    ...opportunityPoolLines,
    "",
    "## 与当前持仓映射",
    "",
    ...safePortfolioImpactLines,
    ...relevantHypotheses.map((item) => `- ${item}`),
    "",
    "## 下一交易日观察与行动偏置",
    "",
    ...safeNextDayWatchLines
  ];

  await writeReportSessionMemory(reportContext.paths.reportSessionMemoryPath, updatedSessionMemory);
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

  if (manifest?.canonical_entrypoints) {
    await updateManifestCanonicalEntrypoints({
      manifestPath,
      baseManifest: manifest,
      entries: {
        latest_market_brief: outputPath
      }
    });
  }

  console.log(
    JSON.stringify(
      {
        accountId,
        portfolioRoot,
        outputPath,
        successfulQuotes: successfulQuotes.length,
        selectedTelegraphs: selectedTelegraphs.length,
        hotBoards: (boards.items ?? []).length
      },
      null,
      2
    )
  );
} finally {
  await closeCmeBrowser().catch(() => {});
}
