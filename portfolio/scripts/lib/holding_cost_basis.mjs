import { round } from "./format_utils.mjs";

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveHoldingUnits(position = {}) {
  const explicitUnits = toFiniteNumber(position?.units);
  if (explicitUnits !== null && explicitUnits >= 0) {
    return explicitUnits;
  }

  const confirmedUnits = toFiniteNumber(position?.confirmed_units);
  if (confirmedUnits !== null && confirmedUnits >= 0) {
    return confirmedUnits;
  }

  return null;
}

function resolveHoldingNav(position = {}, explicitNav = null) {
  const preferred = toFiniteNumber(explicitNav);
  if (preferred !== null && preferred > 0) {
    return preferred;
  }

  const lastConfirmed = toFiniteNumber(position?.last_confirmed_nav);
  if (lastConfirmed !== null && lastConfirmed > 0) {
    return lastConfirmed;
  }

  return null;
}

export function deriveCanonicalHoldingSnapshot(position = {}, { nav = null } = {}) {
  const units = resolveHoldingUnits(position);
  const resolvedNav = resolveHoldingNav(position, nav);
  const costBasis = resolveHoldingCostBasis(position);
  const fallbackAmount = toFiniteNumber(position?.amount);
  const fallbackHoldingPnl = toFiniteNumber(position?.holding_pnl);
  const fallbackHoldingPnlRatePct = toFiniteNumber(position?.holding_pnl_rate_pct);
  const derivedFromCanonicalTruth =
    units !== null && units >= 0 && resolvedNav !== null && resolvedNav > 0;

  if (derivedFromCanonicalTruth) {
    const amountCny = round(units * resolvedNav);
    const holdingPnlCny =
      costBasis !== null ? round(amountCny - costBasis) : fallbackHoldingPnl;
    const holdingPnlRatePct =
      costBasis !== null
        ? costBasis > 0
          ? round((holdingPnlCny / costBasis) * 100)
          : 0
        : fallbackHoldingPnlRatePct;

    return {
      units: round(units, 8),
      nav: round(resolvedNav, 4),
      costBasisCny: costBasis,
      amountCny,
      holdingPnlCny,
      holdingPnlRatePct,
      derivedFromCanonicalTruth
    };
  }

  return {
    units,
    nav: resolvedNav,
    costBasisCny: costBasis,
    amountCny: fallbackAmount,
    holdingPnlCny:
      fallbackAmount !== null && costBasis !== null
        ? round(fallbackAmount - costBasis)
        : fallbackHoldingPnl,
    holdingPnlRatePct:
      fallbackAmount !== null && costBasis !== null
        ? costBasis > 0
          ? round(((fallbackAmount - costBasis) / costBasis) * 100)
          : 0
        : fallbackHoldingPnlRatePct,
    derivedFromCanonicalTruth
  };
}

export function resolveHoldingCostBasis(position = {}) {
  const explicit = toFiniteNumber(position?.holding_cost_basis_cny);
  if (explicit !== null && explicit >= 0) {
    return round(explicit);
  }

  const amount = toFiniteNumber(position?.amount);
  const holdingPnl = toFiniteNumber(position?.holding_pnl);
  if (amount === null || holdingPnl === null) {
    return null;
  }

  const inferred = amount - holdingPnl;
  return Number.isFinite(inferred) && inferred >= 0 ? round(inferred) : null;
}

export function ensureHoldingCostBasis(position = {}) {
  const costBasis = resolveHoldingCostBasis(position);
  if (costBasis !== null) {
    position.holding_cost_basis_cny = costBasis;
  }
  return costBasis;
}

export function recalculateHoldingMetricsFromCostBasis(position = {}, { amount = null } = {}) {
  const costBasis = ensureHoldingCostBasis(position);
  const nextAmount = toFiniteNumber(amount ?? position?.amount);
  if (costBasis === null || nextAmount === null) {
    return position;
  }

  position.holding_cost_basis_cny = costBasis;
  position.holding_pnl = round(nextAmount - costBasis);
  position.holding_pnl_rate_pct =
    costBasis > 0 ? round(((nextAmount - costBasis) / costBasis) * 100) : 0;
  return position;
}

export function rebuildHoldingFromCanonicalTruth(position = {}, { nav = null } = {}) {
  const snapshot = deriveCanonicalHoldingSnapshot(position, { nav });

  if (
    snapshot.units === null ||
    snapshot.costBasisCny === null ||
    snapshot.nav === null ||
    snapshot.amountCny === null ||
    snapshot.holdingPnlCny === null
  ) {
    return { ...position };
  }
  return {
    ...position,
    units: snapshot.units,
    cost_basis_cny: snapshot.costBasisCny,
    holding_cost_basis_cny: snapshot.costBasisCny,
    amount: snapshot.amountCny,
    holding_pnl: snapshot.holdingPnlCny,
    holding_pnl_rate_pct: snapshot.holdingPnlRatePct
  };
}

export function applyBuyToHoldingCostBasis(position = {}, buyAmount = 0) {
  const amount = Math.max(round(Number(buyAmount ?? 0)), 0);
  if (amount <= 0) {
    return ensureHoldingCostBasis(position);
  }

  const previousCostBasis = resolveHoldingCostBasis(position) ?? 0;
  const nextCostBasis = round(previousCostBasis + amount);
  position.holding_cost_basis_cny = nextCostBasis;
  return nextCostBasis;
}

export function applySellToHoldingCostBasis(
  position = {},
  { soldAmount = 0, previousAmount = null } = {}
) {
  const currentCostBasis = resolveHoldingCostBasis(position);
  const baseAmount = toFiniteNumber(previousAmount ?? position?.amount);
  const reduceAmount = Math.max(round(Number(soldAmount ?? 0)), 0);

  if (currentCostBasis === null || baseAmount === null || baseAmount <= 0 || reduceAmount <= 0) {
    return currentCostBasis;
  }

  const remainingAmount = Math.max(round(baseAmount - reduceAmount), 0);
  if (remainingAmount <= 0) {
    position.holding_cost_basis_cny = 0;
    return 0;
  }

  const factor = Math.max(Math.min(remainingAmount / baseAmount, 1), 0);
  const nextCostBasis = round(currentCostBasis * factor);
  position.holding_cost_basis_cny = nextCostBasis;
  return nextCostBasis;
}

export function transferConversionHoldingCostBasis({
  fromPosition = {},
  toPosition = {},
  fromAmount = 0,
  toAmount = 0
} = {}) {
  const sourcePreviousAmount = toFiniteNumber(fromPosition?.amount);
  const sourceCostBasis = resolveHoldingCostBasis(fromPosition);
  const transferAmount = Math.max(round(Number(fromAmount ?? 0)), 0);
  const sourceTransferCostBasis =
    sourcePreviousAmount !== null &&
    sourcePreviousAmount > 0 &&
    sourceCostBasis !== null &&
    transferAmount > 0
      ? round(sourceCostBasis * Math.max(Math.min(transferAmount / sourcePreviousAmount, 1), 0))
      : null;

  if (sourceTransferCostBasis !== null) {
    applySellToHoldingCostBasis(fromPosition, {
      soldAmount: transferAmount,
      previousAmount: sourcePreviousAmount
    });
    const targetExistingCostBasis = resolveHoldingCostBasis(toPosition) ?? 0;
    toPosition.holding_cost_basis_cny = round(targetExistingCostBasis + sourceTransferCostBasis);
    return toPosition.holding_cost_basis_cny;
  }

  return applyBuyToHoldingCostBasis(toPosition, toAmount);
}
