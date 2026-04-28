const DEFAULT_FACTOR_DEFINITIONS = {
  CN_BROAD: { label: "A股宽基" },
  CN_GROWTH: { label: "A股成长" },
  CN_ACTIVE_QUANT: { label: "A股主动量化" },
  US_TECH: { label: "美股科技" },
  US_SEMI: { label: "半导体" },
  CHINA_INTERNET: { label: "中概/港股互联网" },
  HK_DIVIDEND: { label: "港股/红利" },
  GOLD: { label: "黄金避险" },
  BOND_CASH: { label: "短债/现金替代" },
  TACTICAL_HIGH_BETA: { label: "战术高波" }
};

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? null : Math.round(numeric * 100) / 100;
}

function roundPct(value) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? null : Math.round(numeric * 100) / 100;
}

function normalizeLookupText(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function buildAssetLookup(assetMaster = {}) {
  const bySymbol = new Map();
  const byName = new Map();
  for (const asset of asArray(assetMaster?.assets)) {
    const symbol = trimText(asset?.symbol);
    if (symbol) {
      bySymbol.set(symbol, asset);
    }
    const name = normalizeLookupText(asset?.name);
    if (name) {
      byName.set(name, asset);
    }
  }
  return { bySymbol, byName };
}

function normalizeFactorDefinitions(factorProfilesConfig = {}) {
  return {
    ...DEFAULT_FACTOR_DEFINITIONS,
    ...(factorProfilesConfig?.factors ?? factorProfilesConfig?.factorDefinitions ?? {})
  };
}

function factorLabel(factorProfilesConfig = {}, factor) {
  const key = trimText(factor);
  if (!key) {
    return "未识别因子";
  }
  return trimText(normalizeFactorDefinitions(factorProfilesConfig)?.[key]?.label) ?? key;
}

function normalizeStringList(value) {
  return asArray(value)
    .map((item) => trimText(item))
    .filter(Boolean);
}

function resolveProfileFromConfig({ fundCode, fundName, factorProfilesConfig = {} } = {}) {
  const profiles = factorProfilesConfig?.profiles ?? factorProfilesConfig?.fund_factor_profiles ?? {};
  const byCode = profiles?.[fundCode];
  if (byCode) {
    return byCode;
  }
  const normalizedName = normalizeLookupText(fundName);
  return Object.values(profiles).find((profile) => normalizeLookupText(profile?.fundName) === normalizedName) ?? null;
}

function inferFactorFromText({ bucket, category, fundName, market } = {}) {
  const text = [bucket, category, fundName, market].map((item) => String(item ?? "")).join(" ");
  if (/现金|货币|短债|债券|偏债|CASH/i.test(text)) {
    return "BOND_CASH";
  }
  if (/黄金|金价|Gold/i.test(text)) {
    return "GOLD";
  }
  if (/红利|央企|低波|股息/i.test(text)) {
    return "HK_DIVIDEND";
  }
  if (/恒生互联网|中概|互联网/i.test(text)) {
    return "CHINA_INTERNET";
  }
  if (/半导体|芯片|SOXX/i.test(text)) {
    return "US_SEMI";
  }
  if (/纳斯达克|标普|海外科技|美股|QDII|QQQ/i.test(text)) {
    return "US_TECH";
  }
  if (/创业|科创|5G|通信|成长/i.test(text)) {
    return "CN_GROWTH";
  }
  if (/量化|多因子|主动|股票/i.test(text)) {
    return "CN_ACTIVE_QUANT";
  }
  if (/沪深|宽基|A股|CN/i.test(text)) {
    return "CN_BROAD";
  }
  if (/TACTICAL|战术/i.test(text)) {
    return "TACTICAL_HIGH_BETA";
  }
  return "CN_BROAD";
}

function defaultRegion({ market, bucket, factor } = {}) {
  if (market) {
    return market;
  }
  if (["US_TECH", "US_SEMI"].includes(factor)) {
    return "US";
  }
  if (["CHINA_INTERNET", "HK_DIVIDEND"].includes(factor)) {
    return "HK";
  }
  if (factor === "GOLD") {
    return "GLB";
  }
  if (bucket === "CASH") {
    return "CN";
  }
  return "CN";
}

export function resolveFundFactorProfile({
  fundCode,
  fundName,
  bucket,
  position = {},
  assetMaster = {},
  factorProfilesConfig = {}
} = {}) {
  const assetLookup = buildAssetLookup(assetMaster);
  const assetMeta =
    assetLookup.bySymbol.get(trimText(fundCode)) ??
    assetLookup.byName.get(normalizeLookupText(fundName)) ??
    {};
  const configured = resolveProfileFromConfig({ fundCode, fundName, factorProfilesConfig });
  const category = trimText(position?.category) ?? trimText(assetMeta?.category);
  const market = trimText(position?.market) ?? trimText(assetMeta?.market);
  const primaryFactor =
    trimText(configured?.primaryFactor) ??
    inferFactorFromText({
      bucket: trimText(bucket) ?? trimText(assetMeta?.bucket),
      category,
      fundName: trimText(fundName) ?? trimText(assetMeta?.name),
      market
    });
  const source = configured ? "manual_config" : "bucket_category_inferred";
  const secondaryFactors = normalizeStringList(configured?.secondaryFactors).filter((item) => item !== primaryFactor);
  const styleTags = normalizeStringList(configured?.styleTags ?? [category]);

  return {
    primaryFactor,
    primaryFactorLabel: factorLabel(factorProfilesConfig, primaryFactor),
    secondaryFactors,
    secondaryFactorLabels: secondaryFactors.map((factor) => factorLabel(factorProfilesConfig, factor)),
    proxySymbols: normalizeStringList(configured?.proxySymbols),
    region: trimText(configured?.region) ?? defaultRegion({ market, bucket, factor: primaryFactor }),
    styleTags,
    confidence: toFiniteNumber(configured?.confidence) ?? (configured ? 0.75 : 0.45),
    asOf: trimText(configured?.asOf) ?? trimText(factorProfilesConfig?.asOf),
    source
  };
}

export function buildFundFactorContribution({
  fundAnalysis = {},
  factorProfile = {},
  totalAssetsCny = 0,
  factorProfilesConfig = {}
} = {}) {
  const exposureCny = toFiniteNumber(fundAnalysis?.amountCny) ?? 0;
  const factor = trimText(factorProfile?.primaryFactor) ?? "CN_BROAD";
  return {
    factor,
    factorLabel: factorProfile?.primaryFactorLabel ?? factorLabel(factorProfilesConfig, factor),
    exposureCny: roundMoney(exposureCny),
    weightPct: totalAssetsCny > 0 ? roundPct((exposureCny / totalAssetsCny) * 100) : null,
    dayPnl: roundMoney(fundAnalysis?.dayPnl),
    holdingPnl: roundMoney(fundAnalysis?.holdingPnl)
  };
}

export function enrichFundAnalysesWithFactorAttribution({
  fundAnalyses = [],
  portfolioState = {},
  assetMaster = {},
  factorProfilesConfig = {}
} = {}) {
  const totalAssetsCny = toFiniteNumber(portfolioState?.summary?.total_portfolio_assets_cny) ??
    toFiniteNumber(portfolioState?.summary?.totalPortfolioAssets) ??
    toFiniteNumber(portfolioState?.summary?.total_assets_cny) ??
    0;
  return asArray(fundAnalyses).map((item) => {
    const factorProfile = resolveFundFactorProfile({
      fundCode: item?.fundCode,
      fundName: item?.fundName,
      bucket: item?.bucket,
      position: item?.position ?? {},
      assetMaster,
      factorProfilesConfig
    });
    const factorContribution = buildFundFactorContribution({
      fundAnalysis: item,
      factorProfile,
      totalAssetsCny,
      factorProfilesConfig
    });
    const secondary = factorProfile.secondaryFactorLabels.slice(0, 1);
    const tags = [factorProfile.primaryFactorLabel, ...secondary].filter(Boolean).join(" / ");
    return {
      ...item,
      factorProfile,
      factorContribution,
      factorOneLine: `${tags || "未识别因子"} · ${item?.oneLine ?? "仅持仓观察。"}`
    };
  });
}

export function buildFactorExposureSummary({
  fundAnalyses = [],
  totalAssetsCny = 0,
  factorProfilesConfig = {}
} = {}) {
  const byFactor = new Map();
  for (const item of asArray(fundAnalyses)) {
    const contribution = item?.factorContribution ?? buildFundFactorContribution({
      fundAnalysis: item,
      factorProfile: item?.factorProfile,
      totalAssetsCny,
      factorProfilesConfig
    });
    const factor = trimText(contribution.factor) ?? "CN_BROAD";
    const current = byFactor.get(factor) ?? {
      factor,
      factorLabel: contribution.factorLabel ?? factorLabel(factorProfilesConfig, factor),
      exposureCny: 0,
      dayPnl: 0,
      holdingPnl: 0,
      fundCount: 0,
      topFunds: []
    };
    const exposureCny = toFiniteNumber(contribution.exposureCny) ?? 0;
    current.exposureCny += exposureCny;
    current.dayPnl += toFiniteNumber(contribution.dayPnl) ?? 0;
    current.holdingPnl += toFiniteNumber(contribution.holdingPnl) ?? 0;
    current.fundCount += 1;
    current.topFunds.push({
      fundCode: item?.fundCode ?? null,
      fundName: item?.fundName ?? null,
      amountCny: roundMoney(item?.amountCny),
      dayPnl: roundMoney(item?.dayPnl)
    });
    byFactor.set(factor, current);
  }
  return [...byFactor.values()]
    .map((item) => ({
      ...item,
      exposureCny: roundMoney(item.exposureCny),
      dayPnl: roundMoney(item.dayPnl),
      holdingPnl: roundMoney(item.holdingPnl),
      weightPct: totalAssetsCny > 0 ? roundPct((item.exposureCny / totalAssetsCny) * 100) : null,
      topFunds: item.topFunds
        .sort((left, right) => (toFiniteNumber(right.amountCny) ?? 0) - (toFiniteNumber(left.amountCny) ?? 0))
        .slice(0, 3)
    }))
    .sort((left, right) => (toFiniteNumber(right.exposureCny) ?? 0) - (toFiniteNumber(left.exposureCny) ?? 0));
}

export function buildBucketFactorSummary({ fundAnalyses = [], totalAssetsCny = 0 } = {}) {
  const byBucketFactor = new Map();
  for (const item of asArray(fundAnalyses)) {
    const bucket = trimText(item?.bucket) ?? "UNMAPPED";
    const factor = trimText(item?.factorContribution?.factor) ?? trimText(item?.factorProfile?.primaryFactor) ?? "CN_BROAD";
    const key = `${bucket}:${factor}`;
    const current = byBucketFactor.get(key) ?? {
      bucket,
      bucketLabel: item?.bucketLabel ?? bucket,
      factor,
      factorLabel: item?.factorContribution?.factorLabel ?? item?.factorProfile?.primaryFactorLabel ?? factor,
      exposureCny: 0,
      fundCount: 0
    };
    current.exposureCny += toFiniteNumber(item?.amountCny) ?? 0;
    current.fundCount += 1;
    byBucketFactor.set(key, current);
  }
  const byBucket = new Map();
  for (const item of byBucketFactor.values()) {
    const current = byBucket.get(item.bucket) ?? {
      bucket: item.bucket,
      bucketLabel: item.bucketLabel,
      factors: []
    };
    current.factors.push({
      factor: item.factor,
      factorLabel: item.factorLabel,
      exposureCny: roundMoney(item.exposureCny),
      weightPct: totalAssetsCny > 0 ? roundPct((item.exposureCny / totalAssetsCny) * 100) : null,
      fundCount: item.fundCount
    });
    byBucket.set(item.bucket, current);
  }
  return [...byBucket.values()].map((item) => ({
    ...item,
    factors: item.factors.sort((left, right) => (right.exposureCny ?? 0) - (left.exposureCny ?? 0)).slice(0, 3)
  }));
}

export function buildFactorRiskNotes({ factorExposureSummary = [] } = {}) {
  const notes = [];
  const dominant = asArray(factorExposureSummary)[0];
  if (dominant) {
    notes.push(`最大因子暴露：${dominant.factorLabel}，约 ${dominant.weightPct ?? "--"}%。`);
  }
  const negative = asArray(factorExposureSummary)
    .filter((item) => (toFiniteNumber(item?.dayPnl) ?? 0) < 0)
    .sort((left, right) => (toFiniteNumber(left.dayPnl) ?? 0) - (toFiniteNumber(right.dayPnl) ?? 0))[0];
  if (negative) {
    notes.push(`今日主要拖累：${negative.factorLabel} ${negative.dayPnl} 元。`);
  }
  const concentrated = asArray(factorExposureSummary).filter((item) => (toFiniteNumber(item?.weightPct) ?? 0) >= 20);
  if (concentrated.length > 0) {
    notes.push(`集中度关注：${concentrated.map((item) => item.factorLabel).slice(0, 3).join(" / ")}。`);
  }
  return notes.slice(0, 4);
}
