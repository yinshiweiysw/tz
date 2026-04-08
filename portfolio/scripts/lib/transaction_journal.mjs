import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_JOURNAL_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../transactions"
);

const DEFAULT_JOURNAL_PATH = path.join(DEFAULT_JOURNAL_DIR, ".journal.jsonl");

/**
 * Resolve the journal path. Uses the default unless overridden.
 * @param {object} [opts]
 * @param {string} [opts.journalPath] - Full path to the .jsonl file.
 * @returns {string}
 */
export function resolveJournalPath(opts = {}) {
  return String(opts.journalPath ?? DEFAULT_JOURNAL_PATH).trim();
}

/**
 * Ensure the directory for the journal file exists.
 * @param {string} journalPath
 */
function ensureJournalDir(journalPath) {
  const dir = path.dirname(journalPath);
  mkdirSync(dir, { recursive: true });
}

/**
 * Generate a unique transaction ID.
 * Format: tx_<timestamp>_<random_hex>
 * @returns {string}
 */
export function generateTxId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `tx_${timestamp}_${random}`;
}

/**
 * Append a record to the JSONL journal using appendFileSync for crash safety.
 * @param {string} journalPath
 * @param {object} record
 */
function appendRecord(journalPath, record) {
  ensureJournalDir(journalPath);
  appendFileSync(journalPath, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Begin a transaction by writing an intent record.
 *
 * @param {string} description - Human-readable description of the transaction.
 * @param {Array<{path: string, action: string}>} operations - List of file operations planned.
 * @param {object} [opts]
 * @param {string} [opts.journalPath]
 * @param {string} [opts.id] - Optional explicit tx ID (for testing).
 * @param {string} [opts.timestamp] - Optional explicit ISO timestamp (for testing).
 * @returns {string} The transaction ID.
 */
export function beginTransaction(description, operations, opts = {}) {
  const id = String(opts.id ?? generateTxId());
  const timestamp = String(opts.timestamp ?? new Date().toISOString());
  const journalPath = resolveJournalPath(opts);

  const record = {
    id,
    timestamp,
    phase: "intent",
    operations: operations.map((op) => ({
      path: String(op.path ?? ""),
      action: String(op.action ?? "write")
    })),
    description: String(description ?? "")
  };

  appendRecord(journalPath, record);
  return id;
}

/**
 * Commit a transaction by writing a committed record.
 *
 * @param {string} txId - The transaction ID returned by beginTransaction.
 * @param {object} [opts]
 * @param {string} [opts.journalPath]
 * @param {string} [opts.timestamp]
 */
export function commitTransaction(txId, opts = {}) {
  const journalPath = resolveJournalPath(opts);
  const timestamp = String(opts.timestamp ?? new Date().toISOString());

  const record = {
    id: txId,
    timestamp,
    phase: "committed"
  };

  appendRecord(journalPath, record);
}

/**
 * Roll back a transaction by writing a rolled_back record.
 *
 * @param {string} txId - The transaction ID returned by beginTransaction.
 * @param {string} reason - Why the transaction was rolled back.
 * @param {object} [opts]
 * @param {string} [opts.journalPath]
 * @param {string} [opts.timestamp]
 */
export function rollbackTransaction(txId, reason, opts = {}) {
  const journalPath = resolveJournalPath(opts);
  const timestamp = String(opts.timestamp ?? new Date().toISOString());

  const record = {
    id: txId,
    timestamp,
    phase: "rolled_back",
    reason: String(reason ?? "")
  };

  appendRecord(journalPath, record);
}

/**
 * Read and parse the entire journal file.
 *
 * @param {object} [opts]
 * @param {string} [opts.journalPath]
 * @returns {Array<object>} All journal records, oldest first.
 */
export function readJournal(opts = {}) {
  const journalPath = resolveJournalPath(opts);

  let content;
  try {
    content = readFileSync(journalPath, "utf8");
  } catch {
    return [];
  }

  if (!content.trim()) {
    return [];
  }

  const lines = content.split("\n").filter((line) => line.trim());
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines for resilience.
    }
  }
  return records;
}

/**
 * Recover uncommitted intents from the journal.
 *
 * Scans all records and returns intent records that have no matching
 * "committed" or "rolled_back" record for the same txId.
 *
 * @param {object} [opts]
 * @param {string} [opts.journalPath]
 * @returns {Array<object>} Array of intent records that are uncommitted.
 */
export function recoverJournal(opts = {}) {
  const records = readJournal(opts);

  const committedIds = new Set();
  const rolledBackIds = new Set();
  const intents = [];

  for (const record of records) {
    const phase = String(record.phase ?? "");
    const id = String(record.id ?? "");

    if (phase === "intent") {
      intents.push(record);
    } else if (phase === "committed") {
      committedIds.add(id);
    } else if (phase === "rolled_back") {
      rolledBackIds.add(id);
    }
  }

  return intents.filter(
    (intent) => !committedIds.has(intent.id) && !rolledBackIds.has(intent.id)
  );
}
