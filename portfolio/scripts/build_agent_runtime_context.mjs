import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { buildAgentRuntimeContextPayload } from "./lib/agent_runtime_context.mjs";
import {
  readManifestState,
  updateManifestCanonicalEntrypoints
} from "./lib/manifest_state.mjs";
import {
  loadCanonicalPortfolioState,
  readJsonOrNull
} from "./lib/portfolio_state_view.mjs";
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

export async function runAgentRuntimeContextBuild(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const portfolioState = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
  const dashboardState =
    (await readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "dashboard_state.json"))) ??
    (await readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "live_funds_snapshot.json"))) ??
    {};
  const researchBrain =
    (await readJsonOrNull(buildPortfolioPath(portfolioRoot, "data", "research_brain.json"))) ?? {};
  const buildHealth = deps.buildHealth ?? buildFundsDashboardHealth;
  const health = await buildHealth(accountId);
  const bucketSummary = Array.isArray(dashboardState?.presentation?.bucketSummary)
    ? dashboardState.presentation.bucketSummary
    : [];

  const payload = buildAgentRuntimeContextPayload({
    accountId,
    portfolioState: portfolioState.payload,
    dashboardState,
    researchBrain,
    health,
    bucketSummary
  });

  const outputPath = buildPortfolioPath(portfolioRoot, "data", "agent_runtime_context.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      agent_runtime_context_builder: buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "build_agent_runtime_context.mjs"
      ),
      agent_runtime_context: outputPath
    }
  });

  return { outputPath, payload };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runAgentRuntimeContextBuild(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
