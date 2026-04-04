import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { readJsonOrDefault, updateJsonFileAtomically } from "./lib/atomic_json_state.mjs";

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    result[key] = value ?? "";
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

function resolveTime(timeArg) {
  if (timeArg) {
    return timeArg;
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

function parseMultiValue(value) {
  return String(value ?? "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
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

function buildJournalSkeleton({ journalDate, summary, accountId }) {
  return [
    `# ${journalDate} 日度交易纪要`,
    "",
    `- 账户：${accountId}`,
    "",
    "## 当日摘要",
    "",
    `- 持仓总额：${summary.total_fund_assets ?? "--"} 元`,
    `- 持有收益：${summary.holding_profit ?? "--"} 元`,
    `- 累计收益：${summary.cumulative_profit ?? "--"} 元`,
    "- 今日新增重要聊天结论待补充",
    "",
    "## 已确认执行",
    "",
    "### 买入",
    "",
    "- ",
    "",
    "### 卖出",
    "",
    "- ",
    "",
    "## 当前组合定位",
    "",
    "- ",
    "",
    "## 关键判断",
    "",
    "### 市场",
    "",
    "- ",
    "",
    "### 账户",
    "",
    "- ",
    "",
    "## 行为诊断",
    "",
    "- ",
    "",
    "## 明日观察重点",
    "",
    "- ",
    "",
    "## 需要后续确认的事项",
    "",
    "- "
  ];
}

async function ensureJournalExists({ journalDate, journalPath, latestPath, accountId }) {
  try {
    await readFile(journalPath, "utf8");
    return false;
  } catch {}

  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  const summary = latest.summary ?? {};
  const content = `${buildJournalSkeleton({ journalDate, summary, accountId }).join("\n")}\n`;
  await writeFile(journalPath, content, "utf8");
  return true;
}

function ensureEventSection(content) {
  if (content.includes("\n## 事件流\n")) {
    return content;
  }

  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  return `${normalized}\n## 事件流\n`;
}

function buildEntryBlock({
  time,
  type,
  title,
  summary,
  points,
  actions,
  tags,
  fundingKind,
  fundingSourceLines,
  useOfProceedsLines,
  routingNoteLines
}) {
  const lines = [
    `### ${time} [${type}] ${title}`,
    "",
    `- 摘要：${summary}`
  ];

  if (points.length > 0) {
    lines.push(`- 要点：${points.join("；")}`);
  }

  if (actions.length > 0) {
    lines.push(`- 后续：${actions.join("；")}`);
  }

  if (fundingKind) {
    lines.push(`- 资金审计：交易性质=${fundingKind}`);
  }

  if (fundingSourceLines.length > 0) {
    lines.push(`- 资金来源：${fundingSourceLines.join("；")}`);
  }

  if (useOfProceedsLines.length > 0) {
    lines.push(`- 资金去向：${useOfProceedsLines.join("；")}`);
  }

  if (routingNoteLines.length > 0) {
    lines.push(`- 路由依据：${routingNoteLines.join("；")}`);
  }

  if (tags.length > 0) {
    lines.push(`- 标签：${tags.join("、")}`);
  }

  lines.push("");
  return lines.join("\n");
}

const options = parseArgs(process.argv.slice(2));
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const journalDate = resolveDate(options.date);
const entryTime = resolveTime(options.time);
const type = String(options.type ?? "note").trim() || "note";
const title = String(options.title ?? "").trim() || "未命名事件";
const summary = String(options.summary ?? "").trim() || "待补充";
const points = parseMultiValue(options.points);
const actions = parseMultiValue(options.actions);
const tags = parseMultiValue(options.tags);
const fundingKind = optionValue(options, ["fundingkind", "funding-kind", "routingkind", "routing-kind"]);
const fundingSourceLines = parseMultiValue(optionValue(options, ["fundingsource", "funding-source"]));
const useOfProceedsLines = parseMultiValue(
  optionValue(options, ["useofproceeds", "use-of-proceeds", "proceedsuse", "proceeds-use"])
);
const routingNoteLines = parseMultiValue(optionValue(options, ["routingnotes", "routing-notes"]));
const journalDir = buildPortfolioPath(portfolioRoot, "journal", "daily");
const journalPath = buildPortfolioPath(journalDir, `${journalDate}.md`);
const latestPath = buildPortfolioPath(portfolioRoot, "latest.json");
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");

await mkdir(journalDir, { recursive: true });
await ensureJournalExists({ journalDate, journalPath, latestPath, accountId });

const original = await readFile(journalPath, "utf8");
const withEventSection = ensureEventSection(original);
const separator = withEventSection.endsWith("\n\n") ? "" : "\n";
const nextContent = `${withEventSection}${separator}${buildEntryBlock({
  time: entryTime,
  type,
  title,
  summary,
  points,
  actions,
  tags,
  fundingKind,
  fundingSourceLines,
  useOfProceedsLines,
  routingNoteLines
})}`;

await writeFile(journalPath, nextContent, "utf8");

const manifest = await readJsonOrDefault(manifestPath, null);

if (manifest?.canonical_entrypoints) {
  await updateJsonFileAtomically(manifestPath, (current) => ({
    ...(current ?? {}),
    canonical_entrypoints: {
      ...((current ?? {}).canonical_entrypoints ?? {}),
      latest_daily_journal: journalPath
    }
  }));
}

console.log(
  JSON.stringify(
    {
      accountId,
      path: journalPath,
      date: journalDate,
      time: entryTime,
      type,
      title
    },
    null,
    2
  )
);
