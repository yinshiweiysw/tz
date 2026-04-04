import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { loadAssetMaster } from "./lib/asset_master.mjs";
import { loadIpsConstraints } from "./lib/ips_constraints.mjs";
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
import { buildProposedTradesForGate } from "./lib/manual_trade_gate_context.mjs";
import { formatShanghaiDate } from "./lib/portfolio_state_materializer.mjs";
import { loadCanonicalPortfolioState } from "./lib/portfolio_state_view.mjs";
import { evaluateExecutionPermission } from "./lib/execution_permission_gate.mjs";
import { evaluateTradePreFlight } from "./lib/trade_pre_flight_gate.mjs";
import { runRefreshAccountSidecars } from "./refresh_account_sidecars.mjs";

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

function buildTradeFundIdentity(meta = {}, fallbackName = "", userToken = "") {
  return {
    code: String(meta?.fund_code ?? meta?.fundCode ?? "").trim() || null,
    name: String(meta?.name ?? fallbackName ?? "").trim() || null,
    user_stated_token: String(userToken ?? "").trim() || null
  };
}

function enrichTradePayloadWithGateMetadata({
  payload,
  proposedTrades,
  buyItems,
  sellItems,
  conversionItems
}) {
  const normalizedProposedTrades = Array.isArray(proposedTrades) ? proposedTrades : [];
  const normalizedBuyItems = Array.isArray(buyItems) ? buyItems : [];
  const normalizedSellItems = Array.isArray(sellItems) ? sellItems : [];
  const normalizedConversionItems = Array.isArray(conversionItems) ? conversionItems : [];
  const buyMetas = normalizedProposedTrades.slice(0, normalizedBuyItems.length);
  const sellMetas = normalizedProposedTrades.slice(
    normalizedBuyItems.length,
    normalizedBuyItems.length + normalizedSellItems.length
  );
  const conversionMetas = normalizedProposedTrades.slice(
    normalizedBuyItems.length + normalizedSellItems.length
  );

  return {
    ...payload,
    ...(Array.isArray(payload?.executed_buy_transactions)
      ? {
          executed_buy_transactions: payload.executed_buy_transactions.map((trade, index) => {
            const meta = buyMetas[index] ?? {};
            return {
              ...trade,
              category: trade?.category ?? meta?.category ?? null,
              fund_code: trade?.fund_code ?? meta?.fund_code ?? null,
              source_confidence: "user_dialogue_confirmed",
              fund_identity: buildTradeFundIdentity(
                meta,
                trade?.interpreted_fund_name ?? trade?.fund_name_user_stated ?? "",
                normalizedBuyItems[index]?.token ?? trade?.fund_name_user_stated ?? ""
              ),
              bucket_key: meta?.bucket_key ?? null,
              theme_key: meta?.theme_key ?? null
            };
          })
        }
      : {}),
    ...(Array.isArray(payload?.executed_sell_transactions)
      ? {
          executed_sell_transactions: payload.executed_sell_transactions.map((trade, index) => {
            const meta = sellMetas[index] ?? {};
            return {
              ...trade,
              category: trade?.category ?? meta?.category ?? null,
              fund_code: trade?.fund_code ?? meta?.fund_code ?? null,
              source_confidence: "user_dialogue_confirmed",
              fund_identity: buildTradeFundIdentity(
                meta,
                trade?.interpreted_fund_name ?? trade?.fund_name_user_stated ?? "",
                normalizedSellItems[index]?.token ?? trade?.fund_name_user_stated ?? ""
              ),
              bucket_key: meta?.bucket_key ?? null,
              theme_key: meta?.theme_key ?? null
            };
          })
        }
      : {}),
    ...(Array.isArray(payload?.executed_conversion_transactions)
      ? {
          executed_conversion_transactions: payload.executed_conversion_transactions.map((trade, index) => {
            const fromMeta = conversionMetas[index * 2] ?? {};
            const toMeta = conversionMetas[index * 2 + 1] ?? {};
            return {
              ...trade,
              source_confidence: "user_dialogue_confirmed",
              from_fund_identity: buildTradeFundIdentity(
                fromMeta,
                trade?.from_fund_name ?? trade?.from_fund_name_user_stated ?? "",
                normalizedConversionItems[index]?.fromToken ?? trade?.from_fund_name_user_stated ?? ""
              ),
              to_fund_identity: buildTradeFundIdentity(
                toMeta,
                trade?.to_fund_name ?? trade?.to_fund_name_user_stated ?? "",
                normalizedConversionItems[index]?.toToken ?? trade?.to_fund_name_user_stated ?? ""
              ),
              from_bucket_key: fromMeta?.bucket_key ?? null,
              to_bucket_key: toMeta?.bucket_key ?? null,
              from_theme_key: fromMeta?.theme_key ?? null,
              to_theme_key: toMeta?.theme_key ?? null
            };
          })
        }
      : {})
  };
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
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
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
const manifest = await readJsonOrNull(manifestPath);
const latestState = (await loadCanonicalPortfolioState({ portfolioRoot, manifest })).payload ?? {};
const watchlist = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "fund-watchlist.json"));
const lookup = await loadRecorderLookup({
  portfolioRoot,
  latestState,
  watchlist
});
const assetMasterPath =
  manifest?.canonical_entrypoints?.asset_master ??
  buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
const ipsConstraintsPath =
  manifest?.canonical_entrypoints?.ips_constraints ??
  path.join(path.dirname(assetMasterPath), "ips_constraints.json");
const assetMaster = await loadAssetMaster(assetMasterPath);
const ipsConstraints = await loadIpsConstraints(ipsConstraintsPath);
const riskDashboard = await readJsonOrNull(buildPortfolioPath(portfolioRoot, "risk_dashboard.json"));
const proposedTrades = buildProposedTradesForGate({
  buyItems,
  sellItems,
  conversionItems,
  lookup,
  latestState,
  assetMaster,
  sellCashArrived
});
const gateResult = evaluateTradePreFlight({
  portfolioState: latestState,
  proposedTrades,
  assetMaster,
  portfolioRiskState: {
    ...(riskDashboard?.portfolio_risk ?? {}),
    current_drawdown_pct:
      Number(riskDashboard?.portfolio_risk?.current_drawdown_pct ?? riskDashboard?.current_drawdown_pct ?? NaN)
  },
  ipsConstraints
});

const researchBrainPath =
  manifest?.canonical_entrypoints?.latest_research_brain ??
  buildPortfolioPath(portfolioRoot, "data", "research_brain.json");
const researchBrain = await readJsonOrNull(researchBrainPath);
const executionGateResult = evaluateExecutionPermission({
  structuralGate: gateResult,
  researchDecision: researchBrain,
  proposedTrades
});

if (!executionGateResult.allowed) {
  console.error(
    `Trade blocked by unified execution gate: ${executionGateResult.blockingReasons.join(" | ")}`
  );
  process.exit(1);
}

const payload = enrichTradePayloadWithGateMetadata({
  payload: buildManualTradeTransactionContent({
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
  }),
  proposedTrades,
  buyItems,
  sellItems,
  conversionItems
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
const manifestUpdatePath = await updateStateManifestManualTradePointer({
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

let refreshResult = null;
if (!skipMerge) {
  refreshResult = await runRefreshAccountSidecars({
    portfolioRoot,
    user: accountId,
    date: tradeDate
  });
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
      manifestPath: manifestUpdatePath,
      mergeResult,
      refreshResult,
      writebackResult
    },
    null,
    2
  )
);
