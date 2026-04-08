import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPortfolioPath, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { ensureHoldingCostBasis, recalculateHoldingMetricsFromCostBasis } from "./lib/holding_cost_basis.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function findMatchingPosition(positions = [], target = {}) {
  const targetCode = normalizeText(target?.code ?? target?.symbol ?? target?.fund_code);
  const targetName = normalizeText(target?.name);
  return (
    positions.find((item) => {
      const code = normalizeText(item?.code ?? item?.symbol ?? item?.fund_code);
      const name = normalizeText(item?.name);
      return (targetCode && code === targetCode) || (targetName && name === targetName);
    }) ?? null
  );
}

function deriveExplicitCostBasis(position = {}) {
  const seeded = ensureHoldingCostBasis({ ...position });
  return seeded;
}

function extractConversionPairs(notes = []) {
  const pairs = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    const match = String(note ?? "").match(/将(.+?)转换到(.+?)(?:，|,|。|；|;)/u);
    if (!match) {
      continue;
    }
    pairs.push({
      fromName: normalizeText(match[1]),
      toName: normalizeText(match[2])
    });
  }
  return pairs;
}

async function loadHistoricalSnapshots(portfolioRoot) {
  const candidates = [];
  const knownFiles = [
    buildPortfolioPath(portfolioRoot, "latest.before-user-snapshot-2026-04-01.json"),
    buildPortfolioPath(portfolioRoot, "latest.pre-v6-cold-start.backup.json"),
    buildPortfolioPath(portfolioRoot, "latest.pre-v6-restore-merge.backup.json")
  ];

  for (const filePath of knownFiles) {
    const payload = await readJsonOrNull(filePath);
    if (payload) {
      candidates.push({ filePath, payload });
    }
  }

  const holdingsDir = buildPortfolioPath(portfolioRoot, "holdings");
  try {
    const files = (await readdir(holdingsDir))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const fileName of files) {
      const filePath = path.join(holdingsDir, fileName);
      const payload = await readJsonOrNull(filePath);
      if (payload) {
        candidates.push({ filePath, payload });
      }
    }
  } catch {}

  return candidates;
}

function deriveBackfilledCostBasis(position, historicalSnapshots = []) {
  const directCandidates = [];
  const conversionCandidates = [];
  const allConversionPairs = historicalSnapshots.flatMap((snapshot) =>
    extractConversionPairs(snapshot?.payload?.recognition_notes ?? [])
  );
  const currentAmount = Number(position?.amount ?? 0);

  for (const snapshot of historicalSnapshots) {
    const positions = Array.isArray(snapshot?.payload?.positions) ? snapshot.payload.positions : [];
    const directMatch = findMatchingPosition(positions, position);
    const directCostBasis = directMatch ? deriveExplicitCostBasis(directMatch) : null;
    const directAmount = Number(directMatch?.amount ?? 0);
    const coverageRatio =
      currentAmount > 0 && directAmount > 0 ? directAmount / currentAmount : 0;
    if (
      directMatch &&
      directCostBasis !== null &&
      Number(directMatch?.holding_pnl ?? 0) !== 0 &&
      coverageRatio >= 0.8
    ) {
      directCandidates.push({
        costBasis: directCostBasis,
        source: "historical_position_snapshot",
        confidence: "high",
        filePath: snapshot.filePath
      });
    }

    for (const pair of allConversionPairs) {
      if (pair.toName !== normalizeText(position?.name)) {
        continue;
      }
      const sourcePosition = findMatchingPosition(positions, { name: pair.fromName });
      const targetPosition = findMatchingPosition(positions, { name: pair.toName });
      const sourceCostBasis = sourcePosition ? deriveExplicitCostBasis(sourcePosition) : null;
      const targetCostBasis = targetPosition ? deriveExplicitCostBasis(targetPosition) : null;
      if (sourceCostBasis === null || targetCostBasis === null) {
        continue;
      }
      conversionCandidates.push({
        costBasis: Number((sourceCostBasis + targetCostBasis).toFixed(2)),
        source: "historical_conversion_snapshot",
        confidence: "high",
        filePath: snapshot.filePath
      });
    }
  }

  return conversionCandidates.at(-1) ?? directCandidates.at(-1) ?? null;
}

function shouldBackfillPosition(position = {}) {
  if (String(position?.execution_type ?? "OTC").toUpperCase() === "EXCHANGE") {
    return false;
  }
  if (String(position?.status ?? "active") !== "active") {
    return false;
  }
  const source = normalizeText(position?.holding_cost_basis_source);
  if (source.startsWith("historical_")) {
    return true;
  }
  const costBasis = Number(position?.holding_cost_basis_cny ?? NaN);
  if (
    Number.isFinite(costBasis) &&
    costBasis > 0 &&
    !(Number(costBasis) === Number(position?.amount ?? NaN) && Number(position?.holding_pnl ?? 0) === 0)
  ) {
    return false;
  }
  return Number(position?.amount ?? 0) > 0;
}

function applyBackfill(position, backfill = {}) {
  position.holding_cost_basis_cny = backfill.costBasis;
  position.holding_cost_basis_source = backfill.source;
  position.holding_cost_basis_confidence = backfill.confidence;
  position.holding_cost_basis_backfilled_at = new Date().toISOString();
  recalculateHoldingMetricsFromCostBasis(position, {
    amount: Number(position?.amount ?? 0)
  });
}

function resetToSnapshotSeed(position) {
  position.holding_cost_basis_cny = Number(position?.amount ?? 0);
  position.holding_cost_basis_source = "snapshot_seed_amount";
  position.holding_cost_basis_confidence = "low";
  position.holding_cost_basis_backfilled_at = new Date().toISOString();
  position.holding_pnl = 0;
  position.holding_pnl_rate_pct = 0;
}

export async function runHoldingCostBasisBackfill(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const latestRawPath = buildPortfolioPath(portfolioRoot, "snapshots", "latest_raw.json");
  const portfolioStatePath = buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json");
  const latestCompatPath = buildPortfolioPath(portfolioRoot, "latest.json");
  const rawSnapshot = (await readJsonOrNull(latestRawPath)) ?? { positions: [] };
  const portfolioState = (await readJsonOrNull(portfolioStatePath)) ?? { positions: [] };
  const latestCompat = (await readJsonOrNull(latestCompatPath)) ?? null;
  const historicalSnapshots = await loadHistoricalSnapshots(portfolioRoot);

  let updatedPositions = 0;
  const reviewRequired = [];

  for (const rawPosition of rawSnapshot.positions ?? []) {
    if (!shouldBackfillPosition(rawPosition)) {
      continue;
    }
    const backfill = deriveBackfilledCostBasis(rawPosition, historicalSnapshots);
    if (!backfill) {
      if (normalizeText(rawPosition?.holding_cost_basis_source).startsWith("historical_")) {
        resetToSnapshotSeed(rawPosition);
        const statePosition = findMatchingPosition(portfolioState.positions ?? [], rawPosition);
        if (statePosition) {
          resetToSnapshotSeed(statePosition);
        }
        const compatPosition = latestCompat ? findMatchingPosition(latestCompat.positions ?? [], rawPosition) : null;
        if (compatPosition) {
          resetToSnapshotSeed(compatPosition);
        }
      }
      reviewRequired.push({
        code: normalizeText(rawPosition?.code ?? rawPosition?.symbol ?? rawPosition?.fund_code) || null,
        name: normalizeText(rawPosition?.name) || null
      });
      continue;
    }

    applyBackfill(rawPosition, backfill);
    const statePosition = findMatchingPosition(portfolioState.positions ?? [], rawPosition);
    if (statePosition) {
      applyBackfill(statePosition, backfill);
    }
    const compatPosition = latestCompat ? findMatchingPosition(latestCompat.positions ?? [], rawPosition) : null;
    if (compatPosition) {
      applyBackfill(compatPosition, backfill);
    }
    updatedPositions += 1;
  }

  await writeJson(latestRawPath, rawSnapshot);
  await writeJson(portfolioStatePath, portfolioState);
  if (latestCompat) {
    await writeJson(latestCompatPath, latestCompat);
  }

  return {
    portfolioRoot,
    updatedPositions,
    reviewRequired
  };
}

async function main() {
  const result = await runHoldingCostBasisBackfill(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          error: String(error?.message ?? error)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}
