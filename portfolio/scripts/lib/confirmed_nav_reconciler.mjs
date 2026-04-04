import { applyCanonicalFundIdentity, getFundIdentityAliases, normalizeFundName } from "./fund_identity.mjs";
import {
  classifyFundConfirmation,
  summarizeFundConfirmationStates
} from "./fund_confirmation_policy.mjs";

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeCode(code) {
  return String(code ?? "").trim();
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveCurrentNetValue(quote) {
  return toFiniteNumber(quote?.netValue ?? quote?.valuation);
}

function resolveChangePct(quote) {
  return toFiniteNumber(quote?.growthRate ?? quote?.valuationChangePercent);
}

function buildQuoteIndex(quotes = []) {
  const byCode = new Map();
  const byName = new Map();

  for (const quote of quotes) {
    const aliases = getFundIdentityAliases({
      code: quote?.code,
      name: quote?.name
    });
    const canonicalQuote = applyCanonicalFundIdentity(quote);

    for (const identity of aliases) {
      const code = normalizeCode(identity?.code);
      const normalizedName = normalizeFundName(identity?.name);
      if (code) {
        byCode.set(code, canonicalQuote);
      }
      if (normalizedName) {
        byName.set(normalizedName, canonicalQuote);
      }
    }

    const canonicalCode = normalizeCode(canonicalQuote?.code);
    const canonicalName = normalizeFundName(canonicalQuote?.name);
    if (canonicalCode) {
      byCode.set(canonicalCode, canonicalQuote);
    }
    if (canonicalName) {
      byName.set(canonicalName, canonicalQuote);
    }
  }

  return {
    byCode,
    byName
  };
}

function buildAssetIndex(assetMaster = null) {
  const byCode = new Map();
  const byName = new Map();

  for (const asset of assetMaster?.assets ?? []) {
    const code = normalizeCode(asset?.symbol ?? asset?.ticker);
    const name = normalizeFundName(asset?.name);
    if (code) {
      byCode.set(code, asset);
    }
    if (name) {
      byName.set(name, asset);
    }
  }

  return {
    byCode,
    byName
  };
}

function resolveQuote(index, target) {
  const identities = getFundIdentityAliases(target);
  for (const identity of identities) {
    const code = normalizeCode(identity?.code);
    if (code && index.byCode.has(code)) {
      return index.byCode.get(code);
    }
  }

  for (const identity of identities) {
    const normalizedName = normalizeFundName(identity?.name);
    if (normalizedName && index.byName.has(normalizedName)) {
      return index.byName.get(normalizedName);
    }
  }

  return null;
}

function resolveAsset(index, target) {
  const identities = getFundIdentityAliases(target);
  for (const identity of identities) {
    const code = normalizeCode(identity?.code);
    if (code && index.byCode.has(code)) {
      return index.byCode.get(code);
    }
  }

  for (const identity of identities) {
    const normalizedName = normalizeFundName(identity?.name);
    if (normalizedName && index.byName.has(normalizedName)) {
      return index.byName.get(normalizedName);
    }
  }

  return null;
}

function normalizeDateText(value) {
  return String(value ?? "").trim() || null;
}

export function computeConfirmedDailyPnl({
  amount,
  eligibleAmount = amount,
  confirmedUnits = null,
  quote
}) {
  const currentAmount = toFiniteNumber(amount);
  const eligibleAmountValue = toFiniteNumber(eligibleAmount);
  const currentNetValue = resolveCurrentNetValue(quote);
  const changePct = resolveChangePct(quote);
  const units = toFiniteNumber(confirmedUnits);
  const impliedUnits =
    currentAmount !== null && currentNetValue !== null && currentNetValue > 0
      ? currentAmount / currentNetValue
      : null;

  if (
    currentAmount !== null &&
    eligibleAmountValue !== null &&
    currentNetValue !== null &&
    currentNetValue > 0 &&
    changePct !== null &&
    changePct > -100
  ) {
    const storedAmount =
      units !== null && units > 0 ? units * currentNetValue : null;
    const storedUnitsAligned =
      storedAmount !== null &&
      currentAmount > 0 &&
      Math.abs(storedAmount - currentAmount) / currentAmount <= 0.005;
    const effectiveUnits =
      storedUnitsAligned && units !== null && units > 0
        ? units
        : impliedUnits;
    if (effectiveUnits === null || effectiveUnits <= 0) {
      return round((eligibleAmountValue * changePct) / 100);
    }
    const eligibleUnits =
      currentAmount > 0
        ? effectiveUnits * Math.max(Math.min(eligibleAmountValue / currentAmount, 1), 0)
        : effectiveUnits;
    const previousNetValue = currentNetValue / (1 + changePct / 100);
    return round(eligibleUnits * (currentNetValue - previousNetValue));
  }

  if (eligibleAmountValue !== null && changePct !== null) {
    return round((eligibleAmountValue * changePct) / 100);
  }

  return null;
}

function reconcileWatchlistWithPositions(watchlistConfig, positionsByCode) {
  if (!watchlistConfig || !Array.isArray(watchlistConfig.watchlist)) {
    return watchlistConfig;
  }

  const next = clone(watchlistConfig);
  next.watchlist = next.watchlist.map((item) => {
    const canonicalItem = applyCanonicalFundIdentity(item);
    const match =
      positionsByCode.get(normalizeCode(canonicalItem?.code)) ??
      positionsByCode.get(normalizeCode(item?.code)) ??
      null;

    if (!match) {
      return canonicalItem;
    }

    return {
      ...canonicalItem,
      approxCurrentAmountCny: round(Number(match.amount ?? canonicalItem.approxCurrentAmountCny ?? 0)),
      note: canonicalItem.note ?? item?.note ?? null
    };
  });
  return next;
}

export function reconcileRawSnapshotWithConfirmedQuotes({
  rawSnapshot,
  quotes,
  asOfDate = "",
  watchlistConfig = null,
  assetMaster = null
}) {
  const nextRaw = clone(rawSnapshot ?? {});
  const nextWatchlist = clone(watchlistConfig);
  const quoteIndex = buildQuoteIndex(Array.isArray(quotes) ? quotes : []);
  const assetIndex = buildAssetIndex(assetMaster);
  const positions = Array.isArray(nextRaw.positions) ? nextRaw.positions : [];
  const positionsByCode = new Map();
  const asOfDateText = normalizeDateText(asOfDate);
  let updatedPositions = 0;
  let migratedPositions = 0;
  const plannedUpdates = [];
  const stalePositions = [];
  const confirmationStates = [];

  for (const position of positions) {
    if (String(position?.execution_type ?? "OTC").toUpperCase() === "EXCHANGE") {
      continue;
    }
    if (String(position?.status ?? "active").trim() !== "active") {
      continue;
    }

    const canonicalPosition = applyCanonicalFundIdentity(position);
    const asset = resolveAsset(assetIndex, canonicalPosition);
    const quote = resolveQuote(quoteIndex, canonicalPosition);
    const currentNetValue = resolveCurrentNetValue(quote);
    const quoteDate = normalizeDateText(quote?.netValueDate);
    const confirmation = classifyFundConfirmation({
      targetDate: asOfDateText,
      confirmedNavDate: quoteDate,
      asset,
      position: canonicalPosition
    });
    if (
      !quote ||
      currentNetValue === null ||
      currentNetValue <= 0 ||
      !confirmation.isWithinExpectedWindow
    ) {
      if (asOfDateText && ["late_missing", "source_missing"].includes(confirmation.state)) {
        stalePositions.push({
          code: normalizeCode(canonicalPosition?.code ?? position?.code),
          name: String(canonicalPosition?.name ?? position?.name ?? "").trim() || null,
          quoteDate,
          state: confirmation.state,
          expectedConfirmedDate: confirmation.expectedConfirmedDate
        });
      }
      confirmationStates.push({ confirmationState: confirmation.state });
      positionsByCode.set(normalizeCode(position?.code), position);
      continue;
    }

    plannedUpdates.push({
      position,
      canonicalPosition,
      quote,
      confirmation
    });
  }

  for (const { position, canonicalPosition, quote, confirmation } of plannedUpdates) {
    const currentNetValue = resolveCurrentNetValue(quote);
    const originalCode = normalizeCode(position?.code ?? position?.symbol ?? position?.fund_code);
    const originalName = String(position?.name ?? "").trim();
    if (
      canonicalPosition.code !== originalCode ||
      canonicalPosition.name !== originalName
    ) {
      migratedPositions += 1;
    }
    Object.assign(position, canonicalPosition);

    const previousAmount = toFiniteNumber(position?.amount) ?? 0;
    const previousHoldingPnl = toFiniteNumber(position?.holding_pnl);
    const costBasis = previousHoldingPnl === null ? null : previousAmount - previousHoldingPnl;
    const confirmedUnits =
      toFiniteNumber(position?.confirmed_units) ??
      (previousAmount > 0 ? previousAmount / currentNetValue : null);
    const reconciledAmount =
      confirmedUnits !== null && confirmedUnits > 0
        ? round(confirmedUnits * currentNetValue)
        : previousAmount;

    position.confirmed_units =
      confirmedUnits !== null && confirmedUnits > 0 ? round(confirmedUnits, 8) : null;
    position.amount = reconciledAmount;
    position.daily_pnl = computeConfirmedDailyPnl({
      amount: reconciledAmount,
      eligibleAmount: reconciledAmount,
      confirmedUnits,
      quote
    });
    if (costBasis !== null) {
      position.holding_pnl = round(reconciledAmount - costBasis);
      position.holding_pnl_rate_pct =
        costBasis > 0 ? round(((reconciledAmount - costBasis) / costBasis) * 100) : 0;
    }
    position.last_confirmed_nav = round(currentNetValue, 4);
    position.last_confirmed_nav_date =
      String(quote?.netValueDate ?? "").trim() || String(asOfDate ?? "").trim() || null;
    position.last_confirmed_nav_time = String(quote?.valuationTime ?? "").trim() || null;
    position.dialogue_merge_status = "confirmed_nav_reconciled";
    position.confirmation_state = confirmation.state;
    position.expected_confirmed_nav_date = confirmation.expectedConfirmedDate;

    positionsByCode.set(normalizeCode(position?.code), position);
    confirmationStates.push({ confirmationState: confirmation.state });
    updatedPositions += 1;
  }

  const totalFundAssets = round(
    positions
      .filter((position) => String(position?.status ?? "active").trim() === "active")
      .reduce((sum, position) => sum + Number(position?.amount ?? 0), 0)
  );
  const totalHoldingPnl = round(
    positions
      .filter((position) => String(position?.status ?? "active").trim() === "active")
      .reduce((sum, position) => sum + Number(position?.holding_pnl ?? 0), 0)
  );
  const totalDailyPnl = round(
    positions
      .filter((position) => String(position?.status ?? "active").trim() === "active")
      .reduce((sum, position) => sum + Number(position?.daily_pnl ?? 0), 0)
  );
  const availableCash = round(
    Number(
      nextRaw?.cash_ledger?.available_cash_cny ??
        nextRaw?.summary?.available_cash_cny ??
        0
    )
  );

  nextRaw.summary = nextRaw.summary ?? {};
  nextRaw.summary.total_fund_assets = totalFundAssets;
  nextRaw.summary.effective_exposure_after_pending_sell = totalFundAssets;
  nextRaw.summary.yesterday_profit = totalDailyPnl;
  nextRaw.summary.holding_profit = totalHoldingPnl;
  nextRaw.summary.available_cash_cny = availableCash;
  nextRaw.summary.total_portfolio_assets_cny = round(totalFundAssets + availableCash);
  nextRaw.summary.performance_precision = "confirmed_nav_reconciled_close";
  nextRaw.summary.last_confirmed_nav_reconcile_at = new Date().toISOString();
  nextRaw.snapshot_date =
    asOfDateText ||
    (positions
      .map((position) => String(position?.last_confirmed_nav_date ?? "").trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .at(-1) ??
      nextRaw.snapshot_date);
  nextRaw.recognition_notes = Array.isArray(nextRaw.recognition_notes)
    ? nextRaw.recognition_notes
    : [];
  nextRaw.recognition_notes.push(
    `${nextRaw.snapshot_date} 夜间确认净值校准完成：刷新 ${updatedPositions} 只 OTC 基金，迁移 ${migratedPositions} 条份额身份映射。`
  );

  nextRaw.cash_ledger = nextRaw.cash_ledger ?? {};
  nextRaw.cash_ledger.available_cash_cny = availableCash;
  nextRaw.raw_account_snapshot = nextRaw.raw_account_snapshot ?? {};
  nextRaw.raw_account_snapshot.total_fund_assets = totalFundAssets;
  nextRaw.raw_account_snapshot.effective_exposure_after_pending_sell = totalFundAssets;
  const confirmationSummary = summarizeFundConfirmationStates(confirmationStates);

  return {
    rawSnapshot: nextRaw,
    watchlistConfig: reconcileWatchlistWithPositions(nextWatchlist, positionsByCode),
    stats: {
      updatedPositions,
      migratedPositions,
      totalFundAssets,
      totalDailyPnl,
      totalHoldingPnl,
      fullyConfirmedForDate:
        confirmationSummary.totalFundCount > 0 &&
        confirmationSummary.confirmedFundCount === confirmationSummary.totalFundCount,
      stalePositions,
      ...confirmationSummary
    }
  };
}
