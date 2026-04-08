import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBuyToHoldingCostBasis,
  applySellToHoldingCostBasis,
  deriveCanonicalHoldingSnapshot,
  ensureHoldingCostBasis,
  rebuildHoldingFromCanonicalTruth,
  recalculateHoldingMetricsFromCostBasis,
  transferConversionHoldingCostBasis
} from "./holding_cost_basis.mjs";

test("ensureHoldingCostBasis derives durable cost basis from amount minus holding pnl", () => {
  const position = {
    amount: 12000,
    holding_pnl: -600,
    holding_pnl_rate_pct: -4.76
  };

  const costBasis = ensureHoldingCostBasis(position);

  assert.equal(costBasis, 12600);
  assert.equal(position.holding_cost_basis_cny, 12600);
});

test("applyBuyToHoldingCostBasis seeds and increments otc cost basis without fabricating pnl", () => {
  const position = {
    amount: 50000,
    holding_pnl: 0,
    holding_pnl_rate_pct: 0
  };

  applyBuyToHoldingCostBasis(position, 20000);
  recalculateHoldingMetricsFromCostBasis(position, { amount: 70000 });

  assert.equal(position.holding_cost_basis_cny, 70000);
  assert.equal(position.holding_pnl, 0);
  assert.equal(position.holding_pnl_rate_pct, 0);
});

test("applySellToHoldingCostBasis keeps remaining position cost proportional after partial sell", () => {
  const position = {
    amount: 12000,
    holding_pnl: 2000,
    holding_pnl_rate_pct: 20
  };

  ensureHoldingCostBasis(position);
  applySellToHoldingCostBasis(position, {
    soldAmount: 3000,
    previousAmount: 12000
  });
  recalculateHoldingMetricsFromCostBasis(position, { amount: 9000 });

  assert.equal(position.holding_cost_basis_cny, 7500);
  assert.equal(position.holding_pnl, 1500);
  assert.equal(position.holding_pnl_rate_pct, 20);
});

test("transferConversionHoldingCostBasis preserves source cost basis when fund conversion merges into target", () => {
  const fromPosition = {
    name: "工银瑞信黄金ETF联接C",
    amount: 29320.63,
    holding_pnl: -1556.1
  };
  const toPosition = {
    name: "国泰黄金ETF联接E",
    amount: 2000,
    holding_pnl: 0
  };

  ensureHoldingCostBasis(fromPosition);
  ensureHoldingCostBasis(toPosition);

  transferConversionHoldingCostBasis({
    fromPosition,
    toPosition,
    fromAmount: 29320.63,
    toAmount: 34320.63
  });
  recalculateHoldingMetricsFromCostBasis(toPosition, { amount: 36320.63 });

  assert.equal(fromPosition.holding_cost_basis_cny, 0);
  assert.equal(toPosition.holding_cost_basis_cny, 32876.73);
  assert.equal(toPosition.holding_pnl, 3443.9);
  assert.equal(toPosition.holding_pnl_rate_pct, 10.48);
});

test("rebuildHoldingFromCanonicalTruth derives amount and holding pnl from units nav and cost basis", () => {
  const rebuilt = rebuildHoldingFromCanonicalTruth(
    {
      name: "易方达沪深300ETF联接C",
      confirmed_units: 10000,
      holding_cost_basis_cny: 21000,
      amount: 999999,
      holding_pnl: 999999
    },
    { nav: 2.168019 }
  );

  assert.equal(rebuilt.units, 10000);
  assert.equal(rebuilt.cost_basis_cny, 21000);
  assert.equal(rebuilt.amount, 21680.19);
  assert.equal(rebuilt.holding_pnl, 680.19);
  assert.equal(rebuilt.holding_pnl_rate_pct, 3.24);
});

test("deriveCanonicalHoldingSnapshot ignores stale stored amount when units and nav are available", () => {
  const snapshot = deriveCanonicalHoldingSnapshot({
    name: "易方达沪深300ETF联接C",
    confirmed_units: 11891.28539071,
    last_confirmed_nav: 1.766,
    holding_cost_basis_cny: 21000,
    amount: 99999,
    holding_pnl: 88888
  });

  assert.equal(snapshot.units, 11891.28539071);
  assert.equal(snapshot.nav, 1.766);
  assert.equal(snapshot.costBasisCny, 21000);
  assert.equal(snapshot.amountCny, 21000.01);
  assert.equal(snapshot.holdingPnlCny, 0.01);
  assert.equal(snapshot.holdingPnlRatePct, 0);
  assert.equal(snapshot.derivedFromCanonicalTruth, true);
});
