import {
  resolveBucketKey,
  resolveBucketLabel,
  resolveThemeKey,
  resolveThemeLabel
} from "./asset_master.mjs";
import { normalizeIpsConstraints } from "./ips_constraints.mjs";

function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(Number(value).toFixed(digits));
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

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function toPositiveOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function buildSignalLookup(signalMatrix = {}) {
  const lookup = new Map();
  const signals = signalMatrix?.signals ?? {};

  for (const [code, signal] of Object.entries(signals)) {
    const signalCode = String(signal?.code ?? code ?? "").trim();
    const names = [
      signal?.name,
      signal?.portfolio_context?.latest_name_match,
      signal?.portfolio_context?.watchlist_name_match,
      signal?.portfolio_context?.portfolio_name_match
    ];

    if (signalCode) {
      lookup.set(signalCode, signal);
    }

    for (const name of names) {
      const normalized = normalizeName(name);
      if (normalized) {
        lookup.set(normalized, signal);
      }
    }
  }

  return lookup;
}

function matchSignalForPosition(position, signalLookup) {
  const candidates = [
    String(position?.fund_code ?? "").trim(),
    String(position?.code ?? "").trim(),
    String(position?.symbol ?? "").trim(),
    normalizeName(position?.name)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (signalLookup.has(candidate)) {
      return signalLookup.get(candidate);
    }
  }

  const normalizedName = normalizeName(position?.name);
  if (!normalizedName) {
    return null;
  }

  for (const [key, signal] of signalLookup.entries()) {
    if (/^\d+$/.test(String(key))) {
      continue;
    }

    if (key.includes(normalizedName) || normalizedName.includes(key)) {
      return signal;
    }
  }

  return null;
}

function buildMatchedPositionRow(position, signal, assetMaster) {
  const amount = toPositiveAmount(position?.amount);
  if (!amount) {
    return null;
  }

  const currentDrawdown = toFiniteNumber(signal?.indicators?.current_drawdown_60d_percent);
  const maxDrawdown = toFiniteNumber(signal?.indicators?.max_drawdown_60d_percent);

  if (!Number.isFinite(currentDrawdown) || !Number.isFinite(maxDrawdown)) {
    return null;
  }

  const bucketKey = resolveBucketKey(assetMaster ?? {}, position);

  return {
    name: position?.name ?? signal?.name ?? null,
    fund_code: position?.fund_code ?? position?.code ?? position?.symbol ?? signal?.code ?? null,
    amount_cny: round(amount),
    bucket_key: bucketKey,
    bucket_label: resolveBucketLabel(assetMaster ?? {}, bucketKey),
    current_drawdown_60d_percent: round(currentDrawdown),
    max_drawdown_60d_percent: round(maxDrawdown)
  };
}

function resolveTotalAssetsCny(totalAssetsCny, activePositions) {
  const explicit = toPositiveOrNull(totalAssetsCny);
  if (explicit) {
    return explicit;
  }

  const inferred = activePositions.reduce(
    (sum, position) => sum + Number(position?.amount ?? 0),
    0
  );
  return toPositiveOrNull(inferred) ?? 0;
}

function buildSingleFundBreaches(activePositions, totalAssetsCny, singleFundMaxPct, assetMaster) {
  if (!totalAssetsCny || !Number.isFinite(singleFundMaxPct) || singleFundMaxPct <= 0) {
    return [];
  }

  return activePositions
    .map((position) => {
      const amount = toPositiveAmount(position?.amount);
      if (!amount) {
        return null;
      }

      const weightPct = (amount / totalAssetsCny) * 100;
      if (weightPct <= singleFundMaxPct * 100 + 1e-6) {
        return null;
      }

      const bucketKey = resolveBucketKey(assetMaster, position);
      const themeKey = resolveThemeKey(assetMaster, position);
      return {
        fund_code: position?.fund_code ?? position?.code ?? position?.symbol ?? null,
        name: position?.name ?? null,
        amount_cny: round(amount),
        weight_pct: round(weightPct),
        max_pct: round(singleFundMaxPct * 100, 2),
        bucket_key: bucketKey,
        bucket_label: resolveBucketLabel(assetMaster, bucketKey),
        theme_key: themeKey,
        theme_label: themeKey ? resolveThemeLabel(assetMaster, themeKey) : null
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.weight_pct ?? 0) - Number(left.weight_pct ?? 0));
}

function buildThemeBreaches(activePositions, totalAssetsCny, singleThemeMaxPct, assetMaster) {
  if (!totalAssetsCny || !Number.isFinite(singleThemeMaxPct) || singleThemeMaxPct <= 0) {
    return [];
  }

  const themeTotals = new Map();

  for (const position of activePositions) {
    const amount = toPositiveAmount(position?.amount);
    if (!amount) {
      continue;
    }

    const themeKey = resolveThemeKey(assetMaster, position);
    if (!themeKey) {
      continue;
    }

    const current = themeTotals.get(themeKey) ?? {
      theme_key: themeKey,
      theme_label: resolveThemeLabel(assetMaster, themeKey),
      amount_cny: 0,
      funds: []
    };
    current.amount_cny += amount;
    current.funds.push({
      fund_code: position?.fund_code ?? position?.code ?? position?.symbol ?? null,
      name: position?.name ?? null,
      amount_cny: round(amount)
    });
    themeTotals.set(themeKey, current);
  }

  return [...themeTotals.values()]
    .map((row) => {
      const weightPct = (Number(row.amount_cny ?? 0) / totalAssetsCny) * 100;
      if (weightPct <= singleThemeMaxPct * 100 + 1e-6) {
        return null;
      }

      return {
        theme_key: row.theme_key,
        theme_label: row.theme_label,
        amount_cny: round(row.amount_cny),
        weight_pct: round(weightPct),
        max_pct: round(singleThemeMaxPct * 100, 2),
        funds: row.funds
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.weight_pct ?? 0) - Number(left.weight_pct ?? 0));
}

function buildCorrelationClusterBreaches(quantMetrics = {}, highCorrelationMaxPct) {
  if (!Number.isFinite(highCorrelationMaxPct) || highCorrelationMaxPct <= 0) {
    return [];
  }

  const rows = Array.isArray(quantMetrics?.risk_model?.position_risk_contributions)
    ? quantMetrics.risk_model.position_risk_contributions
    : [];
  const matrix = quantMetrics?.matrices?.correlation_matrix?.matrix ?? {};
  const symbols = Array.isArray(quantMetrics?.matrices?.correlation_matrix?.symbols)
    ? quantMetrics.matrices.correlation_matrix.symbols
    : [];
  const symbolLookup = new Map(
    rows
      .map((row) => [String(row?.symbol ?? "").trim(), row])
      .filter(([symbol]) => symbol)
  );
  const breaches = [];

  for (let index = 0; index < symbols.length; index += 1) {
    const leftSymbol = String(symbols[index] ?? "").trim();
    if (!leftSymbol) {
      continue;
    }

    for (let inner = index + 1; inner < symbols.length; inner += 1) {
      const rightSymbol = String(symbols[inner] ?? "").trim();
      if (!rightSymbol) {
        continue;
      }

      const correlation = Number(
        matrix?.[leftSymbol]?.[rightSymbol] ?? matrix?.[rightSymbol]?.[leftSymbol] ?? NaN
      );
      if (!Number.isFinite(correlation) || Math.abs(correlation) < 0.85) {
        continue;
      }

      const leftRow = symbolLookup.get(leftSymbol) ?? {};
      const rightRow = symbolLookup.get(rightSymbol) ?? {};
      const combinedWeightPct =
        Number(leftRow?.weight_pct ?? 0) + Number(rightRow?.weight_pct ?? 0);
      if (combinedWeightPct <= highCorrelationMaxPct * 100 + 1e-6) {
        continue;
      }

      breaches.push({
        left_symbol: leftSymbol,
        left_name: leftRow?.name ?? leftSymbol,
        left_bucket_key: leftRow?.bucket_key ?? null,
        left_bucket_label: leftRow?.bucket_label ?? leftRow?.bucket_key ?? leftSymbol,
        right_symbol: rightSymbol,
        right_name: rightRow?.name ?? rightSymbol,
        right_bucket_key: rightRow?.bucket_key ?? null,
        right_bucket_label: rightRow?.bucket_label ?? rightRow?.bucket_key ?? rightSymbol,
        correlation: round(correlation, 4),
        combined_weight_pct: round(combinedWeightPct),
        max_pct: round(highCorrelationMaxPct * 100, 2)
      });
    }
  }

  return breaches.sort(
    (left, right) => Number(right.combined_weight_pct ?? 0) - Number(left.combined_weight_pct ?? 0)
  );
}

function buildDrawdownStatus(currentDrawdownPct, normalizedIpsConstraints) {
  const reEvaluatePct = Number(normalizedIpsConstraints?.drawdown?.reEvaluatePct ?? 0.08);
  const hardStopPct = Number(normalizedIpsConstraints?.drawdown?.hardStopPct ?? 0.12);
  const normalizedCurrent = Number.isFinite(currentDrawdownPct) ? currentDrawdownPct : null;

  let regime = "normal";
  if (normalizedCurrent !== null && normalizedCurrent >= hardStopPct) {
    regime = "hard_stop";
  } else if (normalizedCurrent !== null && normalizedCurrent >= reEvaluatePct) {
    regime = "re_evaluate";
  }

  return {
    from_peak_pct: round(normalizedCurrent, 4),
    peak_date: null,
    peak_value_cny: null,
    current_regime: regime,
    re_evaluate_pct: round(reEvaluatePct, 4),
    hard_stop_pct: round(hardStopPct, 4)
  };
}

function buildBlockingState({
  drawdownStatus,
  singleFundBreaches,
  themeBreaches,
  correlationClusterBreaches,
  rebalanceMode,
  rebalanceTargets
}) {
  const reasons = [];

  if (drawdownStatus?.current_regime === "hard_stop") {
    reasons.push("drawdown_hard_stop");
  }
  if (singleFundBreaches.length > 0) {
    reasons.push("single_fund_breach");
  }
  if (themeBreaches.length > 0) {
    reasons.push("theme_breach");
  }
  if (correlationClusterBreaches.length > 0) {
    reasons.push("high_correlation_cluster_breach");
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    requires_re_evaluation: drawdownStatus?.current_regime === "re_evaluate",
    rebalance_mode: String(rebalanceMode ?? "").trim() || null,
    allowed_buy_bucket_keys: Array.isArray(rebalanceTargets?.allowed_buy_bucket_keys)
      ? rebalanceTargets.allowed_buy_bucket_keys
      : [],
    single_fund_breach_count: singleFundBreaches.length,
    theme_breach_count: themeBreaches.length,
    correlation_cluster_breach_count: correlationClusterBreaches.length
  };
}

export function buildPortfolioRiskState({
  positions = [],
  signalMatrix = {},
  assetMaster = {},
  quantMetrics = {},
  ipsConstraints = {},
  totalAssetsCny = null,
  rebalanceMode = null,
  rebalanceTargets = null
} = {}) {
  const activePositions = Array.isArray(positions)
    ? positions.filter((position) => String(position?.status ?? "active") === "active")
    : [];
  const normalizedIpsConstraints = normalizeIpsConstraints(ipsConstraints ?? {});
  const signalLookup = buildSignalLookup(signalMatrix);
  const matchedPositions = [];

  for (const position of activePositions) {
    const signal = matchSignalForPosition(position, signalLookup);
    if (!signal) {
      continue;
    }

    const matched = buildMatchedPositionRow(position, signal, assetMaster);
    if (matched) {
      matchedPositions.push(matched);
    }
  }

  const investedMatchedAmount = matchedPositions.reduce(
    (sum, position) => sum + Number(position.amount_cny ?? 0),
    0
  );
  const totalAssets = resolveTotalAssetsCny(totalAssetsCny, activePositions);
  const weightedCurrentDrawdown =
    matchedPositions.length && investedMatchedAmount
      ? matchedPositions.reduce(
          (sum, position) =>
            sum +
            Number(position.amount_cny ?? 0) * Number(position.current_drawdown_60d_percent ?? 0),
          0
        ) / investedMatchedAmount
      : null;
  const weightedMaxDrawdown =
    matchedPositions.length && investedMatchedAmount
      ? matchedPositions.reduce(
          (sum, position) =>
            sum +
            Number(position.amount_cny ?? 0) * Number(position.max_drawdown_60d_percent ?? 0),
          0
        ) / investedMatchedAmount
      : null;
  const currentDrawdownPct =
    Number.isFinite(weightedCurrentDrawdown) ? Math.abs(weightedCurrentDrawdown) / 100 : null;
  const drawdownStatus = buildDrawdownStatus(currentDrawdownPct, normalizedIpsConstraints);
  const drawdownLimit = Number(drawdownStatus.hard_stop_pct ?? normalizedIpsConstraints.drawdown.hardStopPct);
  const singleFundBreaches = buildSingleFundBreaches(
    activePositions,
    totalAssets,
    normalizedIpsConstraints.concentration.singleFundMaxPct,
    assetMaster
  );
  const themeBreaches = buildThemeBreaches(
    activePositions,
    totalAssets,
    normalizedIpsConstraints.concentration.singleThemeMaxPct,
    assetMaster
  );
  const correlationClusterBreaches = buildCorrelationClusterBreaches(
    quantMetrics,
    normalizedIpsConstraints.concentration.highCorrelationMaxPct
  );
  const blockingState = buildBlockingState({
    drawdownStatus,
    singleFundBreaches,
    themeBreaches,
    correlationClusterBreaches,
    rebalanceMode,
    rebalanceTargets
  });

  return {
    matched_position_count: matchedPositions.length,
    matched_positions: matchedPositions,
    invested_matched_amount_cny: round(investedMatchedAmount ?? 0),
    weighted_current_drawdown_60d_percent: round(weightedCurrentDrawdown),
    weighted_max_drawdown_60d_percent: round(weightedMaxDrawdown),
    current_drawdown_pct: round(currentDrawdownPct, 4),
    max_drawdown_limit_pct: drawdownLimit,
    breached_max_drawdown_limit:
      Number.isFinite(drawdownLimit) &&
      Number.isFinite(currentDrawdownPct) &&
      currentDrawdownPct > drawdownLimit,
    drawdown_status: drawdownStatus,
    single_fund_breaches: singleFundBreaches,
    theme_breaches: themeBreaches,
    correlation_cluster_breaches: correlationClusterBreaches,
    blocking_state: blockingState
  };
}
