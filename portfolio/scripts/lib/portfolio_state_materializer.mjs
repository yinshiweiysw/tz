import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { buildPortfolioPath, defaultPortfolioRoot } from "./account_root.mjs";
import { writeJsonAtomic } from "./atomic_json_state.mjs";
import { round } from "./format_utils.mjs";
import {
  applyBuyToHoldingCostBasis,
  applySellToHoldingCostBasis,
  ensureHoldingCostBasis,
  recalculateHoldingMetricsFromCostBasis,
  resolveHoldingCostBasis,
  transferConversionHoldingCostBasis
} from "./holding_cost_basis.mjs";
import { summarizeLedgerEntryLifecycles } from "./trade_lifecycle.mjs";
import { nextTradingDay, secondTradingDay } from "./trading_calendar.mjs";

export { round };

export function nowIso() {
  return new Date().toISOString();
}

export function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function compareDateStrings(left, right) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) {
    return 0;
  }
  return leftText.localeCompare(rightText);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  return JSON.parse(await readFile(targetPath, "utf8"));
}

async function writeJson(targetPath, payload) {
  await writeJsonAtomic(targetPath, payload);
}

export function buildDualLedgerPaths(portfolioRoot) {
  return {
    latestCompatPath: buildPortfolioPath(portfolioRoot, "latest.json"),
    latestRawPath: buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json"),
    executionLedgerPath: buildPortfolioPath(portfolioRoot, "ledger", "execution_ledger.json"),
    portfolioStatePath: buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json"),
    manifestPath: buildPortfolioPath(portfolioRoot, "state-manifest.json")
  };
}

function inferCategoryFromName(name) {
  const text = String(name ?? "");

  if (text.includes("半导体") || text.includes("芯片")) {
    return "A股主动";
  }
  if (text.includes("黄金")) {
    return "黄金";
  }
  if (text.includes("沪深300")) {
    return "A股宽基";
  }
  if (text.includes("红利")) {
    return "A股红利低波";
  }
  if (text.includes("恒生科技")) {
    return "港股科技/QDII";
  }
  if (text.includes("恒生互联网") || text.includes("港股通互联网") || text.includes("港股互联网")) {
    return "港股互联网/QDII";
  }
  if (text.includes("纳斯达克") || text.includes("海外科技")) {
    return "美股科技/QDII";
  }
  if (text.includes("标普500")) {
    return "美股指数/QDII";
  }
  if (text.includes("大宗商品")) {
    return "大宗商品/QDII";
  }
  if (text.includes("债") || text.includes("持有期混合")) {
    return "偏债混合";
  }
  if (text.includes("日本") || text.includes("日经")) {
    return "日本股市/QDII";
  }
  return "未分类";
}

const CASH_LIKE_CATEGORY_SET = new Set(["偏债混合", "债券", "货币"]);

function isCashLikePosition(position) {
  const executionType = String(position?.execution_type ?? "OTC").toUpperCase();
  const bucket = String(position?.bucket ?? "").trim().toUpperCase();
  const category = String(position?.category ?? "").trim();
  const name = String(position?.name ?? "").trim();

  if (executionType !== "OTC") {
    return false;
  }

  return (
    bucket === "CASH" ||
    CASH_LIKE_CATEGORY_SET.has(category) ||
    /债券|短债|货币|恒信债|宁景/u.test(name)
  );
}

function isLiquiditySleevePosition(position) {
  const bucket = String(position?.bucket ?? "").trim().toUpperCase();
  return bucket === "CASH" || isCashLikePosition(position);
}

function deriveCashSemantics({
  positions = [],
  summary = {},
  cashLedger = {},
  availableCash = 0
} = {}) {
  const settledCashCny = round(Number(availableCash ?? 0));
  const frozenCashCny = round(
    Number(cashLedger?.frozen_cash_cny ?? summary?.frozen_cash_cny ?? 0)
  );
  const cashReserveCny = round(
    Number(
      cashLedger?.cash_reserve_override_cny ??
        cashLedger?.cash_reserve_cny ??
        summary?.cash_reserve_cny ??
        0
    )
  );
  const cashLikeFundAssetsCny = round(
    positions
      .filter((item) => item?.status === "active" && isCashLikePosition(item))
      .reduce((sum, item) => sum + Number(item?.amount ?? 0), 0)
  );
  const liquiditySleeveAssetsCny = round(
    positions
      .filter((item) => item?.status === "active" && isLiquiditySleevePosition(item))
      .reduce((sum, item) => sum + Number(item?.amount ?? 0), 0)
  );

  return {
    settledCashCny,
    tradeAvailableCashCny: round(Math.max(settledCashCny - frozenCashCny - cashReserveCny, 0)),
    cashLikeFundAssetsCny,
    liquiditySleeveAssetsCny,
    frozenCashCny,
    cashReserveCny
  };
}

export function parseAmount(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    return round(value);
  }

  const text = String(value).replace(/,/g, "");
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return 0;
  }

  return round(Number(match[0]));
}

export function resolveFundName(trade) {
  return (
    trade?.fund_name ??
    trade?.interpreted_fund_name ??
    trade?.fund_name_user_stated ??
    trade?.to_fund_name ??
    trade?.from_fund_name ??
    null
  );
}

export function inferProfitEffectiveOn(trade, fallbackDate) {
  const executionType = String(trade?.execution_type ?? "OTC").toUpperCase();
  if (executionType === "EXCHANGE") {
    return null;
  }

  const explicit =
    trade?.profit_effective_on ??
    trade?.effective_on ??
    trade?.start_counting_profit_on ??
    null;
  if (explicit) {
    return explicit;
  }

  const tradeDate = trade?.trade_date ?? fallbackDate ?? null;
  const submittedBeforeCutoff =
    trade?.submitted_before_cutoff === true ||
    trade?.order_submitted_before_cutoff === true ||
    trade?.before_cutoff === true;
  const submittedAfterCutoff =
    trade?.submitted_before_cutoff === false ||
    trade?.order_submitted_before_cutoff === false ||
    trade?.before_cutoff === false;

  if (submittedAfterCutoff) {
    return secondTradingDay(tradeDate);
  }

  if (submittedBeforeCutoff) {
    return nextTradingDay(tradeDate);
  }

  // Default OTC assumption: if the user only reported a same-day executed fund order
  // but omitted cutoff details, keep it out of today's PnL and assume T+1 profit start.
  return nextTradingDay(tradeDate);
}

function stripCompatLatestToRawSnapshot(latest, accountId, latestCompatPath) {
  const raw = {
    account_id: latest?.account_id ?? accountId,
    snapshot_date: latest?.snapshot_date ?? formatShanghaiDate(),
    currency: latest?.currency ?? "CNY",
    source_images: cloneJson(latest?.source_images ?? []),
    summary: {
      ...(cloneJson(latest?.summary) ?? {})
    },
    raw_account_snapshot: cloneJson(latest?.raw_account_snapshot ?? {}),
    performance_snapshot: cloneJson(latest?.performance_snapshot ?? {}),
    positions: cloneJson(latest?.positions ?? []),
    exposure_summary: cloneJson(latest?.exposure_summary ?? {}),
    recognition_notes: cloneJson(latest?.recognition_notes ?? []),
    related_files: cloneJson(latest?.related_files ?? {}),
    cash_ledger: cloneJson(latest?.cash_ledger ?? {}),
    snapshot_meta: {
      source_kind: "compat_seed_from_latest",
      seeded_at: nowIso(),
      seeded_from_latest_path: latestCompatPath
    }
  };

  delete raw.summary?.dialogue_adjusted_since_last_platform_snapshot;
  delete raw.summary?.last_dialogue_merge_at;
  delete raw.related_files?.last_dialogue_merge_sources;
  delete raw.related_files?.latest_pending_materialize_backup;

  return raw;
}

function buildPendingLedgerEntryFromCompatPending(pending, index, latest, accountId, latestCompatPath) {
  const name = String(pending?.name ?? "").trim();
  const profitEffectiveOn = String(pending?.profit_effective_on ?? "").trim() || null;
  const tradeDate = String(pending?.trade_date ?? latest?.snapshot_date ?? "").trim() || null;
  const amount = round(Number(pending?.amount ?? 0));

  return {
    id: `compat-pending-seed::${index}::${name}::${profitEffectiveOn ?? "na"}`,
    account_id: latest?.account_id ?? accountId,
    type: "buy",
    status: "recorded",
    recorded_at: nowIso(),
    effective_trade_date: tradeDate,
    profit_effective_on: profitEffectiveOn,
    source: "compat_pending_migration",
    source_file: latestCompatPath,
    normalized: {
      fund_name: name,
      amount_cny: amount,
      category: pending?.category ?? inferCategoryFromName(name),
      execution_type: pending?.execution_type ?? "OTC",
      submitted_before_cutoff: pending?.submitted_before_cutoff === true,
      cutoff_time_local: pending?.cutoff_time_local ?? "15:00",
      profit_effective_on: profitEffectiveOn
    },
    original: cloneJson(pending),
    notes: [
      "Seeded from legacy latest.json pending_profit_effective_positions during dual-ledger migration."
    ]
  };
}

function buildEmptyRawSnapshot(accountId, snapshotDate) {
  return {
    account_id: accountId,
    snapshot_date: snapshotDate,
    currency: "CNY",
    source_images: [],
    summary: {
      basis: "only_current_holdings",
      total_fund_assets: 0,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 0,
      yesterday_profit: 0,
      holding_profit: 0,
      cumulative_profit: 0,
      performance_precision: "empty_seed"
    },
    raw_account_snapshot: {
      total_fund_assets: 0,
      pending_buy_confirm: 0,
      pending_sell_to_arrive: 0,
      effective_exposure_after_pending_sell: 0
    },
    performance_snapshot: {},
    positions: [],
    exposure_summary: {
      qdii_amount: 0,
      qdii_weight_pct: 0,
      hong_kong_related_amount: 0,
      hong_kong_related_weight_pct: 0,
      us_related_amount: 0,
      us_related_weight_pct: 0,
      a_share_amount: 0,
      a_share_weight_pct: 0,
      gold_amount: 0,
      gold_weight_pct: 0,
      bond_mixed_amount: 0,
      bond_mixed_weight_pct: 0,
      commodity_amount: 0,
      commodity_weight_pct: 0
    },
    recognition_notes: [
      "Dual-ledger raw snapshot initialized with empty holdings."
    ],
    related_files: {},
    cash_ledger: {
      available_cash_cny: 0,
      pending_buy_confirm_cny: 0,
      pending_sell_to_arrive_cny: 0
    },
    snapshot_meta: {
      source_kind: "empty_seed",
      seeded_at: nowIso()
    }
  };
}

function buildEmptyExecutionLedger(accountId, snapshotDate) {
  return {
    schema_version: 1,
    account_id: accountId,
    as_of_snapshot_date: snapshotDate,
    created_at: nowIso(),
    updated_at: nowIso(),
    entries: [],
    notes: [
      "Execution ledger initialized for dual-ledger architecture."
    ]
  };
}

export async function updateStateManifestForDualLedger({ portfolioRoot, paths, accountId }) {
  if (!(await fileExists(paths.manifestPath))) {
    return null;
  }

  const manifest = await readJson(paths.manifestPath);
  manifest.version = Math.max(Number(manifest?.version ?? 0), 3);
  manifest.account_id = manifest.account_id ?? accountId;
  manifest.canonical_entrypoints = {
    ...(manifest.canonical_entrypoints ?? {}),
    latest_snapshot: manifest?.canonical_entrypoints?.latest_snapshot ?? paths.latestCompatPath,
    latest_raw_snapshot: paths.latestRawPath,
    execution_ledger: paths.executionLedgerPath,
    portfolio_state: paths.portfolioStatePath,
    materialize_portfolio_state_script: buildPortfolioPath(
      defaultPortfolioRoot,
      "scripts",
      "materialize_portfolio_state.mjs"
    )
  };

  const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
  const dualLedgerNote =
    "Canonical write path is now latest_raw.json + execution_ledger.json; latest.json remains a compatibility materialized view.";
  if (!notes.includes(dualLedgerNote)) {
    notes.push(dualLedgerNote);
  }
  manifest.notes = notes;

  if (Array.isArray(manifest.workflow_rules)) {
    const workflowNote =
      "Write-side state should update latest_raw.json and/or execution_ledger.json first, then regenerate portfolio_state.json and latest.json via the materializer.";
    if (!manifest.workflow_rules.includes(workflowNote)) {
      manifest.workflow_rules.push(workflowNote);
    }
  }

  await writeJson(paths.manifestPath, manifest);
  return manifest;
}

export async function ensureMaterializationFiles({
  portfolioRoot,
  accountId,
  seedMissing = true
}) {
  const paths = buildDualLedgerPaths(portfolioRoot);
  await mkdir(path.dirname(paths.latestRawPath), { recursive: true });
  await mkdir(path.dirname(paths.executionLedgerPath), { recursive: true });
  await mkdir(path.dirname(paths.portfolioStatePath), { recursive: true });

  const changes = [];
  const compatExists = await fileExists(paths.latestCompatPath);
  const compatLatest = compatExists ? await readJson(paths.latestCompatPath) : null;
  const snapshotDate = compatLatest?.snapshot_date ?? formatShanghaiDate();

  if (!(await fileExists(paths.latestRawPath))) {
    const payload =
      seedMissing && compatLatest
        ? stripCompatLatestToRawSnapshot(compatLatest, accountId, paths.latestCompatPath)
        : buildEmptyRawSnapshot(accountId, snapshotDate);
    await writeJson(paths.latestRawPath, payload);
    changes.push({
      action: "created_latest_raw_snapshot",
      path: paths.latestRawPath,
      source: compatLatest ? "seed_from_latest_compat" : "empty_seed"
    });
  }

  if (!(await fileExists(paths.executionLedgerPath))) {
    const payload = buildEmptyExecutionLedger(accountId, snapshotDate);
    const compatPending = Array.isArray(compatLatest?.pending_profit_effective_positions)
      ? compatLatest.pending_profit_effective_positions
      : [];
    if (seedMissing && compatPending.length > 0) {
      payload.entries = compatPending.map((item, index) =>
        buildPendingLedgerEntryFromCompatPending(item, index, compatLatest, accountId, paths.latestCompatPath)
      );
      payload.notes.push(
        `Seeded ${compatPending.length} pending OTC buy events from legacy latest.json compatibility state.`
      );
    }
    payload.updated_at = nowIso();
    await writeJson(paths.executionLedgerPath, payload);
    changes.push({
      action: "created_execution_ledger",
      path: paths.executionLedgerPath,
      seededPendingEntries: payload.entries.length
    });
  }

  if (!(await fileExists(paths.portfolioStatePath))) {
    changes.push({
      action: "portfolio_state_missing_requires_materialization",
      path: paths.portfolioStatePath
    });
  }

  await updateStateManifestForDualLedger({ portfolioRoot, paths, accountId });

  return { paths, changes };
}

function recalcRate(position) {
  if (ensureHoldingCostBasis(position) !== null) {
    recalculateHoldingMetricsFromCostBasis(position, {
      amount: Number(position.amount ?? 0)
    });
    return position;
  }

  const amount = Number(position.amount ?? 0);
  const pnl = Number(position.holding_pnl ?? 0);
  const estimatedCost = amount - pnl;

  if (!estimatedCost || !Number.isFinite(estimatedCost)) {
    position.holding_pnl_rate_pct = 0;
    return position;
  }

  position.holding_pnl_rate_pct = round((pnl / estimatedCost) * 100);
  return position;
}

function ensureActivePosition(positions, name, normalized = {}) {
  const existing = positions.find((item) => item.name === name);
  if (existing) {
    return existing;
  }

  const created = {
    name,
    amount: 0,
    daily_pnl: 0,
    holding_pnl: 0,
    holding_pnl_rate_pct: 0,
    holding_cost_basis_cny: 0,
    category: normalized?.category ?? inferCategoryFromName(name),
    status: "active",
    execution_type: normalized?.execution_type ?? "OTC"
  };

  if (normalized?.code) {
    created.code = normalized.code;
    created.symbol = normalized.symbol ?? normalized.code;
    created.fund_code = normalized.fund_code ?? normalized.code;
  }
  positions.push(created);
  return created;
}

function ensureExchangePosition(positions, normalized = {}) {
  const symbol = String(normalized?.symbol ?? normalized?.code ?? normalized?.ticker ?? "").trim();
  const name = String(normalized?.fund_name ?? normalized?.name ?? symbol).trim();
  const existing = positions.find((item) => {
    const itemSymbol = String(item?.symbol ?? item?.code ?? item?.ticker ?? "").trim();
    return (symbol && itemSymbol === symbol) || (name && item?.name === name);
  });
  if (existing) {
    return existing;
  }

  const created = {
    name,
    symbol: symbol || null,
    code: symbol || null,
    ticker: symbol || null,
    amount: 0,
    shares: 0,
    sellable_shares: 0,
    cost_price: 0,
    daily_pnl: 0,
    holding_pnl: 0,
    holding_pnl_rate_pct: 0,
    category: normalized?.category ?? inferCategoryFromName(name),
    status: "active",
    execution_type: "EXCHANGE",
    settlement_rule: normalized?.settlement_rule ?? "T+1"
  };
  positions.push(created);
  return created;
}

function applyBuy(positions, entry) {
  const normalized = entry?.normalized ?? {};
  const executionType = String(normalized?.execution_type ?? "OTC").toUpperCase();
  const skipHoldingCostBasis = entry?.skipHoldingCostBasis === true;

  if (executionType === "EXCHANGE") {
    const position = ensureExchangePosition(positions, normalized);
    const quantity = Math.max(Math.round(Number(normalized?.quantity ?? 0)), 0);
    const avgPrice = Number(
      normalized?.actual_avg_price ??
        normalized?.price_hint ??
        (quantity > 0 ? Number(normalized?.actual_notional_cny ?? 0) / quantity : 0)
    );
    const oldShares = Math.max(Math.round(Number(position.shares ?? 0)), 0);
    const oldSellable = Math.max(Math.round(Number(position.sellable_shares ?? 0)), 0);
    const oldCostPrice = Number(position.cost_price ?? 0) || 0;
    const newShares = oldShares + quantity;
    const totalCost = oldCostPrice * oldShares + avgPrice * quantity;
    const newCostPrice = newShares > 0 ? totalCost / newShares : 0;
    const settlementRule = String(
      normalized?.settlement_rule ?? position?.settlement_rule ?? "T+1"
    ).toUpperCase();
    const newSellable = settlementRule === "T+0" ? newShares : oldSellable;
    const amount = round(
      Number(normalized?.actual_notional_cny ?? (newShares > 0 ? newShares * avgPrice : 0))
    );

    position.name = String(normalized?.fund_name ?? position.name ?? "").trim() || position.name;
    position.symbol = normalized?.symbol ?? normalized?.code ?? position.symbol ?? null;
    position.code = normalized?.code ?? normalized?.symbol ?? position.code ?? null;
    position.ticker = normalized?.ticker ?? normalized?.symbol ?? normalized?.code ?? position.ticker ?? null;
    position.amount = amount;
    position.shares = newShares;
    position.sellable_shares = newSellable;
    position.cost_price = round(newCostPrice, 4);
    position.category = position.category ?? normalized?.category ?? inferCategoryFromName(position.name);
    position.status = newShares > 0 ? "active" : "user_confirmed_sold";
    position.execution_type = "EXCHANGE";
    position.settlement_rule = settlementRule;
    position.dialogue_merge_status = "materialized_from_execution_ledger";

    return {
      action: "buy",
      name: position.name,
      amount,
      quantity,
      entryId: entry?.id ?? null
    };
  }

  const name = String(normalized?.fund_name ?? "").trim();
  const amount = round(Number(normalized?.amount_cny ?? 0));
  if (!name || amount <= 0) {
    return null;
  }

  const position = ensureActivePosition(positions, name, normalized);
  position.amount = round(Number(position.amount ?? 0) + amount);
  if (!skipHoldingCostBasis) {
    applyBuyToHoldingCostBasis(position, amount);
  }
  position.status = "active";
  position.category = position.category ?? normalized?.category ?? inferCategoryFromName(name);
  position.dialogue_merge_status = "materialized_from_execution_ledger";
  if (normalized?.execution_type) {
    position.execution_type = normalized.execution_type;
  }
  if (normalized?.code) {
    position.code = normalized.code;
    position.symbol = normalized.symbol ?? normalized.code;
    position.fund_code = normalized.fund_code ?? normalized.code;
  }
  recalcRate(position);

  return {
    action: "buy",
    name,
    amount,
    entryId: entry?.id ?? null
  };
}

function applySell(positions, entry) {
  const normalized = entry?.normalized ?? {};
  const executionType = String(normalized?.execution_type ?? "OTC").toUpperCase();
  const skipHoldingCostBasis = entry?.skipHoldingCostBasis === true;

  if (executionType === "EXCHANGE") {
    const position = ensureExchangePosition(positions, normalized);
    const quantity = Math.max(Math.round(Number(normalized?.quantity ?? 0)), 0);
    const avgPrice = Number(
      normalized?.actual_avg_price ??
        normalized?.price_hint ??
        (quantity > 0 ? Number(normalized?.actual_notional_cny ?? 0) / quantity : 0)
    );
    const oldShares = Math.max(Math.round(Number(position.shares ?? 0)), 0);
    const oldSellable = Math.max(Math.round(Number(position.sellable_shares ?? 0)), 0);
    const settlementRule = String(
      normalized?.settlement_rule ?? position?.settlement_rule ?? "T+1"
    ).toUpperCase();
    const actualQuantity = Math.min(quantity, oldShares);
    const newShares = Math.max(oldShares - actualQuantity, 0);
    const newSellable = settlementRule === "T+0" ? newShares : Math.max(oldSellable - actualQuantity, 0);
    const amount = round(Number(normalized?.actual_notional_cny ?? actualQuantity * avgPrice));
    const previousAmount = round(Number(position.amount ?? 0));

    position.amount = newShares > 0 ? round(newShares * avgPrice) : 0;
    position.shares = newShares;
    position.sellable_shares = newSellable;
    position.execution_type = "EXCHANGE";
    position.settlement_rule = settlementRule;
    position.dialogue_merge_status = "materialized_from_execution_ledger";

    if (newShares === 0) {
      position.status = "user_confirmed_sold";
      position.last_seen_amount = previousAmount;
      position.sold_confirmed_by_user_on = entry?.effective_trade_date ?? null;
      position.daily_pnl = 0;
      position.holding_pnl = 0;
      position.holding_pnl_rate_pct = 0;
    } else {
      position.status = "active";
    }

    return {
      action: "sell",
      name: position.name,
      amount,
      quantity: actualQuantity,
      remaining: position.amount,
      entryId: entry?.id ?? null
    };
  }

  const name = String(normalized?.fund_name ?? "").trim();
  const amount = round(Number(normalized?.amount_cny ?? 0));
  if (!name || amount <= 0) {
    return null;
  }

  const position = positions.find((item) => item.name === name);
  if (!position) {
    return {
      action: "sell_skipped_missing_position",
      name,
      amount,
      entryId: entry?.id ?? null
    };
  }

  const previousAmount = Number(position.amount ?? 0);
  if (previousAmount <= 0) {
    return {
      action: "sell_skipped_empty_position",
      name,
      amount,
      entryId: entry?.id ?? null
    };
  }

  const remaining = Math.max(round(previousAmount - amount), 0);
  const factor = previousAmount > 0 ? remaining / previousAmount : 0;
  if (!skipHoldingCostBasis) {
    if (entryReflectsTradeInRawSnapshot(entry)) {
      const currentCostBasis = resolveHoldingCostBasis(position);
      if (currentCostBasis !== null) {
        position.holding_cost_basis_cny = round(Math.max(currentCostBasis - amount, 0));
      }
    } else {
      applySellToHoldingCostBasis(position, {
        soldAmount: amount,
        previousAmount
      });
    }
  }
  position.amount = remaining;
  position.daily_pnl = round(Number(position.daily_pnl ?? 0) * factor);
  position.dialogue_merge_status = "materialized_from_execution_ledger";

  if (remaining === 0) {
    position.status = "user_confirmed_sold";
    position.last_seen_amount = previousAmount;
    position.sold_confirmed_by_user_on = entry?.effective_trade_date ?? null;
    position.daily_pnl = 0;
    position.holding_pnl = 0;
    position.holding_pnl_rate_pct = 0;
  } else {
    position.status = "active";
    recalcRate(position);
  }

  return {
    action: "sell",
    name,
    amount,
    remaining,
    entryId: entry?.id ?? null
  };
}

function applyConversion(positions, entry) {
  const normalized = entry?.normalized ?? {};
  const results = [];

  if (String(normalized?.execution_type ?? "OTC").toUpperCase() !== "EXCHANGE") {
    const fromName = String(normalized?.from_fund_name ?? "").trim();
    const toName = String(normalized?.to_fund_name ?? "").trim();
    const fromAmount = round(Number(normalized?.from_amount_cny ?? 0));
    const toAmount = round(Number(normalized?.to_amount_cny ?? 0));
    const fromPosition = fromName ? ensureActivePosition(positions, fromName, normalized) : null;
    const toPosition = toName
      ? ensureActivePosition(positions, toName, {
          ...normalized,
          fund_name: toName,
          category: inferCategoryFromName(toName)
        })
      : null;

    if (fromPosition && fromAmount > 0) {
      ensureHoldingCostBasis(fromPosition);
    }
    if (toPosition) {
      ensureHoldingCostBasis(toPosition);
    }

    if (fromPosition && toPosition && toAmount > 0) {
      transferConversionHoldingCostBasis({
        fromPosition,
        toPosition,
        fromAmount,
        toAmount
      });
    }
  }

  if (normalized?.from_fund_name && Number(normalized?.from_amount_cny ?? 0) > 0) {
    results.push(
      applySell(positions, {
        ...entry,
        skipHoldingCostBasis: true,
        normalized: {
          fund_name: normalized.from_fund_name,
          amount_cny: normalized.from_amount_cny
        }
      })
    );
  }

  if (normalized?.to_fund_name && Number(normalized?.to_amount_cny ?? 0) > 0) {
    results.push(
      applyBuy(positions, {
        ...entry,
        skipHoldingCostBasis: true,
        normalized: {
          fund_name: normalized.to_fund_name,
          amount_cny: normalized.to_amount_cny,
          category: inferCategoryFromName(normalized.to_fund_name),
          execution_type: normalized.execution_type ?? "OTC"
        }
      })
    );
  }

  return results.filter(Boolean).map((result) => ({
    ...result,
    action: `${result.action}_via_conversion`
  }));
}

function computeExposureSummary(positions) {
  const activePositions = (positions ?? []).filter(
    (item) => item?.status === "active" && Number(item?.amount ?? 0) > 0
  );
  const totalFundAssets = round(activePositions.reduce((sum, item) => sum + Number(item.amount ?? 0), 0));
  const exposure = {
    qdii_amount: 0,
    hong_kong_related_amount: 0,
    us_related_amount: 0,
    a_share_amount: 0,
    gold_amount: 0,
    bond_mixed_amount: 0,
    commodity_amount: 0
  };

  for (const position of activePositions) {
    const amount = Number(position.amount ?? 0);
    const category = String(position.category ?? "");

    if (category.includes("QDII")) {
      exposure.qdii_amount += amount;
    }
    if (category.startsWith("港股")) {
      exposure.hong_kong_related_amount += amount;
    }
    if (category.startsWith("美股") || category.startsWith("海外科技")) {
      exposure.us_related_amount += amount;
    }
    if (category.startsWith("A股")) {
      exposure.a_share_amount += amount;
    }
    if (category === "黄金") {
      exposure.gold_amount += amount;
    }
    if (category === "偏债混合") {
      exposure.bond_mixed_amount += amount;
    }
    if (category.includes("大宗商品")) {
      exposure.commodity_amount += amount;
    }
  }

  return {
    qdii_amount: round(exposure.qdii_amount),
    qdii_weight_pct: totalFundAssets > 0 ? round((exposure.qdii_amount / totalFundAssets) * 100) : 0,
    hong_kong_related_amount: round(exposure.hong_kong_related_amount),
    hong_kong_related_weight_pct:
      totalFundAssets > 0 ? round((exposure.hong_kong_related_amount / totalFundAssets) * 100) : 0,
    us_related_amount: round(exposure.us_related_amount),
    us_related_weight_pct: totalFundAssets > 0 ? round((exposure.us_related_amount / totalFundAssets) * 100) : 0,
    a_share_amount: round(exposure.a_share_amount),
    a_share_weight_pct: totalFundAssets > 0 ? round((exposure.a_share_amount / totalFundAssets) * 100) : 0,
    gold_amount: round(exposure.gold_amount),
    gold_weight_pct: totalFundAssets > 0 ? round((exposure.gold_amount / totalFundAssets) * 100) : 0,
    bond_mixed_amount: round(exposure.bond_mixed_amount),
    bond_mixed_weight_pct:
      totalFundAssets > 0 ? round((exposure.bond_mixed_amount / totalFundAssets) * 100) : 0,
    commodity_amount: round(exposure.commodity_amount),
    commodity_weight_pct:
      totalFundAssets > 0 ? round((exposure.commodity_amount / totalFundAssets) * 100) : 0
  };
}

function buildOtcCompatibilityView(portfolioState) {
  const otcPositions = cloneJson(
    (portfolioState?.positions ?? []).filter(
      (item) => String(item?.execution_type ?? "OTC").toUpperCase() !== "EXCHANGE" && item?.status === "active"
    )
  );
  const otcPendingPositions = cloneJson(
    (portfolioState?.pending_profit_effective_positions ?? []).filter(
      (item) => String(item?.execution_type ?? "OTC").toUpperCase() !== "EXCHANGE"
    )
  );
  const totalFundAssets = round(otcPositions.reduce((sum, item) => sum + Number(item?.amount ?? 0), 0));
  const pendingBuyConfirm = round(otcPendingPositions.reduce((sum, item) => sum + Number(item?.amount ?? 0), 0));
  const totalDailyPnl = round(otcPositions.reduce((sum, item) => sum + Number(item?.daily_pnl ?? 0), 0));
  const totalHoldingPnl = round(otcPositions.reduce((sum, item) => sum + Number(item?.holding_pnl ?? 0), 0));
  const pendingSellToArrive = round(Number(portfolioState?.summary?.pending_sell_to_arrive ?? 0));
  const availableCash = round(
    Number(portfolioState?.cash_ledger?.available_cash_cny ?? portfolioState?.summary?.available_cash_cny ?? 0)
  );
  const cashSemantics = deriveCashSemantics({
    positions: otcPositions,
    summary: portfolioState?.summary ?? {},
    cashLedger: portfolioState?.cash_ledger ?? {},
    availableCash
  });

  const latestCompat = cloneJson(portfolioState);
  latestCompat.positions = otcPositions;
  latestCompat.pending_profit_effective_positions = otcPendingPositions;
  latestCompat.summary = {
    ...(cloneJson(portfolioState?.summary) ?? {}),
    total_fund_assets: totalFundAssets,
    pending_buy_confirm: pendingBuyConfirm,
    effective_exposure_after_pending_sell: totalFundAssets,
    yesterday_profit: totalDailyPnl,
    holding_profit: totalHoldingPnl,
    unrealized_holding_profit_cny: totalHoldingPnl,
    settled_cash_cny: cashSemantics.settledCashCny,
    trade_available_cash_cny: cashSemantics.tradeAvailableCashCny,
    cash_like_fund_assets_cny: cashSemantics.cashLikeFundAssetsCny,
    liquidity_sleeve_assets_cny: cashSemantics.liquiditySleeveAssetsCny,
    total_portfolio_assets_cny: round(totalFundAssets + availableCash + pendingBuyConfirm + pendingSellToArrive),
  };
  latestCompat.performance_snapshot = {
    ...(cloneJson(portfolioState?.performance_snapshot) ?? {}),
    daily_mark_to_market_profit_cny: totalDailyPnl,
    unrealized_holding_profit_cny: totalHoldingPnl,
    pending_profit_effective_cny: pendingBuyConfirm,
    settled_cash_cny: cashSemantics.settledCashCny,
    projected_settled_cash_cny: round(availableCash + pendingSellToArrive),
    trade_available_cash_cny: cashSemantics.tradeAvailableCashCny,
    cash_like_fund_assets_cny: cashSemantics.cashLikeFundAssetsCny,
    liquidity_sleeve_assets_cny: cashSemantics.liquiditySleeveAssetsCny,
  };
  latestCompat.exposure_summary = computeExposureSummary(otcPositions);
  latestCompat.compatibility_view = {
    source: "portfolio_state_materializer",
    generated_at: nowIso(),
    scope: "otc_only",
    excluded_exchange_positions: (portfolioState?.positions ?? []).filter(
      (item) => String(item?.execution_type ?? "OTC").toUpperCase() === "EXCHANGE"
    ).length,
    excluded_non_active_positions: (portfolioState?.positions ?? []).filter((item) => item?.status !== "active").length,
  };
  return latestCompat;
}

function buildPendingPosition(entry) {
  const normalized = entry?.normalized ?? {};
  return {
    name: normalized?.fund_name ?? null,
    amount: round(Number(normalized?.amount_cny ?? 0)),
    category: normalized?.category ?? inferCategoryFromName(normalized?.fund_name ?? ""),
    status: "pending_profit_effective",
    execution_type: normalized?.execution_type ?? "OTC",
    trade_date: entry?.effective_trade_date ?? null,
    submitted_before_cutoff: normalized?.submitted_before_cutoff === true,
    cutoff_time_local: normalized?.cutoff_time_local ?? "15:00",
    profit_effective_on: entry?.profit_effective_on ?? normalized?.profit_effective_on ?? null,
    code: normalized?.code ?? normalized?.fund_code ?? normalized?.symbol ?? null,
    symbol: normalized?.symbol ?? normalized?.code ?? normalized?.fund_code ?? null,
    fund_code: normalized?.fund_code ?? normalized?.code ?? normalized?.symbol ?? null,
    source: entry?.source ?? "execution_ledger",
    source_files: entry?.source_file ? [entry.source_file] : [],
    ledger_entry_id: entry?.id ?? null,
    created_at: entry?.recorded_at ?? nowIso(),
    interpretation_basis:
      entry?.original?.interpretation_basis ?? entry?.original?.amount_interpretation ?? null
  };
}

function dedupeExecutionEntries(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries ?? []) {
    const key = String(entry?.id ?? "").trim()
      ? `id:${String(entry.id).trim()}`
      : [
          entry?.type ?? "",
          entry?.effective_trade_date ?? "",
          entry?.source_file ?? "",
          JSON.stringify(entry?.normalized ?? {})
        ].join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function sortExecutionEntries(entries) {
  return dedupeExecutionEntries(entries).sort((left, right) => {
    const leftDate = String(left?.effective_trade_date ?? "");
    const rightDate = String(right?.effective_trade_date ?? "");
    if (leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }

    const leftRecorded = String(left?.recorded_at ?? "");
    const rightRecorded = String(right?.recorded_at ?? "");
    if (leftRecorded !== rightRecorded) {
      return leftRecorded.localeCompare(rightRecorded);
    }

    return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
  });
}

function shouldOverlayLedgerEntry(rawSnapshotDate, entry) {
  const rawDate = String(rawSnapshotDate ?? "").trim();
  const effectiveTradeDate = String(entry?.effective_trade_date ?? "").trim();
  if (!rawDate || !effectiveTradeDate) {
    return true;
  }
  if (compareDateStrings(rawDate, effectiveTradeDate) <= 0) {
    return true;
  }

  return !entryReflectsTradeInRawSnapshot(entry);
}

function entryReflectsTradeInRawSnapshot(entry) {
  return (
    entry?.normalized?.raw_snapshot_includes_trade === true ||
    entry?.original?.raw_snapshot_includes_trade === true ||
    entry?.normalized?.platform_snapshot_includes_trade === true ||
    entry?.original?.platform_snapshot_includes_trade === true
  );
}

function shouldUnwindSameDayRawEntry(rawSnapshotDate, entry) {
  const rawDate = String(rawSnapshotDate ?? "").trim();
  const effectiveTradeDate = String(entry?.effective_trade_date ?? "").trim();
  const executionType = String(entry?.normalized?.execution_type ?? "OTC").toUpperCase();

  if (!rawDate || !effectiveTradeDate) {
    return false;
  }

  return (
    ["buy", "sell", "conversion"].includes(String(entry?.type ?? "").trim()) &&
    executionType !== "EXCHANGE" &&
    rawDate === effectiveTradeDate &&
    entryReflectsTradeInRawSnapshot(entry)
  );
}

function findRawPositionForLedgerFund(positions, normalized = {}) {
  const code = String(normalized?.code ?? normalized?.fund_code ?? normalized?.symbol ?? "").trim();
  const name = String(
    normalized?.fund_name ?? normalized?.from_fund_name ?? normalized?.to_fund_name ?? ""
  ).trim();

  return (
    positions.find((item) => {
      const itemCode = String(item?.code ?? item?.fund_code ?? item?.symbol ?? "").trim();
      const itemName = String(item?.name ?? "").trim();
      return (code && itemCode === code) || (name && itemName === name);
    }) ?? null
  );
}

function adjustPositionForRawUnwind(position, targetAmount) {
  const previousAmount = round(Number(position?.amount ?? 0));
  const nextAmount = Math.max(round(Number(targetAmount ?? 0)), 0);
  const deltaAmount = round(nextAmount - previousAmount);
  const currentCostBasis = resolveHoldingCostBasis(position);
  position.amount = nextAmount;

  if (currentCostBasis !== null && deltaAmount !== 0) {
    position.holding_cost_basis_cny = round(Math.max(currentCostBasis + deltaAmount, 0));
  }

  if (previousAmount > 0 && nextAmount > 0) {
    recalcRate(position);
    return;
  }

  if (nextAmount <= 0) {
    position.daily_pnl = 0;
    position.holding_pnl = 0;
    position.holding_pnl_rate_pct = 0;
    position.holding_cost_basis_cny = 0;
    return;
  }

  recalcRate(position);
}

function ensureUnwindTargetPosition(positions, normalized = {}, nameOverride = null) {
  const position = findRawPositionForLedgerFund(positions, {
    ...normalized,
    fund_name: nameOverride ?? normalized?.fund_name ?? normalized?.from_fund_name ?? normalized?.to_fund_name ?? null
  });
  if (position) {
    return position;
  }

  const name = String(
    nameOverride ?? normalized?.fund_name ?? normalized?.from_fund_name ?? normalized?.to_fund_name ?? ""
  ).trim();
  if (!name) {
    return null;
  }

  return ensureActivePosition(positions, name, {
    ...normalized,
    fund_name: name
  });
}

function unwindSameDayRawBuyReflection(positions, entry) {
  const normalized = entry?.normalized ?? {};
  const amount = round(Number(normalized?.amount_cny ?? 0));
  const position = findRawPositionForLedgerFund(positions, normalized);

  if (!position || amount <= 0) {
    return {
      unwound: false,
      cashUnwind: 0,
      pendingSellArrivalUnwind: 0,
      warning: `Entry ${entry?.id ?? "unknown"} marked raw_snapshot_includes_trade=true but no matching raw position was found.`
    };
  }

  const previousAmount = round(Number(position.amount ?? 0));
  const adjustedAmount = Math.max(round(previousAmount - amount), 0);
  position.amount = adjustedAmount;
  const currentCostBasis = resolveHoldingCostBasis(position);
  if (currentCostBasis !== null) {
    position.holding_cost_basis_cny = round(Math.max(currentCostBasis - amount, 0));
  }
  if (adjustedAmount <= 0) {
    position.daily_pnl = 0;
    position.holding_pnl = 0;
    position.holding_pnl_rate_pct = 0;
    position.holding_cost_basis_cny = 0;
  } else {
    recalcRate(position);
  }

  return {
    unwound: true,
    cashUnwind: round(-Number(normalized?.cash_effect_cny ?? -amount)),
    pendingSellArrivalUnwind: round(-Number(normalized?.pending_sell_to_arrive_cny ?? 0)),
    positionName: position.name,
    amount,
    kind: "buy"
  };
}

function unwindSameDayRawSellReflection(positions, entry) {
  const normalized = entry?.normalized ?? {};
  const amount = round(Number(normalized?.amount_cny ?? 0));
  const position = ensureUnwindTargetPosition(positions, normalized);

  if (!position || amount <= 0) {
    return {
      unwound: false,
      cashUnwind: 0,
      pendingSellArrivalUnwind: 0,
      warning: `Entry ${entry?.id ?? "unknown"} marked raw_snapshot_includes_trade=true but sell unwind could not resolve a position.`
    };
  }

  const previousAmount = round(Number(position.amount ?? 0));
  const restoredAmount = round(previousAmount + amount);
  adjustPositionForRawUnwind(position, restoredAmount);

  return {
    unwound: true,
    cashUnwind: round(-Number(normalized?.cash_effect_cny ?? 0)),
    pendingSellArrivalUnwind: round(-Number(normalized?.pending_sell_to_arrive_cny ?? 0)),
    positionName: position.name,
    amount,
    kind: "sell"
  };
}

function unwindSameDayRawConversionReflection(positions, entry) {
  const normalized = entry?.normalized ?? {};
  const fromAmount = round(Number(normalized?.from_amount_cny ?? 0));
  const toAmount = round(Number(normalized?.to_amount_cny ?? 0));
  const fromPosition = ensureUnwindTargetPosition(positions, normalized, normalized?.from_fund_name ?? null);
  const toPosition = ensureUnwindTargetPosition(positions, normalized, normalized?.to_fund_name ?? null);
  const warnings = [];

  if (!fromPosition || fromAmount <= 0) {
    warnings.push(
      `Entry ${entry?.id ?? "unknown"} marked raw_snapshot_includes_trade=true but conversion unwind could not restore source position.`
    );
  } else {
    const restoredFromAmount = round(Number(fromPosition.amount ?? 0) + fromAmount);
    adjustPositionForRawUnwind(fromPosition, restoredFromAmount);
  }

  if (!toPosition || toAmount <= 0) {
    warnings.push(
      `Entry ${entry?.id ?? "unknown"} marked raw_snapshot_includes_trade=true but conversion unwind could not locate target position.`
    );
  } else {
    const adjustedToAmount = Math.max(round(Number(toPosition.amount ?? 0) - toAmount), 0);
    adjustPositionForRawUnwind(toPosition, adjustedToAmount);
  }

  if ((!fromPosition || fromAmount <= 0) && (!toPosition || toAmount <= 0)) {
    return {
      unwound: false,
      cashUnwind: 0,
      pendingSellArrivalUnwind: 0,
      warning: warnings.join(" ")
    };
  }

  return {
    unwound: true,
    cashUnwind: round(-Number(normalized?.cash_effect_cny ?? 0)),
    pendingSellArrivalUnwind: round(-Number(normalized?.pending_sell_to_arrive_cny ?? 0)),
    positionName: `${normalized?.from_fund_name ?? "unknown"} -> ${normalized?.to_fund_name ?? "unknown"}`,
    amount: fromAmount || toAmount,
    kind: "conversion",
    warning: warnings.filter(Boolean).join(" ") || null
  };
}

function deriveRawAccountSnapshot(rawSnapshot) {
  return (
    cloneJson(rawSnapshot?.raw_account_snapshot) ?? {
      total_fund_assets: round(Number(rawSnapshot?.summary?.total_fund_assets ?? 0)),
      pending_buy_confirm: round(Number(rawSnapshot?.summary?.pending_buy_confirm ?? 0)),
      pending_sell_to_arrive: round(Number(rawSnapshot?.summary?.pending_sell_to_arrive ?? 0)),
      effective_exposure_after_pending_sell: round(
        Number(rawSnapshot?.summary?.effective_exposure_after_pending_sell ?? rawSnapshot?.summary?.total_fund_assets ?? 0)
      )
    }
  );
}

export function materializePortfolioStateFromInputs({
  rawSnapshot,
  executionLedger,
  accountId,
  portfolioRoot,
  referenceDate,
  paths
}) {
  const raw = cloneJson(rawSnapshot ?? {});
  const effectiveDate = referenceDate || raw?.snapshot_date || formatShanghaiDate();
  const positions = cloneJson(raw?.positions ?? []);
  positions.forEach((position) => ensureHoldingCostBasis(position));
  const pendingPositions = [];
  const sortedEntries = sortExecutionEntries(Array.isArray(executionLedger?.entries) ? executionLedger.entries : []);
  const overlayEntries = [];
  const rawSnapshotDate = String(raw?.snapshot_date ?? "").trim();
  const materialization = {
    generated_at: nowIso(),
    reference_date: effectiveDate,
    raw_snapshot_date: raw?.snapshot_date ?? null,
    ledger_entries_total: sortedEntries.length,
    applied_operations: [],
    raw_snapshot_unwinds: [],
    pending_entry_ids: [],
    activated_entry_ids: [],
    warnings: []
  };
  let ledgerCashDelta = 0;
  let ledgerPendingSellArrivalDelta = 0;
  let rawCashReflectionUnwind = 0;
  let rawPendingSellArrivalReflectionUnwind = 0;

  for (const entry of sortedEntries) {
    if (!shouldUnwindSameDayRawEntry(rawSnapshotDate, entry)) {
      continue;
    }

    let unwindResult = null;
    if (entry?.type === "buy") {
      unwindResult = unwindSameDayRawBuyReflection(positions, entry);
    } else if (entry?.type === "sell") {
      unwindResult = unwindSameDayRawSellReflection(positions, entry);
    } else if (entry?.type === "conversion") {
      unwindResult = unwindSameDayRawConversionReflection(positions, entry);
    }

    if (!unwindResult) {
      continue;
    }

    if (unwindResult.warning) {
      materialization.warnings.push(unwindResult.warning);
    }

    if (!unwindResult.unwound) {
      continue;
    }

    rawCashReflectionUnwind += Number(unwindResult.cashUnwind ?? 0);
    rawPendingSellArrivalReflectionUnwind += Number(unwindResult.pendingSellArrivalUnwind ?? 0);
    materialization.raw_snapshot_unwinds.push({
      entryId: entry?.id ?? null,
      kind: unwindResult.kind ?? entry?.type ?? null,
      name: unwindResult.positionName ?? null,
      amount: round(Number(unwindResult.amount ?? 0))
    });
  }

  for (const entry of sortedEntries) {
    if (String(entry?.status ?? "").trim() === "cancelled") {
      continue;
    }

    if (!shouldOverlayLedgerEntry(raw?.snapshot_date, entry)) {
      materialization.warnings.push(
        `Entry ${entry?.id ?? "unknown"} skipped because raw snapshot date ${raw?.snapshot_date ?? "unknown"} is newer than trade date ${entry?.effective_trade_date ?? "unknown"}.`
      );
      continue;
    }

    overlayEntries.push(entry);
    ledgerCashDelta += Number(entry?.normalized?.cash_effect_cny ?? 0);
    ledgerPendingSellArrivalDelta += Number(entry?.normalized?.pending_sell_to_arrive_cny ?? 0);

    if (entry?.type === "buy") {
      const shouldRemainPending =
        Boolean(entry?.profit_effective_on) &&
        Boolean(effectiveDate) &&
        compareDateStrings(entry.profit_effective_on, effectiveDate) > 0;

      if (shouldRemainPending) {
        pendingPositions.push(buildPendingPosition(entry));
        materialization.pending_entry_ids.push(entry?.id ?? null);
        continue;
      }

      const result = applyBuy(positions, entry);
      if (result) {
        materialization.applied_operations.push(result);
        if (entry?.profit_effective_on) {
          materialization.activated_entry_ids.push(entry?.id ?? null);
        }
      }
      continue;
    }

    if (entry?.type === "sell") {
      const result = applySell(positions, entry);
      if (result) {
        materialization.applied_operations.push(result);
      }
      continue;
    }

    if (entry?.type === "conversion") {
      const results = applyConversion(positions, entry);
      materialization.applied_operations.push(...results);
      continue;
    }

    materialization.warnings.push(`Unsupported ledger entry type: ${entry?.type ?? "unknown"}`);
  }

  const activePositions = positions.filter(
    (item) => item?.status === "active" && Number(item?.amount ?? 0) > 0
  );
  const pendingBuyConfirm = round(
    pendingPositions.reduce((sum, item) => sum + Number(item?.amount ?? 0), 0)
  );
  const totalFundAssets = round(activePositions.reduce((sum, item) => sum + Number(item?.amount ?? 0), 0));
  const totalDailyPnl = round(activePositions.reduce((sum, item) => sum + Number(item?.daily_pnl ?? 0), 0));
  const totalHoldingPnl = round(activePositions.reduce((sum, item) => sum + Number(item?.holding_pnl ?? 0), 0));
  const lastLedgerRecordedAt = overlayEntries
    .map((item) => String(item?.recorded_at ?? "").trim())
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const rawSummary = cloneJson(raw?.summary ?? {});
  const rawCashLedger = cloneJson(raw?.cash_ledger ?? {});
  const rawPerformanceSnapshot = cloneJson(raw?.performance_snapshot ?? {});
  const pendingSellToArrive = round(
    Number(rawCashLedger?.pending_sell_to_arrive_cny ?? rawSummary?.pending_sell_to_arrive ?? 0) +
      rawPendingSellArrivalReflectionUnwind +
      ledgerPendingSellArrivalDelta
  );
  const availableCash = round(
    Number(rawCashLedger?.available_cash_cny ?? rawSummary?.available_cash_cny ?? 0) +
      rawCashReflectionUnwind +
      ledgerCashDelta
  );
  const cumulativeProfitRaw = Number(rawSummary?.cumulative_profit);
  const canDeriveRealizedCumulativeProfit =
    Number.isFinite(cumulativeProfitRaw) &&
    (round(cumulativeProfitRaw) !== 0 ||
      Object.keys(rawPerformanceSnapshot ?? {}).length > 0 ||
      String(rawSummary?.last_user_reported_profit_update_at ?? "").trim().length > 0);
  const cumulativeProfit = canDeriveRealizedCumulativeProfit ? round(cumulativeProfitRaw) : null;
  const realizedCumulativeProfit =
    Number.isFinite(cumulativeProfit) ? round(cumulativeProfit - totalHoldingPnl) : null;
  const tradeLifecycleSummaryRaw = summarizeLedgerEntryLifecycles(overlayEntries, effectiveDate);
  const tradeLifecycleSummary = {
    reference_date: effectiveDate,
    total_entries: overlayEntries.length,
    counts_by_stage: tradeLifecycleSummaryRaw.countsByStage,
    amounts_by_stage: tradeLifecycleSummaryRaw.amountsByStage
  };

  const summary = {
    ...rawSummary,
    total_fund_assets: totalFundAssets,
    pending_buy_confirm: pendingBuyConfirm,
    pending_sell_to_arrive: pendingSellToArrive,
    effective_exposure_after_pending_sell: totalFundAssets,
    yesterday_profit: totalDailyPnl,
    holding_profit: totalHoldingPnl,
    unrealized_holding_profit_cny: totalHoldingPnl,
    realized_cumulative_profit_cny: realizedCumulativeProfit,
    performance_precision:
      overlayEntries.length > 0
        ? "materialized_from_raw_snapshot_plus_execution_ledger"
        : rawSummary?.performance_precision ?? "raw_snapshot",
    dialogue_adjusted_since_last_platform_snapshot: overlayEntries.length > 0,
    last_dialogue_merge_at: lastLedgerRecordedAt ?? rawSummary?.last_dialogue_merge_at ?? null,
    available_cash_cny: availableCash,
    settled_cash_cny: 0,
    trade_available_cash_cny: 0,
    cash_like_fund_assets_cny: 0,
    liquidity_sleeve_assets_cny: 0,
    total_portfolio_assets_cny: round(
      totalFundAssets + availableCash + pendingBuyConfirm + pendingSellToArrive
    )
  };
  const cashSemantics = deriveCashSemantics({
    positions,
    summary,
    cashLedger: rawCashLedger,
    availableCash
  });
  summary.settled_cash_cny = cashSemantics.settledCashCny;
  summary.trade_available_cash_cny = cashSemantics.tradeAvailableCashCny;
  summary.cash_like_fund_assets_cny = cashSemantics.cashLikeFundAssetsCny;
  summary.liquidity_sleeve_assets_cny = cashSemantics.liquiditySleeveAssetsCny;

  const exposureSummary = computeExposureSummary(positions);
  const recognitionNotes = Array.isArray(raw?.recognition_notes) ? [...raw.recognition_notes] : [];
  if (overlayEntries.length > 0) {
    recognitionNotes.push(
      `当前策略状态由 raw snapshot + execution_ledger 物化生成：共叠加 ${overlayEntries.length} 笔执行事件，其中 ${pendingPositions.length} 笔仍处于待收益生效状态。`
    );
  }
  if (materialization.raw_snapshot_unwinds.length > 0) {
    const unwindKinds = [...new Set(materialization.raw_snapshot_unwinds.map((item) => item.kind).filter(Boolean))];
    recognitionNotes.push(
      `已将 ${materialization.raw_snapshot_unwinds.length} 笔同日已被 raw snapshot 反映的交易先行拆出（${unwindKinds.join(" / ")}），再按 execution_ledger 单次重建，避免重复计仓或重复计现金。`
    );
  }

  const cashLedger = {
    ...rawCashLedger,
    available_cash_cny: availableCash,
    settled_cash_cny: cashSemantics.settledCashCny,
    trade_available_cash_cny: cashSemantics.tradeAvailableCashCny,
    cash_like_fund_assets_cny: cashSemantics.cashLikeFundAssetsCny,
    liquidity_sleeve_assets_cny: cashSemantics.liquiditySleeveAssetsCny,
    frozen_cash_cny: cashSemantics.frozenCashCny,
    cash_reserve_cny: cashSemantics.cashReserveCny,
    pending_buy_confirm_cny: pendingBuyConfirm,
    pending_sell_to_arrive_cny: pendingSellToArrive,
    deployed_pending_profit_effective_cny: pendingBuyConfirm,
    projected_settled_cash_cny: round(availableCash + pendingSellToArrive),
    execution_ledger_pending_cash_arrival_cny: round(
      Number(tradeLifecycleSummaryRaw.amountsByStage.platform_confirmed_pending_cash_arrival ?? 0)
    ),
    execution_ledger_cash_arrived_cny: round(
      Number(tradeLifecycleSummaryRaw.amountsByStage.cash_arrived ?? 0)
    )
  };
  const performanceSnapshot = {
    ...(rawPerformanceSnapshot ?? {}),
    daily_mark_to_market_profit_cny: totalDailyPnl,
    unrealized_holding_profit_cny: totalHoldingPnl,
    realized_cumulative_profit_cny: realizedCumulativeProfit,
    cumulative_profit_cny: cumulativeProfit,
    pending_profit_effective_cny: pendingBuyConfirm,
    pending_sell_settlement_cny: pendingSellToArrive,
    settled_cash_cny: cashSemantics.settledCashCny,
    projected_settled_cash_cny: round(availableCash + pendingSellToArrive),
    trade_available_cash_cny: cashSemantics.tradeAvailableCashCny,
    cash_like_fund_assets_cny: cashSemantics.cashLikeFundAssetsCny,
    liquidity_sleeve_assets_cny: cashSemantics.liquiditySleeveAssetsCny,
    accounting_basis: Number.isFinite(cumulativeProfit)
      ? "realized_cumulative_profit_cny = cumulative_profit_cny - unrealized_holding_profit_cny"
      : "unrealized_holding_profit_cny derived from active positions; realized cumulative unavailable because raw summary.cumulative_profit is missing"
  };

  const relatedFiles = {
    ...(cloneJson(raw?.related_files ?? {}) ?? {}),
    latest_snapshot: paths.latestCompatPath,
    latest_raw_snapshot: paths.latestRawPath,
    execution_ledger: paths.executionLedgerPath,
    portfolio_state: paths.portfolioStatePath
  };

  const portfolioState = {
    account_id: raw?.account_id ?? accountId,
    snapshot_date: raw?.snapshot_date ?? null,
    strategy_effective_date: effectiveDate,
    currency: raw?.currency ?? "CNY",
    source_images: cloneJson(raw?.source_images ?? []),
    summary,
    raw_account_snapshot: deriveRawAccountSnapshot(raw),
    performance_snapshot: performanceSnapshot,
    positions,
    pending_profit_effective_positions: pendingPositions,
    exposure_summary: exposureSummary,
    recognition_notes: recognitionNotes,
    related_files: relatedFiles,
    cash_ledger: cashLedger,
    trade_lifecycle_summary: tradeLifecycleSummary,
    raw_snapshot_meta: cloneJson(raw?.snapshot_meta ?? {}),
    materialization
  };
  if (overlayEntries.length > 0) {
    portfolioState.materialization.snapshot_boundary_note =
      "portfolio_state reflects latest_raw.json plus execution_ledger overlays; latest_raw.json remains the platform/raw snapshot boundary.";
  }

  const latestCompat = buildOtcCompatibilityView(portfolioState);

  return {
    portfolioState,
    latestCompat,
    stats: {
      referenceDate: effectiveDate,
      rawSnapshotDate: raw?.snapshot_date ?? null,
      ledgerEntriesTotal: sortedEntries.length,
      overlayEntriesApplied: overlayEntries.length,
      appliedOperations: materialization.applied_operations.length,
      pendingEntries: pendingPositions.length,
      activatedEntries: materialization.activated_entry_ids.length,
      totalFundAssets,
      pendingBuyConfirm
    }
  };
}

export function createLedgerEntriesFromTransactionContent({
  content,
  filePath,
  accountId,
  recordedAt = nowIso()
}) {
  const snapshotDate = content?.snapshot_date ?? null;
  const entries = [];
  const buildTradeId = (type, index, original) => {
    const tradeDate = String(original?.trade_date ?? snapshotDate ?? "").trim() || "na";
    if (type === "conversion") {
      const fromKey = String(
        original?.from_fund_code ?? original?.from_fund_name ?? original?.from_fund_name_user_stated ?? "na"
      ).trim();
      const toKey = String(
        original?.to_fund_code ?? original?.to_fund_name ?? original?.to_fund_name_user_stated ?? "na"
      ).trim();
      const amount = parseAmount(original?.to_amount_cny ?? original?.from_amount_cny ?? original?.amount_cny);
      return `${filePath}::${type}::${tradeDate}::${fromKey}->${toKey}::${amount}::${index}`;
    }

    const securityKey = String(
      original?.fund_code ??
        original?.code ??
        original?.symbol ??
        original?.interpreted_fund_name ??
        original?.fund_name_user_stated ??
        "na"
    ).trim();
    const amount = parseAmount(original?.amount_cny ?? original?.amount_or_shares);
    return `${filePath}::${type}::${tradeDate}::${securityKey}::${amount}::${index}`;
  };
  const pushEntry = (type, index, original, normalized) => {
    entries.push({
      id: `${filePath}::${type}::${index}`,
      trade_id: buildTradeId(type, index, original),
      account_id: accountId,
      type,
      status: "recorded",
      recorded_at: recordedAt,
      effective_trade_date: original?.trade_date ?? snapshotDate,
      profit_effective_on: type === "buy" ? inferProfitEffectiveOn(original, snapshotDate) : null,
      source: content?.source ?? "manual_transaction_file",
      source_file: filePath,
      normalized,
      original: cloneJson(original)
    });
  };

  for (const [index, trade] of (content?.executed_buy_transactions ?? []).entries()) {
    const name = resolveFundName(trade);
    pushEntry("buy", index, trade, {
      fund_name: name,
      amount_cny: parseAmount(trade?.amount_cny),
      category: trade?.category ?? inferCategoryFromName(name),
      execution_type: trade?.execution_type ?? "OTC",
      code: trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null,
      fund_code: trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null,
      symbol: trade?.symbol ?? trade?.fund_code ?? trade?.code ?? null,
      source_confidence: trade?.source_confidence ?? null,
      fund_identity: cloneJson(trade?.fund_identity ?? null),
      bucket_key: trade?.bucket_key ?? null,
      theme_key: trade?.theme_key ?? null,
      submitted_before_cutoff:
        trade?.submitted_before_cutoff === true ||
        trade?.order_submitted_before_cutoff === true ||
        trade?.before_cutoff === true,
      cutoff_time_local: trade?.cutoff_time_local ?? "15:00",
      profit_effective_on: inferProfitEffectiveOn(trade, snapshotDate),
      cash_effect_cny: -parseAmount(trade?.amount_cny),
      raw_snapshot_includes_trade:
        trade?.raw_snapshot_includes_trade === true ||
        trade?.platform_snapshot_includes_trade === true
    });
  }

  for (const [index, trade] of (content?.executed_sell_transactions ?? []).entries()) {
    const name = resolveFundName(trade);
    pushEntry("sell", index, trade, {
      fund_name: name,
      amount_cny: parseAmount(trade?.amount_cny ?? trade?.amount_or_shares),
      execution_type: trade?.execution_type ?? "OTC",
      code: trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null,
      fund_code: trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null,
      symbol: trade?.symbol ?? trade?.fund_code ?? trade?.code ?? null,
      source_confidence: trade?.source_confidence ?? null,
      fund_identity: cloneJson(trade?.fund_identity ?? null),
      bucket_key: trade?.bucket_key ?? null,
      theme_key: trade?.theme_key ?? null,
      cash_effect_cny:
        trade?.cash_arrived === true
          ? parseAmount(trade?.amount_cny ?? trade?.amount_or_shares)
          : 0,
      pending_sell_to_arrive_cny:
        trade?.cash_arrived === false
          ? parseAmount(trade?.amount_cny ?? trade?.amount_or_shares)
          : 0,
      raw_snapshot_includes_trade:
        trade?.raw_snapshot_includes_trade === true ||
        trade?.platform_snapshot_includes_trade === true
    });
  }

  for (const [index, trade] of (content?.executed_conversion_transactions ?? []).entries()) {
    pushEntry("conversion", index, trade, {
      from_fund_name: trade?.from_fund_name ?? null,
      to_fund_name: trade?.to_fund_name ?? null,
      from_amount_cny: parseAmount(trade?.from_amount_cny ?? trade?.amount_cny),
      to_amount_cny: parseAmount(trade?.to_amount_cny ?? trade?.amount_cny),
      execution_type: trade?.execution_type ?? "OTC",
      source_confidence: trade?.source_confidence ?? null,
      from_fund_identity: cloneJson(trade?.from_fund_identity ?? null),
      to_fund_identity: cloneJson(trade?.to_fund_identity ?? null),
      from_bucket_key: trade?.from_bucket_key ?? null,
      to_bucket_key: trade?.to_bucket_key ?? null,
      from_theme_key: trade?.from_theme_key ?? null,
      to_theme_key: trade?.to_theme_key ?? null,
      raw_snapshot_includes_trade:
        trade?.raw_snapshot_includes_trade === true ||
        trade?.platform_snapshot_includes_trade === true
    });
  }

  return entries;
}

export function appendEntriesToExecutionLedger(ledger, entries) {
  const existingIds = new Set((ledger?.entries ?? []).map((item) => item?.id).filter(Boolean));
  const appended = [];
  const skipped = [];

  ledger.entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  for (const entry of entries) {
    if (!entry?.id || existingIds.has(entry.id)) {
      skipped.push(entry?.id ?? null);
      continue;
    }
    ledger.entries.push(entry);
    existingIds.add(entry.id);
    appended.push(entry.id);
  }

  ledger.updated_at = nowIso();
  return { appended, skipped };
}

export async function materializePortfolioRoot({
  portfolioRoot,
  accountId,
  referenceDate = "",
  seedMissing = true
}) {
  const ensured = await ensureMaterializationFiles({ portfolioRoot, accountId, seedMissing });
  const { paths } = ensured;
  const rawSnapshot = await readJson(paths.latestRawPath);
  const executionLedger = await readJson(paths.executionLedgerPath);
  const materialized = materializePortfolioStateFromInputs({
    rawSnapshot,
    executionLedger,
    accountId,
    portfolioRoot,
    referenceDate: String(referenceDate ?? "").trim() || rawSnapshot?.snapshot_date || formatShanghaiDate(),
    paths
  });
  const stampedExecutionLedger = cloneJson(executionLedger);
  stampedExecutionLedger.as_of_snapshot_date = materialized.portfolioState.snapshot_date ?? null;
  stampedExecutionLedger.updated_at = nowIso();
  if (materialized.portfolioState?.materialization?.snapshot_boundary_note) {
    stampedExecutionLedger.notes = Array.isArray(stampedExecutionLedger.notes)
      ? stampedExecutionLedger.notes
      : [];
    const note = materialized.portfolioState.materialization.snapshot_boundary_note;
    if (!stampedExecutionLedger.notes.includes(note)) {
      stampedExecutionLedger.notes.push(note);
    }
  }

  await writeJson(paths.executionLedgerPath, stampedExecutionLedger);
  await writeJson(paths.portfolioStatePath, materialized.portfolioState);
  await writeJson(paths.latestCompatPath, materialized.latestCompat);

  return {
    paths,
    ...materialized,
    ensuredChanges: ensured.changes
  };
}
