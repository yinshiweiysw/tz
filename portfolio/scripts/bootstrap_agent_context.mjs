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
import { loadCanonicalPortfolioState } from "./lib/portfolio_state_view.mjs";
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

export async function buildAgentBootstrapContext(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const canonicalState = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
  const buildHealth = deps.buildHealth ?? buildFundsDashboardHealth;
  const health = await buildHealth(accountId);

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    portfolioRoot,
    systemSummary:
      "Portfolio system uses portfolio_state.json as canonical accounting state, agent_runtime_context.json as the unified fact layer, and strategy_decision_contract.json as the unified decision layer.",
    bootstrapReadOrder: [
      "state-manifest.json",
      "data/agent_runtime_context.json",
      "data/strategy_decision_contract.json",
      "state/portfolio_state.json"
    ],
    canonicalEntrypoints: {
      manifestPath,
      ...(manifest?.canonical_entrypoints ?? {})
    },
    health,
    accountSummary: buildAccountSummary(canonicalState?.payload ?? {}),
    operatingRules: {
      canonicalViewOnly: true,
      reportsAreOutputOnly: true,
      dashboardGetRequestsAreReadOnly: true,
      latestCompatIsCompatibilityOnly: true
    },
    intentRouting: buildAgentIntentRegistry(portfolioRoot)
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
