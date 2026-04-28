import { fileURLToPath } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./account_root.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./atomic_json_state.mjs";
import { updateManifestCanonicalEntrypoints, readManifestState } from "./manifest_state.mjs";
import { aggregateTradingAgentsCallsByBucket, mapBucketSuggestionsToFunds, translateTradingAgentsRating } from "./tradingagents_mapping.mjs";
import { applyTradingAdviceGuardrails } from "./tradingagents_guardrails.mjs";

const DEFAULT_BRIDGE_CONFIG_PATH = fileURLToPath(
  new URL("../../config/tradingagents_bridge.json", import.meta.url)
);
const DEFAULT_FIXTURE_RAW_PATH = fileURLToPath(
  new URL("../../fixtures/tradingagents_raw_snapshot.fixture.json", import.meta.url)
);

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeBrainProfile(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["fast", "full"].includes(text) ? text : null;
}

function resolveRawBrainProfile(rawSnapshot = {}, bridgeConfig = {}) {
  return (
    normalizeBrainProfile(rawSnapshot?.runtimeConfig?.brainProfile) ??
    normalizeBrainProfile(rawSnapshot?.runtimeDiagnostics?.brainProfile) ??
    normalizeBrainProfile(
      (Array.isArray(rawSnapshot?.calls) ? rawSnapshot.calls : [])
        .map((call) => call?.runtimeDiagnostics?.brainProfile)
        .find(Boolean)
    ) ??
    normalizeBrainProfile(bridgeConfig?.providerDefaults?.brainProfile)
  );
}

function toDisplayBucketLabel(assetMaster = {}, bucket) {
  return (
    trimText(assetMaster?.buckets?.[bucket]?.label) ??
    trimText(assetMaster?.buckets?.[bucket]?.short_label) ??
    trimText(bucket) ??
    "未命名桶"
  );
}

function buildBlockedSuggestions(blockedCalls = [], blockedFundMappings = [], ratingMap = {}) {
  const items = [];

  for (const blocked of blockedCalls) {
    items.push({
      symbol: trimText(blocked?.symbol),
      bucket: trimText(blocked?.bucket),
      reason: trimText(blocked?.reason) ?? "blocked"
    });
  }

  for (const blocked of blockedFundMappings) {
    items.push({
      bucket: trimText(blocked?.bucket),
      reason: trimText(blocked?.reason) ?? "bucket_has_no_fund_mapping",
      verdict: blocked?.rating ? translateTradingAgentsRating(blocked.rating, ratingMap) : null
    });
  }

  return items;
}

export async function loadTradingAgentsBridgeConfig(configPath = DEFAULT_BRIDGE_CONFIG_PATH) {
  return (await readJsonOrDefault(configPath, {})) ?? {};
}

export async function loadTradingAgentsRawFixture(fixturePath = DEFAULT_FIXTURE_RAW_PATH) {
  return (await readJsonOrDefault(fixturePath, {})) ?? {};
}

export function resolveTradingAdvicePaths(portfolioRoot, manifest = {}) {
  const canonical = manifest?.canonical_entrypoints ?? {};
  return {
    manifestPath: buildPortfolioPath(portfolioRoot, "state-manifest.json"),
    assetMasterPath:
      canonical.asset_master ?? buildPortfolioPath(portfolioRoot, "config", "asset_master.json"),
    rawSnapshotPath:
      canonical.latest_tradingagents_raw_snapshot ??
      buildPortfolioPath(portfolioRoot, "data", "tradingagents_raw_snapshot.json"),
    adviceSnapshotPath:
      canonical.latest_trading_advice_snapshot ??
      buildPortfolioPath(portfolioRoot, "data", "trading_advice_snapshot.json")
  };
}

export async function buildTradingAdviceSnapshot({
  rawSnapshot = {},
  assetMaster = {},
  bridgeConfig = {},
  accountId = "main",
  now = new Date()
} = {}) {
  const ratingMap = bridgeConfig?.ratingMap ?? {};
  const phase1Buckets = Array.isArray(bridgeConfig?.phase1Buckets) ? bridgeConfig.phase1Buckets : [];
  const { bucketSuggestions, blockedCalls } = aggregateTradingAgentsCallsByBucket(rawSnapshot?.calls ?? [], {
    bucketProxyUniverse: bridgeConfig?.bucketProxyUniverse ?? {},
    phase1Buckets,
    ratingConfidenceDefaults: bridgeConfig?.ratingConfidenceDefaults ?? {}
  });
  const { fundSuggestions, blockedSuggestions: blockedFundMappings } = mapBucketSuggestionsToFunds(
    bucketSuggestions,
    assetMaster,
    { ratingMap }
  );
  const blockedSuggestions = buildBlockedSuggestions(blockedCalls, blockedFundMappings, ratingMap);
  const guarded = applyTradingAdviceGuardrails(rawSnapshot, {
    bucketSuggestions: bucketSuggestions.map((item) => ({
      bucket: item.bucket,
      bucketLabel: toDisplayBucketLabel(assetMaster, item.bucket),
      rating: item.rating,
      verdict: translateTradingAgentsRating(item.rating, ratingMap),
      confidence: item.confidence,
      confidenceSource: item.confidenceSource,
      proxySymbols: item.proxySymbols,
      reasonSummary: item.reasonSummary,
      risks: item.risks,
      riskJudge: item.riskJudge,
      investmentJudge: item.investmentJudge,
      signalCount: item.signalCount
    })),
    fundSuggestions,
    blockedSuggestions,
    now,
    staleAfterHours: bridgeConfig?.staleAfterHours ?? 36
  });

  return {
    generatedAt: now.toISOString(),
    asOf: trimText(rawSnapshot?.asOf) ?? trimText(rawSnapshot?.generatedAt),
    accountId,
    mode: trimText(rawSnapshot?.mode) ?? "fixture",
    source: trimText(rawSnapshot?.source) ?? "TradingAgents",
    provider: trimText(rawSnapshot?.provider),
    brainProfile: resolveRawBrainProfile(rawSnapshot, bridgeConfig),
    status: guarded.status,
    freshnessLabel: guarded.freshness.freshnessLabel,
    ageHours: guarded.freshness.ageHours,
    rawCallCount: Array.isArray(rawSnapshot?.calls) ? rawSnapshot.calls.length : 0,
    bucketSuggestions: guarded.bucketSuggestions,
    fundSuggestions: guarded.fundSuggestions,
    blockedSuggestions: guarded.blockedSuggestions
  };
}

export async function loadTradingAdviceSnapshot({
  portfolioRoot = resolvePortfolioRoot(),
  accountId = resolveAccountId({ portfolioRoot }),
  allowFixtureFallback = true,
  now = new Date(),
  manifest = null,
  bridgeConfig = null
} = {}) {
  const resolvedManifest = manifest ?? (await readManifestState(buildPortfolioPath(portfolioRoot, "state-manifest.json")));
  const paths = resolveTradingAdvicePaths(portfolioRoot, resolvedManifest);
  const persisted = await readJsonOrDefault(paths.adviceSnapshotPath, null);
  if (persisted) {
    return persisted;
  }

  const rawSnapshot =
    (await readJsonOrDefault(paths.rawSnapshotPath, null)) ??
    (allowFixtureFallback ? await loadTradingAgentsRawFixture() : null);
  if (!rawSnapshot) {
    return {
      generatedAt: now.toISOString(),
      asOf: null,
      accountId,
      mode: "fixture",
      source: "TradingAgents",
      status: "blocked",
      freshnessLabel: "unknown",
      ageHours: null,
      rawCallCount: 0,
      bucketSuggestions: [],
      fundSuggestions: [],
      blockedSuggestions: [
        {
          reason: "raw_snapshot_missing",
          guardrailStatus: "blocked"
        }
      ]
    };
  }

  const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingAgentsBridgeConfig());
  const assetMaster = (await readJsonOrDefault(paths.assetMasterPath, {})) ?? {};
  return buildTradingAdviceSnapshot({
    rawSnapshot,
    assetMaster,
    bridgeConfig: resolvedBridgeConfig,
    accountId,
    now
  });
}

export async function persistTradingAdviceArtifacts({
  portfolioRoot = resolvePortfolioRoot(),
  accountId = resolveAccountId({ portfolioRoot }),
  rawSnapshot = {},
  adviceSnapshot = null,
  bridgeConfig = null,
  now = new Date()
} = {}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const paths = resolveTradingAdvicePaths(portfolioRoot, manifest);
  const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingAgentsBridgeConfig());
  const assetMaster = (await readJsonOrDefault(paths.assetMasterPath, {})) ?? {};
  const nextAdviceSnapshot =
    adviceSnapshot ??
    (await buildTradingAdviceSnapshot({
      rawSnapshot,
      assetMaster,
      bridgeConfig: resolvedBridgeConfig,
      accountId,
      now
    }));

  await writeJsonAtomic(paths.rawSnapshotPath, rawSnapshot);
  await writeJsonAtomic(paths.adviceSnapshotPath, nextAdviceSnapshot);
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      latest_tradingagents_raw_snapshot: paths.rawSnapshotPath,
      latest_trading_advice_snapshot: paths.adviceSnapshotPath
    }
  });

  return {
    rawSnapshotPath: paths.rawSnapshotPath,
    adviceSnapshotPath: paths.adviceSnapshotPath,
    rawSnapshot,
    adviceSnapshot: nextAdviceSnapshot
  };
}
