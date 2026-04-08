import test from "node:test";
import assert from "node:assert/strict";

import { runAgentEntrypointRefresh } from "./refresh_agent_entrypoints.mjs";

test("runAgentEntrypointRefresh rebuilds runtime context before strategy decision contract", async () => {
  const calls = [];
  const result = await runAgentEntrypointRefresh(
    { portfolioRoot: "/tmp/demo" },
    {
      runRuntimeContextBuild: async () => {
        calls.push("runtime");
        return { outputPath: "/tmp/demo/data/agent_runtime_context.json" };
      },
      runStrategyDecisionContractBuild: async () => {
        calls.push("contract");
        return { outputPath: "/tmp/demo/data/strategy_decision_contract.json" };
      }
    }
  );

  assert.deepEqual(calls, ["runtime", "contract"]);
  assert.equal(result.runtimeContextPath, "/tmp/demo/data/agent_runtime_context.json");
  assert.equal(
    result.strategyDecisionContractPath,
    "/tmp/demo/data/strategy_decision_contract.json"
  );
});
