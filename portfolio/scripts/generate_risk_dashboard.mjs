import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildBucketConfigMap,
  loadAssetMaster,
  resolveBucketKey,
  resolveBucketLabel,
  resolveRiskRole
} from "./lib/asset_master.mjs";
import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { writeJsonAtomic } from "./lib/atomic_json_state.mjs";
import { loadIpsConstraints } from "./lib/ips_constraints.mjs";
import { buildPortfolioRiskState } from "./lib/portfolio_risk_state.mjs";
import { loadCanonicalPortfolioState, readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import { buildCanonicalPortfolioView } from "./lib/portfolio_canonical_view.mjs";
import { round } from "./lib/format_utils.mjs";
const RISK_RESONANCE_THRESHOLD = 0.6;
const HEDGE_DISCOVERY_THRESHOLD = -0.6;

let assetMaster = null;
let bucketConfigMap = {};
let quantMetrics = null;

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    result[token.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }

  return result;
}

function pct(amount, base) {
  if (!base || !Number.isFinite(base)) {
    return null;
  }
  return round((amount / base) * 100);
}

function sumAmounts(items) {
  return round(items.reduce((sum, item) => sum + Number(item.amount ?? 0), 0));
}

export function deriveRiskCapitalContext({ latest = {}, accountContext = {} } = {}) {
  const summary = latest?.summary ?? {};
  const cashLedger = latest?.cash_ledger ?? {};
  const investedAssetsCny =
    Number(summary?.total_fund_assets ?? 0) ||
    Number(summary?.effective_exposure_after_pending_sell ?? 0) ||
    0;
  const settledCashCny =
    Number(summary?.settled_cash_cny ?? cashLedger?.settled_cash_cny ?? summary?.available_cash_cny ?? cashLedger?.available_cash_cny ?? accountContext?.available_cash_cny ?? accountContext?.reported_cash_estimate_cny ?? 0) ||
    0;
  const tradeAvailableCashCny =
    Number(summary?.trade_available_cash_cny ?? cashLedger?.trade_available_cash_cny ?? settledCashCny) ||
    0;
  const cashLikeFundAssetsCny =
    Number(summary?.cash_like_fund_assets_cny ?? cashLedger?.cash_like_fund_assets_cny ?? 0) || 0;
  const liquiditySleeveAssetsCny =
    Number(summary?.liquidity_sleeve_assets_cny ?? cashLedger?.liquidity_sleeve_assets_cny ?? cashLikeFundAssetsCny) || 0;
  const totalAssetsCny =
    Number(summary?.total_portfolio_assets_cny ?? summary?.total_assets_cny ?? accountContext?.total_assets_cny ?? accountContext?.reported_total_assets_range_cny?.min ?? investedAssetsCny + settledCashCny) ||
    0;

  return {
    total_assets_cny: round(totalAssetsCny),
    invested_assets_cny: round(investedAssetsCny),
    settled_cash_cny: round(settledCashCny),
    trade_available_cash_cny: round(tradeAvailableCashCny),
    cash_like_fund_assets_cny: round(cashLikeFundAssetsCny),
    liquidity_sleeve_assets_cny: round(liquiditySleeveAssetsCny),
    reported_cash_estimate_cny: Number(accountContext?.reported_cash_estimate_cny ?? 0) || 0
  };
}

function effectiveCountFromBuckets(buckets) {
  const values = Object.values(buckets)
    .map((value) => Number(value ?? 0))
    .filter((value) => value > 0);

  if (values.length === 0) {
    return null;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  const sumSquares = values.reduce((sum, value) => sum + Math.pow(value / total, 2), 0);

  if (!sumSquares) {
    return null;
  }

  return round(1 / sumSquares, 2);
}

function inferCategoryFromName(name) {
  const text = String(name ?? "");

  if (text.includes("半导体") || text.includes("芯片")) {
    return "A股主动";
  }
  if (text.includes("黄金")) {
    return "黄金";
  }
  if (text.includes("沪深300")) {
    return "A股宽基";
  }
  if (text.includes("红利")) {
    return "A股红利低波";
  }
  if (text.includes("恒生科技")) {
    return "港股科技/QDII";
  }
  if (text.includes("恒生互联网") || text.includes("港股通互联网") || text.includes("港股互联网")) {
    return "港股互联网/QDII";
  }
  if (text.includes("纳斯达克") || text.includes("海外科技")) {
    return "美股科技/QDII";
  }
  if (text.includes("标普500")) {
    return "美股指数/QDII";
  }
  if (text.includes("大宗商品")) {
    return "大宗商品/QDII";
  }
  return "未分类";
}

function clonePositions(positions) {
  return positions.map((position) => ({ ...position }));
}

function normalizeName(value) {
  return String(value ?? "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/QDII-FOF-LOF/g, "QDII")
    .replace(/QDII-LOF/g, "QDII")
    .replace(/ETF发起式联接/g, "")
    .replace(/ETF发起联接/g, "")
    .replace(/[（）()［］\[\]\s\-_/·.]/g, "")
    .replace(/持有期/g, "持有")
    .replace(/发起式/g, "")
    .replace(/人民币/g, "")
    .replace(/ETF联接/g, "")
    .replace(/联接/g, "")
    .trim();
}

function bucketKeyFromPosition(position) {
  return resolveBucketKey(assetMaster, position);
}

function bucketLabelFromKey(bucketKey) {
  return resolveBucketLabel(assetMaster, bucketKey);
}

function buildPositionLookup(positions) {
  const byKey = new Map();
  const candidates = [];

  for (const position of positions) {
    const normalizedName = normalizeName(position.name);
    candidates.push({ normalizedName, position });

    for (const key of [position.code, position.fund_code, position.name]) {
      const normalized = normalizeName(key);
      if (normalized) {
        byKey.set(normalized, position);
      }
    }
  }

  return { byKey, candidates };
}

function findPositionForCorrelationFund(fund, positionLookup) {
  for (const key of [fund?.code, fund?.name]) {
    const normalized = normalizeName(key);
    if (normalized && positionLookup.byKey.has(normalized)) {
      return positionLookup.byKey.get(normalized);
    }
  }

  for (const key of [fund?.name, fund?.code]) {
    const normalized = normalizeName(key);
    if (!normalized) {
      continue;
    }

    const fuzzyMatch = positionLookup.candidates.find(
      (candidate) =>
        candidate.normalizedName.includes(normalized) ||
        normalized.includes(candidate.normalizedName)
    );
    if (fuzzyMatch) {
      return fuzzyMatch.position;
    }
  }

  return null;
}

function buildSignalLookup(signalMatrix) {
  const lookup = new Map();
  const signals = signalMatrix?.signals ?? {};

  for (const [code, signal] of Object.entries(signals)) {
    const names = new Set([
      signal?.name,
      signal?.portfolio_context?.latest_name_match,
      signal?.portfolio_context?.watchlist_name_match
    ]);

    lookup.set(code, signal);
    for (const name of names) {
      const normalized = normalizeName(name);
      if (normalized) {
        lookup.set(normalized, signal);
      }
    }
  }

  return lookup;
}

function findSignalForPosition(position, signalLookup) {
  const candidates = [
    position.code,
    position.fund_code,
    normalizeName(position.name)
  ];

  for (const key of candidates) {
    if (key && signalLookup.has(key)) {
      return signalLookup.get(key);
    }
  }

  return null;
}

function bucketRoleFromPosition(position) {
  const bucketKey = bucketKeyFromPosition(position);
  return resolveRiskRole(assetMaster, bucketKey);
}

function buildL2SignalAlerts(positions, signalMatrix) {
  const alerts = [];
  const signalLookup = buildSignalLookup(signalMatrix);
  const matched = [];

  for (const position of positions) {
    const signal = findSignalForPosition(position, signalLookup);
    if (!signal) {
      continue;
    }

    matched.push({
      position,
      signal,
      trendStatus: signal?.derived_signals?.trend_status ?? null,
      rsiRegime: signal?.derived_signals?.rsi_regime ?? null,
      biasRegime: signal?.derived_signals?.bias_regime ?? null,
      maxDrawdown60dPercent: Number(signal?.indicators?.max_drawdown_60d_percent ?? null),
      bucketRole: bucketRoleFromPosition(position)
    });
  }

  const weaknessHits = matched.filter(
    (item) => item.trendStatus === "bearish" || item.rsiRegime === "oversold"
  );
  if (weaknessHits.length >= 2) {
    const names = weaknessHits.map((item) => item.position.name).join("、");
    alerts.push(
      `【系统性走弱】当前组合有多只底层资产趋势破位或陷入恐慌区，Beta 风险正在加剧，严禁加杠杆或开启抄底网格。涉及：${names}`
    );
  }

  const overheatingHits = matched.filter(
    (item) => item.biasRegime === "overextended_up" || item.rsiRegime === "overbought"
  );
  if (overheatingHits.length >= 2) {
    const names = overheatingHits.map((item) => item.position.name).join("、");
    alerts.push(
      `【系统性过热】当前组合出现大面积短期超买与乖离过大，极易引发均线回归（回调）。建议检查 IPS 止盈线，随时准备触发 TRIM_PROFIT。涉及：${names}`
    );
  }

  const breakdownHits = matched.filter(
    (item) =>
      (item.bucketRole === "core" || item.bucketRole === "defensive") &&
      Number.isFinite(item.maxDrawdown60dPercent) &&
      item.maxDrawdown60dPercent <= -10
  );
  for (const item of breakdownHits) {
    alerts.push(
      `【核心防守破位】核心/防守资产 ${item.position.name} 出现罕见的超 10% 回撤，请立即核查基本面逻辑是否破裂。`
    );
  }

  return alerts;
}

function valuationAlertDisplayName(signal) {
  const text = String(signal?.name ?? "").trim();
  return text || String(signal?.proxy_key ?? "未知资产");
}

function valuationRoleLabel(signal) {
  const proxyKey = String(signal?.proxy_key ?? "");
  const labels = signal?.mapped_labels ?? [];
  const name = String(signal?.name ?? "");

  if (
    proxyKey.includes("defensive") ||
    labels.includes("A股防守仓") ||
    name.includes("红利") ||
    name.includes("低波")
  ) {
    return "防守资产";
  }

  if (
    proxyKey.includes("core") ||
    labels.includes("A股核心仓") ||
    name.includes("沪深300") ||
    name.includes("上证50")
  ) {
    return "核心资产";
  }

  return "底层资产";
}

function buildValuationAlerts(indexValuationMatrix) {
  const alerts = [];

  for (const signal of Object.values(indexValuationMatrix?.signals ?? {})) {
    const compositePercentile5y = Number(signal?.metrics?.composite_percentile_5y ?? NaN);
    if (!Number.isFinite(compositePercentile5y) || compositePercentile5y <= 85) {
      continue;
    }

    const role = valuationRoleLabel(signal);
    const name = valuationAlertDisplayName(signal);
    const percentile = round(compositePercentile5y);

    if (role === "防守资产") {
      alerts.push(
        `🚨 【估值泡沫警告】防守/核心资产 ${name} 估值处于极度拥挤区（5年分位超 85%，当前 ${percentile}%），长线基本面赔率极差，防守属性正在丧失，请警惕杀估值的均值回归风险！`
      );
      continue;
    }

    alerts.push(
      `🚨 【估值泡沫警告】${role} ${name} 估值处于极度拥挤区（5年分位超 85%，当前 ${percentile}%），长线基本面赔率极差，请警惕杀估值的均值回归风险！`
    );
  }

  return alerts;
}

function resonanceSuffix(leftBucketKey, rightBucketKey) {
  if (
    leftBucketKey === "INCOME" ||
    rightBucketKey === "INCOME" ||
    leftBucketKey === "HEDGE" ||
    rightBucketKey === "HEDGE" ||
    leftBucketKey === "CASH" ||
    rightBucketKey === "CASH"
  ) {
    return "防守结构正在失效！";
  }

  return "静态分散结构正在失效！";
}

function buildQuantSymbolLookup() {
  const lookup = new Map();
  const rows = quantMetrics?.risk_model?.position_risk_contributions ?? [];

  for (const row of rows) {
    const symbol = String(row?.symbol ?? "").trim();
    if (!symbol || lookup.has(symbol)) {
      continue;
    }

    lookup.set(symbol, {
      symbol,
      name: row?.name ?? symbol,
      bucket_key: row?.bucket_key ?? null,
      bucket_label: row?.bucket_label ?? row?.bucket_key ?? symbol
    });
  }

  return lookup;
}

function buildMaterialCorrelationPairs() {
  const matrix = quantMetrics?.matrices?.correlation_matrix?.matrix ?? {};
  const symbols = quantMetrics?.matrices?.correlation_matrix?.symbols ?? Object.keys(matrix);
  const symbolLookup = buildQuantSymbolLookup();
  const pairs = [];

  for (let index = 0; index < symbols.length; index += 1) {
    const leftSymbol = symbols[index];
    for (let inner = index + 1; inner < symbols.length; inner += 1) {
      const rightSymbol = symbols[inner];
      const correlation = Number(matrix?.[leftSymbol]?.[rightSymbol] ?? NaN);
      if (!Number.isFinite(correlation) || Math.abs(correlation) <= RISK_RESONANCE_THRESHOLD) {
        continue;
      }

      const leftMeta = symbolLookup.get(leftSymbol) ?? {
        symbol: leftSymbol,
        name: leftSymbol,
        bucket_key: null,
        bucket_label: leftSymbol
      };
      const rightMeta = symbolLookup.get(rightSymbol) ?? {
        symbol: rightSymbol,
        name: rightSymbol,
        bucket_key: null,
        bucket_label: rightSymbol
      };

      pairs.push({
        left_symbol: leftSymbol,
        left_name: leftMeta.name,
        left_bucket_key: leftMeta.bucket_key,
        left_bucket_label: leftMeta.bucket_label,
        right_symbol: rightSymbol,
        right_name: rightMeta.name,
        right_bucket_key: rightMeta.bucket_key,
        right_bucket_label: rightMeta.bucket_label,
        correlation_60d: round(correlation, 4),
        abs_correlation_60d: round(Math.abs(correlation), 4),
        cross_bucket:
          Boolean(leftMeta.bucket_key) &&
          Boolean(rightMeta.bucket_key) &&
          leftMeta.bucket_key !== rightMeta.bucket_key
      });
    }
  }

  return pairs.sort(
    (left, right) => Number(right.abs_correlation_60d ?? 0) - Number(left.abs_correlation_60d ?? 0)
  );
}

function buildDynamicCorrelationRadar() {
  const resonanceAlerts = [];
  const crowdingAlerts = [];
  const hedgeNotes = [];
  const resonancePairs = [];
  const crowdingPairs = [];
  const hedgePairs = [];

  for (const pair of buildMaterialCorrelationPairs()) {
    const correlation = Number(pair?.correlation_60d ?? NaN);
    if (!Number.isFinite(correlation)) {
      continue;
    }

    if (correlation > RISK_RESONANCE_THRESHOLD) {
      const pairPayload = {
        left_fund: pair.left_name,
        left_bucket: pair.left_bucket_label,
        right_fund: pair.right_name,
        right_bucket: pair.right_bucket_label,
        correlation_60d: pair.correlation_60d,
        left_symbol: pair.left_symbol,
        right_symbol: pair.right_symbol,
        cross_bucket: pair.cross_bucket
      };
      if (pair.cross_bucket) {
        resonancePairs.push(pairPayload);
        resonanceAlerts.push(
          `🚨 真实相关性预警：${pair.left_bucket_label} ${pair.left_name} 与 ${pair.right_bucket_label} ${pair.right_name} 近60天相关系数高达 ${round(correlation, 2)}，已经进入高共振区，${resonanceSuffix(pair.left_bucket_key, pair.right_bucket_key)}`
        );
      } else {
        crowdingPairs.push(pairPayload);
        crowdingAlerts.push(
          `⚠️ 同桶拥挤预警：${pair.left_bucket_label} 内部的 ${pair.left_name} 与 ${pair.right_name} 近60天相关系数高达 ${round(correlation, 2)}，并未形成新增分散，反而在同一风险腿上继续叠加拥挤敞口。`
        );
      }
      continue;
    }

    if (correlation < HEDGE_DISCOVERY_THRESHOLD) {
      hedgePairs.push({
        left_fund: pair.left_name,
        left_bucket: pair.left_bucket_label,
        right_fund: pair.right_name,
        right_bucket: pair.right_bucket_label,
        correlation_60d: pair.correlation_60d,
        left_symbol: pair.left_symbol,
        right_symbol: pair.right_symbol
      });
      hedgeNotes.push(
        `✅ 真实对冲发现：${pair.left_name} 与 ${pair.right_name} 呈现强负相关 (${round(correlation, 2)})，组合内部具备明确的风险平滑关系。`
      );
    }
  }

  return {
    lookback_trading_days: quantMetrics?.lookback_days ?? null,
    positive_resonance_threshold: RISK_RESONANCE_THRESHOLD,
    negative_hedge_threshold: HEDGE_DISCOVERY_THRESHOLD,
    risk_resonance_alerts: resonanceAlerts,
    crowding_alerts: crowdingAlerts,
    hedge_notes: hedgeNotes,
    resonance_pairs: resonancePairs,
    crowding_pairs: crowdingPairs,
    hedge_pairs: hedgePairs,
    highest_pair: quantMetrics?.matrices?.correlation_matrix?.highest_pair ?? null,
  };
}

async function loadPendingManualBuyTrades(transactionsDir) {
  const entries = await readdir(transactionsDir).catch(() => []);
  const files = entries
    .filter((name) => name.endsWith(".json") && name.includes("-manual-"))
    .sort();

  const manualTrades = [];
  const sourceFiles = [];

  for (const file of files) {
    const fullPath = `${transactionsDir}/${file}`;
    const content = JSON.parse(await readFile(fullPath, "utf8"));

    if (String(content.status ?? "").startsWith("merged_into_latest")) {
      continue;
    }

    sourceFiles.push(fullPath);
    manualTrades.push(...(content.executed_buy_transactions ?? []));
  }

  return { manualTrades, sourceFiles };
}

function buildWorkingPositions(basePositions, manualBuys) {
  const working = clonePositions(basePositions);
  const indexByName = new Map(working.map((item, index) => [item.name, index]));

  for (const trade of manualBuys) {
    const name =
      trade.fund_name ??
      trade.interpreted_fund_name ??
      trade.fund_name_user_stated ??
      "未命名手工交易";
    const amount = Number(trade.amount_cny ?? 0);
    const existingIndex = indexByName.get(name);

    if (existingIndex !== undefined) {
      working[existingIndex].amount = round(Number(working[existingIndex].amount ?? 0) + amount);
      working[existingIndex].source = "latest_plus_manual";
      continue;
    }

    working.push({
      name,
      amount: round(amount),
      category: inferCategoryFromName(name),
      status: "manual_buy_pending_visual_confirmation",
      source: "manual_buy_transactions"
    });
    indexByName.set(name, working.length - 1);
  }

  return working;
}

function aggregateByCategory(positions) {
  const result = {};

  for (const position of positions) {
    const category = position.category ?? "未分类";
    result[category] = round(Number(result[category] ?? 0) + Number(position.amount ?? 0));
  }

  return result;
}

function aggregateByBucket(positions) {
  const result = {};

  for (const position of positions) {
    const bucketKey = bucketKeyFromPosition(position);
    result[bucketKey] = round(Number(result[bucketKey] ?? 0) + Number(position.amount ?? 0));
  }

  return result;
}

function topPositions(positions, base) {
  return positions
    .slice()
    .sort((left, right) => Number(right.amount ?? 0) - Number(left.amount ?? 0))
    .slice(0, 5)
    .map((item) => ({
      name: item.name,
      amount: round(item.amount),
      category: item.category ?? null,
      weight_pct_of_invested_capital: pct(Number(item.amount ?? 0), base)
    }));
}

function buildCorrelationStructure(positions, investedCapital) {
  const mrcRows = (quantMetrics?.risk_model?.bucket_marginal_risk_contribution ?? [])
    .filter((item) => Number(item?.risk_share_pct ?? 0) > 0)
    .slice()
    .sort((left, right) => Number(right?.risk_share_pct ?? 0) - Number(left?.risk_share_pct ?? 0));
  const materialPairs = buildMaterialCorrelationPairs();
  const highestPair = materialPairs[0] ?? quantMetrics?.matrices?.correlation_matrix?.highest_pair ?? null;

  return {
    source: "quant_metrics_engine",
    portfolio_annualized_volatility_pct:
      quantMetrics?.risk_model?.portfolio_annualized_volatility_pct ?? null,
    marginal_risk_contributions: mrcRows,
    top_mrc_buckets: mrcRows.slice(0, 3),
    correlation_pairs_over_threshold: materialPairs,
    highest_abs_correlation_pair: highestPair,
    flagged_clusters: [],
    related_exposure_watchlist: [],
    diversification_estimate: {
      invested_position_count: positions.length,
      real_correlation_pairs_over_threshold: materialPairs.length,
      interpretation:
        "本模块已切换到真实相关系数矩阵与桶级 MRC，不再使用启发式主题聚类。"
    }
  };
}

function buildStressScenarios(bucketBreakdown, investedCapital, estimatedTotalCapital) {
  const scenarioDefinitions = [
    {
      key: "offshore_growth_derating",
      name: "离岸成长再杀估值",
      description:
        "中东与外盘风险未消退、成长资产再度杀估值，高波与全球动量桶共同承压。",
      bucket_shocks_pct: {
        A_CORE: -6,
        GLB_MOM: -14,
        TACTICAL: -18,
        HEDGE: 4,
        INCOME: -1,
        CASH: 0
      }
    },
    {
      key: "oil_shock_stagflation",
      name: "油价冲击与滞胀压估值",
      description:
        "原油再次上冲，市场重新交易通胀和更久高利率，权益承压而对冲链条分化。",
      bucket_shocks_pct: {
        A_CORE: -5,
        GLB_MOM: -12,
        TACTICAL: -15,
        HEDGE: -4,
        INCOME: -1,
        CASH: 0
      }
    },
    {
      key: "domestic_growth_scare",
      name: "内需走弱与A股风险偏好回落",
      description:
        "国内增长预期转弱，A股风险偏好与成长弹性同步下修，防守和对冲仓相对缓冲。",
      bucket_shocks_pct: {
        A_CORE: -8,
        GLB_MOM: -6,
        TACTICAL: -9,
        HEDGE: 2,
        INCOME: 1,
        CASH: 0
      }
    }
  ];

  return scenarioDefinitions.map((scenario) => {
    const contributions = Object.entries(scenario.bucket_shocks_pct).map(([bucketKey, shockPct]) => {
      const exposure = Number(bucketBreakdown?.[bucketKey] ?? 0);
      const bucketMeta = bucketConfigMap[bucketKey] ?? {};
      return {
        bucket_key: bucketKey,
        bucket_label: bucketMeta.label ?? bucketKey,
        exposure_cny: round(exposure),
        shock_pct: shockPct,
        pnl_cny: round((exposure * shockPct) / 100)
      };
    });

    const estimatedPnl = round(
      contributions.reduce((sum, contribution) => sum + Number(contribution.pnl_cny ?? 0), 0)
    );

    return {
      key: scenario.key,
      name: scenario.name,
      description: scenario.description,
      shock_assumptions_pct: scenario.bucket_shocks_pct,
      estimated_pnl_cny: estimatedPnl,
      estimated_impact_pct_of_invested_capital: pct(estimatedPnl, investedCapital),
      estimated_impact_pct_of_total_capital:
        estimatedTotalCapital !== null ? pct(estimatedPnl, estimatedTotalCapital) : null,
      main_drivers: contributions
        .slice()
        .sort((left, right) => Math.abs(Number(left.pnl_cny ?? 0)) - Math.abs(Number(right.pnl_cny ?? 0)))
        .reverse()
        .slice(0, 3)
    };
  });
}

export function buildView(label, positions, capitalContext = null) {
  const investedCapital = round(
    positions.reduce((sum, item) => sum + Number(item.amount ?? 0), 0)
  );
  const categoryBreakdown = aggregateByCategory(positions);
  const bucketBreakdown = aggregateByBucket(positions);
  const settledCash = Number(capitalContext?.settled_cash_cny ?? 0);
  const tradeAvailableCash = Number(capitalContext?.trade_available_cash_cny ?? settledCash);
  const liquiditySleeveAssets = Number(capitalContext?.liquidity_sleeve_assets_cny ?? 0);
  const estimatedTotalCapital =
    Number(capitalContext?.total_assets_cny ?? 0) > 0
      ? round(Number(capitalContext.total_assets_cny))
      : settledCash > 0
        ? round(investedCapital + settledCash)
        : null;
  const top = topPositions(positions, investedCapital);
  const largestPosition = top[0] ?? null;
  const top3Weight = round(
    top.slice(0, 3).reduce((sum, item) => sum + Number(item.weight_pct_of_invested_capital ?? 0), 0)
  );
  const correlationStructure = buildCorrelationStructure(positions, investedCapital);
  const stressScenarios = buildStressScenarios(bucketBreakdown, investedCapital, estimatedTotalCapital);
  const worstScenario = stressScenarios
    .slice()
    .sort((left, right) => Number(left.estimated_pnl_cny ?? 0) - Number(right.estimated_pnl_cny ?? 0))[0];

  const alerts = [];
  if ((largestPosition?.weight_pct_of_invested_capital ?? 0) > 25) {
    alerts.push("单一持仓在已投资仓位中占比超过 25%，集中度偏高。");
  }

  for (const [bucketKey, amount] of Object.entries(bucketBreakdown)) {
    const bucketConfig = bucketConfigMap[bucketKey];
    if (!bucketConfig || investedCapital <= 0) {
      continue;
    }

    const weightPct = pct(amount, investedCapital);
    const maxPct = Number(bucketConfig.maxPct ?? NaN);
    const minPct = Number(bucketConfig.minPct ?? NaN);
    const labelText = bucketConfig.label ?? bucketKey;

    if (Number.isFinite(maxPct) && weightPct !== null && weightPct > maxPct * 100 + 1) {
      alerts.push(`${labelText} 当前占已投资仓位 ${weightPct}%，已高于 SSOT 上限 ${round(maxPct * 100, 2)}%。`);
    }

    if (Number.isFinite(minPct) && weightPct !== null && weightPct < Math.max(minPct * 100 - 1, 0)) {
      alerts.push(`${labelText} 当前占已投资仓位 ${weightPct}%，低于 SSOT 下限 ${round(minPct * 100, 2)}%，结构骨架不足。`);
    }
  }

  const topRiskBucket = correlationStructure.top_mrc_buckets?.[0];
  if (Number(topRiskBucket?.risk_share_pct ?? 0) >= 30) {
    alerts.push(
      `真实风控矩阵显示：${topRiskBucket.bucket_label} 当前风险份额高达 ${topRiskBucket.risk_share_pct}%，已经成为组合波动的核心风险源。`
    );
  }
  const topCorrelationPair = correlationStructure.highest_abs_correlation_pair;
  if (Number(topCorrelationPair?.abs_correlation_60d ?? Math.abs(Number(topCorrelationPair?.correlation ?? 0))) >= 0.8) {
    const leftName = topCorrelationPair.left_name ?? topCorrelationPair.left_symbol ?? "左侧资产";
    const rightName = topCorrelationPair.right_name ?? topCorrelationPair.right_symbol ?? "右侧资产";
    const pairValue =
      topCorrelationPair.abs_correlation_60d ??
      round(Math.abs(Number(topCorrelationPair?.correlation ?? 0)), 4);
    const sameBucket =
      topCorrelationPair.left_bucket_key &&
      topCorrelationPair.right_bucket_key &&
      topCorrelationPair.left_bucket_key === topCorrelationPair.right_bucket_key;
    alerts.push(
      sameBucket
        ? `真实相关性矩阵显示：${leftName} 与 ${rightName} 的近60天绝对相关系数已达 ${pairValue}，属于同一仓位桶内部拥挤，并未新增真正分散。`
        : `真实相关性矩阵显示：${leftName} 与 ${rightName} 的近60天绝对相关系数已达 ${pairValue}，跨桶表面分散正在失真。`
    );
  }
  if (Number(worstScenario?.estimated_impact_pct_of_invested_capital ?? 0) <= -8) {
    alerts.push(`压力测试：在“${worstScenario.name}”情景下，已投资仓位估算回撤约 ${Math.abs(Number(worstScenario.estimated_impact_pct_of_invested_capital ?? 0))}%。`);
  }

  return {
    label,
    invested_capital_cny: investedCapital,
    estimated_total_capital_cny: estimatedTotalCapital,
    capital_semantics: {
      settled_cash_cny: round(settledCash),
      trade_available_cash_cny: round(tradeAvailableCash),
      liquidity_sleeve_assets_cny: round(liquiditySleeveAssets),
      cash_like_fund_assets_cny: round(Number(capitalContext?.cash_like_fund_assets_cny ?? 0))
    },
    denominator_labels: {
      bucket_weights: "pct_of_invested_assets",
      top_positions: "pct_of_invested_assets",
      cash_weights: "pct_of_total_assets"
    },
    category_breakdown_cny: categoryBreakdown,
    bucket_breakdown_cny: bucketBreakdown,
    bucket_weights_pct_of_invested_capital: Object.fromEntries(
      Object.entries(bucketBreakdown).map(([bucketKey, amount]) => [bucketKey, pct(amount, investedCapital)])
    ),
    cash_pct_of_total_assets: pct(settledCash, estimatedTotalCapital),
    trade_available_cash_pct_of_total_assets: pct(tradeAvailableCash, estimatedTotalCapital),
    liquidity_sleeve_pct_of_total_assets: pct(liquiditySleeveAssets, estimatedTotalCapital),
    concentration: {
      largest_position: largestPosition,
      top3_weight_pct_of_invested_capital: top3Weight
    },
    correlation_structure: correlationStructure,
    stress_scenarios: stressScenarios,
    top_positions: top,
    alerts
  };
}

export async function runRiskDashboardBuild(rawOptions = {}) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const portfolioRoot = resolvePortfolioRoot(options);
  const accountId = resolveAccountId(options);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const transactionsDir = buildPortfolioPath(portfolioRoot, "transactions");
  const accountContextPath = buildPortfolioPath(portfolioRoot, "account_context.json");
  const signalsMatrixPath = buildPortfolioPath(portfolioRoot, "signals", "signals_matrix.json");
  const indexValuationMatrixPath = buildPortfolioPath(
    portfolioRoot,
    "signals",
    "index_valuation_matrix.json"
  );
  const quantMetricsPath = buildPortfolioPath(portfolioRoot, "data", "quant_metrics_engine.json");
  const outputPath =
    String(options.output ?? "").trim() || buildPortfolioPath(portfolioRoot, "risk_dashboard.json");
  const manifest = await readFile(manifestPath, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => null);
  const assetMasterPath =
    manifest?.canonical_entrypoints?.asset_master ??
    buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
  const ipsConstraintsPath =
    manifest?.canonical_entrypoints?.ips_constraints ??
    path.join(path.dirname(assetMasterPath), "ips_constraints.json");

  assetMaster = await loadAssetMaster(assetMasterPath);
  bucketConfigMap = buildBucketConfigMap(assetMaster);
  const latestView = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
  const latest = buildCanonicalPortfolioView({
    payload: latestView.payload,
    sourceKind: latestView.sourceKind,
    sourcePath: latestView.sourcePath
  });

  const [accountContext, pendingManual, signalMatrix, indexValuationMatrix, loadedQuantMetrics, ipsConstraints] =
    await Promise.all([
      JSON.parse(await readFile(accountContextPath, "utf8")),
      loadPendingManualBuyTrades(transactionsDir),
      JSON.parse(await readFile(signalsMatrixPath, "utf8")),
      readFile(indexValuationMatrixPath, "utf8")
        .then((content) => JSON.parse(content))
        .catch(() => ({ signals: {}, errors: [] })),
      readFile(quantMetricsPath, "utf8")
        .then((content) => JSON.parse(content))
        .catch(() => ({
          risk_model: {},
          matrices: { correlation_matrix: { symbols: [], matrix: {}, highest_pair: null } }
        })),
      loadIpsConstraints(ipsConstraintsPath)
    ]);

  quantMetrics = loadedQuantMetrics;

  const canonicalPositions = (latest.positions ?? []).filter((item) => item.status === "active");
  const manualBuys = pendingManual.manualTrades ?? [];
  const workingPositions = buildWorkingPositions(canonicalPositions, manualBuys);
  const capitalContext = deriveRiskCapitalContext({
    latest,
    accountContext
  });
  const canonicalView = buildView("canonical_latest_snapshot", canonicalPositions, capitalContext);
  const workingView = buildView(
    "working_view_including_user_reported_manual_buys",
    workingPositions,
    capitalContext
  );
  const l2SignalAlerts = buildL2SignalAlerts(canonicalPositions, signalMatrix);
  const valuationAlerts = buildValuationAlerts(indexValuationMatrix);
  const dynamicCorrelationRadar = buildDynamicCorrelationRadar();
  const topMrcBuckets = canonicalView.correlation_structure?.top_mrc_buckets ?? [];
  const materialCorrelationPairs =
    canonicalView.correlation_structure?.correlation_pairs_over_threshold ?? [];
  const portfolioRisk = buildPortfolioRiskState({
    positions: canonicalPositions,
    signalMatrix,
    assetMaster,
    quantMetrics,
    ipsConstraints,
    totalAssetsCny:
      Number(
        capitalContext?.total_assets_cny ??
          latest?.summary?.total_portfolio_assets_cny ??
          latest?.summary?.total_assets_cny ??
          accountContext?.total_assets_cny ??
          0
      ) || null,
    rebalanceMode: latest?.rebalance_mode ?? null,
    rebalanceTargets: latest?.rebalance_targets ?? null
  });

  const dashboard = {
    account_id: accountId,
    as_of: latest.snapshot_date ?? accountContext.as_of ?? null,
    generated_at: new Date().toISOString(),
    source_files: {
      latest_snapshot: latestView.sourcePath,
      manual_buy_transaction_files: pendingManual.sourceFiles,
      account_context: accountContextPath,
      signals_matrix: signalsMatrixPath,
      index_valuation_matrix: indexValuationMatrixPath,
      quant_metrics_engine: quantMetricsPath,
      ips_constraints: ipsConstraintsPath
    },
    l2_signal_alerts: l2SignalAlerts,
    valuation_alerts: valuationAlerts,
    risk_resonance_alerts: dynamicCorrelationRadar.risk_resonance_alerts,
    crowding_alerts: dynamicCorrelationRadar.crowding_alerts,
    correlation_hedge_notes: dynamicCorrelationRadar.hedge_notes,
    dynamic_correlation_radar: dynamicCorrelationRadar,
    quant_risk_summary: {
      portfolio_annualized_volatility_pct:
        canonicalView.correlation_structure?.portfolio_annualized_volatility_pct ?? null,
      top_mrc_buckets: topMrcBuckets,
      correlation_pairs_over_threshold: materialCorrelationPairs.slice(0, 10)
    },
    portfolio_risk: portfolioRisk,
    blocking_state: portfolioRisk.blocking_state,
    single_fund_breaches: portfolioRisk.single_fund_breaches,
    theme_breaches: portfolioRisk.theme_breaches,
    correlation_cluster_breaches: portfolioRisk.correlation_cluster_breaches,
    capital_context: {
      ...accountContext,
      settled_cash_cny: capitalContext.settled_cash_cny,
      trade_available_cash_cny: capitalContext.trade_available_cash_cny,
      cash_like_fund_assets_cny: capitalContext.cash_like_fund_assets_cny,
      liquidity_sleeve_assets_cny: capitalContext.liquidity_sleeve_assets_cny,
      total_assets_cny: capitalContext.total_assets_cny,
      inferred_total_assets_from_working_holdings_plus_reported_cash_cny:
        workingView.estimated_total_capital_cny
    },
    canonical_view: canonicalView,
    working_view: workingView,
    reconciliation_notes: [
      "Canonical view now hard-reads state/portfolio_state.json as the only business state source for risk evaluation.",
      manualBuys.length > 0
        ? "Working view adds user-reported manual buys that have not yet been merged into the canonical state."
        : "There are currently no pending manual buy files outside the canonical state.",
      "真钱现金与流动性防线已拆分：settled_cash_cny 不等于现金类基金资产，风险口径不再把债券基金当作可用现金。",
      "若 canonical state 已提供 total_portfolio_assets_cny / settled_cash_cny，将优先于 account_context.json 的工作估计值。"
    ],
    methodology_notes: [
      "组合波动率、桶级 MRC 与相关性矩阵全部来自 quant_metrics_engine.json 的真实 60 日收益率协方差运算。",
      "真实相关性预警仅提取非对角线资产对中绝对值大于 0.6 的 Pearson 相关系数，不再使用启发式主题聚类。",
      "Stress scenarios are theme-shock approximations intended for discussion and risk control, not predictive return forecasts.",
      "Valuation alerts are derived from index_valuation_matrix.json, which now fuses CN AkShare valuation proxies with overseas price-percentile proxies.",
      "portfolio_risk.current_drawdown_pct is a portfolio-level proxy built from active positions' matched 60-day drawdown signals and is intended for execution gating, not audited NAV peak-trough accounting."
    ]
  };

  await writeJsonAtomic(outputPath, dashboard);

  const terminalLines = [
    "=== 🚨 风控盘 / Quant Risk Radar ===",
    `Account: ${accountId}`,
    `As Of: ${dashboard.as_of ?? "--"}`,
    `Portfolio Annualized Volatility: ${round(
      dashboard.quant_risk_summary.portfolio_annualized_volatility_pct ?? null,
      4
    )}%`,
    `Portfolio Drawdown Proxy: ${dashboard.portfolio_risk?.weighted_current_drawdown_60d_percent ?? "--"}% | Gate ${
      dashboard.portfolio_risk?.breached_max_drawdown_limit ? "BREACHED" : "OK"
    }`,
    `Blocking State: ${dashboard.blocking_state?.blocked ? "BLOCKED" : "CLEAR"} | Reasons ${
      (dashboard.blocking_state?.reasons ?? []).join(", ") || "--"
    }`,
    `Breaches: fund=${dashboard.single_fund_breaches.length} | theme=${dashboard.theme_breaches.length} | corr_cluster=${dashboard.correlation_cluster_breaches.length}`,
    "",
    "Top MRC Risk Share:",
    ...(topMrcBuckets.length > 0
      ? topMrcBuckets.map(
          (item, index) =>
            `${index + 1}. ${item.bucket_label} | Risk Share ${item.risk_share_pct}% | Weight ${item.weight_pct}% | MRC ${item.marginal_risk_contribution_pct}%`
        )
      : ["1. 暂无可用的桶级 MRC 数据"]),
    "",
    "Cross-Bucket Resonance Alerts:",
    ...(dynamicCorrelationRadar.resonance_pairs.length > 0
      ? dynamicCorrelationRadar.resonance_pairs.slice(0, 5).map(
          (item, index) =>
            `${index + 1}. ${item.left_bucket} ${item.left_fund} <-> ${item.right_bucket} ${item.right_fund} | rho ${item.correlation_60d}`
        )
      : ["1. 暂无跨桶高共振资产对"]),
    "",
    "Intra-Bucket Crowding Alerts:",
    ...(dynamicCorrelationRadar.crowding_pairs.length > 0
      ? dynamicCorrelationRadar.crowding_pairs.slice(0, 5).map(
          (item, index) =>
            `${index + 1}. ${item.left_bucket} ${item.left_fund} <-> ${item.right_fund} | rho ${item.correlation_60d}`
        )
      : ["1. 暂无同桶内部拥挤资产对"]),
    "",
    `Output: ${outputPath}`
  ];

  return {
    accountId,
    portfolioRoot,
    outputPath,
    dashboard,
    terminalLines
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runRiskDashboardBuild(parseArgs(process.argv.slice(2)));
  console.log(result.terminalLines.join("\n"));
}
