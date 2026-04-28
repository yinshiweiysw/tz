import { readJsonOrDefault, writeJsonAtomic } from "./atomic_json_state.mjs";
import { buildPortfolioPath } from "./account_root.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./manifest_state.mjs";

const EASTMONEY_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  referer: "https://fund.eastmoney.com/"
};

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "" || value === "--") {
    return null;
  }
  const numeric = Number(String(value).replace(/[,，%]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 2) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

function compactList(value, limit = 8) {
  return asArray(value).map((item) => trimText(item)).filter(Boolean).slice(0, limit);
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]*>/g, " "));
}

function normalizeDate(value) {
  const text = trimText(value);
  if (!text || text === "--") return null;
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? text;
}

function classifyTemplate({ fundName, fundType, region, existingTemplate }) {
  const text = `${fundName ?? ""} ${fundType ?? ""} ${region ?? ""}`;
  if (/QDII|海外|纳斯达克|标普|恒生|港股|日经|GLB|US|HK/i.test(text) && /FOF|基金中基金/i.test(text)) {
    return "qdii_fof_fund";
  }
  if (/QDII|海外|GLB|US|HK/i.test(text) && /商品|黄金|大宗/i.test(text)) {
    return "qdii_commodity_fund";
  }
  if (/QDII|海外|纳斯达克|标普|恒生|港股|日经|GLB|US|HK/i.test(text) && /指数|ETF|联接/i.test(text)) {
    return "qdii_index_fund";
  }
  if (/QDII|海外|纳斯达克|标普|恒生|港股|日经|GLB|US|HK/i.test(text)) {
    return "qdii_active_fund";
  }
  if (/债|现金|货币/.test(text)) {
    return "defensive_fund";
  }
  if (/指数|ETF|联接/.test(text)) {
    return "index_fund";
  }
  if (/股票|混合|主动|量化|低波/.test(text)) {
    return "active_equity_fund";
  }
  return trimText(existingTemplate) ?? "active_equity_fund";
}

function inferTheme({ fundName, fundType, existingTheme }) {
  const text = `${fundName ?? ""} ${fundType ?? ""}`;
  if (/纳斯达克100/.test(text)) return "纳斯达克100";
  if (/纳斯达克|美股科技|海外科技/.test(text)) return "美股科技/纳斯达克";
  if (/恒生互联网/.test(text)) return "恒生互联网科技业";
  if (/恒生科技/.test(text)) return "恒生科技";
  if (/标普500/.test(text)) return "标普500";
  if (/日经225/.test(text)) return "日经225";
  if (/沪深300/.test(text)) return "沪深300";
  if (/科创创业|创业板|科创/.test(text)) return "A股成长";
  if (/半导体/.test(text)) return "半导体产业链";
  if (/红利|央企/.test(text)) return "港股/央企红利";
  if (/黄金/.test(text)) return "黄金避险资产";
  if (/大宗|商品/.test(text)) return "大宗商品/黄金卫星仓";
  if (/低波|蓝筹|高鑫/.test(text)) return "低波蓝筹";
  return trimText(existingTheme) ?? null;
}

function inferTopIndustries({ theme, fundType, existingIndustries = [] }) {
  if (existingIndustries.length > 0) return existingIndustries;
  const text = `${theme ?? ""} ${fundType ?? ""}`;
  if (/纳斯达克|美股科技|海外科技/.test(text)) return ["美股科技", "AI/云计算", "大型成长股"];
  if (/恒生互联网|中概|互联网/.test(text)) return ["港股互联网", "平台经济", "消费科技"];
  if (/半导体/.test(text)) return ["半导体", "硬件", "先进制造"];
  if (/红利|央企/.test(text)) return ["港股红利", "央企", "高股息"];
  if (/黄金|商品|大宗/.test(text)) return ["大宗商品", "黄金/贵金属", "通胀与避险资产"];
  if (/低波|蓝筹/.test(text)) return ["低波蓝筹", "A股核心", "均衡权益"];
  if (/沪深300|宽基/.test(text)) return ["A股宽基", "蓝筹", "沪深300"];
  if (/创业|科创|成长/.test(text)) return ["A股成长", "科技制造", "高波弹性"];
  if (/债|现金|货币/.test(text)) return ["短债", "现金管理", "低波防守"];
  return [];
}

function buildDueDiligenceFocus({ template, theme, existing = [] }) {
  if (existing.length > 0) return existing;
  switch (template) {
    case "qdii_fof_fund":
      return [
        "确认 FOF 底层基金透明度和重复暴露",
        "区分海外交易日/汇率/净值确认滞后与真实风险变化",
        "若同类暴露冗余，优先保留更透明的代表基金"
      ];
    case "qdii_index_fund":
      return [
        `优先看 ${theme ?? "对应指数"} 代理资产趋势与回撤`,
        "检查 QDII 净值确认滞后和申赎限制",
        "复核同指数/同风格基金是否重复持有"
      ];
    case "qdii_active_fund":
      return [
        `优先看 ${theme ?? "海外主题"} 的代理资产与净值确认滞后`,
        "复核基金经理/组合风格和海外高波风险",
        "检查与同类 QDII 基金是否重复暴露"
      ];
    case "qdii_commodity_fund":
      return [
        "确认商品/黄金基金是对冲卫星仓，不按权益进攻仓处理",
        "复核商品、黄金、汇率和海外交易日带来的净值滞后",
        "若 HEDGE 桶偏离目标，优先按仓位上限复核"
      ];
    case "index_fund":
      return [
        `确认跟踪标的 ${theme ?? "指数"} 的方向和估值状态`,
        "复核费率、跟踪误差和同标的重复暴露",
        "不按主动选股逻辑解释短期表现"
      ];
    case "active_equity_fund":
      return [
        "复核基金经理/基金公司与行业穿透是否稳定",
        "检查风格漂移、回撤和同类主动基金重复暴露",
        "资料缺失时降低结论置信度"
      ];
    case "defensive_fund":
      return [
        "确认流动性、防守角色和回撤是否异常",
        "检查久期/信用风险是否偏离现金替代定位",
        "默认不参与进攻动作"
      ];
    default:
      return ["先确认基金类型，再复核代理资产、资料层和组合约束。"];
  }
}

function profileOneLine({ fundType, theme, template, lookthroughStatus }) {
  const role =
    template === "qdii_fof_fund" ? "底层透明度重点复核" :
    template === "qdii_index_fund" ? "跨市场指数暴露" :
    template === "qdii_active_fund" ? "跨市场主动/主题暴露" :
    template === "qdii_commodity_fund" ? "商品/对冲卫星" :
    template === "index_fund" ? "指数暴露" :
    template === "active_equity_fund" ? "主动权益风格" :
    template === "defensive_fund" ? "防守/现金替代" :
    "基金资料";
  return `${fundType ?? "基金"} · ${theme ?? "主题待确认"} · ${role} · ${lookthroughStatus}`;
}

async function fetchJson(url, { fetchFn = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: EASTMONEY_HEADERS,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { fetchFn = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: EASTMONEY_HEADERS,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeBaseInfo(raw = {}) {
  const info = raw?.Datas && typeof raw.Datas === "object" ? raw.Datas : raw?.FCODE ? raw : {};
  const endNavCny = toFiniteNumber(info.ENDNAV);
  const scaleCny = toFiniteNumber(info.FEGM) ?? endNavCny;
  return {
    fundName: trimText(info.SHORTNAME),
    fundCompany: trimText(info.JJGS),
    fundType: trimText(info.FTYPE),
    managerName: trimText(info.JJJL),
    managerId: trimText(info.JJJLID),
    navDate: normalizeDate(info.FSRQ),
    riskLevel: trimText(info.RISKLEVEL),
    fundSize: {
      endNavCny: endNavCny === null ? null : round(endNavCny, 2),
      endNavYi: endNavCny === null ? null : round(endNavCny / 100000000, 2),
      scaleCny: scaleCny === null ? null : round(scaleCny, 2),
      scaleYi: scaleCny === null ? null : round(scaleCny / 100000000, 2),
      asOf: normalizeDate(info.FSRQ),
      sourceField: endNavCny === null ? null : "ENDNAV"
    },
    fees: {
      subscriptionRate: trimText(info.SOURCERATE),
      discountedSubscriptionRate: trimText(info.RATE),
      redemptionRate: trimText(info.SOURCEHRG),
      minSubscriptionCny: toFiniteNumber(info.MINSG),
      minPurchaseCny: toFiniteNumber(info.MINRG),
      purchaseStatus: trimText(info.SGZT),
      redemptionStatus: trimText(info.SHZT)
    },
    rawKeys: Object.keys(info)
  };
}

export function normalizeManagers(listRaw = {}, detailRaw = {}) {
  const managers = asArray(listRaw?.Datas ?? listRaw)
    .map((item) => ({
      id: trimText(item.MGRID),
      name: trimText(item.MGRNAME),
      startDate: normalizeDate(item.FEMPDATE),
      endDate: normalizeDate(item.LEMPDATE),
      days: toFiniteNumber(item.DAYS),
      returnPct: toFiniteNumber(item.PENAVGROWTH)
    }))
    .filter((item) => item.name);
  const details = asArray(detailRaw?.Datas ?? detailRaw);
  const firstDetail = details.find((item) => trimText(item?.MGRNAME) === managers[0]?.name) ?? details[0] ?? {};
  return {
    managers,
    primaryManager: managers[0] ?? null,
    primaryResume: trimText(firstDetail.RESUME),
    primaryEducation: trimText(firstDetail.EDUCATION)
  };
}

export function normalizeMobileHoldings(raw = {}) {
  const stocks = asArray(raw?.Datas?.fundStocks);
  return stocks.map((item) => ({
    code: trimText(item.GPDM),
    name: trimText(item.GPJC),
    weightPct: toFiniteNumber(item.JZBL),
    changeType: trimText(item.PCTNVCHGTYPE),
    changePct: toFiniteNumber(item.PCTNVCHG),
    market: trimText(item.NEWTEXCH ?? item.TEXCH),
    source: "eastmoney_mobile_position"
  })).filter((item) => item.name || item.code);
}

export function parseF10Holdings(text = "") {
  const asOf = text.match(/截止至：<font[^>]*>(.*?)<\/font>/)?.[1] ?? null;
  const rows = [...String(text).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((match) => [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => stripTags(cell[1])))
    .filter((cells) => cells.length >= 7 && /^\d+$/.test(cells[0]))
    .map((cells) => ({
      code: trimText(cells[1]),
      name: trimText(cells[2]),
      weightPct: toFiniteNumber(cells[6]),
      sharesText: trimText(cells[7]),
      marketValueText: trimText(cells[8]),
      source: "eastmoney_f10_holdings",
      asOf: normalizeDate(asOf)
    }))
    .filter((item) => item.name || item.code);
  return {
    asOf: normalizeDate(asOf),
    holdings: rows
  };
}

async function fetchFundResearchSource(code, { fetchFn = globalThis.fetch } = {}) {
  const encoded = encodeURIComponent(code);
  const baseUrl = `https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx?FCODE=${encoded}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=&_=${Date.now()}`;
  const managerListUrl = `https://fundmobapi.eastmoney.com/FundMApi/FundManagerList.ashx?FCODE=${encoded}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=&_=${Date.now()}`;
  const managerDetailUrl = `https://fundmobapi.eastmoney.com/FundMApi/FundMangerDetail.ashx?FCODE=${encoded}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=&_=${Date.now()}`;
  const mobileHoldingsUrl = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${encoded}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=&_=${Date.now()}`;
  const f10HoldingsUrl = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${encoded}&topline=10&year=&month=&rt=${Date.now()}`;

  const [base, managerList, managerDetail, mobileHoldings, f10HoldingsText] = await Promise.allSettled([
    fetchJson(baseUrl, { fetchFn }),
    fetchJson(managerListUrl, { fetchFn }),
    fetchJson(managerDetailUrl, { fetchFn }),
    fetchJson(mobileHoldingsUrl, { fetchFn }),
    fetchText(f10HoldingsUrl, { fetchFn })
  ]);

  return {
    baseUrl,
    managerListUrl,
    managerDetailUrl,
    mobileHoldingsUrl,
    f10HoldingsUrl,
    base: base.status === "fulfilled" ? base.value : null,
    managerList: managerList.status === "fulfilled" ? managerList.value : null,
    managerDetail: managerDetail.status === "fulfilled" ? managerDetail.value : null,
    mobileHoldings: mobileHoldings.status === "fulfilled" ? mobileHoldings.value : null,
    f10HoldingsText: f10HoldingsText.status === "fulfilled" ? f10HoldingsText.value : null,
    errors: [base, managerList, managerDetail, mobileHoldings, f10HoldingsText]
      .map((item) => item.status === "rejected" ? String(item.reason?.message ?? item.reason) : null)
      .filter(Boolean)
  };
}

function buildProfileFromFetched({ code, seed = {}, asset = {}, position = {}, fetched = {}, now = new Date() } = {}) {
  const baseInfo = normalizeBaseInfo(fetched.base ?? {});
  const managerInfo = normalizeManagers(fetched.managerList ?? {}, fetched.managerDetail ?? {});
  const mobileHoldings = normalizeMobileHoldings(fetched.mobileHoldings ?? {});
  const f10Holdings = parseF10Holdings(fetched.f10HoldingsText ?? "");
  const topHoldings = (mobileHoldings.length > 0 ? mobileHoldings : f10Holdings.holdings).slice(0, 10);
  const fundName = baseInfo.fundName ?? trimText(seed.fundName) ?? trimText(position.name) ?? trimText(asset.name) ?? code;
  const fundCompany = baseInfo.fundCompany ?? trimText(seed.fundCompany);
  const fundType = baseInfo.fundType ?? trimText(seed.fundType);
  const region = trimText(seed.region) ?? trimText(asset.market) ?? (/QDII|海外|纳斯达克|标普|恒生|港股/.test(`${fundName} ${fundType}`) ? "GLB" : "CN");
  const theme = inferTheme({
    fundName,
    fundType,
    existingTheme: seed.underlyingIndexOrTheme
  });
  const template = classifyTemplate({
    fundName,
    fundType,
    region,
    existingTemplate: seed.analysisTemplate
  });
  const existingTemplate = trimText(seed.analysisTemplate);
  const isAutoGeneratedSeed = trimText(seed.sourceMode) === "eastmoney_sync";
  const reusableDueDiligenceFocus =
    !isAutoGeneratedSeed && existingTemplate && existingTemplate === template
      ? compactList(seed.dueDiligenceFocus, 8)
      : [];
  const lookthroughStatus = topHoldings.length > 0
    ? "latest_quarter_holdings"
    : trimText(seed.holdingLookthroughStatus) ?? "theme_only";
  const sourceUrls = [
    fetched.baseUrl,
    fetched.managerListUrl,
    fetched.managerDetailUrl,
    fetched.mobileHoldingsUrl,
    fetched.f10HoldingsUrl
  ].filter(Boolean);
  const managerName =
    managerInfo.primaryManager?.name ??
    baseInfo.managerName ??
    trimText(seed.managerName) ??
    trimText(seed.manager?.name);
  const existingIndustries = compactList(seed.topIndustries, 8);
  const limitations = [
    ...(topHoldings.length === 0 ? ["最新重仓股未能从公开接口获取，当前按主题/类型降级分析。"] : []),
    ...(!managerName ? ["基金经理未能从公开接口获取，不能做经理归因。"] : []),
    ...(template === "qdii_fof_fund" ? ["FOF 底层基金穿透仍可能滞后或不完整。"] : []),
    "公开接口字段可能滞后于基金公告，交易判断仍需本地基金护栏复核。"
  ];

  return {
    ...seed,
    fundName,
    fundCompany,
    fundType,
    region,
    underlyingIndexOrTheme: theme,
    analysisTemplate: template,
    dataQuality: topHoldings.length > 0 ? "eastmoney_holdings_sync" : "eastmoney_base_sync",
    sourceMode: "eastmoney_sync",
    sourceUrls,
    asOf: now.toISOString().slice(0, 10),
    fetchedAt: now.toISOString(),
    managerName,
    managerSourceStatus: managerName ? "eastmoney_sync" : "not_loaded",
    manager: {
      ...(seed.manager ?? {}),
      name: managerName ?? null,
      id: managerInfo.primaryManager?.id ?? baseInfo.managerId ?? seed.manager?.id ?? null,
      startDate: managerInfo.primaryManager?.startDate ?? seed.manager?.startDate ?? null,
      days: managerInfo.primaryManager?.days ?? seed.manager?.days ?? null,
      education: managerInfo.primaryEducation ?? seed.manager?.education ?? null,
      resume: managerInfo.primaryResume ?? seed.manager?.resume ?? null,
      source: managerName ? "eastmoney_manager_api" : "not_loaded"
    },
    fundSize: baseInfo.fundSize ?? seed.fundSize ?? null,
    fees: baseInfo.fees ?? seed.fees ?? null,
    riskLevel: baseInfo.riskLevel ?? seed.riskLevel ?? null,
    navDate: baseInfo.navDate ?? seed.navDate ?? null,
    holdingLookthroughStatus: lookthroughStatus,
    lookthroughSource: topHoldings.length > 0 ? topHoldings[0].source : "theme_only",
    topHoldings,
    holdingsAsOf: topHoldings[0]?.asOf ?? f10Holdings.asOf ?? baseInfo.navDate ?? seed.holdingsAsOf ?? null,
    topIndustries: inferTopIndustries({
      theme,
      fundType,
      existingIndustries
    }),
    dueDiligenceFocus: buildDueDiligenceFocus({
      template,
      theme,
      existing: reusableDueDiligenceFocus
    }),
    limitations: [...new Set([...(compactList(seed.limitations, 6)), ...limitations])].slice(0, 8),
    profileOneLine: profileOneLine({
      fundType,
      theme,
      template,
      lookthroughStatus
    }),
    confidence: topHoldings.length > 0 ? 0.82 : managerName ? 0.72 : seed.confidence ?? 0.56,
    diagnostics: {
      ...(seed.diagnostics ?? {}),
      eastmoneyErrorCount: fetched.errors.length,
      eastmoneyErrors: fetched.errors.slice(0, 3)
    }
  };
}

function collectActiveFunds({ portfolioState = {}, dashboardState = {}, assetMaster = {} } = {}) {
  const assetByCode = new Map(asArray(assetMaster.assets).map((item) => [trimText(item.symbol), item]));
  const stateRows = asArray(portfolioState.positions);
  const dashboardRows = asArray(dashboardState.rows ?? dashboardState?.payload?.rows);
  return [...dashboardRows, ...stateRows]
    .filter((item) => (toFiniteNumber(item.amount ?? item.amountCny) ?? 0) > 0)
    .map((item) => {
      const code = trimText(item.code ?? item.fundCode ?? item.fund_code ?? item.symbol);
      return {
        code,
        name: trimText(item.name ?? item.fundName ?? assetByCode.get(code)?.name),
        position: item,
        asset: assetByCode.get(code) ?? {}
      };
    })
    .filter((item, index, rows) => item.code && rows.findIndex((row) => row.code === item.code) === index);
}

export function resolveFundResearchProfilesPath(portfolioRoot, manifest = {}) {
  return manifest?.canonical_entrypoints?.fund_research_profiles ??
    buildPortfolioPath(portfolioRoot, "config", "fund_research_profiles.json");
}

export async function refreshFundResearchProfiles({
  portfolioRoot,
  fetchFn = globalThis.fetch,
  now = new Date(),
  limit = 0
} = {}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const outputPath = resolveFundResearchProfilesPath(portfolioRoot, manifest);
  const [portfolioState, dashboardState, assetMaster, existing] = await Promise.all([
    readJsonOrDefault(buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json"), {}),
    readJsonOrDefault(buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json"), {}),
    readJsonOrDefault(buildPortfolioPath(portfolioRoot, "config", "asset_master.json"), {}),
    readJsonOrDefault(outputPath, {})
  ]);
  const funds = collectActiveFunds({ portfolioState, dashboardState, assetMaster }).slice(0, Number(limit) > 0 ? Number(limit) : undefined);
  const profiles = {};
  const errors = [];
  for (const fund of funds) {
    try {
      const fetched = await fetchFundResearchSource(fund.code, { fetchFn });
      profiles[fund.code] = buildProfileFromFetched({
        code: fund.code,
        seed: existing?.profiles?.[fund.code] ?? {},
        asset: fund.asset,
        position: fund.position,
        fetched,
        now
      });
      if (fetched.errors.length > 0) {
        errors.push({ fundCode: fund.code, errors: fetched.errors.slice(0, 3) });
      }
    } catch (error) {
      const seed = existing?.profiles?.[fund.code] ?? {};
      profiles[fund.code] = {
        ...seed,
        fundCode: fund.code,
        fundName: trimText(seed.fundName) ?? fund.name,
        sourceMode: "fallback_existing_or_inferred",
        fetchedAt: now.toISOString(),
        diagnostics: {
          ...(seed.diagnostics ?? {}),
          refreshError: String(error?.message ?? error)
        }
      };
      errors.push({ fundCode: fund.code, errors: [String(error?.message ?? error)] });
    }
  }

  const payload = {
    version: 1,
    generatedAt: now.toISOString(),
    asOf: now.toISOString().slice(0, 10),
    source: "Eastmoney public fund APIs + local fallback profiles",
    sourceUrls: [
      "https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx",
      "https://fundmobapi.eastmoney.com/FundMApi/FundManagerList.ashx",
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition",
      "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
    ],
    syncStatus: {
      status: errors.length === 0 ? "ready" : errors.length < funds.length ? "partial" : "degraded",
      fundCount: funds.length,
      profileCount: Object.keys(profiles).length,
      errorCount: errors.length,
      errors: errors.slice(0, 10)
    },
    description: "Auto-refreshed fund research profiles for fund-native TradingAgents analysis. Missing lookthrough data is explicit and must not be invented.",
    profiles
  };
  await writeJsonAtomic(outputPath, payload);
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      fund_research_profiles: outputPath
    }
  });
  return {
    outputPath,
    payload
  };
}
