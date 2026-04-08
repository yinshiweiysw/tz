import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { buildPortfolioPath } from "./account_root.mjs";
import { updateJsonFileAtomically, writeJsonAtomic } from "./atomic_json_state.mjs";
import { inferProfitEffectiveOn, parseAmount } from "./portfolio_state_materializer.mjs";
import { resolveLedgerEntryLifecycleStage } from "./trade_lifecycle.mjs";
import {
  beginTransaction,
  commitTransaction,
  rollbackTransaction
} from "./transaction_journal.mjs";

function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .replace(
      /人民币|发起式|发起|联接|ETF|LOF|FOF|指数|股票|混合|持有期|持有|配置|QDII|CNY|人民币A|人民币C|人民币E/giu,
      ""
    )
    .replace(/[()（）\[\]【】\s\-_/·.,，:：]/gu, "")
    .toLowerCase()
    .replace(/[aceh]$/giu, "");
}

function looksLikeFundCode(value) {
  return /^\d{6}$/.test(String(value ?? "").trim());
}

function splitInstructionSpec(spec) {
  return String(spec ?? "")
    .split("||")
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function parseTokenAmountChunk(chunk, instructionLabel) {
  const normalized = String(chunk ?? "").replaceAll("：", ":");
  const separatorIndex = normalized.lastIndexOf(":");
  if (separatorIndex <= 0) {
    throw new Error(`Invalid ${instructionLabel} instruction "${chunk}". Expected format token:amount.`);
  }

  const token = normalized.slice(0, separatorIndex).trim();
  const amountText = normalized.slice(separatorIndex + 1).trim();
  const amountCny = parseAmount(amountText);
  if (!token || amountCny <= 0) {
    throw new Error(`Invalid ${instructionLabel} instruction "${chunk}". Token or amount is missing.`);
  }

  return {
    token,
    amountCny
  };
}

export function parseBuySpec(spec) {
  return splitInstructionSpec(spec).map((chunk) => parseTokenAmountChunk(chunk, "buy"));
}

export function parseSellSpec(spec) {
  return splitInstructionSpec(spec).map((chunk) => parseTokenAmountChunk(chunk, "sell"));
}

export function parseConversionSpec(spec) {
  return splitInstructionSpec(spec).map((chunk) => {
    const normalized = String(chunk ?? "")
      .replaceAll("：", ":")
      .replaceAll("→", "->")
      .replaceAll("➜", "->");
    const parts = normalized.split("->").map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid conversion instruction "${chunk}". Expected format fromToken:amount->toToken:amount.`
      );
    }

    const from = parseTokenAmountChunk(parts[0], "conversion");
    const to = parseTokenAmountChunk(parts[1], "conversion");
    return {
      fromToken: from.token,
      fromAmountCny: from.amountCny,
      toToken: to.token,
      toAmountCny: to.amountCny
    };
  });
}

function makeResolvedFund({ token, fundName = null, fundCode = null }) {
  const trimmedToken = String(token ?? "").trim();
  const trimmedCode = String(fundCode ?? "").trim() || (looksLikeFundCode(trimmedToken) ? trimmedToken : null);
  const trimmedName = String(fundName ?? "").trim() || trimmedToken;

  return {
    token: trimmedToken,
    fundName: trimmedName,
    fundCode: trimmedCode
  };
}

function addLookupEntry(byCode, byName, token, fundName = null, fundCode = null) {
  const resolved = makeResolvedFund({ token, fundName, fundCode });
  if (resolved.fundCode) {
    byCode.set(resolved.fundCode, resolved);
  }

  const normalizedName = normalizeName(resolved.fundName);
  if (normalizedName) {
    byName.set(normalizedName, resolved);
  }
}

export function createFundLookup({ positions = [], pendingPositions = [], watchlistItems = [] }) {
  const byCode = new Map();
  const byName = new Map();

  for (const item of [...positions, ...pendingPositions]) {
    addLookupEntry(
      byCode,
      byName,
      item?.code ?? item?.fund_code ?? item?.symbol ?? item?.name ?? "",
      item?.name ?? null,
      item?.fund_code ?? item?.code ?? item?.symbol ?? null
    );
  }

  for (const item of watchlistItems) {
    addLookupEntry(byCode, byName, item?.code ?? item?.name ?? "", item?.name ?? null, item?.code ?? null);
    for (const alias of Array.isArray(item?.aliases) ? item.aliases : []) {
      addLookupEntry(byCode, byName, alias, item?.name ?? alias, item?.code ?? null);
    }
  }

  return {
    byCode,
    byName
  };
}

export function resolveFundToken(token, lookup) {
  const trimmedToken = String(token ?? "").trim();
  if (!trimmedToken) {
    return makeResolvedFund({ token: trimmedToken });
  }

  const codeMatch = lookup?.byCode?.get(trimmedToken);
  if (codeMatch) {
    return codeMatch;
  }

  const nameMatch = lookup?.byName?.get(normalizeName(trimmedToken));
  if (nameMatch) {
    return nameMatch;
  }

  return makeResolvedFund({ token: trimmedToken });
}

function buildBuyTrade({
  tradeDate,
  item,
  executionType,
  submittedBeforeCutoff,
  cutoffTimeLocal,
  rawSnapshotIncludesTrade,
  lookup
}) {
  const resolved = resolveFundToken(item.token, lookup);
  const trade = {
    trade_date: tradeDate,
    fund_name_user_stated: item.token,
    interpreted_fund_name: resolved.fundName,
    fund_code: resolved.fundCode,
    amount_cny: item.amountCny,
    status: "user_reported_executed",
    execution_type: executionType,
    raw_snapshot_includes_trade: rawSnapshotIncludesTrade
  };

  if (executionType === "OTC") {
    trade.submitted_before_cutoff = submittedBeforeCutoff;
    trade.cutoff_time_local = cutoffTimeLocal;
    trade.profit_effective_on = inferProfitEffectiveOn(trade, tradeDate);
    trade.merge_impact_on_latest = "pending_until_profit_effective_on";
    trade.interpretation_basis = `Recorded via manual_trade_recorder from "${item.token}" with OTC settlement; profit should begin on ${trade.profit_effective_on}.`;
  } else {
    trade.profit_effective_on = null;
    trade.merge_impact_on_latest = "effective_immediately";
    trade.interpretation_basis = `Recorded via manual_trade_recorder from "${item.token}" as EXCHANGE execution; same-day profit lock is bypassed.`;
  }

  trade.lifecycle_stage = resolveLedgerEntryLifecycleStage(
    {
      type: "buy",
      status: trade.status,
      profit_effective_on: trade.profit_effective_on,
      normalized: {
        execution_type: trade.execution_type,
        amount_cny: trade.amount_cny,
        profit_effective_on: trade.profit_effective_on
      }
    },
    tradeDate
  );

  return trade;
}

function buildSellTrade({
  tradeDate,
  item,
  executionType,
  cashArrived,
  rawSnapshotIncludesTrade,
  lookup
}) {
  const resolved = resolveFundToken(item.token, lookup);
  const trade = {
    trade_date: tradeDate,
    fund_name_user_stated: item.token,
    interpreted_fund_name: resolved.fundName,
    fund_code: resolved.fundCode,
    amount_cny: item.amountCny,
    status: "user_reported_executed",
    execution_type: executionType,
    cash_arrived: cashArrived,
    raw_snapshot_includes_trade: rawSnapshotIncludesTrade
  };

  trade.interpretation_basis = cashArrived
    ? `Recorded via manual_trade_recorder from "${item.token}" as an executed sell; proceeds are marked cash_arrived=true and may be recognized immediately.`
    : `Recorded via manual_trade_recorder from "${item.token}" as an executed sell; proceeds remain pending settlement until cash_arrived=true.`;
  trade.lifecycle_stage = resolveLedgerEntryLifecycleStage(
    {
      type: "sell",
      status: trade.status,
      normalized: {
        amount_cny: trade.amount_cny,
        cash_effect_cny: cashArrived ? trade.amount_cny : 0,
        pending_sell_to_arrive_cny: cashArrived ? 0 : trade.amount_cny
      },
      original: {
        cash_arrived: trade.cash_arrived
      }
    },
    tradeDate
  );

  return trade;
}

function buildConversionTrade({
  tradeDate,
  item,
  executionType,
  rawSnapshotIncludesTrade,
  lookup
}) {
  const resolvedFrom = resolveFundToken(item.fromToken, lookup);
  const resolvedTo = resolveFundToken(item.toToken, lookup);
  const trade = {
    trade_date: tradeDate,
    from_fund_name_user_stated: item.fromToken,
    to_fund_name_user_stated: item.toToken,
    from_fund_name: resolvedFrom.fundName,
    to_fund_name: resolvedTo.fundName,
    from_fund_code: resolvedFrom.fundCode,
    to_fund_code: resolvedTo.fundCode,
    from_amount_cny: item.fromAmountCny,
    to_amount_cny: item.toAmountCny,
    status: "user_reported_confirmed_conversion",
    execution_type: executionType,
    raw_snapshot_includes_trade: rawSnapshotIncludesTrade,
    interpretation_basis: `Recorded via manual_trade_recorder as a confirmed conversion from "${item.fromToken}" to "${item.toToken}"; the state materializer should apply the conversion immediately.`
  };

  trade.lifecycle_stage = resolveLedgerEntryLifecycleStage(
    {
      type: "conversion",
      status: trade.status,
      normalized: {
        from_amount_cny: trade.from_amount_cny,
        to_amount_cny: trade.to_amount_cny
      }
    },
    tradeDate
  );

  return trade;
}

export function buildManualTradeTransactionContent({
  tradeDate,
  buyItems = [],
  sellItems = [],
  conversionItems = [],
  executionType = "OTC",
  submittedBeforeCutoff = true,
  cutoffTimeLocal = "15:00",
  rawSnapshotIncludesTrade = false,
  sellCashArrived = false,
  lookup
}) {
  const normalizedExecutionType = String(executionType ?? "OTC").trim().toUpperCase();
  const executedBuyTransactions = buyItems.map((item) =>
    buildBuyTrade({
      tradeDate,
      item,
      executionType: normalizedExecutionType,
      submittedBeforeCutoff,
      cutoffTimeLocal,
      rawSnapshotIncludesTrade,
      lookup
    })
  );
  const executedSellTransactions = sellItems.map((item) =>
    buildSellTrade({
      tradeDate,
      item,
      executionType: normalizedExecutionType,
      cashArrived: sellCashArrived,
      rawSnapshotIncludesTrade,
      lookup
    })
  );
  const executedConversionTransactions = conversionItems.map((item) =>
    buildConversionTrade({
      tradeDate,
      item,
      executionType: normalizedExecutionType,
      rawSnapshotIncludesTrade,
      lookup
    })
  );

  const nextProfitDates = [...new Set(executedBuyTransactions.map((item) => item.profit_effective_on).filter(Boolean))];
  const notes = [
    "These manual fund trades were reported by the user in chat after execution."
  ];

  if (executedBuyTransactions.length > 0) {
    if (normalizedExecutionType === "OTC") {
      notes.push(
        nextProfitDates.length === 1
          ? `All buys are OTC fund orders and should only begin participating in profit and loss from ${nextProfitDates[0]}.`
          : "These OTC fund orders must remain outside same-day profit accounting until their respective profit_effective_on dates."
      );
    } else {
      notes.push("These buys are marked as EXCHANGE executions and therefore bypass pending profit-effective scheduling.");
    }
  }

  if (executedSellTransactions.length > 0) {
    notes.push(
      sellCashArrived
        ? "Sell proceeds in this file are marked cash_arrived=true and may be counted toward available cash immediately."
        : "Sell proceeds in this file are still pending settlement and should remain outside available cash until cash_arrived=true."
    );
  }

  if (executedConversionTransactions.length > 0) {
    notes.push(
      "Conversion entries in this file are treated as confirmed conversions and will be materialized immediately; do not use this path for same-day OTC conversions that are still awaiting platform confirmation."
    );
  }

  if (
    rawSnapshotIncludesTrade &&
    (executedBuyTransactions.length > 0 ||
      executedSellTransactions.length > 0 ||
      executedConversionTransactions.length > 0)
  ) {
    notes.push(
      "The current raw snapshot already reflects these trades in position amounts or cash changes; strategy state must unwind them first and then rematerialize them via execution_ledger."
    );
  }

  notes.push(
    "After ledger merge, latest.json should be regenerated automatically from execution_ledger and portfolio_state materialization."
  );

  return {
    snapshot_date: tradeDate,
    source: "manual_trade_recorder",
    status: "awaiting_execution_ledger_merge",
    ...(executedBuyTransactions.length > 0 ? { executed_buy_transactions: executedBuyTransactions } : {}),
    ...(executedSellTransactions.length > 0 ? { executed_sell_transactions: executedSellTransactions } : {}),
    ...(executedConversionTransactions.length > 0
      ? { executed_conversion_transactions: executedConversionTransactions }
      : {}),
    notes
  };
}

export function buildManualBuyTransactionContent({
  tradeDate,
  buyItems,
  executionType = "OTC",
  submittedBeforeCutoff = true,
  cutoffTimeLocal = "15:00",
  rawSnapshotIncludesTrade = false,
  lookup
}) {
  return buildManualTradeTransactionContent({
    tradeDate,
    buyItems,
    executionType,
    submittedBeforeCutoff,
    cutoffTimeLocal,
    rawSnapshotIncludesTrade,
    lookup
  });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function chooseManualTransactionFilePath({
  transactionsDir,
  tradeDate,
  label = "",
  tradeKinds = []
}) {
  const slug = String(label ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedKinds = [...new Set((tradeKinds ?? []).map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))];
  const buyOnly = normalizedKinds.length === 1 && normalizedKinds[0] === "buy";
  const prefix = buyOnly ? "manual-buys" : "manual-trades";
  const baseName = slug ? `${tradeDate}-${prefix}-${slug}` : `${tradeDate}-${prefix}`;
  let candidate = path.join(transactionsDir, `${baseName}.json`);
  if (!(await pathExists(candidate))) {
    return candidate;
  }

  let index = 2;
  while (true) {
    candidate = path.join(transactionsDir, `${baseName}-${index}.json`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
    index += 1;
  }
}

export async function chooseManualBuysFilePath({ transactionsDir, tradeDate, label = "" }) {
  return chooseManualTransactionFilePath({
    transactionsDir,
    tradeDate,
    label,
    tradeKinds: ["buy"]
  });
}

export async function writeJson(targetPath, payload) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeJsonAtomic(targetPath, payload);
}

export async function readJsonOrNull(targetPath) {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

export async function updateRawSnapshotRelatedFiles({
  portfolioRoot,
  transactionFilePath,
  tradeDate,
  note = null,
  tradeKinds = ["buy"]
}) {
  const rawPath = buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json");
  const rawSnapshot = await readJsonOrNull(rawPath);
  if (!rawSnapshot) {
    return null;
  }

  const normalizedKinds = new Set(
    (tradeKinds ?? []).map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
  );
  rawSnapshot.related_files = {
    ...(rawSnapshot.related_files ?? {}),
    manual_trade_transactions: transactionFilePath,
    ...(normalizedKinds.has("buy") ? { manual_buy_transactions: transactionFilePath } : {})
  };
  if (note) {
    rawSnapshot.recognition_notes = Array.isArray(rawSnapshot.recognition_notes)
      ? rawSnapshot.recognition_notes
      : [];
    if (!rawSnapshot.recognition_notes.includes(note)) {
      rawSnapshot.recognition_notes.push(note);
    }
  }

  if (!rawSnapshot.snapshot_date) {
    rawSnapshot.snapshot_date = tradeDate;
  }

  await writeJsonAtomic(rawPath, rawSnapshot);
  return rawPath;
}

export async function updateStateManifestManualTradePointer({
  portfolioRoot,
  transactionFilePath,
  tradeKinds = ["buy"]
}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readJsonOrNull(manifestPath);
  if (!manifest) {
    return null;
  }

  const normalizedKinds = new Set(
    (tradeKinds ?? []).map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
  );
  await updateJsonFileAtomically(manifestPath, (current) => ({
    ...(current ?? {}),
    canonical_entrypoints: {
      ...((current ?? {}).canonical_entrypoints ?? {}),
      manual_trade_transactions: transactionFilePath,
      ...(normalizedKinds.has("buy") ? { manual_buy_transactions: transactionFilePath } : {})
    }
  }));
  return manifestPath;
}

export async function updateStateManifestManualBuyPointer({ portfolioRoot, transactionFilePath }) {
  return updateStateManifestManualTradePointer({
    portfolioRoot,
    transactionFilePath,
    tradeKinds: ["buy"]
  });
}

export async function loadRecorderLookup({ portfolioRoot, latestState, watchlist }) {
  const positions = Array.isArray(latestState?.positions) ? latestState.positions : [];
  const pendingPositions = Array.isArray(latestState?.pending_profit_effective_positions)
    ? latestState.pending_profit_effective_positions
    : [];
  const watchlistItems = Array.isArray(watchlist?.watchlist) ? watchlist.watchlist : [];

  return createFundLookup({
    positions,
    pendingPositions,
    watchlistItems
  });
}

export async function loadTransactionsForDate({ portfolioRoot, tradeDate }) {
  const transactionsDir = buildPortfolioPath(portfolioRoot, "transactions");
  await mkdir(transactionsDir, { recursive: true });
  const files = await readdir(transactionsDir).catch(() => []);
  return files
    .filter(
      (name) =>
        (name.startsWith(`${tradeDate}-manual-buys`) || name.startsWith(`${tradeDate}-manual-trades`)) &&
        name.endsWith(".json")
    )
    .sort();
}

/**
 * Record a manual trade with transaction journal integration for crash recovery.
 *
 * This function wraps the three multi-file writes (transaction file, raw snapshot
 * update, state manifest pointer update) in a begin/commit/rollback journal cycle.
 * The actual writes still proceed; the journal records intent and completion so
 * that recoverJournal() can detect any interrupted operations after a crash.
 *
 * @param {object} params
 * @param {string} params.portfolioRoot
 * @param {object} params.payload - The trade transaction content.
 * @param {string} params.transactionFilePath - Resolved path for the transaction file.
 * @param {string} params.tradeDate
 * @param {Array<string>} params.tradeKinds - e.g. ["buy"], ["buy", "sell"]
 * @param {string} [params.note] - Optional note for the raw snapshot.
 * @returns {Promise<{transactionFilePath: string, rawSnapshotPath: string|null, manifestUpdatePath: string|null}>}
 */
export async function recordManualTradeWithJournal({
  portfolioRoot,
  payload,
  transactionFilePath,
  tradeDate,
  tradeKinds = ["buy"],
  note = null
}) {
  const operations = [
    { path: transactionFilePath, action: "write" },
    { path: buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json"), action: "update" },
    { path: buildPortfolioPath(portfolioRoot, "state-manifest.json"), action: "update" }
  ];
  const description = `manual_trade_recorder: ${tradeDate} ${tradeKinds.join(",")} trades -> ${path.basename(transactionFilePath)}`;

  let txId;
  try {
    txId = beginTransaction(description, operations);

    // Write the transaction file.
    await writeJson(transactionFilePath, payload);

    // Update raw snapshot related files.
    const rawSnapshotPath = await updateRawSnapshotRelatedFiles({
      portfolioRoot,
      transactionFilePath,
      tradeDate,
      note,
      tradeKinds
    });

    // Update state manifest pointer.
    const manifestUpdatePath = await updateStateManifestManualTradePointer({
      portfolioRoot,
      transactionFilePath,
      tradeKinds
    });

    commitTransaction(txId);

    return {
      transactionFilePath,
      rawSnapshotPath,
      manifestUpdatePath
    };
  } catch (error) {
    if (txId) {
      try {
        rollbackTransaction(txId, String(error?.message ?? error));
      } catch {
        // Best-effort rollback journaling; do not mask the original error.
      }
    }
    throw error;
  }
}
