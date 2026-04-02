import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import {
  buildManualTradeTransactionContent,
  chooseManualTransactionFilePath,
  loadRecorderLookup,
  parseConversionSpec,
  parseBuySpec,
  parseSellSpec,
  readJsonOrNull,
  updateRawSnapshotRelatedFiles,
  updateStateManifestManualTradePointer,
  writeJson
} from "./lib/manual_trade_recorder.mjs";
import { formatShanghaiDate } from "./lib/portfolio_state_materializer.mjs";
import { loadPreferredPortfolioState } from "./lib/portfolio_state_view.mjs";

const execFileAsync = promisify(execFile);
const mergeConfirmedTradesScriptPath = new URL("./merge_confirmed_trades_into_latest.mjs", import.meta.url);
const dailyWritebackScriptPath = new URL("./daily_writeback.mjs", import.meta.url);

function parseArgs(argv) {
  const result = {
    buy: "",
    sell: "",
    convert: "",
    date: "",
    user: "",
    portfolioRoot: "",
    executionType: "OTC",
    submittedBeforeCutoff: "true",
    sellCashArrived: "false",
    rawIncludesTrade: "false",
    cutoffTimeLocal: "15:00",
    skipMerge: false,
    skipWriteback: false,
    label: ""
  };
  const camelize = (key) => key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      result[camelize(key)] = true;
      continue;
    }

    result[key] = next;
    result[camelize(key)] = next;
    index += 1;
  }

  return result;
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function formatMoney(value) {
  return `${Number(value ?? 0).toFixed(2)} 元`;
}

async function runNodeScript(scriptPath, args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    maxBuffer: 1024 * 1024 * 10
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

function buildWritebackSummary({
  tradeDate,
  executionType,
  buyCount,
  sellCount,
  conversionCount,
  buyAmount,
  sellAmount,
  conversionOutAmount,
  effectiveDates,
  sellCashArrived
}) {
  if (buyCount > 0 && sellCount === 0 && conversionCount === 0) {
    if (executionType === "EXCHANGE") {
      return `${tradeDate} 手工登记 ${buyCount} 笔场内买入，共 ${formatMoney(buyAmount)}；场内成交不走次日收益锁。`;
    }

    const effectiveLabel =
      effectiveDates.length === 1 ? effectiveDates[0] : effectiveDates.join(" / ");
    return `${tradeDate} 手工登记 ${buyCount} 笔 OTC 基金买入，共 ${formatMoney(buyAmount)}；统一自 ${effectiveLabel} 起参与收益。`;
  }

  const parts = [];
  if (buyCount > 0) {
    if (executionType === "EXCHANGE") {
      parts.push(`买入 ${buyCount} 笔 ${formatMoney(buyAmount)}（场内即时生效）`);
    } else {
      const effectiveLabel =
        effectiveDates.length === 1 ? effectiveDates[0] : effectiveDates.join(" / ");
      parts.push(`买入 ${buyCount} 笔 ${formatMoney(buyAmount)}（自 ${effectiveLabel} 起计收益）`);
    }
  }
  if (sellCount > 0) {
    parts.push(
      sellCashArrived
        ? `卖出 ${sellCount} 笔 ${formatMoney(sellAmount)}（回笼现金已到账）`
        : `卖出 ${sellCount} 笔 ${formatMoney(sellAmount)}（回笼现金待到账）`
    );
  }
  if (conversionCount > 0) {
    parts.push(`转换 ${conversionCount} 笔，转出基数 ${formatMoney(conversionOutAmount)}（按已确认转换处理）`);
  }
  return `${tradeDate} 手工登记基金交易：${parts.join("；")}。`;
}

function buildWritebackTitle({ buyCount, sellCount, conversionCount }) {
  const activeKinds = [
    buyCount > 0 ? "buy" : null,
    sellCount > 0 ? "sell" : null,
    conversionCount > 0 ? "conversion" : null
  ].filter(Boolean);
  if (activeKinds.length === 1) {
    if (activeKinds[0] === "buy") {
      return "手工基金买入登记";
    }
    if (activeKinds[0] === "sell") {
      return "手工基金卖出登记";
    }
    return "手工基金转换登记";
  }
  return "手工基金交易登记";
}

function buildWritebackPoints(payload) {
  const points = [];

  for (const item of payload.executed_buy_transactions ?? []) {
    points.push(
      `买入:${item.interpreted_fund_name}:${formatMoney(item.amount_cny)}${
        item.profit_effective_on ? `->${item.profit_effective_on}` : ""
      }`
    );
  }

  for (const item of payload.executed_sell_transactions ?? []) {
    points.push(
      `卖出:${item.interpreted_fund_name}:${formatMoney(item.amount_cny)}:${
        item.cash_arrived ? "已到账" : "待到账"
      }`
    );
  }

  for (const item of payload.executed_conversion_transactions ?? []) {
    points.push(
      `转换:${item.from_fund_name}:${formatMoney(item.from_amount_cny)}->${item.to_fund_name}:${formatMoney(
        item.to_amount_cny
      )}`
    );
  }

  return points.join("||");
}

function buildWritebackTags({ buyCount, sellCount, conversionCount }) {
  const tags = ["交易落账", "手工确认", "统一入口"];
  if (buyCount > 0) {
    tags.push("收益生效日");
  }
  if (sellCount > 0) {
    tags.push("卖出回笼");
  }
  if (conversionCount > 0) {
    tags.push("基金转换");
  }
  return tags.join("||");
}

function summarizeTradeKinds({ buyCount, sellCount, conversionCount }) {
  return [
    ...Array(buyCount > 0 ? 1 : 0).fill("buy"),
    ...Array(sellCount > 0 ? 1 : 0).fill("sell"),
    ...Array(conversionCount > 0 ? 1 : 0).fill("conversion")
  ];
}

const options = parseArgs(process.argv.slice(2));
if (!String(options.buy ?? "").trim() && !String(options.sell ?? "").trim() && !String(options.convert ?? "").trim()) {
  console.error(
    "Missing required trade arguments. Example: --buy \"007339:8000\" --sell \"022502:5000\" --convert \"000218:29320.63->022502:29320.63\""
  );
  process.exit(1);
}

const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const tradeDate = String(options.date ?? "").trim() || formatShanghaiDate();
const executionType = String(options.executionType ?? options["execution-type"] ?? "OTC")
  .trim()
  .toUpperCase();
const submittedBeforeCutoff = parseBoolean(
  options.submittedBeforeCutoff ?? options["submitted-before-cutoff"],
  true
);
const sellCashArrived = parseBoolean(options.sellCashArrived ?? options["sell-cash-arrived"], false);
const rawIncludesTrade = parseBoolean(options.rawIncludesTrade ?? options["raw-includes-trade"], false);
const cutoffTimeLocal = String(options.cutoffTimeLocal ?? options["cutoff-time-local"] ?? "15:00").trim() || "15:00";
const skipMerge = parseBoolean(options.skipMerge ?? options["skip-merge"], false);
const skipWriteback = parseBoolean(options.skipWriteback ?? options["skip-writeback"], false);
const label = String(options.label ?? "").trim();

const buyItems = String(options.buy ?? "").trim() ? parseBuySpec(options.buy) : [];
const sellItems = String(options.sell ?? "").trim() ? parseSellSpec(options.sell) : [];
const conversionItems = String(options.convert ?? "").trim() ? parseConversionSpec(options.convert) : [];
const latestState = (await loadPreferredPortfolioState({ portfolioRoot })).payload ?? {};
const watchlist = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "fund-watchlist.json"));
const lookup = await loadRecorderLookup({
  portfolioRoot,
  latestState,
  watchlist
});

const payload = buildManualTradeTransactionContent({
  tradeDate,
  buyItems,
  sellItems,
  conversionItems,
  executionType,
  submittedBeforeCutoff,
  cutoffTimeLocal,
  rawSnapshotIncludesTrade: rawIncludesTrade,
  sellCashArrived,
  lookup
});

const transactionsDir = buildPortfolioPath(portfolioRoot, "transactions");
const tradeKinds = summarizeTradeKinds({
  buyCount: buyItems.length,
  sellCount: sellItems.length,
  conversionCount: conversionItems.length
});
const transactionFilePath = await chooseManualTransactionFilePath({
  transactionsDir,
  tradeDate,
  label,
  tradeKinds
});

await writeJson(transactionFilePath, payload);

const buyAmount = (payload.executed_buy_transactions ?? []).reduce((sum, item) => sum + Number(item.amount_cny ?? 0), 0);
const sellAmount = (payload.executed_sell_transactions ?? []).reduce((sum, item) => sum + Number(item.amount_cny ?? 0), 0);
const conversionOutAmount = (payload.executed_conversion_transactions ?? []).reduce(
  (sum, item) => sum + Number(item.from_amount_cny ?? 0),
  0
);
const effectiveDates = [
  ...new Set((payload.executed_buy_transactions ?? []).map((item) => item.profit_effective_on).filter(Boolean))
];
const rawNote = rawIncludesTrade
  ? `${tradeDate} manual_trade_recorder 已登记手工基金交易；当前 raw snapshot 已包含这些成交在持仓或现金侧的反映，策略层会先做防重拆分，再按 execution_ledger 单次重建。`
  : null;

const rawSnapshotPath = await updateRawSnapshotRelatedFiles({
  portfolioRoot,
  transactionFilePath,
  tradeDate,
  note: rawNote,
  tradeKinds
});
const manifestPath = await updateStateManifestManualTradePointer({
  portfolioRoot,
  transactionFilePath,
  tradeKinds
});

let mergeResult = null;
if (!skipMerge) {
  const args = ["--date", tradeDate, "--transactions", transactionFilePath, "--portfolio-root", portfolioRoot];
  args.push("--user", accountId);
  const result = await runNodeScript(mergeConfirmedTradesScriptPath.pathname, args);
  mergeResult = result.stdout ? JSON.parse(result.stdout) : null;
}

let writebackResult = null;
if (!skipWriteback) {
  const summary = buildWritebackSummary({
    tradeDate,
    executionType,
    buyCount: (payload.executed_buy_transactions ?? []).length,
    sellCount: (payload.executed_sell_transactions ?? []).length,
    conversionCount: (payload.executed_conversion_transactions ?? []).length,
    buyAmount,
    sellAmount,
    conversionOutAmount,
    effectiveDates,
    sellCashArrived
  });
  const points = buildWritebackPoints(payload);
  const args = [
    "--date",
    tradeDate,
    "--portfolio-root",
    portfolioRoot,
    "--user",
    accountId,
    "--type",
    "trade_confirm",
    "--title",
    buildWritebackTitle({
      buyCount: (payload.executed_buy_transactions ?? []).length,
      sellCount: (payload.executed_sell_transactions ?? []).length,
      conversionCount: (payload.executed_conversion_transactions ?? []).length
    }),
    "--summary",
    summary,
    "--points",
    points,
    "--tags",
    buildWritebackTags({
      buyCount: (payload.executed_buy_transactions ?? []).length,
      sellCount: (payload.executed_sell_transactions ?? []).length,
      conversionCount: (payload.executed_conversion_transactions ?? []).length
    })
  ];
  const result = await runNodeScript(dailyWritebackScriptPath.pathname, args);
  writebackResult = result.stdout ? JSON.parse(result.stdout) : null;
}

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      tradeDate,
      executionType,
      transactionFilePath,
      buyCount: (payload.executed_buy_transactions ?? []).length,
      sellCount: (payload.executed_sell_transactions ?? []).length,
      conversionCount: (payload.executed_conversion_transactions ?? []).length,
      buyAmount,
      sellAmount,
      conversionOutAmount,
      effectiveDates,
      rawSnapshotPath,
      manifestPath,
      mergeResult,
      writebackResult
    },
    null,
    2
  )
);
