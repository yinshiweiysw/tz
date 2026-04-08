import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBuyToHoldingCostBasis,
  applySellToHoldingCostBasis,
  ensureHoldingCostBasis,
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
