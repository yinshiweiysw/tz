import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { getFundQuotes } from "../../market-mcp/src/providers/fund.js";
import { getStockQuote } from "../../market-mcp/src/providers/stock.js";
import {
  buildPortfolioPath,
  listDiscoveredPortfolioAccounts,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import {
  buildDualLedgerPaths,
  inferProfitEffectiveOn,
  materializePortfolioRoot
} from "./lib/portfolio_state_materializer.mjs";
import {
  applyCanonicalFundIdentity,
  getFundIdentityAliases,
  normalizeFundName
} from "./lib/fund_identity.mjs";
import { resolveFundMarketSessionPolicy } from "./lib/fund_market_session_policy.mjs";
import {
  applyTodayPnlToBaseValue,
  coercePersistedTodayPnl,
  deriveEstimatedPnlDisplay,
  deriveOvernightCarryDisplay,
  deriveTodayPnlDisplay,
  resolveLatestConfirmedLabel,
  resolveDisplayedDailyChangePct,
  shouldUseConfirmedSnapshotDisplay,
  shouldApplyEstimatedPnlOverlay,
  summarizeObservationTodayPnl,
  summarizeTodayPnl
} from "./lib/live_dashboard_today_pnl.mjs";
import { deriveDashboardAccountingSummary } from "./lib/dashboard_accounting_summary.mjs";
import {
  classifyFundConfirmation,
  summarizeFundConfirmationStates
} from "./lib/fund_confirmation_policy.mjs";
import { findPreviousTradingDateBefore } from "./lib/market_schedule_guard.mjs";
import {
  buildPortfolioStatePaths,
  loadCanonicalPortfolioState,
  pathExists,
  readJsonOrNull
} from "./lib/portfolio_state_view.mjs";
import {
  buildCanonicalPortfolioView,
  selectCanonicalPortfolioPayload
} from "./lib/portfolio_canonical_view.mjs";
import {
  deriveCanonicalHoldingSnapshot,
  resolveHoldingCostBasis
} from "./lib/holding_cost_basis.mjs";
import {
  readNightlyConfirmedNavStatus,
  resolveNightlyConfirmedNavReadiness
} from "./lib/nightly_confirmed_nav_status.mjs";
import { round } from "./lib/format_utils.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8766;
const defaultRefreshMs = 30_000;
const cacheTtlMs = 15_000;
let activePortfolioRoot = resolvePortfolioRoot();
let activeAccountId = resolveAccountId();
const cachedPayloads = new Map();
const inflightPayloadPromises = new Map();

const manualFundCodeHints = {
  [normalizeName("景顺长城纳斯达克科技市值加权ETF联接(QDII)E")]: {
    code: "019118",
    name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
    aliases: [
      "景顺长城纳斯达克科技ETF联接(QDII)E人民币"
    ]
  },
  [normalizeName("华安三菱日联日经225ETF联接(QDII)A")]: {
    code: "020712",
    name: "华安三菱日联日经225ETF联接(QDII)A",
    aliases: [
      "华安三菱日联日经225ETF发起式联接(QDII)A"
    ]
  }
};

function parseArgs(argv) {
  const result = {
    host: defaultHost,
    port: defaultPort,
    refreshMs: defaultRefreshMs,
    open: false
  };

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

  result.port = Number(result.port) || defaultPort;
  result.refreshMs = Number(result.refreshMs) || defaultRefreshMs;
  result.open = Boolean(result.open);
  return result;
}

function parseAmountValue(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? round(value) : 0;
  }
  const text = String(value).replaceAll(",", "");
  const match = text.match(/-?\d+(\.\d+)?/);
  return match ? round(Number(match[0])) : 0;
}

function toNumberOrNull(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric, digits) : null;
}

function computeNetValueDriftPct(quote) {
  const valuation = Number(quote?.valuation);
  const netValue = Number(quote?.netValue);
  if (!Number.isFinite(valuation) || !Number.isFinite(netValue) || valuation <= 0 || netValue <= 0) {
    return null;
  }

  const valuationTime = String(quote?.valuationTime ?? "").trim();
  if (!/\b\d{2}:\d{2}\b/.test(valuationTime)) {
    return null;
  }

  return toNumberOrNull(((valuation - netValue) / netValue) * 100);
}

function formatDateInShanghai(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function compareDateStrings(left, right) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) {
    return 0;
  }
  return leftText.localeCompare(rightText);
}

function normalizeName(name) {
  return normalizeFundName(name);
}

function resolveTradeFundName(trade) {
  return String(
    trade?.interpreted_fund_name ??
      trade?.fund_name ??
      trade?.fund_name_user_stated ??
      trade?.name ??
      trade?.to_fund_name ??
      trade?.from_fund_name ??
      ""
  ).trim();
}

function resolveExpectedProfitEffectiveOn(trade, fallbackDate = null) {
  const explicit = String(
    trade?.profit_effective_on ??
      trade?.effective_on ??
      trade?.start_counting_profit_on ??
      ""
  ).trim();
  if (explicit) {
    return explicit;
  }
  return String(inferProfitEffectiveOn(trade, fallbackDate) ?? "").trim() || null;
}

function createProfitLockRegistry() {
  return {
    byCode: new Map(),
    byName: new Map(),
    items: []
  };
}

function addProfitLock(registry, { code = null, name = null, amount = 0, profitEffectiveOn = null, source = null }) {
  const lockedAmount = Number(amount);
  if (!Number.isFinite(lockedAmount) || lockedAmount <= 0) {
    return;
  }

  const codeKey = String(code ?? "").trim();
  const nameKey = normalizeName(name);
  const existing =
    (codeKey ? registry.byCode.get(codeKey) : null) ??
    (nameKey ? registry.byName.get(nameKey) : null) ??
    null;

  const target =
    existing ??
    {
      code: codeKey || null,
      name: String(name ?? "").trim() || null,
      lockedAmount: 0,
      profitEffectiveOn: profitEffectiveOn ?? null,
      source: source ?? null
    };

  target.lockedAmount = round(Number(target.lockedAmount ?? 0) + lockedAmount);
  target.profitEffectiveOn =
    String(target.profitEffectiveOn ?? "").trim() ||
    String(profitEffectiveOn ?? "").trim() ||
    null;
  target.source = target.source ?? source ?? null;

  if (!existing) {
    registry.items.push(target);
  }
  if (codeKey) {
    registry.byCode.set(codeKey, target);
  }
  if (nameKey) {
    registry.byName.set(nameKey, target);
  }
}

async function loadProfitLockRegistry(portfolioRoot, today) {
  const registry = createProfitLockRegistry();
  const paths = buildDualLedgerPaths(portfolioRoot);
  const ledger = await readJson(paths.executionLedgerPath).catch(() => null);
  const ledgerEntries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const usableLedgerEntries = ledgerEntries.filter((entry) => {
    if (String(entry?.type ?? "").toLowerCase() !== "buy") {
      return false;
    }
    const executionType = String(entry?.normalized?.execution_type ?? "OTC").toUpperCase();
    const profitEffectiveOn = resolveExpectedProfitEffectiveOn(
      entry?.original ?? entry?.normalized ?? {},
      entry?.effective_trade_date ?? today
    );
    return executionType !== "EXCHANGE" && profitEffectiveOn && compareDateStrings(profitEffectiveOn, today) > 0;
  });

  if (usableLedgerEntries.length > 0) {
    for (const entry of usableLedgerEntries) {
      addProfitLock(registry, {
        code: entry?.normalized?.fund_code ?? entry?.normalized?.code ?? entry?.normalized?.symbol ?? null,
        name:
          entry?.normalized?.fund_name ??
          resolveTradeFundName(entry?.original) ??
          null,
        amount: parseAmountValue(entry?.normalized?.amount_cny),
        profitEffectiveOn: resolveExpectedProfitEffectiveOn(
          entry?.original ?? entry?.normalized ?? {},
          entry?.effective_trade_date ?? today
        ),
        source: "execution_ledger"
      });
    }
    return registry;
  }

  const transactionsDir = buildPortfolioPath(portfolioRoot, "transactions");
  const files = await readdir(transactionsDir).catch(() => []);
  for (const fileName of files.filter((name) => name.endsWith(".json") && name.includes("-manual-")).sort()) {
    const filePath = buildPortfolioPath(transactionsDir, fileName);
    const payload = await readJson(filePath).catch(() => null);
    if (!payload) {
      continue;
    }
    const status = String(payload?.status ?? "");
    if (status.startsWith("merged_into_execution_ledger")) {
      continue;
    }
    for (const trade of Array.isArray(payload?.executed_buy_transactions) ? payload.executed_buy_transactions : []) {
      const profitEffectiveOn = resolveExpectedProfitEffectiveOn(
        trade,
        trade?.trade_date ?? payload?.snapshot_date ?? today
      );
      const executionType = String(trade?.execution_type ?? "OTC").toUpperCase();
      if (!profitEffectiveOn || compareDateStrings(profitEffectiveOn, today) <= 0 || executionType === "EXCHANGE") {
        continue;
      }
      addProfitLock(registry, {
        code: trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null,
        name: resolveTradeFundName(trade),
        amount: parseAmountValue(trade?.amount_cny),
        profitEffectiveOn,
        source: "legacy_manual_transaction_file"
      });
    }
  }

  return registry;
}

function resolveProfitLockForRow(registry, position, resolved) {
  const codeCandidates = [
    String(resolved?.code ?? "").trim(),
    String(position?.code ?? "").trim(),
    String(position?.fund_code ?? "").trim(),
    String(position?.symbol ?? "").trim()
  ].filter(Boolean);

  for (const code of codeCandidates) {
    const match = registry.byCode.get(code);
    if (match) {
      return match;
    }
  }

  const nameCandidates = [
    normalizeName(position?.name),
    normalizeName(resolved?.name)
  ].filter(Boolean);

  for (const key of nameCandidates) {
    const match = registry.byName.get(key);
    if (match) {
      return match;
    }
  }

  return null;
}

function resolveProfitLockTarget(registry, pendingPosition) {
  const codeCandidates = [
    String(pendingPosition?.code ?? "").trim(),
    String(pendingPosition?.fund_code ?? "").trim(),
    String(pendingPosition?.symbol ?? "").trim()
  ].filter(Boolean);

  for (const code of codeCandidates) {
    const match = registry.byCode.get(code);
    if (match) {
      return match;
    }
  }

  const normalizedName = normalizeName(pendingPosition?.name);
  if (normalizedName) {
    return registry.byName.get(normalizedName) ?? null;
  }

  return null;
}

function reconcileProfitLockRegistryWithPendingPositions(registry, pendingPositions) {
  for (const pending of pendingPositions) {
    const match = resolveProfitLockTarget(registry, pending);
    if (!match) {
      continue;
    }

    const pendingAmount = Number(pending?.amount ?? 0);
    if (!Number.isFinite(pendingAmount) || pendingAmount <= 0) {
      continue;
    }

    match.lockedAmount = round(Math.max(Number(match.lockedAmount ?? 0) - pendingAmount, 0));
  }

  return registry;
}

function buildResolver(watchlistItems) {
  const exactByCode = new Map();
  const exact = new Map();
  const fuzzy = [];

  for (const item of watchlistItems) {
    const canonicalItem = applyCanonicalFundIdentity(item);
    const aliases = [
      ...getFundIdentityAliases(canonicalItem).map((entry) => entry?.name),
      ...(Array.isArray(item?.aliases) ? item.aliases : [])
    ].filter(Boolean);
    const resolved = {
      code: canonicalItem.code ?? item.code,
      name: canonicalItem.name ?? item.name,
      note: item.note ?? null,
      source: "watchlist"
    };
    for (const entry of getFundIdentityAliases(canonicalItem)) {
      const normalizedCode = String(entry?.code ?? "").trim();
      if (normalizedCode) {
        exactByCode.set(normalizedCode, resolved);
      }
    }
    for (const alias of aliases) {
      const normalized = normalizeName(alias);
      if (normalized) {
        exact.set(normalized, resolved);
        fuzzy.push({
          normalized,
          resolved
        });
      }
    }
  }

  for (const hint of Object.values(manualFundCodeHints)) {
    const aliases = [hint?.name, ...(Array.isArray(hint?.aliases) ? hint.aliases : [])];
    for (const alias of aliases) {
      const normalized = normalizeName(alias);
      if (normalized) {
        exact.set(normalized, {
          code: hint.code,
          name: hint.name,
          note: "manual_code_hint_for_live_dashboard",
          source: "manual_hint"
        });
        fuzzy.push({
          normalized,
          resolved: {
            code: hint.code,
            name: hint.name,
            note: "manual_code_hint_for_live_dashboard",
            source: "manual_hint"
          }
        });
      }
    }
  }

  return function resolvePosition(position) {
    const canonicalPosition = applyCanonicalFundIdentity(position);
    const rawName = String(canonicalPosition?.name ?? position?.name ?? "").trim();
    const nativeCodeCandidates = [
      canonicalPosition?.code,
      canonicalPosition?.symbol,
      canonicalPosition?.fund_code,
      position?.code,
      position?.symbol,
      position?.fund_code
    ];

    for (const code of nativeCodeCandidates) {
      const normalizedCode = String(code ?? "").trim();
      if (normalizedCode && exactByCode.has(normalizedCode)) {
        return exactByCode.get(normalizedCode);
      }
    }
    const normalizedPositionName = normalizeName(rawName);

    const exactMatch = exact.get(normalizedPositionName);
    if (exactMatch) {
      return exactMatch;
    }

    for (const item of fuzzy) {
      if (
        normalizedPositionName &&
        (normalizedPositionName.includes(item.normalized) ||
          item.normalized.includes(normalizedPositionName))
      ) {
        return item.resolved;
      }
    }

    for (const code of nativeCodeCandidates) {
      const normalizedCode = String(code ?? "").trim();
      if (normalizedCode) {
        return {
          code: normalizedCode,
          name: rawName || normalizedCode,
          note: "position_native_code_for_live_dashboard",
          source: "position"
        };
      }
    }

    return {
      code: null,
      name: rawName,
      note: null,
      source: "unmapped"
    };
  };
}

function quoteDateFromItem(quote) {
  const valuationTime = String(quote?.intradayValuationTime ?? quote?.valuationTime ?? "").trim();
  const match = valuationTime.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match?.[1]) {
    return match[1];
  }

  return String(quote?.confirmedNavDate ?? quote?.netValueDate ?? "").trim() || null;
}

function deriveLedgerDailyChangePct(position, amount) {
  const explicitDailyReturnPct = toNumberOrNull(position?.daily_return_pct);
  if (explicitDailyReturnPct !== null) {
    return explicitDailyReturnPct;
  }

  const amountRaw = Number(amount ?? NaN);
  const dailyPnlRaw = Number(position?.daily_pnl ?? NaN);
  if (!Number.isFinite(amountRaw) || !Number.isFinite(dailyPnlRaw)) {
    return null;
  }

  const previousAmountRaw = amountRaw - dailyPnlRaw;
  if (!(previousAmountRaw > 0)) {
    return null;
  }

  return toNumberOrNull((dailyPnlRaw / previousAmountRaw) * 100);
}

function buildRow(position, resolved, quote, today, profitLock = null, options = {}) {
  const canonicalSnapshot = deriveCanonicalHoldingSnapshot(position, {
    nav: quote?.confirmedNav ?? quote?.netValue
  });
  const amount = Number(canonicalSnapshot.amountCny ?? position?.amount ?? 0);
  const confirmedUnits = Number(canonicalSnapshot.units ?? position?.confirmed_units ?? NaN);
  const sessionPolicy =
    options?.sessionPolicy ?? resolveFundMarketSessionPolicy({ asset: options?.assetMeta, position });
  const now = options?.now ?? new Date();
  const profitLockedAmountRaw = Math.max(
    0,
    Math.min(Number(profitLock?.lockedAmount ?? 0), Number.isFinite(amount) ? amount : 0)
  );
  const eligibleAmountRaw = Math.max(amount - profitLockedAmountRaw, 0);
  const confirmedChangePct = resolveDisplayedDailyChangePct({
    valuationChangePercent: quote?.valuationChangePercent,
    growthRate: quote?.growthRate
  });
  const observationKind = String(quote?.observationKind ?? "").trim() || null;
  const intradayChangePct = toNumberOrNull(
    quote?.intradayChangePercent ?? quote?.valuationChangePercent
  );
  const intradayQuoteDate = quoteDateFromItem(quote);
  const intradayUpdateTime = quote?.intradayValuationTime ?? quote?.valuationTime ?? null;
  const estimatedDisplay = deriveEstimatedPnlDisplay({
    quoteDate: intradayQuoteDate,
    today,
    updateTime: intradayUpdateTime,
    sessionPolicy,
    now,
    observationKind,
    intradayChangePct,
    estimatedDailyPnl:
      Number.isFinite(intradayChangePct) && Number.isFinite(eligibleAmountRaw)
        ? round((eligibleAmountRaw * intradayChangePct) / 100)
        : null
  });
  const quoteFresh = estimatedDisplay.quoteFresh;
  const quoteCurrent = estimatedDisplay.quoteCurrent;
  const quoteMode = estimatedDisplay.quoteMode;
  const updateTime =
    ((quoteMode === "live_estimate" || quoteMode === "close_reference") ? intradayUpdateTime : null) ??
    (quote?.confirmedNavDate ?? quote?.netValueDate ? `${quote?.confirmedNavDate ?? quote?.netValueDate} 净值` : null);
  const valuation = toNumberOrNull(
    quoteCurrent ? quote?.intradayValuation ?? quote?.valuation : quote?.confirmedNav ?? quote?.netValue,
    4
  );
  const confirmedDailyPnl =
    Number.isFinite(confirmedChangePct) && Number.isFinite(eligibleAmountRaw)
      ? round((eligibleAmountRaw * confirmedChangePct) / 100)
      : null;
  const estimateDriftPct = computeNetValueDriftPct(quote);
  const estimateDriftPnl =
    Number.isFinite(estimateDriftPct) && Number.isFinite(eligibleAmountRaw)
      ? round((eligibleAmountRaw * estimateDriftPct) / 100)
      : null;
  const resolvedCostBasis = canonicalSnapshot.costBasisCny ?? resolveHoldingCostBasis(position);
  const costBasis = toNumberOrNull(resolvedCostBasis);
  const holdingPnl = toNumberOrNull(canonicalSnapshot.holdingPnlCny ?? position?.holding_pnl);
  const holdingPnlRatePct =
    toNumberOrNull(canonicalSnapshot.holdingPnlRatePct ?? position?.holding_pnl_rate_pct) ??
    (Number.isFinite(holdingPnl) && Number.isFinite(costBasis) && Number(costBasis) > 0
      ? toNumberOrNull((Number(holdingPnl) / Number(costBasis)) * 100)
      : null);
  const quoteDate = quoteDateFromItem(quote);
  const confirmedNavDate = String(
    quote?.confirmedNavDate ?? quote?.netValueDate ?? position?.last_confirmed_nav_date ?? ""
  ).trim() || null;
  const todayPnlDisplay = deriveTodayPnlDisplay({
    quoteDate,
    today,
    updateTime,
    sessionPolicy,
    now,
    confirmedChangePct,
    confirmedDailyPnl
  });
  const ledgerDailyPnl = toNumberOrNull(position?.daily_pnl);
  const ledgerDailyChangePct = deriveLedgerDailyChangePct(position, amount);
  const displayedChangePct = estimatedDisplay.displayedChangePct;
  const displayedDailyPnl = estimatedDisplay.displayedDailyPnl;

  return {
    name: resolved?.name ?? position?.name ?? "未命名基金",
    code: resolved?.code ?? null,
    amount: toNumberOrNull(amount),
    confirmedUnits: Number.isFinite(confirmedUnits) && confirmedUnits > 0 ? round(confirmedUnits, 8) : null,
    valuation,
    changePct: displayedChangePct,
    estimatedPnl: displayedDailyPnl,
    intradayQuoteDate,
    intradayUpdateTime,
    intradayChangePct: toNumberOrNull(intradayChangePct),
    intradayEstimatedPnl:
      Number.isFinite(intradayChangePct) && Number.isFinite(eligibleAmountRaw)
        ? toNumberOrNull(round((eligibleAmountRaw * intradayChangePct) / 100))
        : null,
    confirmedChangePct: todayPnlDisplay.displayedChangePct,
    confirmedDailyPnl: todayPnlDisplay.displayedDailyPnl,
    ledgerDailyPnl,
    ledgerDailyChangePct,
    estimateDriftPct,
    estimateDriftPnl: toNumberOrNull(estimateDriftPnl),
    updateTime,
    quoteDate,
    confirmedNavDate,
    confirmedNav: toNumberOrNull(quote?.confirmedNav ?? quote?.netValue, 4),
    latestConfirmedLabel: resolveLatestConfirmedLabel({
      quoteMode,
      confirmedNavDate
    }),
    observationKind,
    quoteFresh,
    quoteCurrent,
    quoteMode,
    sessionPolicy,
    mappingSource: resolved?.source ?? "unmapped",
    holdingPnl,
    holdingPnlRatePct,
    costBasis,
    category: position?.category ?? "--",
    dialogueMergeStatus: position?.dialogue_merge_status ?? null,
    profitLockedAmount: toNumberOrNull(profitLockedAmountRaw),
    todayPnlEligibleAmount: toNumberOrNull(eligibleAmountRaw),
    todayPnlLocked: profitLockedAmountRaw > 0,
    profitEffectiveOn: profitLock?.profitEffectiveOn ?? position?.profit_effective_on ?? null,
    profitLockSource: profitLock?.source ?? null,
    referenceSymbol: null,
    referenceName: null,
    referenceSource: null,
    referenceQuoteTime: null,
    referenceChangePct: null,
    referenceEstimatedPnl: null
  };
}

function buildPendingRow(pending, resolved, quote, today) {
  return {
    ...buildRow(
      {
        ...pending,
        amount: pending?.amount ?? 0,
        holding_pnl: 0
      },
      resolved,
      quote,
      today
    ),
    pendingStatus: pending?.status ?? "pending_profit_effective",
    profitEffectiveOn: pending?.profit_effective_on ?? null
  };
}

function resolveConfirmationTone(state) {
  if (state === "late_missing" || state === "source_missing") {
    return "warn";
  }
  if (state === "normal_lag" || state === "holiday_delay") {
    return "flat";
  }
  return "flat";
}

export function deriveFundCardPresentation(row = {}) {
  const confirmationState = String(row?.confirmationState ?? "").trim();
  const sessionProfile = String(row?.sessionPolicy?.profile ?? "").trim();
  const confirmedNavDate = String(row?.confirmedNavDate ?? "").trim();
  const overnightCarryReferenceDate = String(row?.overnightCarryReferenceDate ?? "").trim();
  const hasOvernightCarry = Number.isFinite(Number(row?.overnightCarryPnl));
  const isQdiiLagged =
    sessionProfile === "global_qdii" &&
    (confirmationState === "normal_lag" || confirmationState === "holiday_delay");
  const shouldShowHardConfirmationBadge =
    confirmationState === "late_missing" || confirmationState === "source_missing";

  return {
    cardLatestConfirmedLabel:
      isQdiiLagged && confirmedNavDate
        ? `确认净值 ${confirmedNavDate}`
        : row?.latestConfirmedLabel ?? null,
    cardOvernightCarryLabel:
      hasOvernightCarry
        ? overnightCarryReferenceDate
          ? `待确认收益 · ${overnightCarryReferenceDate}`
          : "待确认收益"
        : null,
    cardConfirmationLabel: shouldShowHardConfirmationBadge
      ? row?.confirmationLabel ?? "确认状态待补"
      : null,
    cardConfirmationTone: shouldShowHardConfirmationBadge ? row?.confirmationTone ?? "warn" : null,
    cardQuoteStatusText: isQdiiLagged ? (hasOvernightCarry ? "T+2待确认" : "最近确认净值") : null,
    cardQuoteStatusTone: isQdiiLagged ? "flat" : null
  };
}

export function annotateRowConfirmation(
  row,
  position,
  assetMeta,
  { confirmedTargetDate = null, currentDate = null, now = new Date() } = {}
) {
  const confirmation = classifyFundConfirmation({
    targetDate: confirmedTargetDate,
    confirmedNavDate: row?.confirmedNavDate ?? position?.last_confirmed_nav_date ?? null,
    asset: assetMeta,
    position,
    now
  });

  const overnightCarry = deriveOvernightCarryDisplay({
    quoteDate: row?.intradayQuoteDate ?? row?.quoteDate,
    today: currentDate,
    updateTime: row?.intradayUpdateTime ?? row?.updateTime,
    intradayChangePct: row?.intradayChangePct ?? row?.changePct ?? null,
    estimatedDailyPnl: row?.intradayEstimatedPnl ?? row?.estimatedPnl ?? null,
    pendingReferenceDate:
      row?.sessionPolicy?.profile === "global_qdii"
        ? findPreviousTradingDateBefore({
            market: "US",
            date: row?.intradayQuoteDate ?? row?.quoteDate
          })
        : null,
    expectedConfirmedDate: confirmation.expectedConfirmedDate,
    sessionPolicy: row?.sessionPolicy ?? null
  });

  return {
    ...row,
    confirmationState: confirmation.state,
    confirmationLabel: confirmation.label,
    expectedConfirmedDate: confirmation.expectedConfirmedDate,
    confirmationTone: resolveConfirmationTone(confirmation.state),
    overnightCarryChangePct: overnightCarry.overnightCarryChangePct,
    overnightCarryPnl: overnightCarry.overnightCarryPnl,
    overnightCarryLabel: overnightCarry.overnightCarryLabel,
    overnightCarryReferenceDate: overnightCarry.overnightCarryReferenceDate,
    ...deriveFundCardPresentation({
      ...row,
      confirmationState: confirmation.state,
      confirmationLabel: confirmation.label,
      confirmationTone: resolveConfirmationTone(confirmation.state),
      expectedConfirmedDate: confirmation.expectedConfirmedDate,
      overnightCarryPnl: overnightCarry.overnightCarryPnl,
      overnightCarryLabel: overnightCarry.overnightCarryLabel,
      overnightCarryReferenceDate: overnightCarry.overnightCarryReferenceDate
    })
  };
}

function buildReferenceTargetIndex(proxyConfig = null) {
  const mapping = proxyConfig?.asset_proxy_mapping ?? {};
  const result = new Map();

  for (const item of Object.values(mapping)) {
    const liveSymbol = String(item?.live_symbol ?? "").trim();
    const referenceTargets = Array.isArray(item?.reference_targets)
      ? item.reference_targets.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    if (liveSymbol && referenceTargets.length > 0) {
      result.set(liveSymbol, referenceTargets);
    }
  }

  return result;
}

function parseReferenceQuoteDate(referenceQuote = null) {
  const quoteTime = String(referenceQuote?.quoteTime ?? "").trim();
  const match = quoteTime.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function pickBestReferenceQuote(referenceTargets = [], referenceQuoteMap = new Map()) {
  const candidates = referenceTargets
    .map((target) => referenceQuoteMap.get(String(target ?? "").trim()))
    .filter((quote) => quote && Number.isFinite(Number(quote?.changePercent)));

  if (candidates.length === 0) {
    return null;
  }

  return (
    candidates.find((quote) => String(quote?.quoteTime ?? "").trim()) ??
    candidates.find((quote) => Math.abs(Number(quote?.changePercent ?? 0)) > 1e-8) ??
    candidates[0]
  );
}

export function applyReferenceFallbackToRow(row, assetMeta, referenceQuote) {
  if (String(row?.observationKind ?? "").trim() !== "confirmed_only") {
    return row;
  }

  if (!assetMeta || !referenceQuote || !Number.isFinite(Number(referenceQuote?.changePercent))) {
    return row;
  }

  const referenceChangePct = toNumberOrNull(referenceQuote.changePercent);
  const eligibleAmountRaw = Number(row?.todayPnlEligibleAmount ?? row?.amount ?? NaN);
  const referenceEstimatedPnl =
    Number.isFinite(Number(referenceChangePct)) && Number.isFinite(eligibleAmountRaw)
      ? toNumberOrNull(round((eligibleAmountRaw * Number(referenceChangePct)) / 100))
      : null;

  return {
    ...row,
    observationKind: "reference_only",
    quoteFresh: false,
    quoteCurrent: false,
    quoteMode: "reference_only",
    valuation: row?.confirmedNav ?? row?.valuation ?? null,
    changePct: referenceChangePct,
    estimatedPnl: referenceEstimatedPnl,
    updateTime: String(referenceQuote?.quoteTime ?? "").trim() || row?.updateTime || null,
    latestConfirmedLabel:
      row?.latestConfirmedLabel ??
      resolveLatestConfirmedLabel({
        quoteMode: "confirmed_nav",
        confirmedNavDate: row?.confirmedNavDate ?? null
      }),
    referenceSymbol: String(referenceQuote?.stockCode ?? "").trim() || null,
    referenceName: String(referenceQuote?.name ?? "").trim() || null,
    referenceSource: String(referenceQuote?.source ?? "").trim() || null,
    referenceQuoteTime: String(referenceQuote?.quoteTime ?? "").trim() || null,
    referenceQuoteDate: parseReferenceQuoteDate(referenceQuote),
    referenceChangePct,
    referenceEstimatedPnl
  };
}

function applyLiveQuoteOverlay(row, snapshotDate, today, options = {}) {
  const ledgerAmountRaw = Number(row?.amount ?? 0);
  const ledgerHoldingPnlRaw = Number(row?.holdingPnl ?? NaN);
  const ledgerHoldingPnlRatePctRaw = Number(row?.holdingPnlRatePct ?? NaN);
  const costBasisRaw = Number(row?.costBasis ?? NaN);
  const explicitConfirmedUnitsRaw = Number(row?.confirmedUnits ?? NaN);
  const confirmedNavRaw = Number(row?.confirmedNav ?? NaN);
  const valuationRaw = Number(row?.valuation ?? NaN);
  const inferredObservableUnitsRaw =
    Number.isFinite(explicitConfirmedUnitsRaw) && explicitConfirmedUnitsRaw > 0
      ? explicitConfirmedUnitsRaw
      : Number.isFinite(ledgerAmountRaw) &&
          ledgerAmountRaw > 0 &&
          Number.isFinite(confirmedNavRaw) &&
          confirmedNavRaw > 0
        ? ledgerAmountRaw / confirmedNavRaw
        : NaN;
  const snapshotFreshForAccounting =
    options?.snapshotFreshForAccounting ??
    (String(snapshotDate ?? "").trim() !== "" && String(snapshotDate ?? "").trim() === String(today ?? "").trim());
  const overlayAllowed = shouldApplyEstimatedPnlOverlay(
    snapshotDate,
    row?.quoteDate,
    today,
    row?.updateTime,
    {
      ...options,
      observationKind: row?.observationKind ?? null,
      sessionPolicy: row?.sessionPolicy ?? options?.sessionPolicy ?? null
    }
  );
  const overlayPnlRaw = overlayAllowed ? Number(row?.estimatedPnl ?? NaN) : NaN;
  const appliedOverlayRaw = Number.isFinite(overlayPnlRaw) ? overlayPnlRaw : 0;
  const quoteMode = String(row?.quoteMode ?? "").trim();
  const keepLedgerValuation = ["close_reference", "reference_only", "confirmed_nav", "unavailable"].includes(
    quoteMode
  );
  const canUseObservableUnits =
    Number.isFinite(inferredObservableUnitsRaw) &&
    inferredObservableUnitsRaw > 0 &&
    Number.isFinite(valuationRaw) &&
    ["live_estimate", "today_close"].includes(quoteMode);
  const observableAmountRaw = canUseObservableUnits ? round(inferredObservableUnitsRaw * valuationRaw) : NaN;
  const liveAmountRaw =
    keepLedgerValuation
      ? ledgerAmountRaw
      : Number.isFinite(observableAmountRaw)
      ? observableAmountRaw
      : overlayAllowed && row?.quoteFresh === true
      ? Number(
          applyTodayPnlToBaseValue({
            quoteDate: row?.quoteDate,
            today,
            updateTime: row?.updateTime,
            sessionPolicy: row?.sessionPolicy ?? options?.sessionPolicy ?? null,
            now: options?.now ?? new Date(),
            baseValue: ledgerAmountRaw,
            todayPnl: overlayPnlRaw
          }) ?? ledgerAmountRaw + appliedOverlayRaw
        )
      : ledgerAmountRaw + appliedOverlayRaw;
  const liveHoldingPnlRaw =
    keepLedgerValuation && Number.isFinite(ledgerHoldingPnlRaw)
      ? ledgerHoldingPnlRaw
      : Number.isFinite(costBasisRaw) && Number.isFinite(liveAmountRaw)
      ? liveAmountRaw - costBasisRaw
      : Number.isFinite(ledgerHoldingPnlRaw)
      ? ledgerHoldingPnlRaw + appliedOverlayRaw
      : NaN;

  return {
    ...row,
    ledgerAmount: toNumberOrNull(ledgerAmountRaw),
    ledgerHoldingPnl: Number.isFinite(ledgerHoldingPnlRaw)
      ? toNumberOrNull(ledgerHoldingPnlRaw)
      : null,
    ledgerHoldingPnlRatePct: Number.isFinite(ledgerHoldingPnlRatePctRaw)
      ? toNumberOrNull(ledgerHoldingPnlRatePctRaw)
      : row?.holdingPnlRatePct ?? null,
    snapshotFreshForAccounting,
    accountingOverlayAllowed: overlayAllowed,
    livePnlOverlayApplied: overlayAllowed && Number.isFinite(overlayPnlRaw),
    livePnlOverlayAmount:
      overlayAllowed && Number.isFinite(overlayPnlRaw)
        ? toNumberOrNull(overlayPnlRaw)
        : null,
    amount: toNumberOrNull(liveAmountRaw),
    holdingPnl: Number.isFinite(liveHoldingPnlRaw)
      ? toNumberOrNull(liveHoldingPnlRaw)
      : row?.holdingPnl ?? null,
    holdingPnlRatePct:
      Number.isFinite(costBasisRaw) && costBasisRaw > 0 && Number.isFinite(liveHoldingPnlRaw)
        ? toNumberOrNull((liveHoldingPnlRaw / costBasisRaw) * 100)
        : row?.holdingPnlRatePct ?? null
  };
}

function splitPendingPositionsByEffectiveDate(pendingPositions, today) {
  const effectiveToday = [];
  const future = [];

  for (const position of pendingPositions) {
    const effectiveOn = String(position?.profit_effective_on ?? "").trim();
    if (effectiveOn && compareDateStrings(effectiveOn, today) <= 0) {
      effectiveToday.push(position);
    } else {
      future.push(position);
    }
  }

  return {
    effectiveToday,
    future
  };
}

function materializePendingPositionsForLiveView(activePositions, pendingPositions) {
  const materialized = activePositions.map((position) => ({ ...position }));
  const indexByName = new Map(
    materialized.map((position, index) => [String(position?.name ?? "").trim(), index]).filter(([name]) => name)
  );

  for (const pending of pendingPositions) {
    const name = String(pending?.name ?? "").trim();
    const pendingAmount = Number(pending?.amount ?? 0);
    if (!name || !Number.isFinite(pendingAmount) || pendingAmount <= 0) {
      continue;
    }

    const currentIndex = indexByName.get(name);
    if (currentIndex === undefined) {
      materialized.push({
        ...pending,
        amount: round(pendingAmount),
        holding_pnl: 0,
        status: "active_provisional",
        dialogue_merge_status: "pending_materialized_for_live_view",
        live_pending_effective_on: pending?.profit_effective_on ?? null
      });
      indexByName.set(name, materialized.length - 1);
      continue;
    }

    const base = materialized[currentIndex];
    materialized[currentIndex] = {
      ...base,
      amount: round(Number(base?.amount ?? 0) + pendingAmount),
      live_pending_materialized_amount: round(
        Number(base?.live_pending_materialized_amount ?? 0) + pendingAmount
      ),
      live_pending_effective_on: pending?.profit_effective_on ?? base?.live_pending_effective_on ?? null,
      dialogue_merge_status: "pending_materialized_for_live_view"
    };
  }

  return materialized.sort((left, right) => Number(right?.amount ?? 0) - Number(left?.amount ?? 0));
}

export function deriveLiveDashboardPositionSets(portfolioState = {}, today = formatDateInShanghai()) {
  const activePositions = (portfolioState?.positions ?? []).filter(
    (item) =>
      item?.status === "active" &&
      item?.execution_type !== "EXCHANGE" &&
      Number(item?.amount ?? 0) > 0
  );
  const pendingPositions = (portfolioState?.pending_profit_effective_positions ?? []).filter(
    (item) => Number(item?.amount ?? 0) > 0 && item?.execution_type !== "EXCHANGE"
  );
  const { effectiveToday, future } = splitPendingPositionsByEffectiveDate(pendingPositions, today);
  const effectiveActivePositions = materializePendingPositionsForLiveView(activePositions, effectiveToday);

  return {
    activePositions,
    pendingPositions,
    maturedPendingPositions: effectiveToday,
    futurePendingPositions: future,
    effectiveActivePositions
  };
}

async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function readMtimeMs(path) {
  try {
    const fileStat = await stat(path);
    return Number(fileStat?.mtimeMs ?? 0);
  } catch {
    return 0;
  }
}

async function buildDashboardDependencyKey(portfolioRoot) {
  const dependencyPaths = [
    buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json"),
    buildPortfolioPath(portfolioRoot, "latest.json"),
    buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json"),
    buildPortfolioPath(portfolioRoot, "ledger", "execution_ledger.json"),
    buildPortfolioPath(portfolioRoot, "account_context.json"),
    buildPortfolioPath(portfolioRoot, "fund-watchlist.json"),
    buildPortfolioPath(portfolioRoot, "config", "asset_master.json"),
    buildPortfolioPath(portfolioRoot, "data", "nightly_confirmed_nav_status.json")
  ];

  const mtimes = await Promise.all(
    dependencyPaths.map(async (path) => `${path}:${await readMtimeMs(path)}`)
  );

  return mtimes.join("|");
}

function formatAccountLabel(accountId) {
  if (accountId === "main") {
    return "主账户";
  }
  if (accountId === "wenge") {
    return "文哥账户";
  }
  return `${accountId} 账户`;
}

async function listAvailableAccounts() {
  try {
    const accounts = await listDiscoveredPortfolioAccounts({ includeMain: true });
    return accounts.map((item) => ({
      id: item.id,
      label: formatAccountLabel(item.id)
    }));
  } catch {
    return [
      {
        id: "main",
        label: formatAccountLabel("main")
      }
    ];
  }
}

function pickValidAccountId(requestedAccountId, availableAccounts, fallbackAccountId = activeAccountId) {
  const normalized = resolveAccountId({ user: requestedAccountId || fallbackAccountId });
  const available = new Set(availableAccounts.map((item) => item.id));
  return available.has(normalized) ? normalized : fallbackAccountId;
}

function resolveConfirmedNavStatusLabel(confirmedNavStatus) {
  const state = String(confirmedNavStatus?.state ?? "").trim();
  const targetDate = String(confirmedNavStatus?.targetDate ?? "").trim();
  const stats = confirmedNavStatus?.accountRun?.stats ?? {};
  const normalLagCount =
    Number(stats?.normalLagFundCount ?? 0) + Number(stats?.holidayDelayFundCount ?? 0);
  const holidayDelayCount = Number(stats?.holidayDelayFundCount ?? 0);

  if (state === "confirmed_nav_ready") {
    return {
      tone: "success",
      text: `昨晚确认净值已完成${targetDate ? ` · ${targetDate}` : ""}`
    };
  }

  if (state === "partially_confirmed_normal_lag") {
    return {
      tone: "flat",
      text:
        holidayDelayCount > 0 && normalLagCount === holidayDelayCount
          ? `${targetDate || "当前"}确认净值部分完成，${holidayDelayCount}只基金因休市顺延`
          : `${targetDate || "当前"}确认净值部分完成，${normalLagCount}只基金仍属正常滞后`
    };
  }

  if (state === "late_missing") {
    return {
      tone: "error",
      text: `确认净值超窗缺失，当前降级为账本 + 观察口径${targetDate ? ` · ${targetDate}` : ""}`
    };
  }

  if (state === "source_missing") {
    return {
      tone: "error",
      text: `确认净值数据源缺失，当前降级为账本 + 观察口径${targetDate ? ` · ${targetDate}` : ""}`
    };
  }

  return {
    tone: "warn",
    text: `确认净值状态不可用，当前仅展示账本口径${targetDate ? ` · ${targetDate}` : ""}`
  };
}

function deriveConfirmedNavReadinessState(confirmationSummary, fallbackState = "blocked") {
  const confirmedCount = Number(confirmationSummary?.confirmedFundCount ?? 0);
  const normalLagCount =
    Number(confirmationSummary?.normalLagFundCount ?? 0) +
    Number(confirmationSummary?.holidayDelayFundCount ?? 0);
  const lateMissingCount = Number(confirmationSummary?.lateMissingFundCount ?? 0);
  const sourceMissingCount = Number(confirmationSummary?.sourceMissingFundCount ?? 0);
  const totalFundCount = Number(confirmationSummary?.totalFundCount ?? 0);

  if (sourceMissingCount > 0 && lateMissingCount === 0) {
    return "source_missing";
  }
  if (lateMissingCount > 0) {
    return "late_missing";
  }
  if (normalLagCount > 0) {
    return "partially_confirmed_normal_lag";
  }
  if (totalFundCount > 0 && confirmedCount === totalFundCount) {
    return "confirmed_nav_ready";
  }
  return fallbackState;
}

function withResolvedConfirmedNavLabel(confirmedNavStatus) {
  return {
    ...confirmedNavStatus,
    label: resolveConfirmedNavStatusLabel(confirmedNavStatus)
  };
}

function overlayConfirmedNavStatusFromSummary(confirmedNavStatus, confirmationSummary) {
  if (!confirmationSummary || Number(confirmationSummary?.totalFundCount ?? 0) <= 0) {
    return withResolvedConfirmedNavLabel(confirmedNavStatus);
  }

  const next = {
    ...confirmedNavStatus,
    state: deriveConfirmedNavReadinessState(confirmationSummary, confirmedNavStatus?.state ?? "blocked"),
    accountRun: {
      ...(confirmedNavStatus?.accountRun ?? {}),
      stats: {
        ...(confirmedNavStatus?.accountRun?.stats ?? {}),
        totalFundCount: confirmationSummary.totalFundCount,
        confirmedFundCount: confirmationSummary.confirmedFundCount,
        normalLagFundCount: confirmationSummary.normalLagFundCount,
        holidayDelayFundCount: confirmationSummary.holidayDelayFundCount,
        lateMissingFundCount: confirmationSummary.lateMissingFundCount,
        sourceMissingFundCount: confirmationSummary.sourceMissingFundCount,
        confirmationCoveragePct: confirmationSummary.confirmationCoveragePct
      }
    }
  };
  return withResolvedConfirmedNavLabel(next);
}

function overlayConfirmedNavStatusFromDashboardState(confirmedNavStatus, dashboardStatePayload) {
  const dashboardState = String(
    dashboardStatePayload?.readiness?.confirmedNavState ?? dashboardStatePayload?.confirmedNavStatus?.state ?? ""
  ).trim();
  if (!dashboardState) {
    return withResolvedConfirmedNavLabel(confirmedNavStatus);
  }

  const next = {
    ...confirmedNavStatus,
    ...(dashboardStatePayload?.confirmedNavStatus ?? {}),
    state: dashboardState,
    accountRun: {
      ...(confirmedNavStatus?.accountRun ?? {}),
      stats: {
        ...(confirmedNavStatus?.accountRun?.stats ?? {}),
        confirmedFundCount: Number(dashboardStatePayload?.summary?.confirmedFundCount ?? 0),
        normalLagFundCount: Number(dashboardStatePayload?.summary?.normalLagFundCount ?? 0),
        holidayDelayFundCount: Number(dashboardStatePayload?.summary?.holidayDelayFundCount ?? 0),
        lateMissingFundCount: Number(dashboardStatePayload?.summary?.lateMissingFundCount ?? 0),
        sourceMissingFundCount: Number(dashboardStatePayload?.summary?.sourceMissingFundCount ?? 0),
        confirmationCoveragePct: dashboardStatePayload?.summary?.confirmationCoveragePct ?? null
      }
    }
  };
  return withResolvedConfirmedNavLabel(next);
}

function buildLiveHealthPayload(payload) {
  return {
    ...payload.readiness,
    snapshotDate: payload.snapshotDate ?? payload.readiness?.snapshotDate ?? null,
    accountingState: payload.accountingState ?? payload.readiness?.accountingState ?? null,
    summary: {
      confirmedFundCount: payload.summary?.confirmedFundCount ?? 0,
      normalLagFundCount: payload.summary?.normalLagFundCount ?? 0,
      lateMissingFundCount: payload.summary?.lateMissingFundCount ?? 0,
      confirmationCoveragePct: payload.summary?.confirmationCoveragePct ?? null
    }
  };
}

async function ensureNightlyConfirmedNavReady({ portfolioRoot, accountId, snapshotDate }) {
  const statusPayload = await readNightlyConfirmedNavStatus({ portfolioRoot });
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload,
    accountId,
    snapshotDate
  });

  return {
    ...readiness,
    didRunSelfHeal: false,
    label: resolveConfirmedNavStatusLabel(readiness),
    statusGeneratedAt: statusPayload?.generatedAt ?? null,
    statusRunType: readiness?.accountRun?.runType ?? statusPayload?.runType ?? null
  };
}

function buildFileHealthEntry(kind, targetPath, exists, required = false, reason = null) {
  return {
    kind,
    path: targetPath,
    exists,
    required,
    reason
  };
}

function resolveHealthState({ blocked = false, degraded = false } = {}) {
  if (blocked) {
    return "blocked";
  }
  if (degraded) {
    return "degraded";
  }
  return "ready";
}

function resolveAccountingState(snapshotDate, today) {
  return snapshotDate && snapshotDate === today
    ? "snapshot_fresh_for_accounting"
    : "observation_only_stale_snapshot";
}

export async function buildFundsDashboardHealth(requestedAccountId, now = new Date()) {
  const availableAccounts = await listAvailableAccounts();
  const accountId = pickValidAccountId(requestedAccountId, availableAccounts, activeAccountId);
  const portfolioRoot = resolvePortfolioRoot({ user: accountId });
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readJsonOrNull(manifestPath);
  const statePaths = buildPortfolioStatePaths(portfolioRoot, manifest);
  const dualLedgerPaths = buildDualLedgerPaths(portfolioRoot);
  const assetMasterPath = buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
  const watchlistPath = buildPortfolioPath(portfolioRoot, "fund-watchlist.json");
  const confirmedStatusPath = buildPortfolioPath(portfolioRoot, "data", "nightly_confirmed_nav_status.json");
  const dashboardStatePath = buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json");
  const today = formatDateInShanghai(now);

  const [
    portfolioStateExists,
    assetMasterExists,
    watchlistExists,
    confirmedStatusExists,
    dashboardStateExists,
    latestCompatExists,
    latestRawExists,
    executionLedgerExists
  ] = await Promise.all([
    pathExists(statePaths.portfolioStatePath),
    pathExists(assetMasterPath),
    pathExists(watchlistPath),
    pathExists(confirmedStatusPath),
    pathExists(dashboardStatePath),
    pathExists(statePaths.latestCompatPath),
    pathExists(dualLedgerPaths.latestRawPath),
    pathExists(dualLedgerPaths.executionLedgerPath)
  ]);
  const dashboardStatePayload = dashboardStateExists
    ? await readDashboardStatePayload(portfolioRoot, accountId, availableAccounts, 15_000)
    : null;

  const reasons = [];
  let blocked = false;
  let degraded = false;
  let snapshotDate = null;

  const requiredFiles = [
    buildFileHealthEntry("portfolio_state", statePaths.portfolioStatePath, portfolioStateExists, true),
    buildFileHealthEntry("asset_master", assetMasterPath, assetMasterExists, true)
  ];
  const optionalFiles = [
    buildFileHealthEntry("watchlist", watchlistPath, watchlistExists, false),
    buildFileHealthEntry("nightly_confirmed_nav_status", confirmedStatusPath, confirmedStatusExists, false),
    buildFileHealthEntry("dashboard_state", dashboardStatePath, dashboardStateExists, false)
  ];
  const compatibilityFiles = [
    buildFileHealthEntry("latest_compat", statePaths.latestCompatPath, latestCompatExists, false),
    buildFileHealthEntry("latest_raw", dualLedgerPaths.latestRawPath, latestRawExists, false),
    buildFileHealthEntry("execution_ledger", dualLedgerPaths.executionLedgerPath, executionLedgerExists, false)
  ];

  if (!portfolioStateExists) {
    blocked = true;
    reasons.push(`missing required file: ${statePaths.portfolioStatePath}`);
  }
  if (!assetMasterExists) {
    blocked = true;
    reasons.push(`missing required file: ${assetMasterPath}`);
  }
  if (!watchlistExists) {
    degraded = true;
    reasons.push(`optional watchlist missing: ${watchlistPath}`);
  }
  if (!confirmedStatusExists) {
    degraded = true;
    reasons.push(`optional confirmed-nav status missing: ${confirmedStatusPath}`);
  }
  if (!dashboardStateExists) {
    degraded = true;
    reasons.push(`optional dashboard state missing: ${dashboardStatePath}`);
  }

  if (portfolioStateExists) {
    try {
      const canonical = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
      snapshotDate = String(canonical?.payload?.snapshot_date ?? "").trim() || null;
    } catch (error) {
      blocked = true;
      const message = String(error?.message ?? error);
      reasons.push(message);
      requiredFiles[0].reason = message;
    }
  }

  if (assetMasterExists) {
    const assetMaster = await readJsonOrNull(assetMasterPath);
    if (!assetMaster) {
      blocked = true;
      reasons.push(`asset_master.json is unreadable: ${assetMasterPath}`);
      requiredFiles[1].reason = "invalid_json";
    }
  }

  if (!snapshotDate) {
    const latestCompat = await readJsonOrNull(statePaths.latestCompatPath);
    snapshotDate = String(latestCompat?.snapshot_date ?? "").trim() || null;
  }

  const confirmedStatusPayload = await readNightlyConfirmedNavStatus({ portfolioRoot });
  let confirmedNavStatus = resolveNightlyConfirmedNavReadiness({
    statusPayload: confirmedStatusPayload,
    accountId,
    snapshotDate,
    now
  });
  confirmedNavStatus = overlayConfirmedNavStatusFromDashboardState(
    confirmedNavStatus,
    dashboardStatePayload
  );

  if (["late_missing", "source_missing", "blocked"].includes(String(confirmedNavStatus?.state ?? "").trim())) {
    degraded = true;
    if (confirmedNavStatus?.reason) {
      reasons.push(confirmedNavStatus.reason);
    }
  }

  return {
    state: resolveHealthState({ blocked, degraded }),
    reasons: [...new Set(reasons.filter(Boolean))],
    accountId,
    portfolioRoot,
    requiredFiles,
    optionalFiles,
    compatibilityFiles,
    snapshotDate,
    confirmedNavState: confirmedNavStatus?.state ?? null,
    confirmedNavStatus,
    accountingState: resolveAccountingState(snapshotDate, today)
  };
}

async function loadDashboardOperatorContext(portfolioRoot, accountId) {
  const [accountContext, assetMaster, proxyConfig] = await Promise.all([
    readJson(buildPortfolioPath(portfolioRoot, "account_context.json")).catch(() => null),
    readJson(buildPortfolioPath(portfolioRoot, "config", "asset_master.json")).catch(() => null),
    readJson(buildPortfolioPath(portfolioRoot, "config", "backtest_proxy_mapping.json")).catch(() => null)
  ]);

  const bucketMetaMap = buildDashboardBucketMetaMap(assetMaster);
  const referenceTargetIndex = buildReferenceTargetIndex(proxyConfig);

  return {
    accountContext,
    assetMaster,
    proxyConfig,
    bucketMetaMap,
    bucketIndex: buildDashboardBucketIndex(assetMaster, bucketMetaMap, referenceTargetIndex)
  };
}

function normalizeDashboardPct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric <= 1 ? numeric * 100 : numeric;
}

function formatActiveProfileLabel(profile) {
  const normalized = String(profile ?? "").trim();
  if (!normalized) {
    return "未标注档位";
  }
  if (normalized === "B_offensive_growth_v1") {
    return "B 进攻增强版";
  }
  if (normalized === "absolute_return_v1" || normalized === "A_absolute_return_v1") {
    return "A 绝对收益版";
  }
  return normalized;
}

function buildBucketCompositionHint(bucket) {
  const subSleeveLabels = Object.values(bucket?.sub_sleeves ?? {})
    .map((item) => String(item?.label ?? "").trim())
    .filter(Boolean);
  if (subSleeveLabels.length > 0) {
    return subSleeveLabels.join(" / ");
  }
  const note = String(bucket?.composition_note ?? "").trim();
  return note || null;
}

function buildDashboardAssetMeta(asset, bucketKey, referenceTargetIndex = new Map()) {
  const hedgeSleeveType = String(asset?.hedge_sleeve_type ?? "").trim() || null;
  const portfolioRole = String(asset?.portfolio_role ?? "").trim() || null;
  const symbol = String(asset?.symbol ?? "").trim() || null;
  const roleBadge =
    hedgeSleeveType === "core_gold"
      ? "黄金核心"
      : hedgeSleeveType === "commodity_satellite"
        ? "商品卫星"
        : portfolioRole;
  const explicitReferenceTargets = Array.isArray(asset?.reference_targets)
    ? asset.reference_targets.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const mappedReferenceTargets = symbol ? referenceTargetIndex.get(symbol) ?? [] : [];

  return {
    bucketKey,
    symbol,
    portfolioRole,
    roleBadge,
    hedgeSleeveType,
    referenceTargets: explicitReferenceTargets.length > 0 ? explicitReferenceTargets : mappedReferenceTargets
  };
}

function buildDashboardBucketMetaMap(assetMaster) {
  const order = Array.isArray(assetMaster?.bucket_order)
    ? assetMaster.bucket_order
    : Object.keys(assetMaster?.buckets ?? {});
  const mapEntries = order.map((bucketKey) => {
    const bucket = assetMaster?.buckets?.[bucketKey] ?? {};
    return [
      bucketKey,
      {
        key: bucketKey,
        label: String(bucket?.short_label ?? bucket?.label ?? bucketKey).trim() || bucketKey,
        longLabel: String(bucket?.label ?? bucket?.short_label ?? bucketKey).trim() || bucketKey,
        driver: String(bucket?.driver ?? bucket?.risk_role ?? "").trim() || null,
        compositionHint: buildBucketCompositionHint(bucket),
        targetPct: toNumberOrNull(normalizeDashboardPct(bucket?.target ?? bucket?.target_pct)),
        minPct: toNumberOrNull(normalizeDashboardPct(bucket?.min ?? bucket?.min_pct)),
        maxPct: toNumberOrNull(normalizeDashboardPct(bucket?.max ?? bucket?.max_pct)),
        priorityRank: intOrFallback(bucket?.priority_rank, 999),
        buyGate: String(bucket?.buy_gate ?? "").trim() || null,
        tone: bucketKey === "CASH" ? "cash" : bucketKey === "TACTICAL" ? "warn" : "default"
      }
    ];
  });

  mapEntries.push([
    "unmapped",
    {
      key: "unmapped",
      label: "其他",
      longLabel: "未归类",
      driver: null,
      compositionHint: null,
      targetPct: null,
      minPct: null,
      maxPct: null,
      priorityRank: 999,
      buyGate: null,
      tone: "muted"
    }
  ]);

  return Object.fromEntries(mapEntries);
}

function intOrFallback(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : fallback;
}

function buildDashboardBucketIndex(assetMaster, bucketMetaMap, referenceTargetIndex = new Map()) {
  const byCode = new Map();
  const byName = new Map();
  const assetMetaByCode = new Map();
  const assetMetaByName = new Map();

  for (const asset of assetMaster?.assets ?? []) {
    const bucketKey = String(asset?.bucket ?? "").trim();
    if (!bucketKey || !bucketMetaMap[bucketKey]) {
      continue;
    }
    const assetMeta = buildDashboardAssetMeta(asset, bucketKey, referenceTargetIndex);

    for (const code of [asset?.symbol, asset?.code, asset?.fund_code, asset?.ticker]) {
      const normalizedCode = String(code ?? "").trim();
      if (normalizedCode) {
        byCode.set(normalizedCode, bucketKey);
        assetMetaByCode.set(normalizedCode, assetMeta);
      }
    }

    for (const name of [asset?.name, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])]) {
      const normalizedName = normalizeName(name);
      if (normalizedName) {
        byName.set(normalizedName, bucketKey);
        assetMetaByName.set(normalizedName, assetMeta);
      }
    }
  }

  return {
    byCode,
    byName,
    assetMetaByCode,
    assetMetaByName
  };
}

function matchDashboardBucketRule(rule, position, resolved) {
  const category = String(
    position?.category ?? position?.latestCategory ?? position?.latest_category ?? ""
  ).trim();
  const categoryValues = Array.isArray(rule?.category_equals) ? rule.category_equals : [];
  const namePatterns = Array.isArray(rule?.name_patterns) ? rule.name_patterns : [];
  const nameText = [position?.name, resolved?.name].filter(Boolean).join(" ");

  if (category && categoryValues.includes(category)) {
    return true;
  }

  if (nameText) {
    return namePatterns.some((pattern) => new RegExp(String(pattern), "u").test(nameText));
  }

  return false;
}

function resolveAvailableCashCny(latest, accountContext) {
  const candidates = [
    latest?.summary?.settled_cash_cny,
    latest?.cash_ledger?.settled_cash_cny,
    latest?.summary?.available_cash_cny,
    latest?.cash_ledger?.available_cash_cny,
    accountContext?.available_cash_cny,
    accountContext?.reported_cash_estimate_cny
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return round(numeric);
    }
  }

  return 0;
}

async function readDashboardStatePayload(portfolioRoot, accountId, availableAccounts, refreshMs) {
  const dashboardStatePath = buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json");
  const payload = await readJsonOrNull(dashboardStatePath);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (!payload?.summary || !Array.isArray(payload?.rows)) {
    return null;
  }

  return {
    ...payload,
    accountId: payload?.accountId ?? accountId,
    portfolioRoot: payload?.portfolioRoot ?? portfolioRoot,
    availableAccounts: Array.isArray(payload?.availableAccounts) ? payload.availableAccounts : availableAccounts,
    refreshMs: payload?.refreshMs ?? refreshMs
  };
}

function shouldServePersistedDashboardState(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const pendingRows = Array.isArray(payload?.pendingRows) ? payload.pendingRows : [];
  const maturedPendingRows = Array.isArray(payload?.maturedPendingRows) ? payload.maturedPendingRows : [];

  return rows.length === 0 && pendingRows.length === 0 && maturedPendingRows.length === 0;
}

function resolveTotalPortfolioAssetsRaw(latest, accountContext, activeFundAssetsRaw, availableCashCny) {
  const derivedFromFundsAndCash = Number(activeFundAssetsRaw) + Number(availableCashCny ?? 0);
  const candidates = [
    derivedFromFundsAndCash,
    latest?.summary?.total_portfolio_assets_cny,
    latest?.summary?.total_portfolio_value_cny,
    latest?.summary?.total_assets_cny,
    latest?.summary?.total_assets,
    accountContext?.reported_total_assets_range_cny?.min,
    latest?.summary?.total_fund_assets,
    activeFundAssetsRaw
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return 0;
}

function inferDashboardBucketKey(assetMaster, bucketMetaMap, position, resolved) {
  for (const rule of assetMaster?.bucket_mapping_rules ?? []) {
    const bucketKey = String(rule?.bucket_key ?? "").trim();
    if (!bucketKey || !bucketMetaMap[bucketKey]) {
      continue;
    }
    if (matchDashboardBucketRule(rule, position, resolved)) {
      return bucketKey;
    }
  }

  return assetMaster?.fallback_bucket_key ?? "unmapped";
}

function resolveRowBucketKey(bucketIndex, assetMaster, bucketMetaMap, position, resolved) {
  for (const code of [position?.symbol, position?.code, position?.fund_code, resolved?.code]) {
    const normalizedCode = String(code ?? "").trim();
    if (normalizedCode && bucketIndex.byCode.has(normalizedCode)) {
      return bucketIndex.byCode.get(normalizedCode);
    }
  }

  const normalizedName = normalizeName(position?.name ?? resolved?.name ?? "");
  if (normalizedName && bucketIndex.byName.has(normalizedName)) {
    return bucketIndex.byName.get(normalizedName);
  }

  return inferDashboardBucketKey(assetMaster, bucketMetaMap, position, resolved);
}

function resolveBucketDisplayMeta(bucketMetaMap, bucketKey) {
  const bucketMeta = bucketMetaMap[bucketKey] ?? bucketMetaMap.unmapped;
  return {
    key: bucketMeta.key,
    label: bucketMeta.label,
    longLabel: bucketMeta.longLabel,
    driver: bucketMeta.driver,
    compositionHint: bucketMeta.compositionHint,
    targetPct: bucketMeta.targetPct,
    minPct: bucketMeta.minPct,
    maxPct: bucketMeta.maxPct,
    priorityRank: bucketMeta.priorityRank,
    tone: bucketMeta.tone,
    buyGate: bucketMeta.buyGate
  };
}

function resolveRowAssetMeta(bucketIndex, position, resolved) {
  for (const code of [position?.symbol, position?.code, position?.fund_code, resolved?.code]) {
    const normalizedCode = String(code ?? "").trim();
    if (normalizedCode && bucketIndex.assetMetaByCode.has(normalizedCode)) {
      return bucketIndex.assetMetaByCode.get(normalizedCode);
    }
  }

  const normalizedName = normalizeName(position?.name ?? resolved?.name ?? "");
  if (normalizedName && bucketIndex.assetMetaByName.has(normalizedName)) {
    return bucketIndex.assetMetaByName.get(normalizedName);
  }

  return null;
}

function resolveRowDashboardMeta(bucketIndex, assetMaster, bucketMetaMap, position, resolved) {
  return {
    bucketKey: resolveRowBucketKey(bucketIndex, assetMaster, bucketMetaMap, position, resolved),
    assetMeta: resolveRowAssetMeta(bucketIndex, position, resolved)
  };
}

function buildSyntheticCashRow(availableCashCny) {
  return {
    name: "账户可用现金",
    code: "CASH",
    category: "账本现金",
    amount: round(availableCashCny),
    valuation: null,
    updateTime: "账本口径",
    quoteFresh: true,
    estimatedPnl: null,
    holdingPnl: null,
    holdingPnlRatePct: null,
    changePct: null,
    bucketKey: "CASH",
    isSyntheticCash: true
  };
}

function buildRangeText(minPct, maxPct) {
  if (!Number.isFinite(Number(minPct)) || !Number.isFinite(Number(maxPct))) {
    return "区间未设";
  }
  return `[ ${Number(minPct).toFixed(0)}% ---|--- ${Number(maxPct).toFixed(0)}% ]`;
}

function buildBucketGroups(rows, totalPortfolioAssetsRaw, bucketMetaMap) {
  const groups = new Map();

  for (const row of rows) {
    const bucketMeta = resolveBucketDisplayMeta(bucketMetaMap, row.bucketKey);
    row.currentWeightPct =
      totalPortfolioAssetsRaw > 0
        ? toNumberOrNull((Number(row.amount ?? 0) / totalPortfolioAssetsRaw) * 100)
        : null;
    row.bucketTargetPct = bucketMeta.targetPct;
    row.bucketLabel = bucketMeta.label;

    if (!groups.has(row.bucketKey)) {
      groups.set(row.bucketKey, {
        bucketKey: row.bucketKey,
        bucketLabel: bucketMeta.label,
        bucketLongLabel: bucketMeta.longLabel,
        bucketDriver: bucketMeta.driver,
        bucketCompositionHint: bucketMeta.compositionHint,
        minPct: bucketMeta.minPct,
        targetPct: bucketMeta.targetPct,
        maxPct: bucketMeta.maxPct,
        priorityRank: bucketMeta.priorityRank,
        tone: bucketMeta.tone,
        buyGate: bucketMeta.buyGate,
        currentAmount: 0,
        currentPct: null,
        progressFillPct: 0,
        isOverTarget: false,
        hasSyntheticRows: false,
        rows: []
      });
    }

    const group = groups.get(row.bucketKey);
    group.currentAmount += Number(row.amount ?? 0);
    group.hasSyntheticRows = group.hasSyntheticRows || Boolean(row.isSyntheticCash);
    group.rows.push(row);
  }

  return [...groups.values()]
    .map((group) => {
      const currentPct =
        totalPortfolioAssetsRaw > 0
          ? toNumberOrNull((group.currentAmount / totalPortfolioAssetsRaw) * 100)
          : null;
      const targetPct =
        group.targetPct === null || group.targetPct === undefined ? null : Number(group.targetPct);
      const progressRaw =
        Number.isFinite(currentPct) && Number.isFinite(targetPct) && targetPct > 0
          ? (currentPct / targetPct) * 100
          : null;
      const minPct = Number(group.minPct);
      const maxPct = Number(group.maxPct);
      const rangeWidth = Number.isFinite(minPct) && Number.isFinite(maxPct) ? maxPct - minPct : null;
      const targetMarkerPct =
        Number.isFinite(rangeWidth) && rangeWidth > 0 && Number.isFinite(targetPct)
          ? Math.max(0, Math.min(((targetPct - minPct) / rangeWidth) * 100, 100))
          : 50;

      return {
        ...group,
        currentAmount: toNumberOrNull(group.currentAmount),
        currentPct,
        progressFillPct:
          Number.isFinite(progressRaw) && progressRaw > 0 ? Math.max(4, Math.min(progressRaw, 100)) : 0,
        progressPct: Number.isFinite(progressRaw) ? toNumberOrNull(progressRaw, 1) : null,
        isOverTarget:
          Number.isFinite(currentPct) && Number.isFinite(targetPct) && currentPct > targetPct + 0.01,
        rangeText: buildRangeText(group.minPct, group.maxPct),
        targetMarkerPct: toNumberOrNull(targetMarkerPct, 1),
        roleSummary: [...new Set(group.rows.map((row) => row.roleBadge).filter(Boolean))].join(" / "),
        rows: group.rows.sort((left, right) => Number(right?.amount ?? 0) - Number(left?.amount ?? 0))
      };
    })
    .sort((left, right) => {
      if (left.priorityRank !== right.priorityRank) {
        return left.priorityRank - right.priorityRank;
      }
      return left.bucketLabel.localeCompare(right.bucketLabel, "zh-CN");
    });
}

export async function buildLivePayload(refreshMs, requestedAccountId, deps = {}) {
  const availableAccounts = await listAvailableAccounts();
  const accountId = pickValidAccountId(requestedAccountId, availableAccounts, activeAccountId);
  const health = await buildFundsDashboardHealth(accountId);
  if (health.state === "blocked") {
    const error = new Error(health.reasons.join("; ") || "funds_dashboard_blocked");
    error.readiness = health;
    throw error;
  }
  const portfolioRoot = health.portfolioRoot;
  const watchlistPath = buildPortfolioPath(portfolioRoot, "fund-watchlist.json");
  let latestView = await loadCanonicalPortfolioState({ portfolioRoot });
  const initialSnapshotDate = String(latestView?.payload?.snapshot_date ?? "").trim() || null;
  const confirmedNavStatus = await ensureNightlyConfirmedNavReady({
    portfolioRoot,
    accountId,
    snapshotDate: initialSnapshotDate
  });
  const [watchlist, dashboardOperatorContext] = await Promise.all([
    readJsonOrNull(watchlistPath),
    loadDashboardOperatorContext(portfolioRoot, accountId)
  ]);
  const latestCompatPayload = await readJsonOrNull(latestView?.paths?.latestCompatPath);
  const canonicalSelection = selectCanonicalPortfolioPayload({
    latestView,
    latestCompat: latestCompatPayload
  });
  const latest = buildCanonicalPortfolioView({
    payload: canonicalSelection.payload,
    sourceKind: canonicalSelection.sourceKind,
    sourcePath: canonicalSelection.sourcePath,
    latestCompatSnapshotDate: latestCompatPayload?.snapshot_date ?? null
  });
  const useConfirmedSnapshotDisplay = shouldUseConfirmedSnapshotDisplay({
    confirmedNavState: confirmedNavStatus?.state,
    confirmedTargetDate: confirmedNavStatus?.targetDate,
    snapshotDate: latest?.snapshot_date
  });
  const confirmationTargetDate =
    String(confirmedNavStatus?.targetDate ?? latest?.snapshot_date ?? "").trim() || null;
  const { accountContext, assetMaster, bucketMetaMap, bucketIndex } = dashboardOperatorContext;
  const fundQuoteFetcher = deps.fundQuoteFetcher ?? getFundQuotes;
  const referenceQuoteFetcher = deps.referenceQuoteFetcher ?? getStockQuote;
  const watchlistItems = Array.isArray(watchlist?.watchlist) ? watchlist.watchlist : [];
  const resolvePosition = buildResolver(watchlistItems);
  const today = String(deps.today ?? formatDateInShanghai());
  const buildNow = deps.now instanceof Date ? deps.now : new Date(deps.now ?? Date.now());
  const profitLockRegistry = await loadProfitLockRegistry(portfolioRoot, today);
  const {
    activePositions,
    pendingPositions,
    maturedPendingPositions,
    futurePendingPositions,
    effectiveActivePositions
  } = deriveLiveDashboardPositionSets(latest, today);
  reconcileProfitLockRegistryWithPendingPositions(profitLockRegistry, futurePendingPositions);
  const snapshotDate = String(latest?.snapshot_date ?? "").trim() || null;
  const accountingState = resolveAccountingState(snapshotDate, today);
  const snapshotFreshForAccounting = accountingState === "snapshot_fresh_for_accounting";

  const resolvedPositions = effectiveActivePositions.map((position) => ({
    position,
    resolved: resolvePosition(position)
  }));
  const resolvedPendingPositions = futurePendingPositions.map((position) => ({
    position,
    resolved: resolvePosition(position)
  }));
  const resolvedMaturedPendingPositions = maturedPendingPositions.map((position) => ({
    position,
    resolved: resolvePosition(position)
  }));
  const uniqueCodes = [
    ...new Set(
      [...resolvedPositions, ...resolvedPendingPositions, ...resolvedMaturedPendingPositions]
        .map((item) => item.resolved?.code)
        .filter(Boolean)
    )
  ];
  const quotes = uniqueCodes.length > 0 ? await fundQuoteFetcher(uniqueCodes) : [];
  const quoteMap = new Map(quotes.map((item) => [item.code, item]));
  const rowInputs = resolvedPositions.map(({ position, resolved }) => {
    const dashboardMeta = resolveRowDashboardMeta(
      bucketIndex,
      assetMaster,
      bucketMetaMap,
      position,
      resolved
    );
    const sessionPolicy = resolveFundMarketSessionPolicy({
      asset: dashboardMeta.assetMeta,
      position
    });
    return {
      position,
      resolved,
      quote: quoteMap.get(resolved?.code) ?? null,
      dashboardMeta,
      sessionPolicy
    };
  });
  const uniqueReferenceTargets = [
    ...new Set(
      rowInputs
        .filter((item) => String(item?.quote?.observationKind ?? "").trim() === "confirmed_only")
        .flatMap((item) => item?.dashboardMeta?.assetMeta?.referenceTargets ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  ];
  const referenceQuotes = await Promise.all(
    uniqueReferenceTargets.map(async (symbol) => {
      try {
        return [symbol, await referenceQuoteFetcher(symbol)];
      } catch {
        return [symbol, null];
      }
    })
  );
  const referenceQuoteMap = new Map(referenceQuotes);
  const ledgerRows = rowInputs.map(({ position, resolved, quote, dashboardMeta, sessionPolicy }) => {
    const annotatedRow = annotateRowConfirmation(
      buildRow(
        position,
        resolved,
        quote,
        today,
        resolveProfitLockForRow(profitLockRegistry, position, resolved),
        {
          useConfirmedSnapshotDisplay,
          assetMeta: dashboardMeta.assetMeta,
          sessionPolicy,
          now: buildNow
        }
      ),
      position,
      dashboardMeta.assetMeta,
      {
        confirmedTargetDate: confirmationTargetDate,
        currentDate: today,
        now: buildNow
      }
    );
    const referenceQuote = pickBestReferenceQuote(
      dashboardMeta.assetMeta?.referenceTargets ?? [],
      referenceQuoteMap
    );
    return {
      ...applyReferenceFallbackToRow(annotatedRow, dashboardMeta.assetMeta, referenceQuote),
      bucketKey: dashboardMeta.bucketKey,
      portfolioRole: dashboardMeta.assetMeta?.portfolioRole ?? null,
      roleBadge: dashboardMeta.assetMeta?.roleBadge ?? null,
      hedgeSleeveType: dashboardMeta.assetMeta?.hedgeSleeveType ?? null
    };
  });
  const rows = ledgerRows.map((row) =>
    applyLiveQuoteOverlay(row, snapshotDate, today, {
      useConfirmedSnapshotDisplay,
      snapshotFreshForAccounting,
      now: buildNow
    })
  );
  const pendingRows = resolvedPendingPositions.map(({ position, resolved }) => ({
    ...(() => {
      const dashboardMeta = resolveRowDashboardMeta(
        bucketIndex,
        assetMaster,
        bucketMetaMap,
        position,
        resolved
      );
      return {
        ...annotateRowConfirmation(
          buildPendingRow(position, resolved, quoteMap.get(resolved?.code) ?? null, today),
          position,
          dashboardMeta.assetMeta,
          {
            confirmedTargetDate: confirmationTargetDate,
            currentDate: today,
            now: buildNow
          }
        ),
        bucketKey: dashboardMeta.bucketKey,
        portfolioRole: dashboardMeta.assetMeta?.portfolioRole ?? null,
        roleBadge: dashboardMeta.assetMeta?.roleBadge ?? null,
        hedgeSleeveType: dashboardMeta.assetMeta?.hedgeSleeveType ?? null
      };
    })()
  }));
  const maturedPendingRows = resolvedMaturedPendingPositions.map(({ position, resolved }) => ({
    ...(() => {
      const dashboardMeta = resolveRowDashboardMeta(
        bucketIndex,
        assetMaster,
        bucketMetaMap,
        position,
        resolved
      );
      return {
        ...annotateRowConfirmation(
          buildPendingRow(position, resolved, quoteMap.get(resolved?.code) ?? null, today),
          position,
          dashboardMeta.assetMeta,
          {
            confirmedTargetDate: confirmationTargetDate,
            currentDate: today,
            now: buildNow
          }
        ),
        bucketKey: dashboardMeta.bucketKey,
        portfolioRole: dashboardMeta.assetMeta?.portfolioRole ?? null,
        roleBadge: dashboardMeta.assetMeta?.roleBadge ?? null,
        hedgeSleeveType: dashboardMeta.assetMeta?.hedgeSleeveType ?? null
      };
    })()
  }));
  const mappedRows = rows.filter((row) => row.code);
  const unresolvedRows = rows.filter((row) => !row.code);
  const currentRows = rows.filter((row) => row?.quoteCurrent === true);
  const freshRows = rows.filter((row) => row?.quoteFresh === true);
  const confirmationSummary = summarizeFundConfirmationStates(rows);
  const effectiveConfirmedNavStatus = overlayConfirmedNavStatusFromSummary(
    confirmedNavStatus,
    confirmationSummary
  );
  const latestQuoteTime =
    (currentRows.length > 0 ? currentRows : freshRows)
      .map((row) => String(row?.updateTime ?? "").trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .at(-1) ?? null;
  const displayedTotalFundAssetsRaw = rows.reduce((sum, row) => sum + Number(row?.amount ?? 0), 0);
  const ledgerTotalFundAssetsRaw = ledgerRows.reduce(
    (sum, row) => sum + Number(row?.amount ?? 0),
    0
  );
  const estimatedDriftPnlRaw = rows.reduce((sum, row) => sum + Number(row?.estimateDriftPnl ?? 0), 0);
  const totalHoldingProfitRaw = rows.reduce((sum, row) => sum + Number(row?.holdingPnl ?? 0), 0);
  const totalHoldingCostBasisRaw = rows.reduce(
    (sum, row) => sum + (Number.isFinite(Number(row?.costBasis)) ? Number(row.costBasis) : 0),
    0
  );
  const totalProfitLockedAmountRaw = rows.reduce(
    (sum, row) => sum + Number(row?.profitLockedAmount ?? 0),
    0
  );
  const overnightCarryRows = rows.filter(
    (row) =>
      row?.overnightCarryPnl !== null &&
      row?.overnightCarryPnl !== undefined &&
      Number.isFinite(Number(row?.overnightCarryPnl))
  );
  const overnightCarryPnlRaw = overnightCarryRows.reduce(
    (sum, row) => sum + Number(row?.overnightCarryPnl ?? 0),
    0
  );
  const overnightCarryExpectedDates = [
    ...new Set(
      overnightCarryRows
        .map((row) => String(row?.overnightCarryReferenceDate ?? "").trim())
        .filter(Boolean)
    )
  ];
  const activeFundCount = rows.length;
  const availableCashCny = resolveAvailableCashCny(latest, accountContext);
  const totalPortfolioAssetsRaw = resolveTotalPortfolioAssetsRaw(
    latest,
    accountContext,
    displayedTotalFundAssetsRaw,
    availableCashCny
  );
  const displayedTotalFundAssets = toNumberOrNull(displayedTotalFundAssetsRaw);
  const estimatedCurrentFundAssets = toNumberOrNull(displayedTotalFundAssetsRaw);
  const accountingTodayPnlSummary = summarizeTodayPnl(rows, displayedTotalFundAssetsRaw);
  const observationTodayPnlSummary = summarizeObservationTodayPnl(rows, displayedTotalFundAssetsRaw);
  const displayTodayPnlMode =
    snapshotFreshForAccounting || !Number.isFinite(Number(observationTodayPnlSummary?.estimatedDailyPnl))
      ? "accounting"
      : "observation";
  const displayedTodayPnlSummary =
    currentRows.length > 0
      ? (displayTodayPnlMode === "observation" ? observationTodayPnlSummary : accountingTodayPnlSummary)
      : {
          estimatedDailyPnl: null,
          estimatedDailyPnlRatePct: null
        };
  const pendingBuyConfirm = toNumberOrNull(
    pendingRows.reduce((sum, row) => sum + Number(row?.amount ?? 0), 0)
  );
  const accountingSummary = deriveDashboardAccountingSummary({
    portfolioStateSummary: latest?.summary ?? {},
    performanceSnapshot: latest?.performance_snapshot ?? {},
    cashLedger: latest?.cash_ledger ?? {},
    liveUnrealizedHoldingProfitCny: totalHoldingProfitRaw,
    liveUnrealizedHoldingProfitRatePct:
      totalHoldingCostBasisRaw > 0 ? (totalHoldingProfitRaw / totalHoldingCostBasisRaw) * 100 : null
  });
  const bucketGroups = buildBucketGroups(rows, totalPortfolioAssetsRaw, bucketMetaMap);

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    accountLabel: formatAccountLabel(accountId),
    portfolioRoot,
    availableAccounts,
    refreshMs,
    snapshotDate: latest?.snapshot_date ?? null,
    readiness: {
      ...health,
      confirmedNavState: effectiveConfirmedNavStatus?.state ?? health.confirmedNavState,
      confirmedNavStatus: effectiveConfirmedNavStatus
    },
    accountingState,
    summary: {
      ledgerTotalFundAssets: toNumberOrNull(ledgerTotalFundAssetsRaw),
      totalFundAssets: displayedTotalFundAssets,
      estimatedCurrentFundAssets,
      totalPortfolioAssets: toNumberOrNull(totalPortfolioAssetsRaw),
      availableCashCny: toNumberOrNull(availableCashCny),
      holdingProfit: toNumberOrNull(totalHoldingProfitRaw),
      holdingProfitRatePct:
        totalHoldingCostBasisRaw > 0
          ? toNumberOrNull((totalHoldingProfitRaw / totalHoldingCostBasisRaw) * 100)
          : null,
      unrealizedHoldingProfit: toNumberOrNull(accountingSummary.unrealizedHoldingProfitCny),
      unrealizedHoldingProfitRatePct: toNumberOrNull(accountingSummary.unrealizedHoldingProfitRatePct),
      realizedCumulativeProfit: toNumberOrNull(accountingSummary.realizedCumulativeProfitCny),
      pendingSellSettlementCny: toNumberOrNull(accountingSummary.pendingSellSettlementCny),
      settledCashCny: toNumberOrNull(accountingSummary.settledCashCny),
      projectedSettledCashCny: toNumberOrNull(accountingSummary.projectedSettledCashCny),
      tradeAvailableCashCny: toNumberOrNull(accountingSummary.tradeAvailableCashCny),
      cashLikeFundAssetsCny: toNumberOrNull(accountingSummary.cashLikeFundAssetsCny),
      liquiditySleeveAssetsCny: toNumberOrNull(accountingSummary.liquiditySleeveAssetsCny),
      pendingProfitEffectiveCny: toNumberOrNull(accountingSummary.pendingProfitEffectiveCny),
      pendingBuyConfirm,
      profitLockedAmount: toNumberOrNull(totalProfitLockedAmountRaw),
      pendingOverseasConfirmedPnl: overnightCarryRows.length > 0 ? toNumberOrNull(overnightCarryPnlRaw) : null,
      pendingOverseasConfirmedLabel:
        overnightCarryRows.length === 0
          ? null
          : overnightCarryExpectedDates.length === 1
            ? `海外待确认 ${overnightCarryExpectedDates[0]}`
            : "海外待确认 多日期",
      pendingOverseasConfirmedCount: overnightCarryRows.length,
      accountingDailyPnl: toNumberOrNull(accountingTodayPnlSummary.estimatedDailyPnl ?? 0),
      accountingDailyPnlRatePct: accountingTodayPnlSummary.estimatedDailyPnlRatePct,
      observationDailyPnl: observationTodayPnlSummary.estimatedDailyPnl,
      observationDailyPnlRatePct: observationTodayPnlSummary.estimatedDailyPnlRatePct,
      estimatedDailyPnlMode: displayTodayPnlMode,
      displayDailyPnl: displayedTodayPnlSummary.estimatedDailyPnl,
      displayDailyPnlRatePct: displayedTodayPnlSummary.estimatedDailyPnlRatePct,
      estimatedDailyPnl: accountingTodayPnlSummary.estimatedDailyPnl,
      estimatedDailyPnlRatePct: accountingTodayPnlSummary.estimatedDailyPnlRatePct,
      estimatedDriftPnl: toNumberOrNull(estimatedDriftPnlRaw),
      estimatedDriftPnlRatePct:
        displayedTotalFundAssetsRaw > 0
          ? toNumberOrNull((estimatedDriftPnlRaw / displayedTotalFundAssetsRaw) * 100)
          : null,
      activeFundCount,
      freshFundCount: freshRows.length,
      currentFundCount: currentRows.length,
      latestQuoteTime,
      pendingFundCount: pendingRows.length,
      maturedPendingFundCount: maturedPendingRows.length,
      mappedFundCount: mappedRows.length,
      unresolvedFundCount: unresolvedRows.length,
      confirmedFundCount: confirmationSummary.confirmedFundCount,
      normalLagFundCount:
        confirmationSummary.normalLagFundCount + confirmationSummary.holidayDelayFundCount,
      lateMissingFundCount:
        confirmationSummary.lateMissingFundCount + confirmationSummary.sourceMissingFundCount,
      confirmationCoveragePct: confirmationSummary.confirmationCoveragePct
    },
    configuration: {
      activeProfile: String(assetMaster?.active_profile ?? "").trim() || null,
      activeProfileLabel: formatActiveProfileLabel(assetMaster?.active_profile),
      maxDrawdownLimitPct: toNumberOrNull(
        normalizeDashboardPct(assetMaster?.global_constraints?.max_drawdown_limit)
      ),
      absoluteEquityCapPct: toNumberOrNull(
        normalizeDashboardPct(assetMaster?.global_constraints?.absolute_equity_cap)
      )
    },
    confirmedNavStatus: effectiveConfirmedNavStatus,
    bucketGroups,
    rows,
    pendingRows,
    maturedPendingRows
  };
}

export async function persistLiveSnapshot(portfolioRoot, payload) {
  try {
    const snapshotPath = buildPortfolioPath(portfolioRoot, "data/live_funds_snapshot.json");
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(
      JSON.stringify(
        {
          status: "live_snapshot_write_failed",
          portfolioRoot,
          message: String(error?.message ?? error)
        },
        null,
        2
      )
    );
  }
}

export function isAutoMarkToMarketWritebackEnabled(env = process.env) {
  const flag = String(env?.FUNDS_DASHBOARD_ENABLE_AUTO_MARK_TO_MARKET ?? "").trim();
  return flag === "1" || flag.toLowerCase() === "true";
}

function resolveAutoMaterializeSnapshotDate(rows, currentSnapshotDate) {
  const candidates = rows
    .filter((row) => !row?.isSyntheticCash)
    .map((row) => String(row?.quoteDate ?? "").trim())
    .filter((quoteDate) => quoteDate && compareDateStrings(quoteDate, currentSnapshotDate) > 0)
    .sort((left, right) => left.localeCompare(right));

  return candidates.at(-1) ?? null;
}

function isConfirmedPayloadReadyForWriteback(payload, nextSnapshotDate) {
  const confirmedState = String(payload?.confirmedNavStatus?.state ?? "").trim();
  const targetDate = String(payload?.confirmedNavStatus?.targetDate ?? "").trim();

  return (
    confirmedState === "confirmed_nav_ready" &&
    Boolean(targetDate) &&
    Boolean(nextSnapshotDate) &&
    targetDate === nextSnapshotDate
  );
}

export async function materializeLatestMarkToMarket(portfolioRoot, payload) {
  if (!isAutoMarkToMarketWritebackEnabled()) {
    return {
      updated: false,
      disabledReason: "auto_mark_to_market_writeback_disabled",
      snapshotDate: payload?.snapshotDate ?? null
    };
  }

  return {
    updated: false,
    disabledReason: "canonical_truth_writeback_retired",
    snapshotDate: payload?.snapshotDate ?? null
  };
}

export async function runLiveFundsSnapshotBuild(rawOptions = {}) {
  const refreshMs = Math.max(5000, Number(rawOptions.refreshMs ?? rawOptions["refresh-ms"]) || 60000);
  const accountId = resolveAccountId(rawOptions);
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const payload = await buildLivePayload(refreshMs, accountId);
  await persistLiveSnapshot(portfolioRoot, payload);

  return {
    accountId,
    portfolioRoot,
    outputPath: buildPortfolioPath(portfolioRoot, "data/live_funds_snapshot.json"),
    payload
  };
}

export async function getLivePayload(refreshMs, requestedAccountId, force = false, deps = {}) {
  const availableAccounts = await listAvailableAccounts();
  const accountId = pickValidAccountId(requestedAccountId, availableAccounts, activeAccountId);
  const portfolioRoot = resolvePortfolioRoot({ user: accountId });
  const dependencyKey = await buildDashboardDependencyKey(portfolioRoot);
  const now = Date.now();
  const cachedEntry = cachedPayloads.get(accountId);

  if (
    !force &&
    cachedEntry &&
    cachedEntry.dependencyKey === dependencyKey &&
    now - cachedEntry.cachedAt < cacheTtlMs
  ) {
    return cachedEntry.payload;
  }

  const inflightEntry = inflightPayloadPromises.get(accountId);
  if (!force && inflightEntry && inflightEntry.dependencyKey === dependencyKey) {
    return inflightEntry.promise;
  }

  const dashboardStatePayload = await readDashboardStatePayload(
    portfolioRoot,
    accountId,
    availableAccounts,
    refreshMs
  );
  if (shouldServePersistedDashboardState(dashboardStatePayload)) {
    cachedPayloads.set(accountId, {
      payload: dashboardStatePayload,
      cachedAt: Date.now(),
      dependencyKey
    });
    return dashboardStatePayload;
  }

  const inflightPayloadPromise = buildLivePayload(refreshMs, accountId, deps)
    .then(async (payload) => {
      cachedPayloads.set(accountId, {
        payload,
        cachedAt: Date.now(),
        dependencyKey
      });
      return payload;
    })
    .finally(() => {
      const currentInflightEntry = inflightPayloadPromises.get(accountId);
      if (currentInflightEntry?.promise === inflightPayloadPromise) {
        inflightPayloadPromises.delete(accountId);
      }
    });

  inflightPayloadPromises.set(accountId, {
    dependencyKey,
    promise: inflightPayloadPromise
  });
  return inflightPayloadPromise;
}

function htmlPage({ refreshMs, initialAccountId, availableAccounts }) {
  const optionHtml = availableAccounts
    .map(
      (item) =>
        `<option value="${item.id}"${item.id === initialAccountId ? " selected" : ""}>${item.label}</option>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>基金实时看板</title>
    <style>
      :root {
        --bg: #f3efe7;
        --panel: rgba(255, 255, 255, 0.92);
        --line: rgba(17, 24, 39, 0.1);
        --ink: #17212b;
        --muted: #64748b;
        --up: #d33f49;
        --down: #1f8b4c;
        --accent: #0f766e;
        --warn: #b45309;
        --shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      [hidden] {
        display: none !important;
      }

      body {
        margin: 0;
        font-family: "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif;
        color: var(--ink);
        font-variant-numeric: tabular-nums;
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.14), transparent 30%),
          linear-gradient(180deg, #faf6ee 0%, var(--bg) 100%);
      }

      .shell {
        width: min(94vw, 900px);
        margin: 12px auto 22px;
      }

      .window {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .topbar {
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(249, 247, 243, 0.92));
      }

      .eyebrow {
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(15, 118, 110, 0.72);
        font-weight: 700;
      }

      h1 {
        margin: 4px 0 6px;
        font-size: 24px;
        line-height: 1;
      }

      .subline {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.42;
        max-width: 760px;
      }

      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        margin-top: 10px;
        flex-wrap: wrap;
      }

      .toolbar-left {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .status {
        font-size: 11px;
        color: var(--muted);
      }

      .toolbar-chip {
        display: inline-flex;
        align-items: center;
        max-width: min(100%, 360px);
        padding: 5px 9px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        border: 1px solid rgba(15, 118, 110, 0.12);
        color: rgba(15, 118, 110, 0.92);
        font-size: 10px;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .toolbar-chip.success {
        background: rgba(15, 118, 110, 0.08);
        border-color: rgba(15, 118, 110, 0.12);
        color: rgba(15, 118, 110, 0.92);
      }

      .toolbar-chip.warn {
        background: rgba(202, 138, 4, 0.1);
        border-color: rgba(202, 138, 4, 0.18);
        color: rgba(161, 98, 7, 0.96);
      }

      .toolbar-chip.error {
        background: rgba(220, 38, 38, 0.08);
        border-color: rgba(220, 38, 38, 0.14);
        color: rgba(185, 28, 28, 0.95);
      }

      .toolbar-chip.muted {
        background: rgba(100, 116, 139, 0.08);
        border-color: rgba(100, 116, 139, 0.14);
        color: rgba(71, 85, 105, 0.96);
      }

      .account-picker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(15, 118, 110, 0.15);
        background: rgba(255, 255, 255, 0.85);
        color: var(--muted);
        font-size: 11px;
        font-weight: 600;
      }

      .account-picker select {
        border: 0;
        background: transparent;
        color: var(--ink);
        font-size: 11px;
        font-weight: 700;
        outline: none;
        cursor: pointer;
      }

      .btn {
        border: 1px solid rgba(15, 118, 110, 0.15);
        background: rgba(15, 118, 110, 0.08);
        color: var(--accent);
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }

      .btn:hover {
        background: rgba(15, 118, 110, 0.12);
      }

      .summary {
        padding: 8px 16px 7px;
        border-bottom: 1px solid var(--line);
      }

      .summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 4px;
      }

      .summary-title {
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(100, 116, 139, 0.86);
        font-weight: 700;
      }

      .summary-toggle {
        border: 1px solid rgba(15, 118, 110, 0.14);
        background: rgba(15, 118, 110, 0.06);
        color: var(--accent);
        padding: 4px 9px;
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.2;
        cursor: pointer;
      }

      .summary-toggle:hover {
        background: rgba(15, 118, 110, 0.1);
      }

      .summary-body {
        display: grid;
        gap: 6px;
      }

      .data-ribbon {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1px;
        padding: 1px;
        border-radius: 14px;
        overflow: hidden;
        background: rgba(15, 23, 42, 0.18);
        border: 1px solid rgba(15, 23, 42, 0.14);
      }

      .ribbon-item {
        min-height: 62px;
        padding: 8px 10px 7px;
        background: linear-gradient(180deg, rgba(27, 36, 50, 0.98), rgba(23, 31, 43, 0.96));
        color: #f8fafc;
      }

      .ribbon-label {
        font-size: 10px;
        color: rgba(226, 232, 240, 0.78);
        margin-bottom: 3px;
      }

      .ribbon-value {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.15;
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
        color: #f8fafc;
        white-space: nowrap;
      }

      .ribbon-value--profit {
        font-size: 17px;
      }

      .ribbon-sub {
        margin-top: 3px;
        font-size: 10px;
        color: rgba(203, 213, 225, 0.74);
      }

      .ribbon-value.flat,
      .ribbon-sub.flat {
        color: rgba(226, 232, 240, 0.8);
      }

      .ribbon-value.warn,
      .ribbon-sub.warn {
        color: #fbbf24;
      }

      .summary-collapsed-note {
        display: none;
      }

      .bucket-strip {
        padding: 8px 16px 0;
        display: grid;
        gap: 6px;
      }

      .bucket-strip-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .bucket-strip-title {
        font-size: 11px;
        font-weight: 800;
        color: var(--ink);
      }

      .bucket-strip-copy {
        display: none;
      }

      .sort-box {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 9px;
        border-radius: 11px;
        border: 1px solid rgba(100, 116, 139, 0.14);
        background: rgba(255, 255, 255, 0.78);
      }

      .sort-box label {
        font-size: 10px;
        color: var(--muted);
        white-space: nowrap;
      }

      .sort-box select {
        border: 0;
        background: transparent;
        color: var(--ink);
        font-size: 10.5px;
        font-weight: 700;
        outline: none;
        cursor: pointer;
      }

      .bucket-chip-list {
        display: grid;
        grid-template-columns: repeat(var(--bucket-chip-columns, 7), minmax(0, 1fr));
        gap: 6px;
        align-items: stretch;
      }

      .bucket-chip {
        min-width: 0;
        width: 100%;
        border: 1px solid rgba(100, 116, 139, 0.14);
        background: rgba(255, 255, 255, 0.8);
        color: var(--ink);
        border-radius: 12px;
        padding: 8px 8px 7px;
        cursor: pointer;
        text-align: left;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .bucket-chip:hover {
        transform: translateY(-1px);
        border-color: rgba(15, 118, 110, 0.28);
      }

      .bucket-chip.active {
        background: linear-gradient(180deg, rgba(27, 36, 50, 0.98), rgba(23, 31, 43, 0.96));
        border-color: rgba(15, 23, 42, 0.32);
        color: #f8fafc;
      }

      .bucket-chip.under {
        border-color: rgba(15, 118, 110, 0.24);
      }

      .bucket-chip.over {
        border-color: rgba(211, 63, 73, 0.24);
      }

      .bucket-chip-title {
        display: block;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bucket-chip-head {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }

      .bucket-chip-state {
        font-size: 8px;
        font-weight: 700;
        line-height: 1.2;
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bucket-chip.under .bucket-chip-state {
        color: var(--accent);
      }

      .bucket-chip.over .bucket-chip-state {
        color: var(--up);
      }

      .bucket-chip-meta {
        display: block;
        margin-top: 3px;
        font-size: 8.5px;
        line-height: 1.2;
        color: var(--muted);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bucket-chip.active .bucket-chip-meta {
        color: rgba(226, 232, 240, 0.78);
      }

      .bucket-chip.active .bucket-chip-state {
        color: rgba(226, 232, 240, 0.72);
      }

      .holdings-panel {
        padding: 12px 18px 0;
        display: grid;
        gap: 10px;
      }

      .holdings-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .holdings-title {
        font-size: 13px;
        font-weight: 800;
        color: var(--ink);
      }

      .holdings-summary {
        margin-top: 4px;
        font-size: 11px;
        color: var(--muted);
      }

      .holdings-asof {
        font-size: 11px;
        color: var(--muted);
        white-space: nowrap;
      }

      .bucket-board {
        display: grid;
        gap: 10px;
      }

      .bucket-card {
        border: 1px solid rgba(100, 116, 139, 0.14);
        background: rgba(255, 255, 255, 0.82);
        border-radius: 16px;
        padding: 13px 14px;
      }

      .bucket-card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .bucket-card-title-wrap {
        min-width: 0;
      }

      .bucket-card-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .bucket-card-title {
        font-size: 14px;
        font-weight: 800;
        color: var(--ink);
      }

      .bucket-card-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.08);
        color: var(--muted);
        font-size: 10px;
        line-height: 1.2;
      }

      .bucket-card-meta {
        margin-top: 4px;
        font-size: 10.5px;
        color: var(--muted);
        line-height: 1.4;
      }

      .bucket-card-toggle,
      .fold-toggle {
        border: 1px solid rgba(15, 118, 110, 0.14);
        background: rgba(15, 118, 110, 0.06);
        color: var(--accent);
        padding: 5px 10px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.2;
        cursor: pointer;
        white-space: nowrap;
      }

      .bucket-card-toggle:hover,
      .fold-toggle:hover {
        background: rgba(15, 118, 110, 0.1);
      }

      .bucket-stats {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }

      .bucket-stat-label {
        font-size: 10px;
        color: var(--muted);
      }

      .bucket-stat-value {
        margin-top: 3px;
        font-size: 14px;
        line-height: 1.18;
        font-weight: 700;
        color: var(--ink);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .bucket-card-bar-row {
        margin-top: 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
      }

      .bucket-card-gap {
        font-size: 10.5px;
        font-weight: 700;
      }

      .bucket-card-gap--under {
        color: var(--accent);
      }

      .bucket-card-gap--over {
        color: var(--down);
      }

      .bucket-card-gap--balanced {
        color: var(--muted);
      }

      .bucket-card-range {
        font-size: 10px;
        color: rgba(100, 116, 139, 0.82);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .bucket-card-bar {
        position: relative;
        margin-top: 6px;
        height: 6px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.12);
        overflow: hidden;
      }

      .bucket-card-fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, rgba(15, 118, 110, 0.86), rgba(20, 184, 166, 0.96));
      }

      .bucket-card-fill.over {
        background: linear-gradient(90deg, rgba(211, 63, 73, 0.92), rgba(248, 113, 113, 0.98));
      }

      .bucket-card-target {
        position: absolute;
        top: -2px;
        width: 2px;
        height: 10px;
        background: rgba(15, 118, 110, 0.92);
        border-radius: 999px;
        transform: translateX(-50%);
      }

      .bucket-details {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid rgba(100, 116, 139, 0.12);
        display: grid;
        gap: 8px;
      }

      .fund-lite {
        padding: 2px 0 8px;
        border-bottom: 1px solid rgba(17, 24, 39, 0.06);
      }

      .fund-lite:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }

      .fund-lite-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .fund-lite-main {
        min-width: 0;
      }

      .fund-lite-name {
        font-size: 12.5px;
        font-weight: 700;
        line-height: 1.32;
        color: var(--ink);
      }

      .fund-lite-meta {
        margin-top: 3px;
        font-size: 10px;
        color: var(--muted);
        line-height: 1.35;
      }

      .fund-lite-side {
        text-align: right;
      }

      .fund-lite-amount {
        font-size: 13px;
        font-weight: 700;
        line-height: 1.18;
        color: var(--ink);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .fund-lite-weight {
        margin-top: 3px;
        font-size: 10px;
        color: var(--muted);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .fund-lite-pnl {
        margin-top: 7px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 10.5px;
      }

      .fund-lite-pnl-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .fund-lite-pnl-label {
        color: var(--muted);
      }

      .fund-lite-pnl-value {
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
        font-weight: 700;
      }

      .all-funds-list {
        display: grid;
        gap: 10px;
      }

      .all-fund-row {
        border: 1px solid rgba(100, 116, 139, 0.12);
        background: rgba(255, 255, 255, 0.84);
        border-radius: 16px;
        padding: 12px 13px;
      }

      .all-fund-main {
        min-width: 0;
      }

      .all-fund-name {
        font-size: 12.5px;
        font-weight: 700;
        line-height: 1.32;
        color: var(--ink);
      }

      .all-fund-meta {
        margin-top: 5px;
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .holding-pill {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 0 7px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.08);
        color: rgba(71, 85, 105, 0.92);
        font-size: 10px;
        line-height: 1;
      }

      .holding-pill--warn {
        background: rgba(245, 158, 11, 0.12);
        color: rgba(180, 83, 9, 0.96);
      }

      .holding-pill--error {
        background: rgba(239, 68, 68, 0.12);
        color: rgba(185, 28, 28, 0.96);
      }

      .holding-time {
        font-size: 10px;
        color: rgba(100, 116, 139, 0.82);
      }

      .all-fund-side {
        text-align: right;
        min-width: 112px;
      }

      .all-fund-amount {
        font-size: 13px;
        font-weight: 700;
        line-height: 1.18;
        color: var(--ink);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .all-fund-weight {
        margin-top: 3px;
        font-size: 10px;
        color: var(--muted);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .all-fund-pnl {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        gap: 8px;
      }

      .all-fund-pnl-item {
        border-radius: 12px;
        background: rgba(248, 250, 252, 0.88);
        padding: 8px 9px;
        min-width: 0;
      }

      .all-fund-pnl-label {
        display: block;
        color: var(--muted);
        font-size: 10px;
      }

      .all-fund-pnl-value {
        display: block;
        margin-top: 3px;
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
        font-weight: 700;
        font-size: 12px;
        line-height: 1.2;
      }

      .fold-panels {
        padding: 10px 18px 0;
        display: grid;
        gap: 10px;
      }

      .fold-panel {
        border: 1px solid rgba(100, 116, 139, 0.14);
        background: rgba(255, 255, 255, 0.78);
        border-radius: 14px;
      }

      .fold-panel-head {
        padding: 10px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .fold-panel-title {
        font-size: 12px;
        font-weight: 800;
        color: var(--ink);
      }

      .fold-panel-summary {
        margin-top: 3px;
        font-size: 10.5px;
        color: var(--muted);
        line-height: 1.4;
      }

      .fold-panel-body {
        padding: 0 12px 12px;
      }

      .table-wrap {
        max-height: min(72vh, 820px);
        overflow: auto;
      }

      .pending-wrap {
        padding: 9px 18px 0;
        display: grid;
        gap: 8px;
      }

      .pending-panel {
        border: 1px solid rgba(180, 83, 9, 0.14);
        background: rgba(180, 83, 9, 0.07);
        border-radius: 12px;
        padding: 9px 11px;
      }

      .pending-title {
        font-size: 12px;
        color: var(--warn);
        font-weight: 700;
        margin-bottom: 8px;
      }

      .pending-item {
        font-size: 12px;
        line-height: 1.45;
        color: var(--ink);
      }

      .sort-strip {
        padding: 10px 18px 8px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .sort-strip-label {
        font-size: 11px;
        color: var(--muted);
        font-weight: 700;
      }

      .sort-strip-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .sort-chip {
        border: 1px solid rgba(100, 116, 139, 0.12);
        background: rgba(255, 255, 255, 0.86);
        color: var(--muted);
        padding: 5px 10px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.2;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
      }

      .sort-chip:hover {
        color: var(--accent);
        border-color: rgba(15, 118, 110, 0.18);
      }

      .sort-chip.active {
        color: var(--accent);
        border-color: rgba(15, 118, 110, 0.2);
        background: rgba(15, 118, 110, 0.08);
      }

      .sort-chip-indicator {
        min-width: 10px;
        font-size: 10px;
        color: rgba(100, 116, 139, 0.72);
      }

      .sort-chip.active .sort-chip-indicator {
        color: inherit;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      colgroup col:nth-child(1) {
        width: 30%;
      }

      colgroup col:nth-child(2) {
        width: 16%;
      }

      colgroup col:nth-child(3) {
        width: 16%;
      }

      colgroup col:nth-child(4) {
        width: 16%;
      }

      colgroup col:nth-child(5) {
        width: 22%;
      }

      thead th {
        position: sticky;
        top: 0;
        background: rgba(250, 247, 239, 0.96);
        z-index: 1;
        font-size: 11.5px;
        font-weight: 700;
        color: var(--muted);
        text-align: right;
        padding: 10px 10px;
        border-bottom: 1px solid var(--line);
        white-space: nowrap;
      }

      thead th:first-child,
      tbody td:first-child {
        text-align: left;
      }

      tbody tr {
        border-bottom: 1px solid rgba(17, 24, 39, 0.06);
        transition: background 140ms ease;
      }

      tbody tr:hover {
        background: rgba(15, 118, 110, 0.03);
      }

      .bucket-row td {
        padding: 7px 10px;
        background: rgba(15, 118, 110, 0.038);
        border-top: 1px solid rgba(15, 118, 110, 0.08);
        border-bottom: 1px solid rgba(15, 118, 110, 0.08);
        vertical-align: middle;
      }

      .bucket-head {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .bucket-title {
        font-size: 12px;
        font-weight: 800;
        color: var(--ink);
      }

      .bucket-meta {
        font-size: 10px;
        color: var(--muted);
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .bucket-progress {
        min-width: 0;
      }

      .bucket-progress-values {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 10.5px;
        color: var(--muted);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
        white-space: nowrap;
      }

      .bucket-progress-bar {
        margin-top: 5px;
        height: 4px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.14);
        overflow: hidden;
      }

      .bucket-progress-fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, rgba(15, 118, 110, 0.86), rgba(20, 184, 166, 0.96));
      }

      .bucket-progress-fill.over {
        background: linear-gradient(90deg, rgba(211, 63, 73, 0.92), rgba(248, 113, 113, 0.98));
      }

      .bucket-progress-sub {
        margin-top: 5px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .bucket-range-text {
        font-size: 10px;
        color: rgba(100, 116, 139, 0.86);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
        white-space: nowrap;
      }

      .bucket-range-bar {
        position: relative;
        flex: 1;
        height: 4px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.12);
        overflow: visible;
      }

      .bucket-range-marker {
        position: absolute;
        top: -2px;
        width: 2px;
        height: 8px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.92);
        transform: translateX(-50%);
      }

      .bucket-role {
        font-size: 10px;
        color: var(--muted);
        text-align: right;
        white-space: nowrap;
      }

      tbody td {
        padding: 8px 10px;
        text-align: right;
        vertical-align: middle;
        font-size: 13px;
      }

      .fund-name {
        font-weight: 700;
        line-height: 1.32;
        font-size: 13.5px;
        color: var(--ink);
      }

      .fund-sub {
        margin-top: 4px;
      }

      .meta-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .meta-chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.065);
        color: #7c8592;
        font-size: 10px;
        line-height: 1.2;
      }

      .cell-main {
        font-weight: 700;
        line-height: 1.18;
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .cell-main--quote {
        font-size: 15px;
      }

      .cell-main--amount {
        font-size: 15px;
      }

      .cell-sub {
        color: rgba(100, 116, 139, 0.78);
        font-size: 10px;
        margin-top: 3px;
        line-height: 1.25;
      }

      .stack {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }

      tbody td:first-child .stack {
        align-items: flex-start;
      }

      .allocation-stack {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        min-width: 138px;
      }

      .allocation-weight {
        font-size: 13px;
        font-weight: 700;
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .allocation-caption {
        margin-top: 2px;
        font-size: 10px;
        color: rgba(100, 116, 139, 0.8);
      }

      .allocation-split {
        margin-top: 6px;
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
        width: 100%;
      }

      .allocation-bucket-bar {
        position: relative;
        width: 82px;
        height: 5px;
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.1);
        overflow: hidden;
      }

      .allocation-bucket-fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, rgba(71, 85, 105, 0.55), rgba(100, 116, 139, 0.86));
      }

      .allocation-bucket-text {
        font-size: 10px;
        color: rgba(100, 116, 139, 0.76);
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .mini-pnl-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px 14px;
        min-width: 0;
        width: auto;
        max-width: 270px;
        margin-left: auto;
      }

      .mini-pnl-item {
        padding: 0;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .mini-pnl-label {
        font-size: 10px;
        color: var(--muted);
        line-height: 1.15;
      }

      .mini-pnl-value {
        margin-top: 0;
        font-size: 12.5px;
        font-weight: 700;
        line-height: 1.18;
        font-family: "Roboto Mono", "SFMono-Regular", "SF Mono", "Menlo", monospace;
      }

      .up {
        color: var(--up);
      }

      .down {
        color: var(--down);
      }

      .flat {
        color: var(--muted);
      }

      .stale {
        color: var(--warn);
      }

      .empty {
        padding: 24px 18px 30px;
        color: var(--muted);
        text-align: center;
      }

      .footer {
        padding: 12px 18px 16px;
        font-size: 12px;
        color: var(--muted);
        border-top: 1px solid var(--line);
      }

      @media (max-width: 720px) {
        .data-ribbon {
          grid-template-columns: 1fr;
        }

        .bucket-strip-head {
          align-items: stretch;
        }

        .sort-box {
          width: 100%;
          justify-content: space-between;
        }

        .bucket-chip-list {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .all-fund-pnl {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .bucket-stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .holdings-head,
        .fund-lite-head,
        .bucket-card-head,
        .fold-panel-head {
          flex-direction: column;
          align-items: stretch;
        }

        .mini-pnl-grid {
          min-width: 0;
          max-width: 220px;
        }

        .sort-strip {
          align-items: flex-start;
        }
      }

      @media (max-width: 640px) {
        .shell {
          width: 100vw;
          margin: 0;
        }

        .window {
          border-radius: 0;
          border-left: 0;
          border-right: 0;
        }

        .data-ribbon {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .topbar,
        .summary,
        .bucket-strip,
        .holdings-panel,
        .fold-panels,
        .pending-wrap,
        .sort-strip,
        .footer {
          padding-left: 16px;
          padding-right: 16px;
        }

        .table-wrap {
          overflow-x: auto;
        }

        table {
          min-width: 780px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="window">
        <div class="topbar">
          <div class="eyebrow">Portfolio Live View</div>
          <h1>基金实时看板</h1>
          <div class="subline">当前账户：<span id="accountLabel">${formatAccountLabel(initialAccountId)}</span>。仅展示场外基金；真钱现金与流动性防线单独展示，不含场内证券。</div>
          <div class="toolbar">
            <div class="toolbar-left">
              <label class="account-picker">
                <span>账户</span>
                <select id="accountSelect">${optionHtml}</select>
              </label>
              <div class="status" id="status">准备连接实时估值链路...</div>
              <div class="toolbar-chip muted" id="confirmedNavHeadline">确认净值状态读取中...</div>
              <div class="toolbar-chip" id="configHeadlineInline">配置读取中...</div>
            </div>
            <button class="btn" id="refreshBtn" type="button">刷新</button>
          </div>
        </div>

        <div class="summary">
          <div class="summary-head">
            <div class="summary-title">账户总览</div>
            <button class="summary-toggle" id="summaryToggleBtn" type="button">收起</button>
          </div>
          <div class="summary-body" id="summaryBody">
            <div class="data-ribbon">
              <div class="ribbon-item">
              <div class="ribbon-label">总资产</div>
              <div class="ribbon-value" id="totalAssets">--</div>
              <div class="ribbon-sub">账本资产 + 观察口径</div>
              </div>
              <div class="ribbon-item">
              <div class="ribbon-label">已投资资产</div>
              <div class="ribbon-value" id="fundMarketValue">--</div>
              <div class="ribbon-sub" id="fundCountText">--</div>
              </div>
              <div class="ribbon-item">
              <div class="ribbon-label">真现金</div>
              <div class="ribbon-value" id="settledCash">--</div>
              <div class="ribbon-sub" id="settledCashNote">--</div>
              </div>
              <div class="ribbon-item">
              <div class="ribbon-label">流动性防线</div>
              <div class="ribbon-value" id="liquiditySleeveAssets">--</div>
              <div class="ribbon-sub" id="liquiditySleeveNote">--</div>
              </div>
              <div class="ribbon-item">
              <div class="ribbon-label">今日收益</div>
              <div class="ribbon-value ribbon-value--profit" id="estimatedDailyPnl">--</div>
              <div class="ribbon-sub" id="estimatedDailyPnlRate">--</div>
              </div>
              <div class="ribbon-item">
              <div class="ribbon-label">持有收益</div>
              <div class="ribbon-value ribbon-value--profit" id="unrealizedHoldingProfit">--</div>
              <div class="ribbon-sub" id="unrealizedHoldingProfitRate">--</div>
              </div>
            </div>
          </div>
          <div class="summary-collapsed-note" id="summaryCollapsedNote" hidden>概览已折叠。</div>
        </div>

        <section class="bucket-strip" id="bucketStrip" hidden>
          <div class="bucket-strip-head">
            <div>
              <div class="bucket-strip-title">分类筛选</div>
              <div class="bucket-strip-copy">点分类直接筛卡片。</div>
            </div>
            <div class="sort-box">
              <label for="sortSelect">卡片排序</label>
              <select id="sortSelect">
                <option value="amount_desc">按市值</option>
                <option value="estimatedPnl_desc">按今日收益</option>
                <option value="holdingPnl_asc">按持亏优先</option>
                <option value="holdingPnl_desc">按持盈优先</option>
              </select>
            </div>
          </div>
          <div class="bucket-chip-list" id="bucketChips"></div>
        </section>

        <section class="holdings-panel" id="holdingsPanel" hidden>
          <div class="holdings-head">
            <div>
              <div class="holdings-title">当前持仓</div>
              <div class="holdings-summary" id="holdingsSummary">读取中...</div>
            </div>
            <div class="holdings-asof" id="holdingsAsOf">读取中...</div>
          </div>
          <div class="all-funds-list" id="fundsList"></div>
        </section>

        <div class="fold-panels">
          <section class="fold-panel" id="pendingFold" hidden>
            <div class="fold-panel-head">
              <div>
                <div class="fold-panel-title">待确认</div>
                <div class="fold-panel-summary" id="pendingFoldSummary">读取中...</div>
              </div>
              <button class="fold-toggle" id="pendingFoldToggle" type="button">展开</button>
            </div>
            <div class="fold-panel-body" id="pendingFoldBody" hidden>
              <div class="pending-wrap">
                <div class="pending-panel" id="maturedPendingPanel" hidden>
                  <div class="pending-title">应自今日起计收益，待主状态刷新确认</div>
                  <div id="maturedPendingRows"></div>
                </div>
                <div class="pending-panel" id="pendingPanel" hidden>
                  <div class="pending-title">今日申购，下一交易日起计收益</div>
                  <div id="pendingRows"></div>
                </div>
              </div>
            </div>
          </section>

        </div>

        <div class="empty" id="empty" hidden>正在加载基金实时估值...</div>
        <div class="footer">默认每 ${Math.round(refreshMs / 1000)} 秒自动刷新一次；页面优先读取 <code>data/dashboard_state.json</code> 作为产品读模型，<code>state/portfolio_state.json</code> 仍是 canonical accounting state。任何 repo 状态写回都必须走显式刷新链，不会在 GET 请求里偷偷执行。</div>
      </div>
    </div>

    <script>
      const config = {
        refreshMs: ${JSON.stringify(refreshMs)},
        currentAccount: ${JSON.stringify(initialAccountId)},
        availableAccounts: ${JSON.stringify(availableAccounts)},
        currentPayload: null,
        diagnosticsMode: loadDiagnosticsMode(),
        sortMode: loadSortMode(),
        selectedBucket: loadSelectedBucket(),
        summaryCollapsed: loadSummaryCollapsed(),
        pendingCollapsed: loadPanelCollapsed("pendingFold", true)
      };
      const elements = {
        status: document.getElementById("status"),
        accountLabel: document.getElementById("accountLabel"),
        accountSelect: document.getElementById("accountSelect"),
        confirmedNavHeadline: document.getElementById("confirmedNavHeadline"),
        configHeadlineInline: document.getElementById("configHeadlineInline"),
        summaryBody: document.getElementById("summaryBody"),
        summaryToggleBtn: document.getElementById("summaryToggleBtn"),
        summaryCollapsedNote: document.getElementById("summaryCollapsedNote"),
        totalAssets: document.getElementById("totalAssets"),
        fundMarketValue: document.getElementById("fundMarketValue"),
        fundCountText: document.getElementById("fundCountText"),
        settledCash: document.getElementById("settledCash"),
        settledCashNote: document.getElementById("settledCashNote"),
        liquiditySleeveAssets: document.getElementById("liquiditySleeveAssets"),
        liquiditySleeveNote: document.getElementById("liquiditySleeveNote"),
        unrealizedHoldingProfit: document.getElementById("unrealizedHoldingProfit"),
        unrealizedHoldingProfitRate: document.getElementById("unrealizedHoldingProfitRate"),
        estimatedDailyPnl: document.getElementById("estimatedDailyPnl"),
        estimatedDailyPnlRate: document.getElementById("estimatedDailyPnlRate"),
        bucketStrip: document.getElementById("bucketStrip"),
        bucketChips: document.getElementById("bucketChips"),
        sortSelect: document.getElementById("sortSelect"),
        holdingsPanel: document.getElementById("holdingsPanel"),
        holdingsSummary: document.getElementById("holdingsSummary"),
        holdingsAsOf: document.getElementById("holdingsAsOf"),
        fundsList: document.getElementById("fundsList"),
        maturedPendingPanel: document.getElementById("maturedPendingPanel"),
        maturedPendingRows: document.getElementById("maturedPendingRows"),
        pendingPanel: document.getElementById("pendingPanel"),
        pendingRows: document.getElementById("pendingRows"),
        pendingFold: document.getElementById("pendingFold"),
        pendingFoldSummary: document.getElementById("pendingFoldSummary"),
        pendingFoldToggle: document.getElementById("pendingFoldToggle"),
        pendingFoldBody: document.getElementById("pendingFoldBody"),
        empty: document.getElementById("empty"),
        refreshBtn: document.getElementById("refreshBtn")
      };

      let loading = false;

      function loadSummaryCollapsed() {
        try {
          return window.localStorage.getItem("funds.dashboard.summaryCollapsed") === "1";
        } catch {}

        return false;
      }

      function loadDiagnosticsMode() {
        try {
          const url = new URL(window.location.href);
          return url.searchParams.get("diagnostics") === "1";
        } catch {}

        return false;
      }

      function saveSummaryCollapsed() {
        try {
          window.localStorage.setItem(
            "funds.dashboard.summaryCollapsed",
            config.summaryCollapsed ? "1" : "0"
          );
        } catch {}
      }

      function loadSortMode() {
        try {
          return window.localStorage.getItem("funds.dashboard.sortMode") || "amount_desc";
        } catch {}

        return "amount_desc";
      }

      function saveSortMode() {
        try {
          window.localStorage.setItem("funds.dashboard.sortMode", String(config.sortMode || "amount_desc"));
        } catch {}
      }

      function loadSelectedBucket() {
        try {
          return window.localStorage.getItem("funds.dashboard.selectedBucket") || "ALL";
        } catch {}

        return "ALL";
      }

      function saveSelectedBucket() {
        try {
          window.localStorage.setItem(
            "funds.dashboard.selectedBucket",
            String(config.selectedBucket || "ALL")
          );
        } catch {}
      }

      function loadPanelCollapsed(key, fallbackValue) {
        try {
          const value = window.localStorage.getItem("funds.dashboard.panel." + key);
          if (value === "1") {
            return true;
          }
          if (value === "0") {
            return false;
          }
        } catch {}

        return fallbackValue;
      }

      function savePanelCollapsed(key, collapsed) {
        try {
          window.localStorage.setItem("funds.dashboard.panel." + key, collapsed ? "1" : "0");
        } catch {}
      }

      function sortBucketGroups(bucketGroups) {
        return bucketGroups.map((group) => ({
          ...group,
          rows: [...(Array.isArray(group?.rows) ? group.rows : [])].sort((left, right) => {
            return Number(right?.amount ?? 0) - Number(left?.amount ?? 0);
          })
        }));
      }

      function getFilteredFundRows(fundRows) {
        if (config.selectedBucket === "ALL") {
          return [...fundRows];
        }

        return fundRows.filter((row) => String(row?.bucketKey ?? "") === config.selectedBucket);
      }

      function getVisibleHoldingRows(fundRows, cashRow) {
        const filteredFunds = getFilteredFundRows(fundRows);
        const sortedFunds = getSortedFundRows(filteredFunds);
        if (config.selectedBucket === "CASH" && cashRow) {
          return [cashRow, ...sortedFunds];
        }
        if (config.selectedBucket === "ALL" && sortedFunds.length === 0 && cashRow) {
          return [cashRow];
        }
        return sortedFunds;
      }

      function getSortedFundRows(fundRows) {
        const rows = [...fundRows];
        switch (config.sortMode) {
          case "estimatedPnl_desc":
            return rows.sort((left, right) => Number(right?.estimatedPnl ?? 0) - Number(left?.estimatedPnl ?? 0));
          case "holdingPnl_asc":
            return rows.sort((left, right) => Number(left?.holdingPnl ?? 0) - Number(right?.holdingPnl ?? 0));
          case "holdingPnl_desc":
            return rows.sort((left, right) => Number(right?.holdingPnl ?? 0) - Number(left?.holdingPnl ?? 0));
          case "amount_desc":
          default:
            return rows.sort((left, right) => Number(right?.amount ?? 0) - Number(left?.amount ?? 0));
        }
      }

      function sortModeLabel(mode) {
        switch (mode) {
          case "estimatedPnl_desc":
            return "按今日收益";
          case "holdingPnl_asc":
            return "按持亏优先";
          case "holdingPnl_desc":
            return "按持盈优先";
          case "amount_desc":
          default:
            return "按市值";
        }
      }

      function renderBucketStrip(bucketGroups, fundRows) {
        if (!bucketGroups.length) {
          elements.bucketStrip.hidden = true;
          elements.bucketChips.innerHTML = "";
          elements.bucketChips.style.removeProperty("--bucket-chip-columns");
          return;
        }

        const validBucketKeys = new Set(bucketGroups.map((group) => String(group?.bucketKey ?? "")));
        if (config.selectedBucket !== "ALL" && !validBucketKeys.has(config.selectedBucket)) {
          config.selectedBucket = "ALL";
          saveSelectedBucket();
        }

        const allAmount = sumNumericValues(fundRows.map((row) => row?.amount));
        const chipsHtml = [
          (
            '<button class="bucket-chip' + (config.selectedBucket === "ALL" ? " active" : "") + '" type="button" data-bucket-filter="ALL">' +
              '<span class="bucket-chip-head">' +
                '<span class="bucket-chip-title">全部</span>' +
                '<span class="bucket-chip-state">筛选关闭</span>' +
              "</span>" +
              '<span class="bucket-chip-meta">' +
                escapeHtml(String(fundRows.length) + "只 · " + formatCurrency(allAmount)) +
              "</span>" +
            "</button>"
          ),
          ...bucketGroups.map((group) => {
            const gapState = bucketGapState(group.currentPct, group.targetPct);
            const active = config.selectedBucket === String(group?.bucketKey ?? "");
            return (
              '<button class="bucket-chip ' + escapeHtml(gapState.tone) + (active ? " active" : "") + '" type="button" data-bucket-filter="' + escapeHtml(String(group?.bucketKey ?? "")) + '">' +
                '<span class="bucket-chip-head">' +
                  '<span class="bucket-chip-title">' + escapeHtml(group.bucketLabel) + "</span>" +
                  '<span class="bucket-chip-state">' + escapeHtml(gapState.label) + "</span>" +
                "</span>" +
                '<span class="bucket-chip-meta">' +
                  escapeHtml(
                    formatPercent(group.currentPct) +
                      " / " +
                      (hasNumericValue(group.targetPct) ? formatPercent(group.targetPct) : "--") +
                      " · " +
                      String(group.fundRowCount ?? 0) +
                      "只"
                  ) +
                "</span>" +
              "</button>"
            );
          })
        ].join("");

        elements.bucketStrip.hidden = false;
        elements.bucketChips.innerHTML = chipsHtml;
        elements.bucketChips.style.setProperty(
          "--bucket-chip-columns",
          String(Math.max(bucketGroups.length + 1, 1))
        );
        elements.sortSelect.value = config.sortMode;
      }

      function renderSummaryCollapsedState() {
        elements.summaryBody.hidden = Boolean(config.summaryCollapsed);
        elements.summaryCollapsedNote.hidden = true;
        elements.summaryToggleBtn.textContent = config.summaryCollapsed ? "展开" : "收起";
      }

      function renderFoldStates() {
        elements.pendingFoldBody.hidden = Boolean(config.pendingCollapsed);
        elements.pendingFoldToggle.textContent = config.pendingCollapsed ? "展开" : "收起";
      }

      function hasNumericValue(value) {
        return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
      }

      function formatCurrency(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }

        return new Intl.NumberFormat("zh-CN", {
          style: "currency",
          currency: "CNY",
          maximumFractionDigits: 2
        }).format(Number(value));
      }

      function formatSignedCurrency(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }

        const number = Number(value);
        const formatted = formatCurrency(Math.abs(number));
        if (number > 0) {
          return "+" + formatted;
        }
        if (number < 0) {
          return "-" + formatted;
        }
        return formatted;
      }

      function formatPrice(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }

        return Number(value).toFixed(4);
      }

      function formatSignedPercent(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }

        const number = Number(value).toFixed(2);
        return (Number(value) > 0 ? "+" : "") + number + "%";
      }

      function formatPercent(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }
        return Number(value).toFixed(2) + "%";
      }

      function resolveValuationLabelForCard(row) {
        if (row?.quoteMode === "live_estimate") {
          return "盘中估值";
        }
        if (row?.quoteMode === "reference_only") {
          return "最近确认净值";
        }
        if (row?.quoteMode === "close_reference" || row?.quoteMode === "today_close") {
          return "收盘参考";
        }
        return "确认净值";
      }

      function resolveQuoteStatusForCard(row) {
        if (row?.quoteMode === "live_estimate") {
          return {
            text: "盘中估值",
            tone: "flat"
          };
        }

        if (row?.quoteMode === "reference_only") {
          return {
            text: row?.referenceSymbol ? "参考 " + row.referenceSymbol : "参考涨跌",
            tone: "flat"
          };
        }

        if (row?.quoteMode === "close_reference" || row?.quoteMode === "today_close") {
          return {
            text: "收盘参考",
            tone: "flat"
          };
        }

        const quoteDateText = String(row?.quoteDate ?? "").trim();
        if (quoteDateText) {
          return {
            text: quoteDateText + "净值",
            tone: "flat"
          };
        }

        const updateTimeText = String(row?.updateTime ?? "").trim();
        if (updateTimeText) {
          return {
            text: updateTimeText,
            tone: "flat"
          };
        }

        return {
          text: "暂无估值",
          tone: "flat"
        };
      }

      function resolvePnlLabelForCard(row) {
        return row?.quoteMode === "reference_only" ? "参考涨跌额" : "今日收益";
      }

      function resolveChangeLabelForCard(row) {
        return row?.quoteMode === "reference_only" ? "参考涨跌幅" : "今日涨跌幅";
      }

      function sumNumericValues(values) {
        return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
      }

      function bucketGapState(currentPct, targetPct) {
        const current = Number(currentPct);
        const target = Number(targetPct);
        if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
          return {
            label: "未设目标",
            tone: "balanced"
          };
        }

        const gap = current - target;
        const absGap = Math.abs(gap);
        if (absGap < 0.01) {
          return {
            label: "贴近目标",
            tone: "balanced"
          };
        }

        return {
          label: (gap > 0 ? "超配 " : "低配 ") + formatPercent(absGap),
          tone: gap > 0 ? "over" : "under"
        };
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function toneClass(value) {
        if (!hasNumericValue(value)) {
          return "flat";
        }
        if (Number(value) > 0) {
          return "up";
        }
        if (Number(value) < 0) {
          return "down";
        }
        return "flat";
      }

      function buildCashHoldingCard(row) {
        const weightText = hasNumericValue(row.currentWeightPct)
          ? "占组合 " + formatPercent(row.currentWeightPct)
          : "占组合 --";
        const targetText = hasNumericValue(row.bucketTargetPct)
          ? formatPercent(row.bucketTargetPct)
          : "--";
        const cashGapState = bucketGapState(row.currentWeightPct, row.bucketTargetPct);
        const badgesHtml = [row.code, row.bucketLabel ?? "现金", row.category]
          .filter(Boolean)
          .map((part) => '<span class="holding-pill">' + escapeHtml(part) + "</span>")
          .join("");

        return (
          '<div class="all-fund-row">' +
            '<div class="fund-lite-head">' +
              '<div class="all-fund-main">' +
                '<div class="all-fund-name">' + escapeHtml(row.name) + "</div>" +
                '<div class="all-fund-meta">' +
                  badgesHtml +
                  '<span class="holding-time">' + escapeHtml(row.updateTime ?? "账本口径") + "</span>" +
                "</div>" +
              "</div>" +
              '<div class="all-fund-side">' +
                '<div class="all-fund-amount">' + escapeHtml(formatCurrency(row.amount)) + "</div>" +
                '<div class="all-fund-weight">' + escapeHtml(weightText) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="all-fund-pnl">' +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">现金占比</span>' +
                '<span class="all-fund-pnl-value flat">' + escapeHtml(formatPercent(row.currentWeightPct)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">现金目标</span>' +
                '<span class="all-fund-pnl-value flat">' + escapeHtml(targetText) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">当前状态</span>' +
                '<span class="all-fund-pnl-value ' + escapeHtml(cashGapState.tone) + '">' + escapeHtml(cashGapState.label) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">资金口径</span>' +
                '<span class="all-fund-pnl-value flat">可用现金</span>' +
              "</div>" +
            "</div>" +
          "</div>"
        );
      }

      function buildFundHoldingCard(row, rowBucketLookup) {
        const key = String(row?.code ?? row?.name ?? "");
        const bucketLabel = rowBucketLookup.get(key) ?? row?.bucketLabel ?? row?.bucket ?? "";
        const valuationLabel = resolveValuationLabelForCard(row);
        const quoteStatus = row?.cardQuoteStatusText
          ? {
              text: row.cardQuoteStatusText,
              tone: row?.cardQuoteStatusTone ?? "flat"
            }
          : resolveQuoteStatusForCard(row);
        const pnlLabel = resolvePnlLabelForCard(row);
        const changeLabel = resolveChangeLabelForCard(row);
        const badgesHtml = [row.code, bucketLabel, row.category]
          .filter(Boolean)
          .map((part) => '<span class="holding-pill">' + escapeHtml(part) + "</span>")
          .join("");
        const profitLockBadge =
          hasNumericValue(row.profitLockedAmount) && Number(row.profitLockedAmount) > 0
            ? '<span class="holding-pill">' +
              escapeHtml(
                "待" +
                  (row.profitEffectiveOn ?? "下一交易日") +
                  "计收益 " +
                  formatCurrency(row.profitLockedAmount)
              ) +
              "</span>"
            : "";
        const latestConfirmedBadge =
          row?.cardLatestConfirmedLabel || row?.latestConfirmedLabel
            ? '<span class="holding-pill">' + escapeHtml(row.cardLatestConfirmedLabel ?? row.latestConfirmedLabel) + "</span>"
            : "";
        const overnightCarryBadge =
          hasNumericValue(row?.overnightCarryPnl)
            ? '<span class="holding-pill holding-pill--flat">' +
              escapeHtml(
                (row?.cardOvernightCarryLabel ?? row?.overnightCarryLabel ?? "待确认收益") +
                  " " +
                  formatSignedCurrency(row.overnightCarryPnl)
              ) +
              "</span>"
            : "";
        const confirmationBadge =
          row?.cardConfirmationLabel
            ? '<span class="holding-pill holding-pill--' +
              escapeHtml(row?.cardConfirmationTone === "warn" ? "warn" : "flat") +
              '">' +
              escapeHtml(row.cardConfirmationLabel) +
              "</span>"
            : "";
        const weightText = hasNumericValue(row.currentWeightPct)
          ? "占组合 " + formatPercent(row.currentWeightPct)
          : "占组合 --";

        return (
          '<div class="all-fund-row">' +
            '<div class="fund-lite-head">' +
              '<div class="all-fund-main">' +
                '<div class="all-fund-name">' + escapeHtml(row.name) + "</div>" +
                '<div class="all-fund-meta">' +
                  badgesHtml +
                  profitLockBadge +
                  latestConfirmedBadge +
                  overnightCarryBadge +
                  confirmationBadge +
                  '<span class="holding-time">' + escapeHtml(row.updateTime ?? "无估值") + "</span>" +
                "</div>" +
              "</div>" +
              '<div class="all-fund-side">' +
                '<div class="all-fund-amount">' + escapeHtml(formatCurrency(row.amount)) + "</div>" +
                '<div class="all-fund-weight">' + escapeHtml(weightText) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="all-fund-pnl">' +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">' + escapeHtml(valuationLabel) + "</span>" +
                '<span class="all-fund-pnl-value flat">' + escapeHtml(formatPrice(row.valuation)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">' + escapeHtml(pnlLabel) + "</span>" +
                '<span class="all-fund-pnl-value ' + toneClass(row.estimatedPnl) + '">' + escapeHtml(formatSignedCurrency(row.estimatedPnl)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">' + escapeHtml(changeLabel) + "</span>" +
                '<span class="all-fund-pnl-value ' + toneClass(row.changePct) + '">' + escapeHtml(formatSignedPercent(row.changePct)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">持有收益</span>' +
                '<span class="all-fund-pnl-value ' + toneClass(row.holdingPnl) + '">' + escapeHtml(formatSignedCurrency(row.holdingPnl)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">数据状态</span>' +
                '<span class="all-fund-pnl-value ' + escapeHtml(quoteStatus.tone) + '">' + escapeHtml(quoteStatus.text) + "</span>" +
              "</div>" +
              (
                config.diagnosticsMode
                  ? '<div class="all-fund-pnl-item">' +
                      '<span class="all-fund-pnl-label">净值偏离诊断</span>' +
                      '<span class="all-fund-pnl-value ' + toneClass(row.estimateDriftPnl) + '">' + escapeHtml(formatSignedCurrency(row.estimateDriftPnl)) + " / " + escapeHtml(formatSignedPercent(row.estimateDriftPct)) + "</span>" +
                    "</div>"
                  : ""
              ) +
            "</div>" +
          "</div>"
        );
      }

      function syncAccountOptions(accounts) {
        if (!Array.isArray(accounts) || accounts.length === 0) {
          return;
        }

        const currentOptions = Array.from(elements.accountSelect.options).map((option) => option.value);
        const nextOptions = accounts.map((item) => item.id);
        const changed =
          currentOptions.length !== nextOptions.length ||
          currentOptions.some((value, index) => value !== nextOptions[index]);

        if (changed) {
          elements.accountSelect.innerHTML = accounts
            .map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</option>')
            .join("");
        }

        config.availableAccounts = accounts;
        elements.accountSelect.value = config.currentAccount;
      }

      function updateAccountUrl(accountId) {
        const url = new URL(window.location.href);
        url.searchParams.set("account", accountId);
        window.history.replaceState(null, "", url);
      }

      function render(payload) {
        config.currentPayload = payload;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const fundRows = rows.filter((row) => !row?.isSyntheticCash);
        const cashRow = rows.find((row) => row?.isSyntheticCash) ?? null;
        const bucketGroups = sortBucketGroups(
          Array.isArray(payload?.bucketGroups) ? payload.bucketGroups : []
        )
          .map((group) => {
            const groupRows = Array.isArray(group?.rows) ? group.rows : [];
            const displayRows = groupRows.filter((row) => !row?.isSyntheticCash);
            const syntheticCashCount = groupRows.length - displayRows.length;
            return {
              ...group,
              displayRows,
              fundRowCount: displayRows.length,
              syntheticCashCount
            };
          })
          .filter((group) => group.displayRows.length > 0 || group.syntheticCashCount > 0);
        const pendingRows = Array.isArray(payload?.pendingRows) ? payload.pendingRows : [];
        const maturedPendingRows = Array.isArray(payload?.maturedPendingRows) ? payload.maturedPendingRows : [];
        const rowBucketLookup = new Map();
        for (const group of bucketGroups) {
          for (const row of group.displayRows) {
            const key = String(row?.code ?? row?.name ?? "");
            if (key) {
              rowBucketLookup.set(key, group.bucketLabel);
            }
          }
        }
        const accountId = payload?.accountId ?? config.currentAccount;
        const accountLabel = payload?.accountLabel ?? accountId;
        syncAccountOptions(payload?.availableAccounts ?? config.availableAccounts);
        config.currentAccount = accountId;
        elements.accountSelect.value = accountId;
        elements.accountLabel.textContent = accountLabel;
        renderSummaryCollapsedState();
        renderFoldStates();
        renderBucketStrip(bucketGroups, fundRows);

        const configHeadlineParts = [
          payload?.configuration?.activeProfileLabel,
          hasNumericValue(payload?.configuration?.absoluteEquityCapPct)
            ? "权益上限 " + formatPercent(payload.configuration.absoluteEquityCapPct)
            : "",
          hasNumericValue(payload?.configuration?.maxDrawdownLimitPct)
            ? "回撤目标 " + formatPercent(payload.configuration.maxDrawdownLimitPct)
            : ""
        ].filter(Boolean);
        elements.configHeadlineInline.textContent = configHeadlineParts.join(" · ") || "配置未标注";
        elements.configHeadlineInline.hidden = configHeadlineParts.length === 0;
        const confirmedNavHeadline = payload?.confirmedNavStatus?.label ?? {
          tone: "muted",
          text: "确认净值状态未知"
        };
        elements.confirmedNavHeadline.textContent = confirmedNavHeadline.text;
        elements.confirmedNavHeadline.className =
          "toolbar-chip " + (confirmedNavHeadline.tone || "muted");

        elements.totalAssets.textContent = formatCurrency(payload?.summary?.totalPortfolioAssets);
        elements.fundMarketValue.textContent = formatCurrency(payload?.summary?.totalFundAssets);
        elements.fundCountText.textContent =
          String(payload?.summary?.activeFundCount ?? fundRows.length) + " 只基金";
        elements.settledCash.textContent = formatCurrency(payload?.summary?.settledCashCny);
        elements.settledCash.className = "ribbon-value flat";
        elements.settledCashNote.textContent =
          hasNumericValue(payload?.summary?.tradeAvailableCashCny)
            ? "可交易 " + formatCurrency(payload?.summary?.tradeAvailableCashCny)
            : "已结算现金";
        elements.settledCashNote.className = "ribbon-sub flat";
        elements.liquiditySleeveAssets.textContent = formatCurrency(
          payload?.summary?.liquiditySleeveAssetsCny
        );
        elements.liquiditySleeveAssets.className = "ribbon-value flat";
        elements.liquiditySleeveNote.textContent =
          hasNumericValue(payload?.summary?.cashLikeFundAssetsCny)
            ? "现金类基金 " + formatCurrency(payload?.summary?.cashLikeFundAssetsCny)
            : "不计入真钱现金";
        elements.liquiditySleeveNote.className = "ribbon-sub flat";
        elements.unrealizedHoldingProfit.textContent = formatSignedCurrency(
          payload?.summary?.unrealizedHoldingProfit
        );
        elements.unrealizedHoldingProfit.className =
          "ribbon-value ribbon-value--profit " + toneClass(payload?.summary?.unrealizedHoldingProfit);
        elements.unrealizedHoldingProfitRate.textContent =
          hasNumericValue(payload?.summary?.unrealizedHoldingProfitRatePct)
            ? "收益率 " + formatSignedPercent(payload?.summary?.unrealizedHoldingProfitRatePct)
            : "持仓浮盈亏";
        elements.unrealizedHoldingProfitRate.className =
          "ribbon-sub " + toneClass(payload?.summary?.unrealizedHoldingProfitRatePct);
        const displayDailyPnl =
          payload?.summary?.displayDailyPnl ?? payload?.summary?.estimatedDailyPnl;
        const displayDailyPnlRatePct =
          payload?.summary?.displayDailyPnlRatePct ?? payload?.summary?.estimatedDailyPnlRatePct;
        const displayDailyPnlMode = String(payload?.summary?.estimatedDailyPnlMode ?? "accounting");
        elements.estimatedDailyPnl.textContent = formatSignedCurrency(displayDailyPnl);
        elements.estimatedDailyPnl.className =
          "ribbon-value ribbon-value--profit " + toneClass(displayDailyPnl);
        const estimatedDailyNotes = [];
        if (hasNumericValue(payload?.summary?.profitLockedAmount) && Number(payload.summary.profitLockedAmount) > 0) {
          estimatedDailyNotes.push("已剔除待下一交易日计收益 " + formatCurrency(payload.summary.profitLockedAmount));
        }
        if (
          hasNumericValue(payload?.summary?.pendingOverseasConfirmedPnl) &&
          Number(payload.summary.pendingOverseasConfirmedPnl) !== 0
        ) {
          estimatedDailyNotes.push(
            (payload?.summary?.pendingOverseasConfirmedLabel ?? "海外待确认") +
              " " +
              formatSignedCurrency(payload.summary.pendingOverseasConfirmedPnl)
          );
        }
        elements.estimatedDailyPnlRate.textContent =
          estimatedDailyNotes.length > 0
            ? estimatedDailyNotes.join(" · ")
            : displayDailyPnlMode === "observation"
              ? (
                  hasNumericValue(displayDailyPnlRatePct)
                    ? "观察口径 " + formatSignedPercent(displayDailyPnlRatePct)
                    : "观察口径 · 账本快照待更新"
                )
              : hasNumericValue(displayDailyPnlRatePct)
                ? "收益率 " + formatSignedPercent(displayDailyPnlRatePct)
              : "当前暂无最新估值";
        elements.estimatedDailyPnlRate.className =
          "ribbon-sub " +
          ((estimatedDailyNotes.length > 0) ||
          !hasNumericValue(displayDailyPnlRatePct)
            ? "flat"
            : toneClass(displayDailyPnlRatePct));

        const visibleHoldingRows = getVisibleHoldingRows(fundRows, cashRow);
        if (visibleHoldingRows.length > 0) {
          const visibleFundRows = visibleHoldingRows.filter((row) => !row?.isSyntheticCash);
          const cashVisible = visibleHoldingRows.some((row) => row?.isSyntheticCash);
          const visibleHoldingAmount = sumNumericValues(visibleHoldingRows.map((row) => row?.amount));
          const latestQuoteTime =
            payload?.summary?.latestQuoteTime ||
            visibleHoldingRows
              .map((row) => String(row?.updateTime ?? "").trim())
              .filter(Boolean)
              .sort((left, right) => left.localeCompare(right))
              .at(-1) ||
            "暂无盘中估值";
          const activeBucketGroup =
            config.selectedBucket === "ALL"
              ? null
              : bucketGroups.find((group) => String(group?.bucketKey ?? "") === config.selectedBucket) ?? null;
          const holdingsTitle =
            activeBucketGroup?.bucketLabel
              ? activeBucketGroup.bucketLabel +
                " · " +
                (
                  cashVisible
                    ? (visibleFundRows.length > 0 ? String(visibleFundRows.length) + "只基金 + 现金" : "现金头寸")
                    : String(visibleFundRows.length) + "只"
                )
              : "全部基金 · " + String(visibleFundRows.length) + "只";

          elements.holdingsPanel.hidden = false;
          elements.holdingsSummary.textContent =
            holdingsTitle + " · 当前金额 " + formatCurrency(visibleHoldingAmount) + " · " + sortModeLabel(config.sortMode);
          elements.holdingsAsOf.textContent =
            "最新估值 " +
            latestQuoteTime +
            " · 今日更新 " +
            String(payload?.summary?.freshFundCount ?? visibleFundRows.length) +
            (cashVisible ? " 只基金 + 现金" : " 只");

          elements.fundsList.innerHTML = visibleHoldingRows
            .map((row) => row?.isSyntheticCash ? buildCashHoldingCard(row) : buildFundHoldingCard(row, rowBucketLookup))
            .join("");
        } else {
          elements.bucketStrip.hidden = true;
          elements.bucketChips.innerHTML = "";
          elements.holdingsPanel.hidden = true;
          elements.holdingsSummary.textContent = "当前没有 active 基金持仓";
          elements.holdingsAsOf.textContent = "--";
          elements.fundsList.innerHTML = "";
        }

        const pendingCount = maturedPendingRows.length + pendingRows.length;
        const pendingAmount = sumNumericValues([
          ...maturedPendingRows.map((row) => row?.amount),
          ...pendingRows.map((row) => row?.amount)
        ]);

        if (maturedPendingRows.length > 0) {
          elements.maturedPendingPanel.hidden = false;
          elements.maturedPendingRows.innerHTML = maturedPendingRows
            .map((row) =>
              '<div class="pending-item">' +
                escapeHtml(row.name) +
                " · " +
                escapeHtml(formatCurrency(row.amount)) +
                " · 应自 " +
                escapeHtml(row.profitEffectiveOn ?? "--") +
                " 起参与今日收益，待主状态刷新确认" +
              "</div>"
            )
            .join("");
        } else {
          elements.maturedPendingPanel.hidden = true;
          elements.maturedPendingRows.innerHTML = "";
        }

        if (pendingRows.length > 0) {
          elements.pendingPanel.hidden = false;
          elements.pendingRows.innerHTML = pendingRows
            .map((row) =>
              '<div class="pending-item">' +
                escapeHtml(row.name) +
                " · " +
                escapeHtml(formatCurrency(row.amount)) +
                " · 自 " +
                escapeHtml(row.profitEffectiveOn ?? "--") +
                " 起开始计收益" +
              "</div>"
            )
            .join("");
        } else {
          elements.pendingPanel.hidden = true;
          elements.pendingRows.innerHTML = "";
        }

        if (pendingCount > 0) {
          elements.pendingFold.hidden = false;
          elements.pendingFoldSummary.textContent =
            String(pendingCount) + " 笔 · " + formatCurrency(pendingAmount);
        } else {
          elements.pendingFold.hidden = true;
          elements.pendingFoldSummary.textContent = "当前没有待确认申购";
        }

        if (fundRows.length === 0 && !cashRow) {
          elements.empty.hidden = false;
          elements.empty.textContent = "当前没有 active 基金持仓。";
          return;
        }

        elements.empty.hidden = true;
      }

      function renderBlockedPayload(payload) {
        config.currentPayload = payload;
        syncAccountOptions(payload?.availableAccounts ?? config.availableAccounts);
        const accountId = payload?.accountId ?? config.currentAccount;
        config.currentAccount = accountId;
        elements.accountSelect.value = accountId;
        elements.accountLabel.textContent = payload?.accountLabel ?? accountId;
        elements.confirmedNavHeadline.textContent = "账户状态未就绪";
        elements.confirmedNavHeadline.className = "toolbar-chip warn";
        elements.configHeadlineInline.hidden = true;
        elements.totalAssets.textContent = "--";
        elements.fundMarketValue.textContent = "--";
        elements.fundCountText.textContent = "0 只基金";
        elements.settledCash.textContent = "--";
        elements.settledCash.className = "ribbon-value flat";
        elements.settledCashNote.textContent = "无已结算现金口径";
        elements.settledCashNote.className = "ribbon-sub flat";
        elements.liquiditySleeveAssets.textContent = "--";
        elements.liquiditySleeveAssets.className = "ribbon-value flat";
        elements.liquiditySleeveNote.textContent = "无流动性防线账本";
        elements.liquiditySleeveNote.className = "ribbon-sub flat";
        elements.unrealizedHoldingProfit.textContent = "--";
        elements.unrealizedHoldingProfit.className = "ribbon-value ribbon-value--profit flat";
        elements.unrealizedHoldingProfitRate.textContent = "持仓浮盈亏";
        elements.unrealizedHoldingProfitRate.className = "ribbon-sub flat";
        elements.estimatedDailyPnl.textContent = "--";
        elements.estimatedDailyPnl.className = "ribbon-value ribbon-value--profit flat";
        elements.estimatedDailyPnlRate.textContent = "账户未初始化";
        elements.estimatedDailyPnlRate.className = "ribbon-sub flat";
        elements.bucketStrip.hidden = true;
        elements.bucketChips.innerHTML = "";
        elements.holdingsPanel.hidden = true;
        elements.holdingsSummary.textContent = "当前没有 active 基金持仓";
        elements.holdingsAsOf.textContent = "--";
        elements.fundsList.innerHTML = "";
        elements.maturedPendingPanel.hidden = true;
        elements.maturedPendingRows.innerHTML = "";
        elements.pendingPanel.hidden = true;
        elements.pendingRows.innerHTML = "";
        elements.pendingFold.hidden = true;
        elements.pendingFoldSummary.textContent = "当前没有待确认申购";
        elements.empty.hidden = false;
        const reasons = Array.isArray(payload?.readiness?.reasons) ? payload.readiness.reasons : [];
        elements.empty.textContent =
          reasons.length > 0
            ? "当前账户尚未初始化：" + reasons.join("；")
            : "当前账户尚未初始化。";
      }

      async function refreshData(manual) {
        if (loading) {
          return;
        }

        loading = true;
        elements.status.textContent = manual ? "手动刷新中..." : "正在刷新实时估值...";

        try {
          const url = new URL("/api/live-funds", window.location.origin);
          url.searchParams.set("ts", String(Date.now()));
          url.searchParams.set("account", config.currentAccount);
          const response = await fetch(url, {
            cache: "no-store"
          });

          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }

          const payload = await response.json();
          if (payload?.error === "live_dashboard_blocked") {
            renderBlockedPayload(payload);
            elements.status.textContent = "账户未初始化，当前仅展示阻塞状态";
            return;
          }

          render(payload);
          const generatedAt = new Date(payload.generatedAt);
          const timeText = Number.isFinite(generatedAt.getTime())
            ? generatedAt.toLocaleString("zh-CN", { hour12: false })
            : payload.generatedAt;
          const unresolved = Number(payload?.summary?.unresolvedFundCount ?? 0);
          const unresolvedText = unresolved > 0 ? "，仍有 " + unresolved + " 只未映射" : "";
          elements.status.textContent =
            "已更新 " + timeText + " · " + Math.round(config.refreshMs / 1000) + " 秒自动刷新" + unresolvedText;
        } catch (error) {
          elements.status.textContent = "刷新失败：" + String(error?.message ?? error);
          if (!elements.fundsList.innerHTML) {
            elements.empty.hidden = false;
            elements.empty.textContent = "实时估值拉取失败，请稍后重试。";
          }
        } finally {
          loading = false;
        }
      }

      elements.accountSelect.addEventListener("change", (event) => {
        config.currentAccount = event.target.value;
        updateAccountUrl(config.currentAccount);
        refreshData(true);
      });
      elements.summaryToggleBtn.addEventListener("click", () => {
        config.summaryCollapsed = !config.summaryCollapsed;
        saveSummaryCollapsed();
        renderSummaryCollapsedState();
      });
      elements.pendingFoldToggle.addEventListener("click", () => {
        config.pendingCollapsed = !config.pendingCollapsed;
        savePanelCollapsed("pendingFold", config.pendingCollapsed);
        renderFoldStates();
      });
      elements.bucketChips.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-bucket-filter]");
        if (!chip) {
          return;
        }

        const bucketKey = String(chip.dataset.bucketFilter ?? "ALL") || "ALL";
        if (config.selectedBucket === bucketKey) {
          return;
        }
        config.selectedBucket = bucketKey;
        saveSelectedBucket();
        if (config.currentPayload) {
          render(config.currentPayload);
        }
      });
      elements.sortSelect.addEventListener("change", (event) => {
        const nextMode = String(event.target.value || "amount_desc");
        if (!nextMode) {
          return;
        }
        config.sortMode = nextMode;
        saveSortMode();
        if (config.currentPayload) {
          render(config.currentPayload);
        }
      });
      elements.refreshBtn.addEventListener("click", () => refreshData(true));
      updateAccountUrl(config.currentAccount);
      renderSummaryCollapsedState();
      renderFoldStates();
      refreshData(false);
      window.setInterval(() => refreshData(false), config.refreshMs);
    </script>
  </body>
</html>`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

async function maybeOpenBrowser(url, shouldOpen) {
  if (!shouldOpen) {
    return;
  }

  spawn("open", [url], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

let backgroundRefreshTimer = null;

function startBackgroundRefresh(refreshMs) {
  if (backgroundRefreshTimer) {
    clearInterval(backgroundRefreshTimer);
  }

  backgroundRefreshTimer = setInterval(async () => {
    try {
      const accounts = await listAvailableAccounts();
      const targets =
        Array.isArray(accounts) && accounts.length > 0
          ? accounts.map((item) => item.id)
          : [activeAccountId];

      await Promise.all(
        targets.map((accountId) => getLivePayload(refreshMs, accountId, true).catch(() => null))
      );
    } catch (error) {
      console.warn(
        JSON.stringify(
          {
            status: "background_refresh_failed",
            message: String(error?.message ?? error)
          },
          null,
          2
        )
      );
    }
  }, Math.max(Number(refreshMs) || defaultRefreshMs, 15_000));
}

const args = parseArgs(process.argv.slice(2));

export function createFundsLiveDashboardServer(runtimeArgs = parseArgs(process.argv.slice(2))) {
  activePortfolioRoot = resolvePortfolioRoot(runtimeArgs);
  activeAccountId = resolveAccountId(runtimeArgs);

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${runtimeArgs.host}:${runtimeArgs.port}`);

    try {
      if (requestUrl.pathname === "/api/live-funds") {
        const force = requestUrl.searchParams.get("force") === "1";
        const requestedAccountId = requestUrl.searchParams.get("account") || activeAccountId;
        const payload = await getLivePayload(runtimeArgs.refreshMs, requestedAccountId, force);
        sendJson(response, 200, payload);
        return;
      }

      if (requestUrl.pathname === "/api/live-funds/health") {
        const requestedAccountId = requestUrl.searchParams.get("account") || activeAccountId;
        try {
          const payload = await getLivePayload(runtimeArgs.refreshMs, requestedAccountId, false);
          sendJson(response, 200, buildLiveHealthPayload(payload));
        } catch (error) {
          const payload = error?.readiness ?? (await buildFundsDashboardHealth(requestedAccountId));
          sendJson(response, 200, payload);
        }
        return;
      }

      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
        const availableAccounts = await listAvailableAccounts();
        const initialAccountId = pickValidAccountId(
          requestUrl.searchParams.get("account"),
          availableAccounts,
          activeAccountId
        );
        sendHtml(
          response,
          htmlPage({
            refreshMs: runtimeArgs.refreshMs,
            initialAccountId,
            availableAccounts
          })
        );
        return;
      }

      sendJson(response, 404, {
        error: "not_found",
        path: requestUrl.pathname
      });
    } catch (error) {
      const readiness = error?.readiness ?? null;
      if (readiness?.state === "blocked") {
        const availableAccounts = await listAvailableAccounts();
        const accountId = readiness?.accountId ?? resolveAccountId();
        sendJson(response, 200, {
          generatedAt: new Date().toISOString(),
          error: "live_dashboard_blocked",
          message: String(error?.message ?? error),
          readiness,
          accountId,
          accountLabel: formatAccountLabel(accountId),
          availableAccounts
        });
        return;
      }

      sendJson(response, 500, {
        error: "live_dashboard_failed",
        message: String(error?.message ?? error),
        readiness
      });
    }
  });

  server.on("error", (error) => {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          host: runtimeArgs.host,
          port: runtimeArgs.port,
          error: String(error?.message ?? error)
        },
        null,
        2
      )
    );
    process.exit(1);
  });

  return server;
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const server = createFundsLiveDashboardServer(args);
  server.listen(args.port, args.host, async () => {
    const url = `http://${args.host}:${args.port}`;
    startBackgroundRefresh(args.refreshMs);
    getLivePayload(args.refreshMs, activeAccountId, true).catch(() => null);
    await maybeOpenBrowser(`${url}/?account=${encodeURIComponent(activeAccountId)}`, args.open);
    console.log(
      JSON.stringify(
        {
          status: "listening",
          accountId: activeAccountId,
          portfolioRoot: activePortfolioRoot,
          host: args.host,
          port: args.port,
          url,
          refreshMs: args.refreshMs
        },
        null,
        2
      )
    );
  });
}
