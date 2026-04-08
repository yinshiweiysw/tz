import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { loadManualFilesForLedgerMerge } from "./merge_confirmed_trades_into_latest.mjs";

test("loadManualFilesForLedgerMerge skips previously merged files by default", async () => {
  const transactionsDir = await mkdtemp(path.join(os.tmpdir(), "merge-confirmed-default-"));
  await mkdir(transactionsDir, { recursive: true });

  const mergedFilePath = path.join(transactionsDir, "2026-04-02-manual-buys.json");
  await writeFile(
    mergedFilePath,
    `${JSON.stringify(
      {
        snapshot_date: "2026-04-02",
        status: "merged_into_execution_ledger_from_dialogue_confirmation",
        executed_buy_transactions: [{ fund_code: "016482", amount_cny: 20000 }]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const loaded = await loadManualFilesForLedgerMerge(transactionsDir);
  assert.equal(loaded.length, 0);
});

test("loadManualFilesForLedgerMerge can replay previously merged files in repair mode", async () => {
  const transactionsDir = await mkdtemp(path.join(os.tmpdir(), "merge-confirmed-replay-"));
  await mkdir(transactionsDir, { recursive: true });

  const mergedFilePath = path.join(transactionsDir, "2026-04-02-manual-buys.json");
  await writeFile(
    mergedFilePath,
    `${JSON.stringify(
      {
        snapshot_date: "2026-04-02",
        status: "merged_into_execution_ledger_from_dialogue_confirmation",
        executed_buy_transactions: [{ fund_code: "016482", amount_cny: 20000 }]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const loaded = await loadManualFilesForLedgerMerge(transactionsDir, null, {
    replayMerged: true
  });

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].filePath, mergedFilePath);
});
