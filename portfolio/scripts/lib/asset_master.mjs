import { readFile } from "node:fs/promises";
import { buildPortfolioPath, resolvePortfolioRoot } from "./account_root.mjs";

export function resolveDefaultAssetMasterPath(portfolioRoot = resolvePortfolioRoot()) {
  return buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
}

export const defaultAssetMasterPath = resolveDefaultAssetMasterPath();

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizePct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric;
}

function normalizeBucketConfig(bucketKey, bucket) {
  const targetPct = toNumberOrNull(bucket?.target ?? bucket?.target_pct);
  const minPct = normalizePct(bucket?.min ?? bucket?.min_pct);
  const maxPct = normalizePct(bucket?.max ?? bucket?.max_pct);
  return {
    key: bucketKey,
    label: bucket?.label ?? bucketKey,
    shortLabel: bucket?.short_label ?? bucket?.label ?? bucketKey,
    driver: bucket?.driver ?? bucket?.risk_role ?? null,
    targetAmount: toNumberOrNull(bucket?.target_amount_cny),
    targetPct,
    minPct,
    maxPct,
    riskRole: bucket?.risk_role ?? bucket?.driver ?? null,
    benchmarkSleeveKey: bucket?.benchmark_sleeve_key ?? null
  };
}

function matchesRule(rule, category, name) {
  const categoryEquals = Array.isArray(rule?.category_equals) ? rule.category_equals : [];
  const namePatterns = Array.isArray(rule?.name_patterns) ? rule.name_patterns : [];

  const categoryMatch = category ? categoryEquals.includes(category) : false;
  const nameMatch = name
    ? namePatterns.some((pattern) => new RegExp(String(pattern), "u").test(name))
    : false;

  if (categoryEquals.length > 0 || namePatterns.length > 0) {
    return categoryMatch || nameMatch;
  }

  return false;
}

export async function loadAssetMaster(path = defaultAssetMasterPath) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (!payload?.buckets || !payload?.bucket_mapping_rules) {
    throw new Error(`Invalid asset master config: ${path}`);
  }
  return payload;
}

export function getBucketEntries(assetMaster) {
  const order = Array.isArray(assetMaster?.bucket_order)
    ? assetMaster.bucket_order
    : Object.keys(assetMaster?.buckets ?? {});

  return order.map((bucketKey) => [
    bucketKey,
    normalizeBucketConfig(bucketKey, assetMaster?.buckets?.[bucketKey] ?? {})
  ]);
}

export function buildBucketConfigMap(assetMaster) {
  return Object.fromEntries(getBucketEntries(assetMaster));
}

export function resolveBucketKey(assetMaster, subject = {}) {
  const category = String(
    subject?.category ?? subject?.latestCategory ?? subject?.latest_category ?? ""
  ).trim();
  const name = String(subject?.name ?? "").trim();

  for (const rule of assetMaster?.bucket_mapping_rules ?? []) {
    if (matchesRule(rule, category, name)) {
      return rule.bucket_key;
    }
  }

  return assetMaster?.fallback_bucket_key ?? "TACTICAL";
}

export function resolveBucketLabel(assetMaster, bucketKey) {
  return assetMaster?.buckets?.[bucketKey]?.label ?? "未分类仓位";
}

export function resolveRiskRole(assetMaster, bucketKey) {
  return assetMaster?.buckets?.[bucketKey]?.risk_role ?? assetMaster?.buckets?.[bucketKey]?.driver ?? null;
}

export function getPerformanceBenchmarkSleeves(assetMaster) {
  return assetMaster?.performance_benchmark?.sleeves ?? {};
}

function normalizeSleevePct(value, fallback = 0.15) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(Math.max(numeric, 0), 0.15);
}

export function getSpeculativeSleeveConfig(assetMaster = {}) {
  const sleeve = assetMaster?.speculative_sleeve ?? {};
  return {
    maxPct: normalizeSleevePct(sleeve.max_pct, 0.15),
    defaultExit: String(sleeve.default_exit ?? "反弹分批止盈").trim(),
    scaleInSteps: Array.isArray(sleeve.scale_in_steps) ? sleeve.scale_in_steps : [],
    allowedTriggerSources: Array.isArray(sleeve.allowed_trigger_sources)
      ? sleeve.allowed_trigger_sources
      : []
  };
}
