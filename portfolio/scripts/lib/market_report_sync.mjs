import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildPortfolioPath } from "./account_root.mjs";
import { writeJsonAtomic } from "./atomic_json_state.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./manifest_state.mjs";

const MARKET_TOPIC_ENTRY_KEYS = [
  "latest_daily_brief",
  "latest_market_brief",
  "latest_morning_market_pulse",
  "latest_noon_market_pulse",
  "latest_close_market_pulse",
  "high_impact_event_calendar",
  "latest_research_brain"
];

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function deriveLegacyMarketReportSourceRoot(portfolioRoot) {
  const explicit = trimText(process.env.MARKET_TOPICS_SOURCE_ROOT);
  if (explicit) {
    return path.resolve(explicit);
  }

  const normalized = path.resolve(portfolioRoot);
  const marker = `${path.sep}tz-main-simplified${path.sep}portfolio`;
  if (normalized.endsWith(marker)) {
    return normalized.slice(0, -marker.length) + `${path.sep}tz${path.sep}portfolio`;
  }

  return null;
}

function destinationPathForSource({ sourcePortfolioRoot, portfolioRoot, sourcePath }) {
  const relative = path.relative(sourcePortfolioRoot, sourcePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return buildPortfolioPath(portfolioRoot, relative);
  }

  return buildPortfolioPath(portfolioRoot, "data", "market_topics_external", path.basename(sourcePath));
}

async function maybeReadJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function persistSyncStatus(portfolioRoot, result) {
  const statusPath = buildPortfolioPath(portfolioRoot, "data", "market_topics_sync_status.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    status: result.status,
    reason: result.reason ?? null,
    sourcePortfolioRoot: result.sourcePortfolioRoot ?? null,
    copied: result.copied ?? [],
    entryCount: Object.keys(result.entries ?? {}).length
  };
  await writeJsonAtomic(statusPath, payload);
  await updateManifestCanonicalEntrypoints({
    manifestPath: buildPortfolioPath(portfolioRoot, "state-manifest.json"),
    baseManifest: await maybeReadJson(buildPortfolioPath(portfolioRoot, "state-manifest.json")),
    entries: {
      market_topics_sync_status: statusPath
    }
  });
  return {
    ...result,
    syncStatusPath: statusPath,
    syncStatus: payload
  };
}

export async function syncMarketTopicReports({
  portfolioRoot,
  sourcePortfolioRoot = deriveLegacyMarketReportSourceRoot(portfolioRoot),
  keys = MARKET_TOPIC_ENTRY_KEYS
} = {}) {
  const resolvedPortfolioRoot = path.resolve(portfolioRoot);
  const resolvedSourceRoot = trimText(sourcePortfolioRoot) ? path.resolve(sourcePortfolioRoot) : null;
  if (!resolvedSourceRoot || !existsSync(buildPortfolioPath(resolvedSourceRoot, "state-manifest.json"))) {
    return persistSyncStatus(resolvedPortfolioRoot, {
      status: "skipped",
      reason: "source_manifest_missing",
      sourcePortfolioRoot: resolvedSourceRoot,
      copied: [],
      entries: {}
    });
  }

  const sourceManifest = await readManifestState(buildPortfolioPath(resolvedSourceRoot, "state-manifest.json"));
  const sourceCanonical = sourceManifest?.canonical_entrypoints ?? {};
  const copied = [];
  const entries = {};

  for (const key of keys) {
    const sourcePath = trimText(sourceCanonical?.[key]);
    if (!sourcePath || !existsSync(sourcePath)) {
      continue;
    }

    const destinationPath = destinationPathForSource({
      sourcePortfolioRoot: resolvedSourceRoot,
      portfolioRoot: resolvedPortfolioRoot,
      sourcePath
    });
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    entries[key] = destinationPath;
    copied.push({
      key,
      from: sourcePath,
      to: destinationPath
    });
  }

  if (copied.length > 0) {
    const manifestPath = buildPortfolioPath(resolvedPortfolioRoot, "state-manifest.json");
    const baseManifest = await maybeReadJson(manifestPath);
    await updateManifestCanonicalEntrypoints({
      manifestPath,
      baseManifest,
      entries
    });
  }

  return persistSyncStatus(resolvedPortfolioRoot, {
    status: copied.length > 0 ? "synced" : "skipped",
    reason: copied.length > 0 ? null : "no_source_entries",
    sourcePortfolioRoot: resolvedSourceRoot,
    copied,
    entries
  });
}
