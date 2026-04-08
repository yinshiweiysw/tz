import { round } from "./format_utils.mjs";

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
