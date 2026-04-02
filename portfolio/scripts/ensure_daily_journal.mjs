import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { loadPreferredPortfolioState, readJsonOrNull } from "./lib/portfolio_state_view.mjs";

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (!result.date) {
        result.date = token;
      }
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    result[key] = next ?? "";
    index += 1;
  }

  return result;
}

function resolveDate(options) {
  const dateArg = String(options.date ?? "").trim();
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

const options = parseArgs(process.argv.slice(2));
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const journalDate = resolveDate(options);
const journalDir = buildPortfolioPath(portfolioRoot, "journal", "daily");
const journalPath = buildPortfolioPath(journalDir, `${journalDate}.md`);
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");

await mkdir(journalDir, { recursive: true });

try {
  await readFile(journalPath, "utf8");
  console.log(JSON.stringify({ created: false, accountId, path: journalPath }, null, 2));
  process.exit(0);
} catch {}

const manifest = await readJsonOrNull(manifestPath);
const portfolioStateView = await loadPreferredPortfolioState({ portfolioRoot, manifest });
const summary = portfolioStateView.payload?.summary ?? {};
const content = `${buildJournalSkeleton({ journalDate, summary, accountId }).join("\n")}\n`;

await writeFile(journalPath, content, "utf8");

if (manifest?.canonical_entrypoints) {
  manifest.canonical_entrypoints.latest_daily_journal = journalPath;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ created: true, accountId, path: journalPath }, null, 2));
