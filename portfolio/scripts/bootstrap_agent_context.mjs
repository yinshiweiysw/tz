import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import {
  readManifestState,
  updateManifestCanonicalEntrypoints
} from "./lib/manifest_state.mjs";
import {
  loadCanonicalPortfolioState,
  readJsonOrNull
} from "./lib/portfolio_state_view.mjs";
import { buildAgentIntentRegistry } from "./lib/agent_intent_registry.mjs";
import { buildFundsDashboardHealth } from "./serve_funds_live_dashboard.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function buildAccountSummary(portfolioState = {}) {
  const summary = portfolioState?.summary ?? {};
  const positions = Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];
  return {
    snapshotDate: String(portfolioState?.snapshot_date ?? "").trim() || null,
    totalPortfolioAssetsCny: Number(summary?.total_portfolio_assets_cny ?? 0) || 0,
    investedAssetsCny: Number(summary?.total_fund_assets ?? 0) || 0,
    settledCashCny:
      Number(summary?.settled_cash_cny ?? summary?.available_cash_cny ?? 0) || 0,
    tradeAvailableCashCny:
      Number(summary?.trade_available_cash_cny ?? summary?.settled_cash_cny ?? summary?.available_cash_cny ?? 0) || 0,
    cashLikeFundAssetsCny: Number(summary?.cash_like_fund_assets_cny ?? 0) || 0,
    liquiditySleeveAssetsCny: Number(summary?.liquidity_sleeve_assets_cny ?? 0) || 0,
    activePositionCount: positions.filter((item) => item?.status === "active").length
  };
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numbersAligned(left, right, tolerance = 0.01) {
  const a = toNullableNumber(left);
  const b = toNullableNumber(right);
  if (a === null || b === null) {
    return false;
  }
  return Math.abs(a - b) <= tolerance;
}

function buildEntrypointIntegrity({
  accountId,
  runtimeContext = {},
  strategyDecisionContract = {}
} = {}) {
  const runtimeAccountId = runtimeContext?.accountId ?? null;
  const strategyContractAccountId = strategyDecisionContract?.accountId ?? null;
  const runtimeCodes = new Set(
    (Array.isArray(runtimeContext?.positions) ? runtimeContext.positions : [])
      .map((item) => String(item?.code ?? "").trim())
      .filter(Boolean)
  );
  const contractCodes = new Set(
    (Array.isArray(strategyDecisionContract?.positionFacts)
      ? strategyDecisionContract.positionFacts
      : []
    )
      .map((item) => String(item?.code ?? "").trim())
      .filter(Boolean)
  );
  const runtimePortfolio = runtimeContext?.portfolio ?? {};
  const contractCash = strategyDecisionContract?.cashSemantics ?? {};
  const runtimePositionCount = Array.isArray(runtimeContext?.positions)
    ? runtimeContext.positions.length
    : 0;
  const contractPositionFactCount = Array.isArray(strategyDecisionContract?.positionFacts)
    ? strategyDecisionContract.positionFacts.length
    : 0;

  return {
    runtimeGeneratedAt: runtimeContext?.generatedAt ?? null,
    strategyDecisionContractGeneratedAt: strategyDecisionContract?.generatedAt ?? null,
    runtimeAccountId,
    strategyDecisionContractAccountId: strategyContractAccountId,
    accountIdsAligned:
      Boolean(accountId) &&
      runtimeAccountId === accountId &&
      strategyContractAccountId === accountId,
    runtimeSnapshotDate: runtimeContext?.snapshotDate ?? null,
    strategyDecisionContractSnapshotDate:
      strategyDecisionContract?.freshness?.snapshotDate ?? null,
    snapshotDatesAligned:
      Boolean(runtimeContext?.snapshotDate) &&
      runtimeContext?.snapshotDate === strategyDecisionContract?.freshness?.snapshotDate,
    runtimePositionCount,
    contractPositionFactCount,
    positionFactsAligned:
      runtimePositionCount === contractPositionFactCount &&
      runtimeCodes.size === contractCodes.size &&
      [...runtimeCodes].every((code) => contractCodes.has(code)),
    cashSemanticsAligned:
      numbersAligned(runtimePortfolio?.settledCashCny, contractCash?.settledCashCny) &&
      numbersAligned(
        runtimePortfolio?.tradeAvailableCashCny,
        contractCash?.tradeAvailableCashCny
      ) &&
      numbersAligned(
        runtimePortfolio?.cashLikeFundAssetsCny,
        contractCash?.cashLikeFundAssetsCny
      ) &&
      numbersAligned(
        runtimePortfolio?.liquiditySleeveAssetsCny,
        contractCash?.liquiditySleeveAssetsCny
      )
  };
}

function normalizeReadiness(value, fallback = "unknown") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export async function buildAgentBootstrapContext(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const canonicalState = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
  const runtimeContextPath =
    manifest?.canonical_entrypoints?.agent_runtime_context ??
    buildPortfolioPath(portfolioRoot, "data", "agent_runtime_context.json");
  const strategyDecisionContractPath =
    manifest?.canonical_entrypoints?.strategy_decision_contract ??
    buildPortfolioPath(portfolioRoot, "data", "strategy_decision_contract.json");
  const runtimeContext = (await readJsonOrNull(runtimeContextPath)) ?? {};
  const strategyDecisionContract =
    (await readJsonOrNull(strategyDecisionContractPath)) ?? {};
  const buildHealth = deps.buildHealth ?? buildFundsDashboardHealth;
  const health = await buildHealth(accountId);
  const decisionReadiness = normalizeReadiness(
    strategyDecisionContract?.decisionReadiness,
    health?.state === "ready" ? "ready" : health?.state ?? "unknown"
  );
  const analysisReadiness = normalizeReadiness(
    runtimeContext?.systemState?.researchReadiness?.level,
    decisionReadiness
  );
  const newsCoverageReadiness = normalizeReadiness(
    runtimeContext?.systemState?.researchReadiness?.coverage_status ??
      runtimeContext?.marketContext?.newsCoverageReadiness,
    "unknown"
  );

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    portfolioRoot,
    systemSummary:
      "Portfolio system uses portfolio_state.json as canonical accounting state, agent_runtime_context.json as the unified fact layer, and strategy_decision_contract.json as the unified decision layer.",
    bootstrapReadOrder: [
      "state-manifest.json",
      "data/agent_bootstrap_context.json",
      "state/portfolio_state.json"
    ],
    canonicalEntrypoints: {
      manifestPath,
      ...(manifest?.canonical_entrypoints ?? {})
    },
    health,
    analysisReadiness,
    decisionReadiness,
    newsCoverageReadiness,
    portfolioFactsVersion: 1,
    accountSummary: buildAccountSummary(canonicalState?.payload ?? {}),
    entrypointIntegrity: buildEntrypointIntegrity({
      accountId,
      runtimeContext,
      strategyDecisionContract
    }),
    operatingRules: {
      canonicalViewOnly: true,
      reportsAreOutputOnly: true,
      dashboardGetRequestsAreReadOnly: true,
      latestCompatIsCompatibilityOnly: true
    },
    intentRouting: buildAgentIntentRegistry(portfolioRoot),
    changeGuardrails: {
      required: true,
      checklist: [
        "change_layer",
        "canonical_inputs",
        "affected_modules",
        "impact_decision",
        "write_boundary_check",
        "required_regressions"
      ],
      policy: {
        impactAssessmentBeforeImplementation: true,
        regressionBeforeCompletion: true,
        noSilentFeatureRemoval: true
      }
    }
  };
}

export async function runBootstrapAgentContextBuild(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const outputPath = buildPortfolioPath(portfolioRoot, "data", "agent_bootstrap_context.json");
  const payload = await buildAgentBootstrapContext(rawOptions, deps);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      agent_bootstrap_context_script: buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "bootstrap_agent_context.mjs"
      ),
      latest_agent_bootstrap_context: outputPath
    }
  });

  return {
    accountId,
    portfolioRoot,
    outputPath,
    payload
  };
}

async function main() {
  const result = await runBootstrapAgentContextBuild(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          error: String(error?.message ?? error)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}
