import { readFile, stat } from "node:fs/promises";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./account_root.mjs";
import { readManifestState } from "./manifest_state.mjs";
import { readJsonOrNull } from "./portfolio_state_view.mjs";
import { readJsonOrDefault } from "./atomic_json_state.mjs";

function cleanMarkdownLine(line) {
  return String(line ?? "")
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/`/g, "")
    .trim();
}

function isUsefulReportLine(line) {
  const text = cleanMarkdownLine(line);
  if (!text) {
    return false;
  }

  return ![
    /^账户[:：]/,
    /^视图口径[:：]/,
    /^数据模式[:：]/,
    /^未自动刷新/,
    /^数据时点[:：]/,
    /^生成方式[:：]/,
    /^质量提示[:：]/,
    /^研究会话[:：]/,
    /^决策状态[:：]/,
    /^风险说明[:：]/,
    /^执行建议[:：]/,
    /^账户仓位[:：]/,
    /^source[:：]/i,
    /^path[:：]/i
  ].some((pattern) => pattern.test(text));
}

function extractHeading(content = "") {
  const lines = String(content).split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  return cleanMarkdownLine(heading ?? "");
}

function parseMarkdownSections(content = "") {
  const sections = [];
  let currentSection = null;

  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.match(/^##+\s+(.*)$/);
    if (sectionMatch) {
      currentSection = {
        heading: cleanMarkdownLine(sectionMatch[1]),
        lines: []
      };
      sections.push(currentSection);
      continue;
    }

    if (currentSection) {
      currentSection.lines.push(line);
    }
  }

  return sections;
}

function findSection(sections = [], candidates = []) {
  return sections.find((section) =>
    candidates.some((candidate) =>
      candidate instanceof RegExp
        ? candidate.test(section.heading)
        : section.heading.includes(String(candidate))
    )
  );
}

function extractSectionUsefulLines(section) {
  return Array.isArray(section?.lines)
    ? section.lines
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^```/.test(line))
        .filter((line) => isUsefulReportLine(line))
        .map((line) => cleanMarkdownLine(line))
        .filter(Boolean)
    : [];
}

function extractSectionListItems(section, limit = Infinity) {
  const items = (Array.isArray(section?.lines) ? section.lines : [])
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .filter((line) => isUsefulReportLine(line))
    .map((line) => cleanMarkdownLine(line))
    .filter(Boolean);
  return Number.isFinite(limit) ? items.slice(0, limit) : items;
}

function parseLabeledLine(text) {
  const normalized = cleanMarkdownLine(text);
  const match = normalized.match(/^([^：:]{1,32})[:：]\s*(.+)$/);
  if (!match) {
    return null;
  }

  return {
    label: match[1].trim(),
    value: match[2].trim()
  };
}

function extractSectionLabeledValue(section, labels = []) {
  const normalizedLabels = labels.map((label) => String(label).replace(/\s+/g, ""));

  for (const line of extractSectionUsefulLines(section)) {
    const labeled = parseLabeledLine(line);
    if (!labeled) {
      continue;
    }

    if (normalizedLabels.includes(String(labeled.label).replace(/\s+/g, ""))) {
      return labeled.value;
    }
  }

  return null;
}

function extractSectionLead(section) {
  const listItem = extractSectionListItems(section, 1)[0];
  if (listItem) {
    return listItem;
  }

  return extractSectionUsefulLines(section)[0] ?? null;
}

function dedupeMarketHighlights(items = []) {
  const seenPairs = new Set();
  const seenLabels = new Set();
  const results = [];

  for (const item of items) {
    const label = String(item?.label ?? "").trim();
    const text = String(item?.text ?? "").trim();
    if (!label || !text) {
      continue;
    }

    const dedupeKey = `${label}::${text}`;
    if (seenPairs.has(dedupeKey) || seenLabels.has(label)) {
      continue;
    }

    seenPairs.add(dedupeKey);
    seenLabels.add(label);
    results.push({
      label,
      text
    });
  }

  return results;
}

function buildReportSummary(content = "", kind = "") {
  const sections = parseMarkdownSections(content);

  if (kind.startsWith("market_pulse")) {
    const conclusion = extractSectionLead(findSection(sections, ["一句话结论"]));
    if (conclusion) {
      return conclusion;
    }

    const structureConclusion = extractSectionLabeledValue(
      findSection(sections, ["强弱主题"]),
      ["结构结论"]
    );
    if (structureConclusion) {
      return structureConclusion;
    }
  }

  if (kind === "market_brief") {
    const driverLine = extractSectionLabeledValue(
      findSection(sections, ["Active Market Driver"]),
      ["主线", "实际市场反应", "预期差"]
    );
    if (driverLine) {
      return driverLine;
    }

    const marketTone = extractSectionLabeledValue(
      findSection(sections, ["市场温度补充"]),
      ["市场定性", "驱动线索"]
    );
    if (marketTone) {
      return marketTone;
    }
  }

  if (kind === "daily_brief") {
    const dailyMainline = extractSectionLabeledValue(
      findSection(sections, ["今日主线与行动备忘录"]),
      ["今日主线", "当前预期差"]
    );
    if (dailyMainline) {
      return dailyMainline;
    }
  }

  return extractSummary(content);
}

function extractSummary(content = "", limit = 2) {
  const lines = String(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#/.test(line))
    .filter((line) => !/^```/.test(line));

  const summaryLines = [];
  for (const line of lines) {
    if (!isUsefulReportLine(line)) {
      continue;
    }
    summaryLines.push(cleanMarkdownLine(line));
    if (summaryLines.length >= limit) {
      break;
    }
  }
  return summaryLines.filter(Boolean).join(" ");
}

function extractBulletHighlights(content = "", limit = 4) {
  return String(content)
    .split(/\r?\n/)
    .filter((line) => /^[-*]\s+/.test(line.trim()))
    .map((line) => cleanMarkdownLine(line))
    .filter((line) => isUsefulReportLine(line))
    .slice(0, limit);
}

function extractAsOf(content = "", fallback = null) {
  const heading = extractHeading(content);
  const headingDateMatch = heading.match(/(\d{4}-\d{2}-\d{2})/);
  if (headingDateMatch) {
    return headingDateMatch[1];
  }
  return fallback;
}

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function parseDateText(value) {
  const text = String(value ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  if (!text) {
    return null;
  }
  const date = new Date(`${text}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : { text, date };
}

function diffCalendarDays(leftText, rightText) {
  const left = parseDateText(leftText);
  const right = parseDateText(rightText);
  if (!left || !right) {
    return null;
  }
  return Math.round((right.date.getTime() - left.date.getTime()) / 86_400_000);
}

function resolveStalenessLabel(asOf, now = new Date()) {
  const today = formatShanghaiDate(now);
  const date = parseDateText(asOf);
  if (!date) {
    return "stale";
  }
  if (date.text === today) {
    return "same_day";
  }
  const lagDays = diffCalendarDays(date.text, today);
  if (lagDays !== null && lagDays > 0 && lagDays <= 3) {
    return "carry_forward_previous_trading_day";
  }
  return "stale";
}

function labelStaleness(stalenessLabel, asOf = null) {
  const suffix = asOf ? ` · ${asOf}` : "";
  switch (stalenessLabel) {
    case "same_day":
      return `今日报告${suffix}`;
    case "carry_forward_previous_trading_day":
      return `沿用上一交易日${suffix}`;
    default:
      return `旧报告${suffix}`;
  }
}

function resolveGenerationStatus(primaryStalenessLabel, reports = []) {
  if (!Array.isArray(reports) || reports.length === 0) {
    return {
      status: "missing",
      label: "今日报告未生成"
    };
  }
  if (primaryStalenessLabel === "same_day") {
    return {
      status: "same_day",
      label: "今日报告已生成"
    };
  }
  if (primaryStalenessLabel === "carry_forward_previous_trading_day") {
    return {
      status: "today_report_missing",
      label: "今日报告未生成，沿用上一交易日"
    };
  }
  return {
    status: "stale",
    label: "今日报告未生成，当前报告已陈旧"
  };
}

function resolveSourceMode({ reports = [], syncStatus = null, portfolioRoot = "" } = {}) {
  if (!Array.isArray(reports) || reports.length === 0) {
    return "missing";
  }
  if (syncStatus?.sourcePortfolioRoot) {
    return "legacy_sync";
  }
  const root = String(portfolioRoot ?? "").replace(/\/$/, "");
  return reports.every((report) => String(report?.path ?? "").startsWith(root))
    ? "simplified"
    : "missing";
}

function reportPriority(kind = "") {
  switch (kind) {
    case "market_pulse_close":
      return 60;
    case "market_pulse_noon":
      return 50;
    case "market_pulse_morning":
      return 40;
    case "market_brief":
      return 30;
    case "daily_brief":
      return 20;
    default:
      return 0;
  }
}

async function readMarkdownReport(filePath, kind) {
  if (!filePath) {
    return null;
  }

  try {
    const content = await readFile(filePath, "utf8");
    const stats = await stat(filePath);
    return {
      kind,
      path: filePath,
      title: extractHeading(content) || kind,
      asOf: extractAsOf(content),
      updatedAt: stats.mtime.toISOString(),
      summary: buildReportSummary(content, kind),
      highlights: extractBulletHighlights(content),
      content,
      sections: parseMarkdownSections(content)
    };
  } catch {
    return null;
  }
}

async function selectLatestReport(candidates = []) {
  const loaded = (await Promise.all(candidates)).filter(Boolean);
  return loaded.sort(compareReports)[0] ?? null;
}

function compareReports(left = {}, right = {}) {
  const leftAsOf = String(left?.asOf ?? "");
  const rightAsOf = String(right?.asOf ?? "");
  if (leftAsOf !== rightAsOf) {
    return rightAsOf.localeCompare(leftAsOf);
  }
  const priorityDelta = reportPriority(right?.kind) - reportPriority(left?.kind);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return String(right?.updatedAt ?? "").localeCompare(String(left?.updatedAt ?? ""));
}

function summarizeEvents(calendar = {}) {
  return (Array.isArray(calendar?.events) ? calendar.events : [])
    .filter((event) => String(event?.title ?? "").trim())
    .sort((left, right) => String(left?.scheduledAt ?? "").localeCompare(String(right?.scheduledAt ?? "")))
    .slice(0, 4)
    .map((event) => ({
      eventId: String(event?.eventId ?? "").trim() || null,
      title: String(event?.title ?? "").trim(),
      scheduledAt: String(event?.scheduledAt ?? "").trim() || null,
      importance: String(event?.importance ?? "").trim() || null
    }));
}

function buildMarketOverview({ latestPulse, marketBrief, dailyBrief }) {
  const pulseSections = latestPulse?.sections ?? [];
  const marketSections = marketBrief?.sections ?? [];
  const dailySections = dailyBrief?.sections ?? [];

  const pulseConclusion = extractSectionLead(findSection(pulseSections, ["一句话结论"]));
  const pulseStrongest = extractSectionLabeledValue(findSection(pulseSections, ["强弱主题"]), ["最强"]);
  const pulseWeakest = extractSectionLabeledValue(findSection(pulseSections, ["强弱主题"]), ["最弱"]);
  const pulseStructure = extractSectionLabeledValue(
    findSection(pulseSections, ["强弱主题"]),
    ["结构结论"]
  );
  const pulseAShare = extractSectionLabeledValue(findSection(pulseSections, ["收盘跨资产"]), ["A股"]);
  const pulseHK = extractSectionLabeledValue(findSection(pulseSections, ["收盘跨资产"]), ["港股"]);
  const pulseGlobal = extractSectionLabeledValue(
    findSection(pulseSections, ["收盘跨资产"]),
    ["外盘锚点", "商品与汇率", "组合读法"]
  );

  const driverMainline = extractSectionLabeledValue(
    findSection(marketSections, ["Active Market Driver"]),
    ["主线"]
  );
  const driverDislocation = extractSectionLabeledValue(
    findSection(marketSections, ["Active Market Driver"]),
    ["预期差", "实际市场反应"]
  );
  const marketTemperature = extractSectionLabeledValue(
    findSection(marketSections, ["市场温度补充"]),
    ["市场定性", "驱动线索"]
  );
  const boardNames = extractSectionListItems(findSection(marketSections, ["热点板块"]), 3)
    .map((item) => item.split(/[：:]/)[0]?.trim())
    .filter(Boolean);

  const dailyMainline = extractSectionLabeledValue(
    findSection(dailySections, ["今日主线与行动备忘录"]),
    ["今日主线", "当前预期差"]
  );

  const headline =
    pulseConclusion ??
    driverMainline ??
    dailyMainline ??
    latestPulse?.summary ??
    marketBrief?.summary ??
    dailyBrief?.summary ??
    "暂无最新市场专题摘要";

  const summaryNote =
    pulseStructure ??
    marketTemperature ??
    driverDislocation ??
    dailyMainline ??
    null;

  const highlightCandidates = [
    { label: "主线", text: driverMainline ?? pulseConclusion },
    { label: "最强", text: pulseStrongest ?? (boardNames.length > 0 ? boardNames.join(" / ") : null) },
    { label: "最弱", text: pulseWeakest },
    { label: "A股", text: pulseAShare },
    { label: "港股", text: pulseHK },
    { label: "外盘", text: pulseGlobal ?? marketTemperature }
  ];

  const fallbackHighlights = [
    { label: "主线", text: latestPulse?.summary ?? marketBrief?.summary ?? dailyBrief?.summary },
    { label: "盘中", text: latestPulse?.highlights?.[0] ?? latestPulse?.highlights?.[1] ?? null },
    { label: "市场", text: marketBrief?.highlights?.[0] ?? marketBrief?.summary ?? null },
    { label: "组合", text: dailyBrief?.summary ?? null }
  ];

  return {
    headline,
    summaryNote,
    themeHighlights: dedupeMarketHighlights([...highlightCandidates, ...fallbackHighlights]).slice(0, 6)
  };
}

export async function buildMarketTopicsPayload({
  portfolioRoot = resolvePortfolioRoot(),
  accountId = resolveAccountId({ portfolioRoot }),
  now = new Date()
} = {}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const canonical = manifest?.canonical_entrypoints ?? {};

  const latestPulse = await selectLatestReport([
    readMarkdownReport(canonical.latest_close_market_pulse, "market_pulse_close"),
    readMarkdownReport(canonical.latest_noon_market_pulse, "market_pulse_noon"),
    readMarkdownReport(canonical.latest_morning_market_pulse, "market_pulse_morning")
  ]);
  const marketBrief = await readMarkdownReport(canonical.latest_market_brief, "market_brief");
  const dailyBrief = await readMarkdownReport(canonical.latest_daily_brief, "daily_brief");
  const eventCalendar =
    (await readJsonOrNull(canonical.high_impact_event_calendar ?? buildPortfolioPath(portfolioRoot, "data", "high_impact_event_calendar.json"))) ??
    {};
  const syncStatus =
    (await readJsonOrDefault(canonical.market_topics_sync_status ?? buildPortfolioPath(portfolioRoot, "data", "market_topics_sync_status.json"), null)) ??
    null;
  const researchBrain =
    (await readJsonOrDefault(canonical.latest_research_brain ?? buildPortfolioPath(portfolioRoot, "data", "research_brain.json"), null)) ??
    null;

  const reports = [latestPulse, marketBrief, dailyBrief].filter(Boolean).sort(compareReports);
  const primaryReport = reports[0] ?? null;
  const primaryStalenessLabel = resolveStalenessLabel(primaryReport?.asOf, now);
  const generationStatus = resolveGenerationStatus(primaryStalenessLabel, reports);
  const sourceMode = resolveSourceMode({ reports, syncStatus, portfolioRoot });
  const marketOverview = buildMarketOverview({
    latestPulse,
    marketBrief,
    dailyBrief
  });

  return {
    generatedAt: now.toISOString(),
    accountId,
    headline: marketOverview.headline,
    asOf: primaryReport?.asOf ?? latestPulse?.asOf ?? marketBrief?.asOf ?? dailyBrief?.asOf ?? null,
    primaryAsOfLabel: labelStaleness(primaryStalenessLabel, primaryReport?.asOf),
    generationStatus,
    sourceMode,
    syncStatus,
    reports: reports.map((report) => {
      const stalenessLabel = resolveStalenessLabel(report.asOf, now);
      return {
        kind: report.kind,
        title: report.title,
        asOf: report.asOf,
        updatedAt: report.updatedAt,
        stalenessLabel,
        stalenessText: labelStaleness(stalenessLabel, report.asOf),
        summary: report.summary,
        path: report.path
      };
    }),
    themeHighlights: marketOverview.themeHighlights,
    summaryNote: marketOverview.summaryNote,
    keyEvents: summarizeEvents(eventCalendar),
    researchSummary:
      typeof researchBrain?.summary === "string"
        ? researchBrain.summary
        : typeof researchBrain?.headline === "string"
          ? researchBrain.headline
          : null
  };
}
