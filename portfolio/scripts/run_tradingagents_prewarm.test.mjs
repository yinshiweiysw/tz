import test from "node:test";
import assert from "node:assert/strict";

import { runTradingAgentsPrewarm } from "./run_tradingagents_prewarm.mjs";

test("runTradingAgentsPrewarm warms only missing and stale symbols", async () => {
  const inspectCalls = [];
  const snapshotCalls = [];

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24"
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 2,
          prewarmPrioritySymbols: ["QQQ", "SOXX", "ASHR"]
        },
        bucketProxyUniverse: {
          A_CORE: ["ASHR"],
          GLB_MOM: ["QQQ", "SOXX"]
        }
      }),
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async (options) => {
        inspectCalls.push(options.symbols);
        if (inspectCalls.length === 1) {
          return {
            freshSymbols: ["ASHR"],
            staleSymbols: ["QQQ"],
            missingSymbols: ["SOXX"],
            fullyFresh: false
          };
        }
        return {
          freshSymbols: ["ASHR", "QQQ", "SOXX"],
          staleSymbols: [],
          missingSymbols: [],
          fullyFresh: true
        };
      },
      runSnapshot: (options) => {
        snapshotCalls.push(options.symbols);
        return {
          calls: [
            {
              symbol: options.symbols[0],
              rating: "HOLD"
            }
          ]
        };
      }
    }
  );

  assert.deepEqual(snapshotCalls, [["QQQ"], ["SOXX"]]);
  assert.deepEqual(result.warmTargets, ["QQQ", "SOXX"]);
  assert.deepEqual(result.initialCoverage.freshSymbols, ["ASHR"]);
  assert.deepEqual(result.finalCoverage.freshSymbols, ["ASHR", "QQQ", "SOXX"]);
  assert.equal(result.failed.length, 0);
});

test("runTradingAgentsPrewarm limits dashboard background work to one prioritized symbol by default", async () => {
  const snapshotCalls = [];

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24"
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmPrioritySymbols: ["QQQ", "SOXX", "ASHR"]
        },
        bucketProxyUniverse: {
          A_CORE: ["ASHR"],
          GLB_MOM: ["QQQ", "SOXX"]
        }
      }),
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: ["ASHR"],
        missingSymbols: ["SOXX", "QQQ"],
        fullyFresh: false
      }),
      runSnapshot: (options) => {
        snapshotCalls.push(options.symbols);
        return {
          calls: [
            {
              symbol: options.symbols[0],
              rating: "HOLD"
            }
          ]
        };
      }
    }
  );

  assert.deepEqual(snapshotCalls, [["QQQ"]]);
  assert.deepEqual(result.warmTargets, ["QQQ"]);
  assert.equal(result.warmTargetCount, 1);
});
