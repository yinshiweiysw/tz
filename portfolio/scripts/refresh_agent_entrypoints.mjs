import { pathToFileURL } from "node:url";

import { buildPortfolioPath, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { pathExists } from "./lib/portfolio_state_view.mjs";
import { runBootstrapAgentContextBuild } from "./bootstrap_agent_context.mjs";
import { runAgentRuntimeContextBuild } from "./build_agent_runtime_context.mjs";
import { runStrategyDecisionContractBuild } from "./build_strategy_decision_contract.mjs";

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

export async function runAgentEntrypointRefresh(rawOptions = {}, deps = {}) {
  const runRuntimeContextBuild = deps.runRuntimeContextBuild ?? runAgentRuntimeContextBuild;
  const runStrategyDecisionContract =
    deps.runStrategyDecisionContractBuild ?? runStrategyDecisionContractBuild;
  const runBootstrapBuild =
    deps.runBootstrapAgentContextBuild ?? runBootstrapAgentContextBuild;
  const portfolioRoot = resolvePortfolioRoot(rawOptions);

  const runtimeResult = await runRuntimeContextBuild(rawOptions);
  const contractResult = await runStrategyDecisionContract(rawOptions);
  let bootstrapResult = null;
  const shouldBuildBootstrap =
    typeof deps.runBootstrapAgentContextBuild === "function" ||
    (await pathExists(buildPortfolioPath(portfolioRoot, "state", "portfolio_state.json")));

  if (shouldBuildBootstrap) {
    bootstrapResult = await runBootstrapBuild(rawOptions);
  }

  return {
    runtimeContextPath: runtimeResult?.outputPath ?? null,
    strategyDecisionContractPath: contractResult?.outputPath ?? null,
    bootstrapAgentContextPath: bootstrapResult?.outputPath ?? null
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runAgentEntrypointRefresh(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
