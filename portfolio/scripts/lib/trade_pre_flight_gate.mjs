import {
  buildBucketConfigMap,
  resolveBucketKey,
  resolveBucketLabel
} from "./asset_master.mjs";
import { normalizeIpsConstraints } from "./ips_constraints.mjs";

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeFundCode(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function resolveProjectedFundKey(entry = {}) {
  const code = normalizeFundCode(entry?.fund_code ?? entry?.code ?? entry?.symbol ?? null);
  if (code) {
    return `code:${code}`;
  }
  const name = normalizeName(entry?.name ?? entry?.fund_name ?? "");
  return name ? `name:${name}` : null;
}

function buildHoldingIndex(positions = []) {
  const index = new Map();
  for (const position of positions) {
    if (String(position?.status ?? "active").trim() !== "active") {
      continue;
    }
    const amount = safeNumber(position?.amount, 0);
    if (amount <= 0) {
      continue;
    }

    const code = normalizeFundCode(position?.fund_code ?? position?.code ?? position?.symbol ?? null);
    const name = normalizeName(position?.name ?? "");
    if (code) {
      index.set(`code:${code}`, amount);
    }
    if (name) {
      index.set(`name:${name}`, amount);
    }
  }
  return index;
}

function readHoldingAmount(index, trade = {}) {
  const code = normalizeFundCode(trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null);
  const name = normalizeName(trade?.name ?? trade?.fund_name ?? "");
  if (code && index.has(`code:${code}`)) {
    return safeNumber(index.get(`code:${code}`), 0);
  }
  if (name && index.has(`name:${name}`)) {
    return safeNumber(index.get(`name:${name}`), 0);
  }
  return 0;
}

function writeHoldingAmount(index, trade = {}, amount = 0) {
  const nextAmount = Math.max(safeNumber(amount, 0), 0);
  const code = normalizeFundCode(trade?.fund_code ?? trade?.code ?? trade?.symbol ?? null);
  const name = normalizeName(trade?.name ?? trade?.fund_name ?? "");
  if (code) {
    index.set(`code:${code}`, nextAmount);
  }
  if (name) {
    index.set(`name:${name}`, nextAmount);
  }
}

function resolveTradeBucketKey(assetMaster, trade = {}) {
  return (
    String(trade?.bucket_key ?? trade?.bucketKey ?? "").trim() ||
    resolveBucketKey(assetMaster, {
      category: trade?.category ?? null,
      name: trade?.name ?? trade?.fund_name ?? null
    })
  );
}

function buildCurrentBucketAmounts(assetMaster, positions = []) {
  const amounts = {};
  for (const position of positions) {
    if (String(position?.status ?? "active").trim() !== "active") {
      continue;
    }
    const amount = safeNumber(position?.amount, 0);
    if (amount <= 0) {
      continue;
    }
    const bucketKey = resolveTradeBucketKey(assetMaster, position);
    amounts[bucketKey] = safeNumber(amounts[bucketKey], 0) + amount;
  }
  return amounts;
}

function resolveCashFloorPct(assetMaster, bucketConfigs) {
  const cashBucket = bucketConfigs.CASH ?? {};
  const bucketMin = safeNumber(cashBucket.minPct ?? cashBucket.min ?? 0, 0);
  return Math.max(bucketMin, 0);
}

function isHighBetaBucket(bucketKey, bucketConfig = {}) {
  const riskRole = String(bucketConfig?.riskRole ?? bucketConfig?.risk_role ?? "").trim().toLowerCase();
  return riskRole === "growth" || riskRole === "tactical" || ["GLB_MOM", "TACTICAL"].includes(bucketKey);
}

function isEquityLikeBucket(assetMaster, bucketKey, bucketConfig = {}) {
  if (typeof bucketConfig?.is_equity_like === "boolean") {
    return bucketConfig.is_equity_like;
  }
  const rawValue = assetMaster?.buckets?.[bucketKey]?.is_equity_like;
  return typeof rawValue === "boolean" ? rawValue : bucketKey !== "CASH";
}

function defaultCashEffect(trade = {}) {
  if (trade?.cash_effect_cny !== undefined && trade?.cash_effect_cny !== null) {
    return safeNumber(trade.cash_effect_cny, 0);
  }

  const amount = safeNumber(trade?.amount_cny, 0);
  if (trade?.type === "buy") {
    return -amount;
  }
  if (trade?.type === "sell") {
    return trade?.cash_arrived === true ? amount : 0;
  }
  return 0;
}

function defaultBucketDelta(trade = {}) {
  if (trade?.bucket_amount_delta !== undefined && trade?.bucket_amount_delta !== null) {
    return safeNumber(trade.bucket_amount_delta, 0);
  }

  const amount = safeNumber(trade?.amount_cny, 0);
  if (trade?.type === "buy") {
    return amount;
  }
  if (trade?.type === "sell") {
    return -amount;
  }
  return 0;
}

function resolveThemeKey(trade = {}, bucketKey = null) {
  const explicit = String(trade?.theme_key ?? trade?.themeKey ?? "").trim();
  return explicit || null;
}

export function evaluateTradePreFlight({
  portfolioState = {},
  proposedTrades = [],
  assetMaster = {},
  portfolioRiskState = {},
  ipsConstraints = null
} = {}) {
  const normalizedIpsConstraints = normalizeIpsConstraints(ipsConstraints ?? {});
  const bucketConfigs = buildBucketConfigMap(assetMaster);
  const totalAssets = Math.max(
    safeNumber(
      portfolioState?.summary?.total_portfolio_assets_cny ??
        portfolioState?.summary?.total_assets_cny ??
        0,
      0
    ),
    0
  );
  const blockingReasons = [];
  const warnings = [];
  const projectedBucketAmounts = buildCurrentBucketAmounts(assetMaster, portfolioState?.positions ?? []);
  const holdingIndex = buildHoldingIndex(portfolioState?.positions ?? []);
  const projectedFundAmounts = new Map();
  const projectedThemeAmounts = new Map();
  let projectedCash = safeNumber(
    portfolioState?.summary?.available_cash_cny ?? portfolioState?.cash_ledger?.available_cash_cny ?? 0,
    0
  );

  for (const position of portfolioState?.positions ?? []) {
    if (String(position?.status ?? "active").trim() !== "active") {
      continue;
    }

    const amount = safeNumber(position?.amount, 0);
    if (amount <= 0) {
      continue;
    }

    const projectedFundKey = resolveProjectedFundKey(position);
    const bucketKey = resolveTradeBucketKey(assetMaster, position);
    const themeKey = resolveThemeKey(position, bucketKey);

    if (projectedFundKey) {
      projectedFundAmounts.set(projectedFundKey, amount);
    }
    if (themeKey) {
      projectedThemeAmounts.set(themeKey, safeNumber(projectedThemeAmounts.get(themeKey), 0) + amount);
    }
  }
  const currentFundAmounts = new Map(projectedFundAmounts);
  const currentThemeAmounts = new Map(projectedThemeAmounts);

  for (const trade of proposedTrades) {
    const tradeType = String(trade?.type ?? "").trim().toLowerCase();
    const amount = safeNumber(trade?.amount_cny, 0);
    const bucketKey = resolveTradeBucketKey(assetMaster, trade);
    const bucketConfig = bucketConfigs[bucketKey] ?? {};
    const bucketLabel = resolveBucketLabel(assetMaster, bucketKey);
    const currentHolding = readHoldingAmount(holdingIndex, trade);

    if (tradeType === "buy") {
      if (String(assetMaster?.buckets?.[bucketKey]?.buy_gate ?? "").trim().toLowerCase() === "frozen") {
        blockingReasons.push(`Trade blocked: bucket ${bucketLabel} buy_gate is frozen.`);
        continue;
      }

      const rebalanceMode = String(
        portfolioState?.rebalance_mode ?? portfolioState?.blocking_state?.rebalance_mode ?? ""
      ).trim();
      const allowedBuyBucketKeys = Array.isArray(
        portfolioState?.rebalance_targets?.allowed_buy_bucket_keys
      )
        ? portfolioState.rebalance_targets.allowed_buy_bucket_keys
        : [];
      if (
        rebalanceMode === "priority" &&
        allowedBuyBucketKeys.length > 0 &&
        !allowedBuyBucketKeys.includes(bucketKey)
      ) {
        blockingReasons.push(
          `Trade blocked: rebalance priority mode only allows buys into ${allowedBuyBucketKeys.join(", ")}.`
        );
        continue;
      }

      const currentDrawdownPct = safeNumber(portfolioRiskState?.current_drawdown_pct, NaN);
      const maxDrawdownLimit = safeNumber(
        normalizedIpsConstraints.drawdown.hardStopPct ??
          assetMaster?.global_constraints?.max_drawdown_limit,
        NaN
      );
      if (
        Number.isFinite(currentDrawdownPct) &&
        Number.isFinite(maxDrawdownLimit) &&
        currentDrawdownPct >= maxDrawdownLimit &&
        isHighBetaBucket(bucketKey, bucketConfig)
      ) {
        blockingReasons.push(
          `Trade blocked: drawdown ${currentDrawdownPct} exceeds max drawdown limit ${maxDrawdownLimit} for high beta bucket ${bucketLabel}.`
        );
        continue;
      }
    }

    if (tradeType === "sell" && currentHolding + 1e-6 < amount) {
      blockingReasons.push(
        `Trade blocked: insufficient holding for ${trade?.name ?? trade?.fund_name ?? trade?.fund_code ?? "unknown"}.`
      );
      continue;
    }

    projectedCash += defaultCashEffect(trade);
    projectedBucketAmounts[bucketKey] = Math.max(
      0,
      safeNumber(projectedBucketAmounts[bucketKey], 0) + defaultBucketDelta(trade)
    );

    const themeKey = resolveThemeKey(trade, bucketKey);
    const projectedFundKey = resolveProjectedFundKey(trade);
    const nextFundAmount = Math.max(
      0,
      currentHolding +
        (tradeType === "buy" ? amount : tradeType === "sell" ? -amount : 0)
    );
    const nextThemeAmount = Math.max(
      0,
      safeNumber(projectedThemeAmounts.get(themeKey), 0) + defaultBucketDelta(trade)
    );

    if (projectedFundKey) {
      projectedFundAmounts.set(projectedFundKey, nextFundAmount);
    }
    if (themeKey) {
      projectedThemeAmounts.set(themeKey, nextThemeAmount);
    }

    if (tradeType === "buy") {
      writeHoldingAmount(holdingIndex, trade, currentHolding + amount);
    } else if (tradeType === "sell") {
      writeHoldingAmount(holdingIndex, trade, Math.max(currentHolding - amount, 0));
    }
  }

  const cashFloorPct = Math.max(
    resolveCashFloorPct(assetMaster, bucketConfigs),
    normalizedIpsConstraints.cashFloorPct
  );
  const cashFloorCny = totalAssets > 0 ? totalAssets * cashFloorPct : 0;
  if (totalAssets > 0 && projectedCash + 1e-6 < cashFloorCny) {
    blockingReasons.push(
      `Trade blocked: projected cash floor breach. projected=${projectedCash.toFixed(2)} floor=${cashFloorCny.toFixed(2)}`
    );
  }

  let projectedEquityAmount = 0;
  for (const [bucketKey, amount] of Object.entries(projectedBucketAmounts)) {
    const bucketConfig = bucketConfigs[bucketKey] ?? {};
    const maxPct = safeNumber(bucketConfig?.maxPct, 0);
    if (totalAssets > 0 && maxPct > 0 && amount - totalAssets * maxPct > 1e-6) {
      blockingReasons.push(
        `Trade blocked: bucket max breach for ${resolveBucketLabel(assetMaster, bucketKey)}. projected=${amount.toFixed(2)} max=${(totalAssets * maxPct).toFixed(2)}`
      );
    }

    if (isEquityLikeBucket(assetMaster, bucketKey, bucketConfig)) {
      projectedEquityAmount += amount;
    }
  }

  const absoluteEquityCap = safeNumber(assetMaster?.global_constraints?.absolute_equity_cap, 0);
  if (totalAssets > 0 && absoluteEquityCap > 0 && projectedEquityAmount - totalAssets * absoluteEquityCap > 1e-6) {
    blockingReasons.push(
      `Trade blocked: projected equity cap breach. projected=${projectedEquityAmount.toFixed(2)} cap=${(totalAssets * absoluteEquityCap).toFixed(2)}`
    );
  }

  if (projectedCash < 0) {
    blockingReasons.push(`Trade blocked: projected cash would become negative (${projectedCash.toFixed(2)}).`);
  }

  const singleFundMaxPct = safeNumber(normalizedIpsConstraints.concentration.singleFundMaxPct, 0);
  if (totalAssets > 0 && singleFundMaxPct > 0) {
    for (const [key, amount] of projectedFundAmounts.entries()) {
      const currentAmount = safeNumber(currentFundAmounts.get(key), 0);
      if (amount - totalAssets * singleFundMaxPct > 1e-6 && amount - currentAmount > 1e-6) {
        blockingReasons.push(
          `Trade blocked: projected single fund max breach for ${key}. projected=${amount.toFixed(2)} max=${(
            totalAssets * singleFundMaxPct
          ).toFixed(2)}`
        );
      }
    }
  }

  const singleThemeMaxPct = safeNumber(normalizedIpsConstraints.concentration.singleThemeMaxPct, 0);
  if (totalAssets > 0 && singleThemeMaxPct > 0) {
    for (const [themeKey, amount] of projectedThemeAmounts.entries()) {
      const currentAmount = safeNumber(currentThemeAmounts.get(themeKey), 0);
      if (amount - totalAssets * singleThemeMaxPct > 1e-6 && amount - currentAmount > 1e-6) {
        blockingReasons.push(
          `Trade blocked: projected theme max breach for ${themeKey}. projected=${amount.toFixed(2)} max=${(
            totalAssets * singleThemeMaxPct
          ).toFixed(2)}`
        );
      }
    }
  }

  return {
    allowed: blockingReasons.length === 0,
    blockingReasons,
    warnings,
    metadata: {
      projected_available_cash_cny: Number(projectedCash.toFixed(2)),
      projected_bucket_amounts: Object.fromEntries(
        Object.entries(projectedBucketAmounts).map(([key, value]) => [key, Number(value.toFixed(2))])
      ),
      projected_equity_amount_cny: Number(projectedEquityAmount.toFixed(2)),
      cash_floor_cny: Number(cashFloorCny.toFixed(2))
    }
  };
}
