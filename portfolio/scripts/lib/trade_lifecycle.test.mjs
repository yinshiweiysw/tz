import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveLedgerEntryLifecycleStage,
  summarizeLedgerEntryLifecycles
} from "./trade_lifecycle.mjs";

test("resolveLedgerEntryLifecycleStage marks OTC buy before profit-effective date as pending profit", () => {
  const stage = resolveLedgerEntryLifecycleStage(
    {
      type: "buy",
      status: "recorded",
      profit_effective_on: "2026-04-02",
      normalized: {
        execution_type: "OTC",
        amount_cny: 5000
      }
    },
    "2026-04-01"
  );

  assert.equal(stage, "platform_confirmed_pending_profit");
});

test("resolveLedgerEntryLifecycleStage marks OTC buy on or after profit-effective date as profit effective", () => {
  const stage = resolveLedgerEntryLifecycleStage(
    {
      type: "buy",
      status: "recorded",
      profit_effective_on: "2026-04-02",
      normalized: {
        execution_type: "OTC",
        amount_cny: 5000
      }
    },
    "2026-04-02"
  );

  assert.equal(stage, "profit_effective");
});

test("resolveLedgerEntryLifecycleStage marks sell proceeds awaiting settlement as pending cash arrival", () => {
  const stage = resolveLedgerEntryLifecycleStage(
    {
      type: "sell",
      status: "recorded",
      normalized: {
        amount_cny: 4000,
        pending_sell_to_arrive_cny: 4000,
        cash_effect_cny: 0
      },
      original: {
        cash_arrived: false
      }
    },
    "2026-04-01"
  );

  assert.equal(stage, "platform_confirmed_pending_cash_arrival");
});

test("resolveLedgerEntryLifecycleStage marks settled sell proceeds as cash arrived", () => {
  const stage = resolveLedgerEntryLifecycleStage(
    {
      type: "sell",
      status: "recorded",
      normalized: {
        amount_cny: 4000,
        pending_sell_to_arrive_cny: 0,
        cash_effect_cny: 4000
      },
      original: {
        cash_arrived: true
      }
    },
    "2026-04-01"
  );

  assert.equal(stage, "cash_arrived");
});

test("summarizeLedgerEntryLifecycles aggregates counts and staged amounts by lifecycle stage", () => {
  const summary = summarizeLedgerEntryLifecycles(
    [
      {
        id: "buy-1",
        type: "buy",
        status: "recorded",
        profit_effective_on: "2026-04-02",
        normalized: {
          execution_type: "OTC",
          amount_cny: 5000
        }
      },
      {
        id: "sell-1",
        type: "sell",
        status: "recorded",
        normalized: {
          amount_cny: 3000,
          pending_sell_to_arrive_cny: 3000,
          cash_effect_cny: 0
        },
        original: {
          cash_arrived: false
        }
      },
      {
        id: "sell-2",
        type: "sell",
        status: "recorded",
        normalized: {
          amount_cny: 2000,
          pending_sell_to_arrive_cny: 0,
          cash_effect_cny: 2000
        },
        original: {
          cash_arrived: true
        }
      }
    ],
    "2026-04-01"
  );

  assert.equal(summary.countsByStage.platform_confirmed_pending_profit, 1);
  assert.equal(summary.countsByStage.platform_confirmed_pending_cash_arrival, 1);
  assert.equal(summary.countsByStage.cash_arrived, 1);
  assert.equal(summary.amountsByStage.platform_confirmed_pending_profit, 5000);
  assert.equal(summary.amountsByStage.platform_confirmed_pending_cash_arrival, 3000);
  assert.equal(summary.amountsByStage.cash_arrived, 2000);
});
