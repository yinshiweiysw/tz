import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import {
  appendEntriesToExecutionLedger,
  buildDualLedgerPaths,
  createLedgerEntriesFromTransactionContent,
  formatShanghaiDate,
  materializePortfolioRoot,
  nowIso
} from "./lib/portfolio_state_materializer.mjs";

function parseArgs(argv) {
  const result = {};
  const camelize = (key) => key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      result[camelize(key)] = true;
      continue;
    }

    result[key] = next;
    result[camelize(key)] = next;
    index += 1;
  }

  return result;
}

async function readJson(targetPath) {
  return JSON.parse(await readFile(targetPath, "utf8"));
}

async function writeJson(targetPath, payload) {
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function shouldReplayMergedTransactionFile(content, { replayMerged = false } = {}) {
  const status = String(content?.status ?? "");
  if (status.startsWith("merged_into_latest")) {
    return false;
  }
  if (status.startsWith("merged_into_execution_ledger")) {
    return replayMerged;
  }
  return true;
}

export async function loadManualFilesForLedgerMerge(
  transactionsDir,
  explicitPath = null,
  { replayMerged = false } = {}
) {
  const files = explicitPath
    ? [explicitPath]
    : (await readdir(transactionsDir))
        .filter((name) => name.endsWith(".json") && name.includes("-manual-"))
        .sort()
        .map((name) => path.join(transactionsDir, name));

  const loaded = [];
  for (const filePath of files) {
    const content = await readJson(filePath);
    if (!shouldReplayMergedTransactionFile(content, { replayMerged })) {
      continue;
    }
    loaded.push({ filePath, content });
  }

  return loaded;
}

export async function mergeConfirmedTradesIntoLatestCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const portfolioRoot = resolvePortfolioRoot(options);
  const accountId = resolveAccountId(options);
  const paths = buildDualLedgerPaths(portfolioRoot);
  const transactionsDir = path.join(portfolioRoot, "transactions");
  const manualFiles = await loadManualFilesForLedgerMerge(transactionsDir, options.transactions || null, {
    replayMerged: String(options.replayMerged ?? options["replay-merged"] ?? "").trim() === "true"
  });

  if (manualFiles.length === 0) {
    console.log(
      JSON.stringify(
        {
          accountId,
          portfolioRoot,
          status: "noop",
          mergedFiles: [],
          message: "No pending manual transaction files require ledger merge."
        },
        null,
        2
      )
    );
    return;
  }

  const materializedBefore = await materializePortfolioRoot({
    portfolioRoot,
    accountId,
    referenceDate: String(options.date ?? "").trim() || formatShanghaiDate(),
    seedMissing: true
  });
  const executionLedger = await readJson(paths.executionLedgerPath);
  const mergedOperations = [];
  const mergedFiles = [];

  for (const entry of manualFiles) {
    const newEntries = createLedgerEntriesFromTransactionContent({
      content: entry.content,
      filePath: entry.filePath,
      accountId,
      recordedAt: nowIso()
    });
    const appendResult = appendEntriesToExecutionLedger(executionLedger, newEntries);

    entry.content.status = "merged_into_execution_ledger_from_dialogue_confirmation";
    entry.content.merged_at = nowIso();
    entry.content.merged_target = paths.executionLedgerPath;
    entry.content.notes = [
      ...(entry.content.notes ?? []),
      "Merged into execution_ledger.json based on user dialogue confirmation; state is now materialized separately."
    ];

    await writeJson(entry.filePath, entry.content);
    mergedFiles.push(entry.filePath);
    mergedOperations.push({
      file: entry.filePath,
      appendedEntryIds: appendResult.appended,
      skippedEntryIds: appendResult.skipped
    });
  }

  executionLedger.notes = Array.isArray(executionLedger.notes) ? executionLedger.notes : [];
  executionLedger.notes.push(
    `${nowIso()} 已按对话确认写入 ${mergedFiles.length} 个手工交易文件；兼容 latest.json 将通过 materializer 自动重算。`
  );
  await writeJson(paths.executionLedgerPath, executionLedger);

  const materializedAfter = await materializePortfolioRoot({
    portfolioRoot,
    accountId,
    referenceDate: String(options.date ?? "").trim() || formatShanghaiDate(),
    seedMissing: true
  });

  console.log(
    JSON.stringify(
      {
        accountId,
        portfolioRoot,
        executionLedgerPath: paths.executionLedgerPath,
        compatibilityLatestPath: paths.latestCompatPath,
        seededChanges: materializedBefore.ensuredChanges,
        mergedFiles,
        mergedOperations,
        stats: materializedAfter.stats
      },
      null,
      2
    )
  );
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await mergeConfirmedTradesIntoLatestCli();
}
