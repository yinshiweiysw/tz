import { mkdir, access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { round } from "./lib/format_utils.mjs";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    result[key] = argv[index + 1] ?? "";
    index += 1;
  }

  return result;
}

function optionValue(options, keys, fallback = "") {
  for (const key of keys) {
    const value = String(options?.[key] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return fallback;
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

function sanitizeSlug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled-trade";
}

function splitList(value) {
  return String(value ?? "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeName(value) {
  return String(value ?? "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replace(/[\s\u3000]/g, "")
    .replaceAll("(QDII)", "")
    .replaceAll("（QDII）", "")
    .replaceAll("QDII-FOF-LOF", "QDII")
    .replaceAll("QDII-LOF", "QDII")
    .replaceAll("ETF发起式联接", "")
    .replaceAll("ETF发起联接", "")
    .replaceAll("ETF联接", "")
    .replaceAll("联接", "")
    .replaceAll("发起式", "")
    .replaceAll("混合型", "混合")
    .replaceAll("持有期", "持有")
    .replace(/[()［］\[\]\-_/·.]/g, "")
    .trim();
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAssetName(line) {
  return String(line ?? "")
    .split(/[：:]/)[0]
    .trim();
}

function extractSixDigitCode(value) {
  return String(value ?? "").match(/\b(\d{6})\b/)?.[1] ?? null;
}

function extractMarkdownSectionLines(markdown, heading) {
  const pattern = new RegExp(`^## ${escapeRegex(heading)}\\n([\\s\\S]*?)(?=^## |\\Z)`, "m");
  const match = markdown.match(pattern);
  if (!match) {
    return [];
  }

  return match[1]
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function parseBulletField(lines, label) {
  const prefix = `- ${label}：`;
  const line = lines.find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function parseAmountFromText(value) {
  const matched = String(value ?? "").match(/-?\d+(?:\.\d+)?/g);
  if (!matched || matched.length === 0) {
    return null;
  }

  return Number(matched[matched.length - 1]);
}

async function readFirstAvailable(paths) {
  for (const path of paths) {
    if (!path) {
      continue;
    }

    try {
      const content = await readFile(path, "utf8");
      return { path, content };
    } catch {}
  }

  return null;
}

function buildSignalLookup(signalMatrix) {
  const lookup = new Map();

  for (const [code, signal] of Object.entries(signalMatrix?.signals ?? {})) {
    const candidates = new Set([
      code,
      signal?.code,
      signal?.name,
      signal?.portfolio_context?.latest_name_match,
      signal?.portfolio_context?.watchlist_name_match
    ]);

    for (const candidate of candidates) {
      const normalized = normalizeName(candidate);
      if (normalized) {
        lookup.set(normalized, signal);
      }
    }
  }

  return lookup;
}

function buildValuationLookup(indexValuationMatrix) {
  const lookup = new Map();

  for (const signal of Object.values(indexValuationMatrix?.signals ?? {})) {
    const candidates = new Set([
      signal?.proxy_key,
      signal?.name,
      ...(signal?.mapped_labels ?? [])
    ]);

    for (const candidate of candidates) {
      const normalized = normalizeName(candidate);
      if (normalized) {
        lookup.set(normalized, signal);
      }
    }
  }

  return lookup;
}

function findSignalForAsset(assetLine, signalLookup) {
  const assetName = extractAssetName(assetLine);
  const candidates = new Set([
    extractSixDigitCode(assetLine),
    extractSixDigitCode(assetName),
    assetName,
    assetLine
  ]);

  for (const candidate of candidates) {
    const normalized = normalizeName(candidate);
    if (normalized && signalLookup.has(normalized)) {
      return signalLookup.get(normalized);
    }
  }

  return null;
}

function findValuationForAsset(assetName, signal, valuationLookup) {
  const candidates = new Set([
    assetName,
    signal?.code,
    signal?.name,
    signal?.portfolio_context?.latest_name_match,
    signal?.portfolio_context?.watchlist_name_match
  ]);

  for (const candidate of candidates) {
    const normalized = normalizeName(candidate);
    if (normalized && valuationLookup.has(normalized)) {
      return valuationLookup.get(normalized);
    }
  }

  return null;
}

function signalFlags(signal) {
  const derived = signal?.derived_signals ?? {};
  const biasRegime = String(derived.bias_regime ?? "");
  const rsiRegime = String(derived.rsi_regime ?? "");
  const trendStatus = String(derived.trend_status ?? "neutral");

  return {
    trendStatus,
    biasRegime,
    rsiRegime,
    hardBlocked: biasRegime === "overextended_up" || rsiRegime === "overbought",
    fallingKnife: biasRegime === "capitulation_zone" || rsiRegime === "oversold",
    trendPreferred: ["bullish", "weak_bullish"].includes(trendStatus),
    weakTrend: ["weak_bearish", "bearish"].includes(trendStatus)
  };
}

function deriveSystemVerdict(signal, valuation) {
  const flags = signalFlags(signal);
  const valuationRegime = String(valuation?.derived_signals?.valuation_regime_primary ?? "");

  if (flags.hardBlocked) {
    if (valuationRegime === "overvalued") {
      return "短线过热拦截 / 高估值受限 / 不宜追高";
    }
    return "短线过热拦截 / 不宜追高";
  }

  if (valuationRegime === "extreme_undervalued") {
    if (flags.trendPreferred) {
      return "左侧极度低估击球区 / 右侧开始配合 / 允许定投或小额网格";
    }
    return "左侧极度低估击球区 / 允许定投或小额网格";
  }

  if (flags.trendPreferred && valuationRegime === "overvalued") {
    return "顺势投机 / 高估值受限 / 贴紧20日线";
  }

  if (flags.trendPreferred) {
    return "顺势跟随 / 可按计划执行";
  }

  if (flags.fallingKnife && valuationRegime === "overvalued") {
    return "左侧试仓 / 但高估值受限 / 仅极小仓";
  }

  if (flags.fallingKnife) {
    return "左侧深跌试仓 / 等待右侧企稳";
  }

  if (flags.weakTrend && valuationRegime === "overvalued") {
    return "弱趋势观察 / 高估值受限 / 暂停长线定投";
  }

  if (flags.weakTrend) {
    return "弱趋势观察 / 不作主动放大";
  }

  if (valuationRegime === "overvalued") {
    return "高估值受限 / 不适合长线定投";
  }

  if (!signal && valuationRegime === "extreme_undervalued") {
    return "左侧极度低估击球区 / 当前仅估值支持";
  }

  if (!signal && valuationRegime === "overvalued") {
    return "高估值受限 / 当前仅估值代理可用";
  }

  return "中性观察 / 等待更明确触发";
}

function buildBulletBlock(lines) {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- ";
}

function buildQuantSnapshotBlock(assetLines, signalMatrix, indexValuationMatrix) {
  if (assetLines.length === 0) {
    return "- 当前未提供可识别标的，无法生成量化快照。";
  }

  const signalLookup = buildSignalLookup(signalMatrix);
  const valuationLookup = buildValuationLookup(indexValuationMatrix);
  const blocks = [];

  for (const assetLine of assetLines) {
    const assetName = extractAssetName(assetLine) || assetLine;
    const signal = findSignalForAsset(assetLine, signalLookup);
    const valuation = findValuationForAsset(assetName, signal, valuationLookup);
    const valuationPercentile = Number.isFinite(Number(valuation?.metrics?.composite_percentile_5y))
      ? round(valuation.metrics.composite_percentile_5y)
      : null;
    const systemVerdict = deriveSystemVerdict(signal, valuation);

    blocks.push(`### ${assetName}`);
    blocks.push(`- 快照日期：L2=${signal?.signal_date ?? "未覆盖"}；估值=${valuation?.signal_date ?? "未覆盖"}`);
    blocks.push(
      `- 动量/情绪：trend_status=${signal?.derived_signals?.trend_status ?? "未覆盖"}；bias_regime=${signal?.derived_signals?.bias_regime ?? "未覆盖"}；rsi_regime=${signal?.derived_signals?.rsi_regime ?? "未覆盖"}`
    );

    if (valuation) {
      blocks.push(
        `- 估值/赔率：估值代理=${valuation?.name ?? "未知代理"}；5年复合估值分位=${valuationPercentile ?? "未覆盖"}%；valuation_regime_primary=${valuation?.derived_signals?.valuation_regime_primary ?? "未覆盖"}`
      );
    } else {
      blocks.push("- 估值/赔率：当前无可用估值代理，暂仅保留动量/情绪判断。");
    }

    blocks.push(`- 系统判定：${systemVerdict}`);
    blocks.push("");
  }

  return blocks.join("\n").trimEnd();
}

function inferBucketLabel(role, assetLines) {
  const roleText = String(role ?? "");
  const joinedAssets = assetLines.map((line) => extractAssetName(line)).join(" ");

  if (roleText.includes("防守") || /红利|低波|银行/.test(joinedAssets)) {
    return "防守仓";
  }
  if (roleText.includes("核心") || /沪深300|上证50|标普500/.test(joinedAssets)) {
    return "核心仓";
  }
  if (roleText.includes("港股") || /恒生互联网|恒生科技|港股/.test(joinedAssets)) {
    return "港股参与仓";
  }
  if (roleText.includes("战术") || /半导体|纳斯达克|海外科技/.test(joinedAssets)) {
    return "战术仓";
  }
  if (roleText.includes("对冲") || /黄金|大宗商品/.test(joinedAssets)) {
    return "对冲仓";
  }
  if (roleText.includes("现金")) {
    return "现金/机动仓";
  }

  return null;
}

function parseTradeLegSection(lines) {
  return {
    bucket: parseBulletField(lines, "仓位桶"),
    amount: parseBulletField(lines, "金额"),
    fundingSource: parseBulletField(lines, "资金来源"),
    status: parseBulletField(lines, "状态"),
    rationale: parseBulletField(lines, "理由")
  };
}

function parseTrimPlansSection(lines) {
  const plans = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (current) {
        plans.push(current);
      }
      current = {
        title: line.slice(4).trim(),
        targetBucket: null,
        trimTarget: null,
        suggestedTrimAmount: null,
        routeLabel: null,
        routeInstruction: null
      };
      continue;
    }

    if (!current || !line.startsWith("- ")) {
      continue;
    }

    const match = line.match(/^- ([^：]+)：(.*)$/);
    if (!match) {
      continue;
    }

    const label = match[1].trim();
    const value = match[2].trim();

    if (label === "目标桶") {
      current.targetBucket = value;
    } else if (label === "减仓标的") {
      current.trimTarget = value;
    } else if (label === "建议减仓金额") {
      current.suggestedTrimAmount = parseAmountFromText(value);
    } else if (label === "系统定性") {
      current.routeLabel = value;
    } else if (label === "系统指令") {
      current.routeInstruction = value;
    }
  }

  if (current) {
    plans.push(current);
  }

  return plans;
}

function parseFundingRouteSection(lines) {
  const routeLines = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim());
  const firstLine = routeLines[0] ?? "";
  const secondLine = routeLines[1] ?? "";

  return {
    rawLines: routeLines,
    totalTrimProceeds: parseAmountFromText(firstLine),
    targetBuyBucket: firstLine.match(/本次\s*(.+?)\s*的买入资金/)?.[1]?.trim() ?? null,
    remainingAmount: parseAmountFromText(secondLine),
    remainingBucket: secondLine.match(/划归至【(.+?)】/)?.[1]?.trim() ?? null
  };
}

function parseTradePlanContext(markdown) {
  const planDate = markdown.match(/^# (\d{4}-\d{2}-\d{2}) .+/m)?.[1] ?? null;

  return {
    planDate,
    firstLeg: parseTradeLegSection(extractMarkdownSectionLines(markdown, "第一笔计划")),
    secondLeg: parseTradeLegSection(extractMarkdownSectionLines(markdown, "第二笔排队")),
    trimPlans: parseTrimPlansSection(extractMarkdownSectionLines(markdown, "✂️ 智能减仓与再平衡预案")),
    routing: parseFundingRouteSection(
      extractMarkdownSectionLines(markdown, "🔄 调仓资金路由建议 (Self-Financing Route)")
    )
  };
}

function isBuyDirection(direction) {
  return /buy|加仓|买入/i.test(String(direction ?? ""));
}

function isSellDirection(direction) {
  return /sell|trim|减仓|卖出/i.test(String(direction ?? ""));
}

function resolveRouteLeg(planContext, requestedLeg, bucketLabel) {
  if (!planContext) {
    return null;
  }

  if (requestedLeg === "first") {
    return planContext.firstLeg;
  }

  if (requestedLeg === "second") {
    return planContext.secondLeg;
  }

  if (bucketLabel && planContext.firstLeg?.bucket === bucketLabel) {
    return planContext.firstLeg;
  }

  if (bucketLabel && planContext.secondLeg?.bucket === bucketLabel) {
    return planContext.secondLeg;
  }

  if (planContext.firstLeg?.bucket) {
    return planContext.firstLeg;
  }

  return planContext.secondLeg;
}

function resolveTrimPlan(planContext, direction, assetLines, bucketLabel) {
  const trimPlans = planContext?.trimPlans ?? [];
  if (trimPlans.length === 0) {
    return null;
  }

  if (isBuyDirection(direction)) {
    return trimPlans[0];
  }

  const assetNames = assetLines.map((line) => normalizeName(extractAssetName(line) || line));
  const exactAssetMatch = trimPlans.find((plan) => {
    const normalizedTarget = normalizeName(plan.trimTarget);
    return assetNames.some(
      (assetName) =>
        normalizedTarget.includes(assetName) || assetName.includes(normalizedTarget)
    );
  });

  if (exactAssetMatch) {
    return exactAssetMatch;
  }

  if (bucketLabel) {
    const bucketMatch = trimPlans.find((plan) => plan.targetBucket === bucketLabel);
    if (bucketMatch) {
      return bucketMatch;
    }
  }

  return trimPlans[0];
}

function normalizeTradeNature(rawValue, direction, autoFundingSource) {
  const rawText = String(rawValue ?? "").trim();
  const text = rawText.toLowerCase();

  if (
    rawText &&
    !text.includes("减仓回笼") &&
    !text.includes("trim") &&
    !text.includes("sell") &&
    !text.includes("内部划拨") &&
    !text.includes("internal") &&
    !text.includes("外部增量") &&
    !text.includes("external")
  ) {
    return rawText;
  }

  if (
    text.includes("减仓回笼") ||
    text.includes("trim") ||
    text.includes("sell")
  ) {
    return "减仓回笼";
  }

  if (
    text.includes("内部划拨") ||
    text.includes("internal")
  ) {
    return "内部划拨买入";
  }

  if (
    text.includes("外部增量") ||
    text.includes("external")
  ) {
    return "外部增量买入";
  }

  if (isSellDirection(direction)) {
    return "减仓回笼";
  }

  if (/减仓|回笼/.test(autoFundingSource)) {
    return "内部划拨买入";
  }

  if (/场外新增|现金仓|机动资金/.test(autoFundingSource)) {
    return "外部增量买入";
  }

  return "外部增量买入";
}

function buildFundingAuditBlock({
  direction,
  fundingKind,
  fundingSourceLines,
  useOfProceedsLines,
  routingNoteLines,
  routeContext,
  role,
  assetLines
}) {
  const routeBucket = inferBucketLabel(role, assetLines);
  const selectedLeg = routeContext?.selectedLeg ?? null;
  const selectedTrimPlan = routeContext?.selectedTrimPlan ?? null;
  const routing = routeContext?.routing ?? null;

  const derivedFundingSourceLines = [...fundingSourceLines];
  const derivedUseOfProceedsLines = [...useOfProceedsLines];
  const derivedRoutingNotes = [...routingNoteLines];

  if (routeContext?.planPath) {
    derivedRoutingNotes.push(`自动读取 ${routeContext.planPath}`);
  }

  if (isBuyDirection(direction)) {
    if (derivedFundingSourceLines.length === 0) {
      if (selectedLeg?.fundingSource && /减仓回笼资金/.test(selectedLeg.fundingSource) && selectedTrimPlan) {
        derivedFundingSourceLines.push(
          `来源于 ${routeContext.planDate} 减仓 ${selectedTrimPlan.trimTarget ?? "系统减仓标的"} 的回笼资金（预期 ${selectedTrimPlan.suggestedTrimAmount ?? "未覆盖"} 元），按系统路由优先划拨至${selectedLeg.bucket ?? routeBucket ?? "目标仓位"}。`
        );
      } else if (fundingKind === "外部增量买入") {
        derivedFundingSourceLines.push("来源于场外新增资金。");
      } else if (selectedLeg?.fundingSource) {
        derivedFundingSourceLines.push(`依据 ${routeContext.planDate} 交易生成器：${selectedLeg.fundingSource}`);
      } else {
        derivedFundingSourceLines.push("来源于场外新增资金。");
      }
    }

    if (derivedUseOfProceedsLines.length === 0) {
      let sentence = `本单为${selectedLeg?.bucket ?? routeBucket ?? "目标仓位"}的买入执行腿，成交后计入${selectedLeg?.bucket ?? routeBucket ?? "目标仓位"}。`;
      if (routing?.remainingAmount && routing?.remainingBucket) {
        sentence += ` 若同日调仓路由全部执行，剩余 ${routing.remainingAmount} 元回流${routing.remainingBucket}。`;
      }
      derivedUseOfProceedsLines.push(sentence);
    }
  } else if (isSellDirection(direction)) {
    if (derivedFundingSourceLines.length === 0) {
      derivedFundingSourceLines.push("本单为组合内部减仓回笼动作，不涉及场外新增资金。");
    }

    if (derivedUseOfProceedsLines.length === 0) {
      if (selectedTrimPlan?.suggestedTrimAmount && routing?.targetBuyBucket) {
        let sentence = `回笼资金 ${selectedTrimPlan.suggestedTrimAmount} 元，优先用于补充${routing.targetBuyBucket}`;
        if (routing.remainingAmount && routing.remainingBucket) {
          sentence += `，剩余 ${routing.remainingAmount} 元划入${routing.remainingBucket}`;
        }
        sentence += "。";
        derivedUseOfProceedsLines.push(sentence);
      } else if (selectedTrimPlan?.suggestedTrimAmount) {
        derivedUseOfProceedsLines.push(`回笼资金 ${selectedTrimPlan.suggestedTrimAmount} 元，暂回流现金/机动仓待命。`);
      } else {
        derivedUseOfProceedsLines.push("回笼资金去向待补录。");
      }
    }
  }

  const tradeNature = normalizeTradeNature(
    fundingKind,
    direction,
    derivedFundingSourceLines.join("；")
  );
  const lines = [
    `- 交易性质：${tradeNature}`,
    `- 资金来源：${derivedFundingSourceLines.join("；") || "待补录"}`,
    `- 资金去向：${derivedUseOfProceedsLines.join("；") || "待补录"}`
  ];

  if (derivedRoutingNotes.length > 0) {
    lines.push(`- 路由依据：${derivedRoutingNotes.join("；")}`);
  }

  if (routing?.rawLines?.length > 0) {
    lines.push(`- 系统路由摘要：${routing.rawLines.join("；")}`);
  }

  return lines.join("\n");
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    template
  );
}

const options = parseArgs(args);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const templatePath = buildPortfolioPath(portfolioRoot, "templates", "trade-card-template.md");
const signalsMatrixPath = buildPortfolioPath(portfolioRoot, "signals", "signals_matrix.json");
const indexValuationMatrixPath = buildPortfolioPath(
  portfolioRoot,
  "signals",
  "index_valuation_matrix.json"
);
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
const date = resolveDate(optionValue(options, ["date"]));
const year = date.slice(0, 4);
const title = optionValue(options, ["title"], "未命名交易");
const slug = sanitizeSlug(optionValue(options, ["slug"], title));
const direction = optionValue(options, ["direction"], "pending");
const status = optionValue(options, ["status"], "draft");
const role = optionValue(options, ["role"], "unspecified");
const assetLines = splitList(optionValue(options, ["assets"]));
const thesisLines = splitList(optionValue(options, ["thesis"]));
const whyNowLines = splitList(optionValue(options, ["whynow"]));
const invalidationLines = splitList(optionValue(options, ["invalidation"]));
const riskLines = splitList(optionValue(options, ["risks"]));
const followUpLines = splitList(optionValue(options, ["followup"]));
const relatedLines = splitList(optionValue(options, ["related"]));
const tradeSystem = optionValue(options, ["system"], "core_allocation_engine");
const triggerSource = optionValue(options, ["triggersource", "trigger-source"], "not_specified");
const exitRule = optionValue(
  options,
  ["exitrule", "exit-rule"],
  "按原交易计划执行，未出现确认信号前不主动放大风险。"
);
const tradeInvalidation = optionValue(
  options,
  ["tradeinvalidation", "trade-invalidation"],
  invalidationLines[0] ?? "若核心假设被证伪或价格行为显著偏离预期，则取消执行并复盘。"
);
const fundingKind = optionValue(options, ["fundingkind", "funding-kind", "routingkind", "routing-kind"]);
const fundingSourceLines = splitList(optionValue(options, ["fundingsource", "funding-source"]));
const useOfProceedsLines = splitList(optionValue(options, ["useofproceeds", "use-of-proceeds", "proceedsuse", "proceeds-use"]));
const routingNoteLines = splitList(optionValue(options, ["routingnotes", "routing-notes"]));
const routeLeg = optionValue(options, ["routeleg", "route-leg"], "auto");
const routePlanDate = optionValue(options, ["routeplandate", "route-plan-date"], date);
const explicitRoutePlanPath = optionValue(options, ["routepath", "route-path"]);

const dir = buildPortfolioPath(portfolioRoot, "trade_cards", year);
const path = buildPortfolioPath(dir, `${date}-${slug}.md`);

await mkdir(dir, { recursive: true });

try {
  await access(path, constants.F_OK);
  console.log(JSON.stringify({ created: false, path }, null, 2));
  process.exit(0);
} catch {}

const [template, signalMatrix, indexValuationMatrix, manifest] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(signalsMatrixPath, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => ({ signals: {}, errors: [] })),
  readFile(indexValuationMatrixPath, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => ({ signals: {}, errors: [] })),
  readFile(manifestPath, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => null)
]);

const routePlanFile = await readFirstAvailable([
  explicitRoutePlanPath,
  manifest?.canonical_entrypoints?.latest_trade_plan_v4_report,
  buildPortfolioPath(portfolioRoot, "reports", `${routePlanDate}-next-trade-plan-regime-v4.md`),
  buildPortfolioPath(portfolioRoot, "reports", `${routePlanDate}-next-trade-generator.md`),
  manifest?.canonical_entrypoints?.latest_next_trade_generator
]);
const routePlanContext = routePlanFile
  ? parseTradePlanContext(routePlanFile.content)
  : null;
const routeBucket = inferBucketLabel(role, assetLines);
const selectedLeg = routePlanContext
  ? resolveRouteLeg(routePlanContext, routeLeg, routeBucket)
  : null;
const selectedTrimPlan = routePlanContext
  ? resolveTrimPlan(routePlanContext, direction, assetLines, routeBucket)
  : null;

const content = renderTemplate(template, {
  account_id: accountId,
  date,
  title,
  direction,
  status,
  role,
  system: tradeSystem,
  trigger_source: triggerSource,
  exit_rule: exitRule,
  trade_invalidation: tradeInvalidation,
  assets: buildBulletBlock(assetLines),
  quant_snapshot: buildQuantSnapshotBlock(assetLines, signalMatrix, indexValuationMatrix),
  funding_routing: buildFundingAuditBlock({
    direction,
    fundingKind,
    fundingSourceLines,
    useOfProceedsLines,
    routingNoteLines,
    routeContext: routePlanContext
      ? {
          ...routePlanContext,
          planDate: routePlanContext.planDate ?? routePlanDate,
          planPath: routePlanFile?.path ?? null,
          selectedLeg,
          selectedTrimPlan
        }
      : null,
    role,
    assetLines
  }),
  thesis: buildBulletBlock(thesisLines),
  why_now: buildBulletBlock(whyNowLines),
  invalidation: buildBulletBlock(invalidationLines),
  risks: buildBulletBlock(riskLines),
  follow_up: buildBulletBlock(followUpLines),
  related:
    relatedLines.length > 0
      ? buildBulletBlock(relatedLines)
      : ["- state/portfolio_state.json", "- 当日日志", "- transactions / ledger"].join("\n")
});

await writeFile(path, `${content.trimEnd()}\n`, "utf8");
console.log(JSON.stringify({ created: true, path }, null, 2));
