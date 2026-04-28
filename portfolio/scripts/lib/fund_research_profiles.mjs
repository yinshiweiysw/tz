function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactList(value, limit = 6) {
  return asArray(value).map((item) => trimText(item)).filter(Boolean).slice(0, limit);
}

function inferFundCompany(fundName) {
  const name = String(fundName ?? "").trim();
  const match = name.match(/^([\u4e00-\u9fa5]{2,6})(?:中证|沪深|创业板|科创|纳斯达克|标普|恒生|港股|海外|大宗|高鑫|量化|先锋|黄金|现金|短债|三菱|日经|互联|5G|半导体|红利|商品|中国|全球|标普|QDII|ETF|LOF|FOF)/);
  return match?.[1] ? `${match[1]}基金` : null;
}

function inferFundType({ fundName, category }) {
  const text = `${fundName ?? ""} ${category ?? ""}`;
  if (/FOF/i.test(text)) return "FOF/基金中基金";
  if (/ETF联接|联接/.test(text)) return "ETF联接基金";
  if (/指数|沪深|中证|标普|纳斯达克|恒生|日经/.test(text)) return "指数/指数增强基金";
  if (/股票|混合|主动|量化/.test(text)) return "主动权益基金";
  if (/债|现金|货币/.test(text)) return "固收/现金替代基金";
  return "基金";
}

function inferUnderlyingTheme({ fundName, category, factorProfile = {} }) {
  const text = `${fundName ?? ""} ${category ?? ""} ${factorProfile?.primaryFactorLabel ?? ""}`;
  if (/纳斯达克|美股科技|海外科技/.test(text)) return "美股科技/纳斯达克";
  if (/半导体/.test(text)) return "半导体产业链";
  if (/恒生互联网|港股互联网|中概|互联网/.test(text)) return "港股/中概互联网";
  if (/大宗|商品/.test(text)) return "大宗商品配置";
  if (/黄金/.test(text)) return "黄金避险资产";
  if (/红利|央企/.test(text)) return "港股/央企红利";
  if (/沪深300|A股宽基/.test(text)) return "A股宽基/沪深300";
  if (/创业板|科创|成长/.test(text)) return "A股成长";
  if (/量化|多因子/.test(text)) return "A股主动量化";
  if (/低波|蓝筹/.test(text)) return "低波蓝筹";
  if (/债|现金|货币/.test(text)) return "低波现金替代";
  return factorProfile?.primaryFactorLabel ?? null;
}

function inferIndustries({ factorProfile = {}, fundName, category }) {
  const factor = String(factorProfile?.primaryFactor ?? "");
  const text = `${fundName ?? ""} ${category ?? ""}`;
  if (factor === "US_TECH") return ["美股科技", "软件/平台", "AI/云计算"];
  if (factor === "US_SEMI" || /半导体/.test(text)) return ["半导体", "硬件", "先进制造"];
  if (factor === "CHINA_INTERNET") return ["互联网平台", "港股科技", "消费科技"];
  if (factor === "HK_DIVIDEND") return ["港股红利", "央企", "高股息"];
  if (factor === "GOLD") return ["黄金", "贵金属", "避险资产"];
  if (factor === "BOND_CASH") return ["短债", "现金管理", "低波防守"];
  if (factor === "CN_GROWTH") return ["A股成长", "科技制造", "高波弹性"];
  if (factor === "CN_ACTIVE_QUANT") return ["A股主动", "量化多因子", "中小盘/宽基"];
  if (factor === "CN_BROAD") return ["A股宽基", "蓝筹", "沪深300"];
  if (/低波|蓝筹/.test(text)) return ["低波蓝筹", "A股核心", "均衡权益"];
  return compactList(factorProfile?.styleTags, 3);
}

function inferTemplate({ region, fundType }) {
  const text = `${region ?? ""} ${fundType ?? ""}`;
  if (/FOF|基金中基金/i.test(text) && /QDII|海外|美股|港股|GLB|US|HK/i.test(text)) {
    return "qdii_fof_fund";
  }
  if (/QDII|海外|GLB|US|HK/i.test(text) && /商品|黄金|大宗/i.test(text)) {
    return "qdii_commodity_fund";
  }
  if (/QDII|海外|美股|港股|GLB|US|HK/i.test(text) && /指数|ETF|联接/i.test(text)) {
    return "qdii_index_fund";
  }
  if (/QDII|海外|美股|港股|GLB|US|HK/i.test(text)) {
    return "qdii_active_fund";
  }
  if (/固收|现金|债/.test(String(fundType ?? ""))) {
    return "defensive_fund";
  }
  if (/指数|ETF/.test(String(fundType ?? ""))) {
    return "index_fund";
  }
  return "active_equity_fund";
}

export function resolveFundResearchProfile({
  fundCode,
  fundName,
  bucket,
  position = {},
  assetMaster = {},
  factorProfile = {},
  researchProfilesConfig = {}
} = {}) {
  const code = trimText(fundCode);
  const configured = code ? researchProfilesConfig?.profiles?.[code] ?? null : null;
  const asset = asArray(assetMaster?.assets).find((item) => trimText(item?.symbol) === code) ?? {};
  const name = trimText(configured?.fundName) ?? trimText(fundName) ?? trimText(asset?.name);
  const category = trimText(configured?.category) ?? trimText(position?.category) ?? trimText(asset?.category);
  const fundType = trimText(configured?.fundType) ?? inferFundType({ fundName: name, category });
  const region = trimText(configured?.region) ?? trimText(factorProfile?.region) ?? trimText(asset?.market);
  const underlyingTheme =
    trimText(configured?.underlyingIndexOrTheme) ??
    inferUnderlyingTheme({ fundName: name, category, factorProfile });
  const topIndustries = compactList(configured?.topIndustries, 8);
  const inferredIndustries = inferIndustries({ factorProfile, fundName: name, category });
  const topHoldings = asArray(configured?.topHoldings).slice(0, 10).map((item) => ({
    name: trimText(item?.name ?? item),
    weightPct: Number.isFinite(Number(item?.weightPct)) ? Number(item.weightPct) : null,
    source: trimText(item?.source) ?? trimText(configured?.source) ?? null,
    asOf: trimText(item?.asOf) ?? trimText(configured?.holdingsAsOf) ?? null
  })).filter((item) => item.name);
  const holdingsAsOf =
    trimText(configured?.holdingsAsOf) ??
    trimText(topHoldings.find((item) => item.asOf)?.asOf) ??
    null;
  const holdingLookthroughStatus =
    trimText(configured?.holdingLookthroughStatus) ??
    (topHoldings.length > 0 || topIndustries.length > 0 ? "profile_partial" : "not_loaded");
  const dataQuality =
    trimText(configured?.dataQuality) ??
    (configured ? "manual_profile_v1" : "inferred_from_local_metadata");
  const limitations = compactList(configured?.limitations, 8);
  const managerName = trimText(configured?.managerName) ?? trimText(configured?.manager?.name);
  const managerSourceStatus = trimText(configured?.managerSourceStatus) ?? (managerName ? "configured" : "not_loaded");
  const template = trimText(configured?.analysisTemplate) ?? inferTemplate({ region, fundType });
  const profileOneLine =
    trimText(configured?.profileOneLine) ??
    `${fundType} · ${underlyingTheme ?? "主题待确认"} · ${holdingLookthroughStatus === "not_loaded" ? "持仓穿透待补" : "已有部分穿透资料"}`;

  return {
    profileVersion: 1,
    source: configured ? "fund_research_profiles" : "inferred_local_metadata",
    dataQuality,
    sourceMode: trimText(configured?.sourceMode) ?? null,
    asOf: trimText(configured?.asOf) ?? trimText(researchProfilesConfig?.asOf) ?? null,
    fetchedAt: trimText(configured?.fetchedAt) ?? null,
    navDate: trimText(configured?.navDate) ?? null,
    holdingsAsOf,
    fundCode: code,
    fundName: name,
    fundCompany: trimText(configured?.fundCompany) ?? inferFundCompany(name),
    fundSize: configured?.fundSize ?? null,
    fees: configured?.fees ?? null,
    fundType,
    region,
    bucket: trimText(bucket) ?? trimText(asset?.bucket),
    underlyingIndexOrTheme: underlyingTheme,
    analysisTemplate: template,
    manager: {
      name: managerName ?? trimText(configured?.manager?.name),
      sourceStatus: managerSourceStatus
    },
    lookthrough: {
      status: holdingLookthroughStatus,
      source: trimText(configured?.lookthroughSource) ?? "local_profile",
      topIndustries: topIndustries.length > 0 ? topIndustries : inferredIndustries,
      topHoldings
    },
    dueDiligenceFocus: compactList(configured?.dueDiligenceFocus, 8),
    limitations: limitations.length > 0
      ? limitations
      : [
          "未加载最新基金季报/半年报持仓穿透时，不得编造重仓股或基金经理结论。",
          "基金净值可能滞后于代理资产，交易结论必须经过本地基金护栏。"
        ],
    profileOneLine,
    confidence: Number.isFinite(Number(configured?.confidence)) ? Number(configured.confidence) : configured ? 0.68 : 0.42
  };
}
