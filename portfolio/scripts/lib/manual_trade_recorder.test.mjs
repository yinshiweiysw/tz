import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildManualTradeTransactionContent,
  buildManualBuyTransactionContent,
  chooseManualBuysFilePath,
  chooseManualTransactionFilePath,
  createFundLookup,
  parseBuySpec,
  parseConversionSpec,
  parseSellSpec
} from "./manual_trade_recorder.mjs";

test("parseBuySpec parses compact buy instructions", () => {
  const parsed = parseBuySpec("007339:8000||021482:5000||国金量化多因子股票A:5000");
  assert.deepEqual(parsed, [
    { token: "007339", amountCny: 8000 },
    { token: "021482", amountCny: 5000 },
    { token: "国金量化多因子股票A", amountCny: 5000 }
  ]);
});

test("parseSellSpec parses compact sell instructions", () => {
  const parsed = parseSellSpec("022502:5000||007339:4000||国金量化多因子股票A:6000");
  assert.deepEqual(parsed, [
    { token: "022502", amountCny: 5000 },
    { token: "007339", amountCny: 4000 },
    { token: "国金量化多因子股票A", amountCny: 6000 }
  ]);
});

test("parseConversionSpec parses compact conversion instructions", () => {
  const parsed = parseConversionSpec(
    "工银瑞信黄金ETF联接C:29320.63->022502:29320.63||007339:4000->易方达上证50增强A:4000"
  );
  assert.deepEqual(parsed, [
    {
      fromToken: "工银瑞信黄金ETF联接C",
      fromAmountCny: 29320.63,
      toToken: "022502",
      toAmountCny: 29320.63
    },
    {
      fromToken: "007339",
      fromAmountCny: 4000,
      toToken: "易方达上证50增强A",
      toAmountCny: 4000
    }
  ]);
});

test("chooseManualBuysFilePath increments suffix when same-day file already exists", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "manual-trades-"));
  const transactionsDir = path.join(tempDir, "transactions");
  await mkdir(transactionsDir, { recursive: true });
  await writeFile(
    path.join(transactionsDir, "2026-04-01-manual-buys.json"),
    JSON.stringify({ status: "merged_into_execution_ledger_from_dialogue_confirmation" }, null, 2),
    "utf8"
  );

  const nextPath = await chooseManualBuysFilePath({
    transactionsDir,
    tradeDate: "2026-04-01"
  });

  assert.equal(nextPath, path.join(transactionsDir, "2026-04-01-manual-buys-2.json"));
});

test("chooseManualTransactionFilePath increments suffix when same-day trade file already exists", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "manual-trades-"));
  const transactionsDir = path.join(tempDir, "transactions");
  await mkdir(transactionsDir, { recursive: true });
  await writeFile(
    path.join(transactionsDir, "2026-04-01-manual-trades.json"),
    JSON.stringify({ status: "awaiting_execution_ledger_merge" }, null, 2),
    "utf8"
  );

  const nextPath = await chooseManualTransactionFilePath({
    transactionsDir,
    tradeDate: "2026-04-01"
  });

  assert.equal(nextPath, path.join(transactionsDir, "2026-04-01-manual-trades-2.json"));
});

test("buildManualBuyTransactionContent builds OTC trades with next-day profit effect", () => {
  const lookup = createFundLookup({
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        code: "007339",
        fund_code: "007339",
        symbol: "007339"
      }
    ],
    pendingPositions: [],
    watchlistItems: [
      {
        code: "022502",
        name: "国泰黄金ETF联接E"
      }
    ]
  });

  const payload = buildManualBuyTransactionContent({
    tradeDate: "2026-04-01",
    buyItems: parseBuySpec("007339:8000||022502:10000"),
    executionType: "OTC",
    submittedBeforeCutoff: true,
    cutoffTimeLocal: "15:00",
    rawSnapshotIncludesTrade: true,
    lookup
  });

  assert.equal(payload.snapshot_date, "2026-04-01");
  assert.equal(payload.executed_buy_transactions.length, 2);
  assert.deepEqual(
    payload.executed_buy_transactions.map((item) => ({
      fundName: item.interpreted_fund_name,
      fundCode: item.fund_code,
      amount: item.amount_cny,
      profitEffectiveOn: item.profit_effective_on,
      lifecycleStage: item.lifecycle_stage,
      rawSnapshotIncludesTrade: item.raw_snapshot_includes_trade
    })),
    [
      {
        fundName: "易方达沪深300ETF联接C",
        fundCode: "007339",
        amount: 8000,
        profitEffectiveOn: "2026-04-02",
        lifecycleStage: "platform_confirmed_pending_profit",
        rawSnapshotIncludesTrade: true
      },
      {
        fundName: "国泰黄金ETF联接E",
        fundCode: "022502",
        amount: 10000,
        profitEffectiveOn: "2026-04-02",
        lifecycleStage: "platform_confirmed_pending_profit",
        rawSnapshotIncludesTrade: true
      }
    ]
  );
});

test("buildManualBuyTransactionContent keeps exchange trades out of pending profit schedule", () => {
  const lookup = createFundLookup({
    positions: [],
    pendingPositions: [],
    watchlistItems: []
  });

  const payload = buildManualBuyTransactionContent({
    tradeDate: "2026-04-01",
    buyItems: parseBuySpec("513100:3000"),
    executionType: "EXCHANGE",
    submittedBeforeCutoff: true,
    cutoffTimeLocal: "15:00",
    rawSnapshotIncludesTrade: false,
    lookup
  });

  assert.equal(payload.executed_buy_transactions[0].profit_effective_on, null);
  assert.equal(payload.executed_buy_transactions[0].lifecycle_stage, "profit_effective");
  assert.equal(payload.executed_buy_transactions[0].execution_type, "EXCHANGE");
  assert.equal(payload.executed_buy_transactions[0].raw_snapshot_includes_trade, false);
});

test("buildManualTradeTransactionContent builds sell and confirmed conversion payloads", () => {
  const lookup = createFundLookup({
    positions: [
      {
        name: "工银瑞信黄金ETF联接C",
        code: "000218",
        fund_code: "000218",
        symbol: "000218"
      },
      {
        name: "国泰黄金ETF联接E",
        code: "022502",
        fund_code: "022502",
        symbol: "022502"
      }
    ],
    pendingPositions: [],
    watchlistItems: []
  });

  const payload = buildManualTradeTransactionContent({
    tradeDate: "2026-04-01",
    sellItems: parseSellSpec("022502:5000"),
    conversionItems: parseConversionSpec("工银瑞信黄金ETF联接C:29320.63->022502:29320.63"),
    executionType: "OTC",
    rawSnapshotIncludesTrade: true,
    sellCashArrived: false,
    lookup
  });

  assert.equal(payload.snapshot_date, "2026-04-01");
  assert.equal(payload.executed_sell_transactions.length, 1);
  assert.equal(payload.executed_conversion_transactions.length, 1);
  assert.deepEqual(payload.executed_sell_transactions[0], {
    trade_date: "2026-04-01",
    fund_name_user_stated: "022502",
    interpreted_fund_name: "国泰黄金ETF联接E",
    fund_code: "022502",
    amount_cny: 5000,
    status: "user_reported_executed",
    execution_type: "OTC",
    cash_arrived: false,
    lifecycle_stage: "platform_confirmed_pending_cash_arrival",
    raw_snapshot_includes_trade: true,
    interpretation_basis:
      'Recorded via manual_trade_recorder from "022502" as an executed sell; proceeds remain pending settlement until cash_arrived=true.'
  });
  assert.deepEqual(payload.executed_conversion_transactions[0], {
    trade_date: "2026-04-01",
    from_fund_name_user_stated: "工银瑞信黄金ETF联接C",
    to_fund_name_user_stated: "022502",
    from_fund_name: "工银瑞信黄金ETF联接C",
    to_fund_name: "国泰黄金ETF联接E",
    from_fund_code: "000218",
    to_fund_code: "022502",
    from_amount_cny: 29320.63,
    to_amount_cny: 29320.63,
    status: "user_reported_confirmed_conversion",
    execution_type: "OTC",
    lifecycle_stage: "platform_confirmed_conversion",
    raw_snapshot_includes_trade: true,
    interpretation_basis:
      'Recorded via manual_trade_recorder as a confirmed conversion from "工银瑞信黄金ETF联接C" to "022502"; the state materializer should apply the conversion immediately.'
  });
});

test("buildManualTradeTransactionContent marks settled sell proceeds as cash arrived", () => {
  const lookup = createFundLookup({
    positions: [
      {
        name: "国泰黄金ETF联接E",
        code: "022502",
        fund_code: "022502",
        symbol: "022502"
      }
    ],
    pendingPositions: [],
    watchlistItems: []
  });

  const payload = buildManualTradeTransactionContent({
    tradeDate: "2026-04-01",
    sellItems: parseSellSpec("022502:5000"),
    executionType: "OTC",
    rawSnapshotIncludesTrade: false,
    sellCashArrived: true,
    lookup
  });

  assert.equal(payload.executed_sell_transactions[0].cash_arrived, true);
  assert.equal(payload.executed_sell_transactions[0].lifecycle_stage, "cash_arrived");
});
