import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  recoverJournal,
  readJournal
} from "./transaction_journal.mjs";

async function tmpJournalPath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tx-journal-test-"));
  return path.join(dir, ".journal.jsonl");
}

test("beginTransaction writes intent record", async () => {
  const journalPath = await tmpJournalPath();
  const txId = beginTransaction("test transaction", [
    { path: "/tmp/a.json", action: "write" },
    { path: "/tmp/b.json", action: "write" }
  ], { journalPath, id: "tx_test_001", timestamp: "2026-04-06T00:00:00.000Z" });

  assert.equal(txId, "tx_test_001");

  const content = await readFile(journalPath, "utf8");
  const records = content.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "tx_test_001");
  assert.equal(records[0].phase, "intent");
  assert.equal(records[0].description, "test transaction");
  assert.equal(records[0].operations.length, 2);
  assert.equal(records[0].operations[0].path, "/tmp/a.json");
  assert.equal(records[0].operations[0].action, "write");
});

test("commitTransaction writes committed record", async () => {
  const journalPath = await tmpJournalPath();

  beginTransaction("test commit", [{ path: "/tmp/a.json" }], {
    journalPath,
    id: "tx_commit_001",
    timestamp: "2026-04-06T00:00:00.000Z"
  });
  commitTransaction("tx_commit_001", {
    journalPath,
    timestamp: "2026-04-06T00:00:01.000Z"
  });

  const content = await readFile(journalPath, "utf8");
  const records = content.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 2);
  assert.equal(records[1].id, "tx_commit_001");
  assert.equal(records[1].phase, "committed");
});

test("rollbackTransaction writes rolled_back record with reason", async () => {
  const journalPath = await tmpJournalPath();

  beginTransaction("test rollback", [{ path: "/tmp/a.json" }], {
    journalPath,
    id: "tx_rollback_001",
    timestamp: "2026-04-06T00:00:00.000Z"
  });
  rollbackTransaction("tx_rollback_001", "disk full", {
    journalPath,
    timestamp: "2026-04-06T00:00:01.000Z"
  });

  const content = await readFile(journalPath, "utf8");
  const records = content.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 2);
  assert.equal(records[1].id, "tx_rollback_001");
  assert.equal(records[1].phase, "rolled_back");
  assert.equal(records[1].reason, "disk full");
});

test("recoverJournal returns uncommitted intents", async () => {
  const journalPath = await tmpJournalPath();

  // Intent that will be committed
  beginTransaction("committed tx", [{ path: "/tmp/a.json" }], {
    journalPath,
    id: "tx_a",
    timestamp: "2026-04-06T00:00:00.000Z"
  });
  commitTransaction("tx_a", {
    journalPath,
    timestamp: "2026-04-06T00:00:01.000Z"
  });

  // Intent that will be rolled back
  beginTransaction("rolled back tx", [{ path: "/tmp/b.json" }], {
    journalPath,
    id: "tx_b",
    timestamp: "2026-04-06T00:00:02.000Z"
  });
  rollbackTransaction("tx_b", "user cancelled", {
    journalPath,
    timestamp: "2026-04-06T00:00:03.000Z"
  });

  // Intent that stays uncommitted (simulated crash)
  beginTransaction("uncommitted tx", [{ path: "/tmp/c.json" }], {
    journalPath,
    id: "tx_c",
    timestamp: "2026-04-06T00:00:04.000Z"
  });

  const uncommitted = recoverJournal({ journalPath });
  assert.equal(uncommitted.length, 1);
  assert.equal(uncommitted[0].id, "tx_c");
  assert.equal(uncommitted[0].phase, "intent");
  assert.equal(uncommitted[0].description, "uncommitted tx");
  assert.equal(uncommitted[0].operations.length, 1);
  assert.equal(uncommitted[0].operations[0].path, "/tmp/c.json");
});

test("after commit, recoverJournal returns empty for that transaction", async () => {
  const journalPath = await tmpJournalPath();

  beginTransaction("fully committed", [{ path: "/tmp/d.json" }], {
    journalPath,
    id: "tx_d",
    timestamp: "2026-04-06T00:00:00.000Z"
  });
  commitTransaction("tx_d", {
    journalPath,
    timestamp: "2026-04-06T00:00:01.000Z"
  });

  const uncommitted = recoverJournal({ journalPath });
  assert.equal(uncommitted.length, 0);
});

test("recoverJournal returns empty for missing journal file", async () => {
  const journalPath = "/tmp/nonexistent_tx_journal_dir/.journal.jsonl";
  const uncommitted = recoverJournal({ journalPath });
  assert.equal(uncommitted.length, 0);
});

test("readJournal returns all records in order", async () => {
  const journalPath = await tmpJournalPath();

  beginTransaction("first", [{ path: "/tmp/1.json" }], {
    journalPath,
    id: "tx_1",
    timestamp: "2026-04-06T00:00:00.000Z"
  });
  beginTransaction("second", [{ path: "/tmp/2.json" }], {
    journalPath,
    id: "tx_2",
    timestamp: "2026-04-06T00:00:01.000Z"
  });

  const records = readJournal({ journalPath });
  assert.equal(records.length, 2);
  assert.equal(records[0].id, "tx_1");
  assert.equal(records[1].id, "tx_2");
});

test("multiple transactions: only uncommitted appear in recovery", async () => {
  const journalPath = await tmpJournalPath();

  // tx_1: committed
  beginTransaction("tx1", [{ path: "/a.json" }], {
    journalPath,
    id: "tx_1",
    timestamp: "2026-04-06T00:00:00.000Z"
  });
  commitTransaction("tx_1", {
    journalPath,
    timestamp: "2026-04-06T00:00:01.000Z"
  });

  // tx_2: rolled back
  beginTransaction("tx2", [{ path: "/b.json" }], {
    journalPath,
    id: "tx_2",
    timestamp: "2026-04-06T00:00:02.000Z"
  });
  rollbackTransaction("tx_2", "error", {
    journalPath,
    timestamp: "2026-04-06T00:00:03.000Z"
  });

  // tx_3: uncommitted
  beginTransaction("tx3", [{ path: "/c.json" }], {
    journalPath,
    id: "tx_3",
    timestamp: "2026-04-06T00:00:04.000Z"
  });

  // tx_4: uncommitted
  beginTransaction("tx4", [{ path: "/d.json" }], {
    journalPath,
    id: "tx_4",
    timestamp: "2026-04-06T00:00:05.000Z"
  });

  const uncommitted = recoverJournal({ journalPath });
  const ids = uncommitted.map((r) => r.id);
  assert.deepEqual(ids, ["tx_3", "tx_4"]);
});
