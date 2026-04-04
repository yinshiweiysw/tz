import { mkdir, writeFile } from "node:fs/promises";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { getSpeculativeSleeveConfig, loadAssetMaster } from "./lib/asset_master.mjs";
import { readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import {
  buildSpeculativeInstruction,
  computeSpeculativeBudget,
  detectSpeculativeExposure,
  deriveSpeculativeTrigger
} from "./lib/speculative_engine.mjs";

const args = process.argv.slice(2);

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

function resolveDate(dateArg) {
  if (dateArg) {
    return String(dateArg).slice(0, 10);
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function normalizeName(value) {
  return String(value ?? "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replace(/[\s\u3000]/g, "")
    .replaceAll("(QDII)", "")
    .replaceAll("（QDII）", "")
    .replaceAll("QDII-FOF-LOF", "QDII")
    .replaceAll("QDII-LOF", "QDII")
    .replaceAll("ETF发起式联接", "")
    .replaceAll("ETF发起联接", "")
    .replaceAll("ETF联接", "")
    .replaceAll("联接", "")
    .replaceAll("发起式", "")
    .replaceAll("混合型", "混合")
    .replace(/[()［］\[\]\-_/·.]/g, "")
    .trim();
}

function buildSignalLookup(signalMatrix = {}) {
  const lookup = new Map();

  for (const [code, signal] of Object.entries(signalMatrix?.signals ?? {})) {
    const candidates = new Set([
      code,
      signal?.code,
      signal?.name,
      signal?.portfolio_context?.latest_name_match,
      signal?.portfolio_context?.watchlist_name_match
    ]);

    for (const candidate of candidates) {
      const normalized = normalizeName(candidate);
      if (normalized) {
        lookup.set(normalized, signal);
      }
    }
  }

  return lookup;
}

function buildValuationLookup(indexValuationMatrix = {}) {
  const lookup = new Map();

  for (const [key, signal] of Object.entries(indexValuationMatrix?.signals ?? {})) {
    const candidates = new Set([key, signal?.proxy_key, signal?.name, ...(signal?.mapped_labels ?? [])]);
    for (const candidate of candidates) {
      const normalized = normalizeName(candidate);
      if (normalized) {
        lookup.set(normalized, signal);
      }
    }
  }

  return lookup;
}

function findSignalForCandidate(candidate = {}, signalLookup = new Map()) {
  const proxies = Array.isArray(candidate.tradable_proxies) ? candidate.tradable_proxies : [];
  const keys = new Set([
    candidate.theme_name,
    ...proxies.flatMap((proxy) => [proxy?.symbol, proxy?.name])
  ]);

  for (const key of keys) {
    const normalized = normalizeName(key);
    if (normalized && signalLookup.has(normalized)) {
      return signalLookup.get(normalized);
    }
  }

  return null;
}

function findValuationForCandidate(candidate = {}, signal = null, valuationLookup = new Map()) {
  const proxies = Array.isArray(candidate.tradable_proxies) ? candidate.tradable_proxies : [];
  const keys = new Set([
    signal?.valuation_context?.proxy_key,
    signal?.valuation_context?.proxy_name,
    candidate.theme_name,
    ...proxies.flatMap((proxy) => [proxy?.name, proxy?.symbol])
  ]);

  for (const key of keys) {
    const normalized = normalizeName(key);
    if (normalized && valuationLookup.has(normalized)) {
      return valuationLookup.get(normalized);
    }
  }

  return null;
}

function enrichCandidate(candidate, signalLookup, valuationLookup) {
  const signal = findSignalForCandidate(candidate, signalLookup);
  const valuation = findValuationForCandidate(candidate, signal, valuationLookup);
  const firstProxy = Array.isArray(candidate?.tradable_proxies) ? candidate.tradable_proxies[0] : null;

  return {
    ...candidate,
    symbol: String(firstProxy?.symbol ?? signal?.code ?? "").trim(),
    name: String(firstProxy?.name ?? signal?.name ?? candidate?.theme_name ?? "").trim(),
    left_side_regime: String(signal?.derived_signals?.left_side_regime ?? "neutral"),
    valuation_regime_primary: String(
      valuation?.derived_signals?.valuation_regime_primary ??
        signal?.valuation_context?.valuation_regime_primary ??
        ""
    )
  };
}

const options = parseArgs(args);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const reportDate = resolveDate(options.date);
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");

const manifest = await readJsonOrNull(manifestPath);
const canonical = manifest?.canonical_entrypoints ?? {};

const assetMasterPath = canonical.asset_master ?? buildPortfolioPath(portfolioRoot, "config", "asset_master.json");
const opportunityPoolPath =
  canonical.latest_opportunity_pool_json ?? buildPortfolioPath(portfolioRoot, "data", "opportunity_pool.json");
const signalMatrixPath =
  canonical.latest_fund_signals_matrix ?? buildPortfolioPath(portfolioRoot, "signals", "signals_matrix.json");
const indexValuationMatrixPath =
  canonical.latest_index_valuation_matrix ??
  buildPortfolioPath(portfolioRoot, "signals", "index_valuation_matrix.json");
const portfolioStatePath = canonical.portfolio_state ?? buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json");
const outputPath =
  options["output-json"] ||
  canonical.latest_speculative_plan_json ||
  buildPortfolioPath(portfolioRoot, "data", "speculative_plan.json");

const [assetMaster, opportunityPool, signalMatrix, indexValuationMatrix, portfolioState] = await Promise.all([
  loadAssetMaster(assetMasterPath),
  readJsonOrNull(opportunityPoolPath),
  readJsonOrNull(signalMatrixPath),
  readJsonOrNull(indexValuationMatrixPath),
  readJsonOrNull(portfolioStatePath)
]);

const sleeveConfig = getSpeculativeSleeveConfig(assetMaster);
const signalLookup = buildSignalLookup(signalMatrix ?? {});
const valuationLookup = buildValuationLookup(indexValuationMatrix ?? {});
const candidates = Array.isArray(opportunityPool?.candidates) ? opportunityPool.candidates : [];
const enriched = candidates.map((candidate) => enrichCandidate(candidate, signalLookup, valuationLookup));

const totalAssetsCny = Number(
  portfolioState?.summary?.total_portfolio_assets_cny ?? portfolioState?.summary?.total_fund_assets ?? 0
);
const speculativeExposure = detectSpeculativeExposure(portfolioState ?? {});
let rollingSpeculativeExposure = speculativeExposure.amount;
const planItems = [];

for (const candidate of enriched) {
  const trigger = deriveSpeculativeTrigger({
    candidate,
    sleeveConfig,
    options: {
      manualTheme: options["manual-theme"] || options.manualTheme,
      eventTheme: options["event-theme"] || options.eventTheme
    }
  });
  if (!trigger) {
    continue;
  }

  const budget = computeSpeculativeBudget({
    totalAssetsCny,
    currentSpeculativeExposureCny: rollingSpeculativeExposure,
    sleeveConfig
  });
  if (budget.suggested_amount_cny <= 0) {
    continue;
  }

  const instruction = buildSpeculativeInstruction({
    asOf: reportDate,
    candidate,
    trigger,
    budget,
    sleeveConfig
  });
  planItems.push(instruction);
  rollingSpeculativeExposure += instruction.suggested_amount_cny;
}

const finalBudget = computeSpeculativeBudget({
  totalAssetsCny,
  currentSpeculativeExposureCny: rollingSpeculativeExposure,
  sleeveConfig
});

const planPayload = {
  version: 1,
  as_of: reportDate,
  generated_at: new Date().toISOString(),
  account_id: accountId,
  system: "left_speculative_sleeve",
  trigger_sources_supported: sleeveConfig.allowedTriggerSources,
  source: {
    opportunity_pool: opportunityPoolPath,
    signals_matrix: signalMatrixPath,
    index_valuation_matrix: indexValuationMatrixPath,
    portfolio_state: portfolioStatePath,
    asset_master: assetMasterPath
  },
  budget_context: {
    total_assets_cny: totalAssetsCny,
    initial_speculative_exposure_cny: speculativeExposure.amount,
    initial_exposure_note: speculativeExposure.note,
    max_pct: finalBudget.max_pct,
    sleeve_cap_cny: finalBudget.sleeve_cap_cny,
    remaining_budget_cny: finalBudget.available_budget_cny
  },
  instructions: planItems
};

await mkdir(buildPortfolioPath(portfolioRoot, "data"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(planPayload, null, 2)}\n`, "utf8");

if (manifest) {
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      latest_speculative_plan_json: outputPath
    }
  });
}

console.log(
  JSON.stringify(
    {
      accountId,
      asOf: reportDate,
      outputPath,
      instructions: planItems.length
    },
    null,
    2
  )
);
