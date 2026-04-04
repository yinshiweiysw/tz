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

function normalizeMatchText(value) {
  return String(value ?? "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[（）()［］\[\]\s\-_/·.]/g, "")
    .trim()
    .toLowerCase();
}

function normalizePct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
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

function matchesThemeRule(rule, subject = {}) {
  const category = String(
    subject?.category ?? subject?.latestCategory ?? subject?.latest_category ?? ""
  ).trim();
  const name = String(subject?.name ?? subject?.fund_name ?? "").trim();
  const codeCandidates = new Set(buildAssetCodeCandidates(subject));
  const bucketKey = String(
    subject?.bucket_key ?? subject?.bucketKey ?? subject?.bucket ?? ""
  ).trim();
  const market = String(subject?.market ?? "").trim();
  const bucketKeys = normalizeStringArray(rule?.bucket_keys);
  const marketEquals = normalizeStringArray(rule?.market_equals);
  const codeEquals = normalizeStringArray(rule?.code_equals);

  if (bucketKeys.length > 0 && (!bucketKey || !bucketKeys.includes(bucketKey))) {
    return false;
  }
  if (marketEquals.length > 0 && (!market || !marketEquals.includes(market))) {
    return false;
  }

  if (codeEquals.length > 0) {
    for (const code of codeEquals) {
      if (codeCandidates.has(code)) {
        return true;
      }
    }
  }

  return matchesRule(rule, category, name);
}

function buildAssetCodeCandidates(subject = {}) {
  return [
    subject?.fund_code,
    subject?.code,
    subject?.symbol
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function buildAssetNameCandidates(subject = {}) {
  return [subject?.name, subject?.fund_name]
    .map((value) => normalizeMatchText(value))
    .filter(Boolean);
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

function normalizeThemeConfig(themeKey, theme) {
  return {
    key: themeKey,
    label: theme?.label ?? themeKey,
    bucketKeys: normalizeStringArray(theme?.bucket_keys)
  };
}

export function getThemeEntries(assetMaster) {
  return Object.entries(assetMaster?.themes ?? {}).map(([themeKey, theme]) => [
    themeKey,
    normalizeThemeConfig(themeKey, theme)
  ]);
}

export function buildThemeConfigMap(assetMaster) {
  return Object.fromEntries(getThemeEntries(assetMaster));
}

export function resolveAssetDefinition(assetMaster, subject = {}) {
  const assets = Array.isArray(assetMaster?.assets) ? assetMaster.assets : [];
  if (!assets.length) {
    return null;
  }

  const codeCandidates = new Set(buildAssetCodeCandidates(subject));
  const nameCandidates = buildAssetNameCandidates(subject);

  for (const asset of assets) {
    const assetCode = String(
      asset?.symbol ?? asset?.fund_code ?? asset?.code ?? ""
    ).trim();
    if (assetCode && codeCandidates.has(assetCode)) {
      return asset;
    }
  }

  if (!nameCandidates.length) {
    return null;
  }

  for (const asset of assets) {
    const assetName = normalizeMatchText(asset?.name);
    if (!assetName) {
      continue;
    }

    const matched = nameCandidates.some(
      (candidate) =>
        candidate === assetName ||
        candidate.includes(assetName) ||
        assetName.includes(candidate)
    );
    if (matched) {
      return asset;
    }
  }

  return null;
}

export function resolveBucketKey(assetMaster, subject = {}) {
  const explicitBucketKey = String(
    subject?.bucket_key ?? subject?.bucketKey ?? subject?.bucket ?? ""
  ).trim();
  if (explicitBucketKey) {
    return explicitBucketKey;
  }

  const assetDefinition = resolveAssetDefinition(assetMaster, subject);
  const explicitAssetBucket = String(assetDefinition?.bucket ?? assetDefinition?.bucket_key ?? "").trim();
  if (explicitAssetBucket) {
    return explicitAssetBucket;
  }

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

export function resolveThemeKey(assetMaster, subject = {}) {
  const explicitThemeKey = String(
    subject?.theme_key ?? subject?.themeKey ?? ""
  ).trim();
  if (explicitThemeKey) {
    return explicitThemeKey;
  }

  const assetDefinition = resolveAssetDefinition(assetMaster, subject);
  const assetThemeKey = String(assetDefinition?.theme_key ?? assetDefinition?.themeKey ?? "").trim();
  if (assetThemeKey) {
    return assetThemeKey;
  }

  const category = String(
    subject?.category ?? subject?.latestCategory ?? subject?.latest_category ?? ""
  ).trim();
  const name = String(subject?.name ?? subject?.fund_name ?? "").trim();
  const bucketKey = resolveBucketKey(assetMaster, subject);

  for (const rule of assetMaster?.theme_mapping_rules ?? []) {
    if (
      matchesThemeRule(rule, {
        ...subject,
        category,
        name,
        bucket: bucketKey
      })
    ) {
      return rule.theme_key ?? null;
    }
  }

  return assetMaster?.fallback_theme_key ?? "UNCLASSIFIED";
}

export function resolveThemeLabel(assetMaster, themeKey) {
  const normalizedThemeKey = String(themeKey ?? "").trim();
  if (!normalizedThemeKey) {
    return "未分类主题";
  }
  return assetMaster?.themes?.[normalizedThemeKey]?.label ?? normalizedThemeKey;
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
