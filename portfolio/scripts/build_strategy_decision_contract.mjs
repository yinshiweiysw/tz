import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import {
  readManifestState,
  updateManifestCanonicalEntrypoints
} from "./lib/manifest_state.mjs";
import { readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import { buildStrategyDecisionContract } from "./lib/strategy_decision_contract.mjs";

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

export async function runStrategyDecisionContractBuild(rawOptions = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const manifest = await readManifestState(manifestPath);
  const runtimeContextPath =
    manifest?.canonical_entrypoints?.agent_runtime_context ??
    buildPortfolioPath(portfolioRoot, "data", "agent_runtime_context.json");
  const runtimeContext = await readJsonOrNull(runtimeContextPath);
  const tradePlan = await readJsonOrNull(
    buildPortfolioPath(portfolioRoot, "data", "trade_plan_v4.json")
  );
  const signals = await readJsonOrNull(
    buildPortfolioPath(portfolioRoot, "signals", "regime_router_signals.json")
  );

  const payload = buildStrategyDecisionContract({
    runtimeContext: {
      ...runtimeContext,
      accountId: runtimeContext?.accountId ?? accountId
    },
    tradePlan,
    signals
  });
  const outputPath = buildPortfolioPath(
    portfolioRoot,
    "data",
    "strategy_decision_contract.json"
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      strategy_decision_contract_builder: buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "build_strategy_decision_contract.mjs"
      ),
      strategy_decision_contract: outputPath
    }
  });

  return { outputPath, payload };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runStrategyDecisionContractBuild(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
