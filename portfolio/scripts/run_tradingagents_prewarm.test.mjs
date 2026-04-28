import test from "node:test";
import assert from "node:assert/strict";

import { runTradingAgentsPrewarm } from "./run_tradingagents_prewarm.mjs";

const noPrewarmStatus = {
  loadStatus: async () => ({ generatedAt: null, providers: {} }),
  saveStatus: async () => {}
};

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
      ...noPrewarmStatus,
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
      ...noPrewarmStatus,
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

test("runTradingAgentsPrewarm can target DeepSeek fallback provider cache", async () => {
  const providerDefaultsSeen = [];

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      provider: "deepseek"
    },
    {
      ...noPrewarmStatus,
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ"]
        },
        providerChain: {
          primary: {
            llmProvider: "glm",
            deepThinkModel: "glm-5.1",
            quickThinkModel: "glm-5"
          },
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ"]
        }
      }),
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async ({ providerDefaults }) => {
        providerDefaultsSeen.push(providerDefaults);
        return {
          freshSymbols: [],
          staleSymbols: [],
          missingSymbols: ["QQQ"],
          fullyFresh: false
        };
      },
      runSnapshot: ({ providerDefaults }) => {
        providerDefaultsSeen.push(providerDefaults);
        return { calls: [{ symbol: "QQQ", rating: "HOLD" }] };
      }
    }
  );

  assert.equal(result.provider, "deepseek");
  assert.equal(result.deepModel, "deepseek-v4-pro");
  assert.equal(result.quickModel, "deepseek-v4-pro");
  assert.equal(providerDefaultsSeen[0].llmProvider, "deepseek");
  assert.equal(providerDefaultsSeen[0].deepThinkModel, "deepseek-v4-pro");
});

test("runTradingAgentsPrewarm defaults to GLM primary before fallback providers", async () => {
  const snapshotProviders = [];

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24"
    },
    {
      ...noPrewarmStatus,
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ"]
        },
        providerChain: {
          primary: {
            llmProvider: "glm",
            deepThinkModel: "glm-5.1",
            quickThinkModel: "glm-5"
          },
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ"]
        }
      }),
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ"],
        fullyFresh: false
      }),
      runSnapshot: ({ providerDefaults }) => {
        snapshotProviders.push(providerDefaults.llmProvider);
        return { calls: [{ symbol: "QQQ", rating: "HOLD" }] };
      }
    }
  );

  assert.deepEqual(snapshotProviders, ["glm"]);
  assert.equal(result.provider, "glm");
  assert.deepEqual(result.warmTargets, ["QQQ"]);
});

test("runTradingAgentsPrewarm falls through to fallback provider when primary circuit is open", async () => {
  const snapshotProviders = [];

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      now: new Date("2026-04-24T10:00:00+08:00")
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ"],
          prewarmCircuitBreakerTimeoutThreshold: 1
        },
        providerChain: {
          primary: {
            llmProvider: "glm",
            deepThinkModel: "glm-5.1",
            quickThinkModel: "glm-5"
          },
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ"]
        }
      }),
      loadStatus: async () => ({
        providers: {
          "glm/glm-5.1/glm-5": {
            circuitBreaker: {
              status: "open",
              reason: "tradingagents_original_graph_timeout",
              tradeDate: "2026-04-24",
              cooldownUntil: "2026-04-24T12:00:00+08:00",
              timeoutSymbols: ["QQQ"],
              timeoutCount: 1,
              threshold: 1
            },
            symbols: {
              QQQ: {
                symbol: "QQQ",
                tradeDate: "2026-04-24",
                status: "timeout"
              }
            }
          }
        }
      }),
      saveStatus: async () => {},
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ"],
        fullyFresh: false
      }),
      runSnapshot: ({ providerDefaults }) => {
        snapshotProviders.push(providerDefaults.llmProvider);
        return { calls: [{ symbol: "QQQ", rating: "HOLD" }] };
      }
    }
  );

  assert.deepEqual(snapshotProviders, ["deepseek"]);
  assert.equal(result.provider, "deepseek");
  assert.deepEqual(result.warmTargets, ["QQQ"]);
});

test("runTradingAgentsPrewarm reports DeepSeek symbol timeout compactly", async () => {
  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      provider: "deepseek"
    },
    {
      ...noPrewarmStatus,
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1
        },
        providerChain: {
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ"]
        }
      }),
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ"],
        fullyFresh: false
      }),
      runSnapshot: () => {
        throw new Error(
          "TimeoutError: provider_timeout:deepseek symbol=QQQ after 120s\n" +
            "[tradingagents_diagnostic] path=/tmp/ta-diag/QQQ.json"
        );
      }
    }
  );

  assert.equal(result.failed[0].provider, "deepseek");
  assert.equal(result.failed[0].error, "provider_timeout:deepseek");
  assert.equal(result.failed[0].status, "timeout");
  assert.equal(result.failed[0].diagnosticPath, "/tmp/ta-diag/QQQ.json");
  assert.equal(typeof result.failed[0].durationMs, "number");
  assert.equal(result.symbolRuntime.find((item) => item.symbol === "QQQ")?.status, "timeout");
  assert.equal(result.symbolRuntime.find((item) => item.symbol === "QQQ")?.diagnosticPath, "/tmp/ta-diag/QQQ.json");
  assert.equal(typeof result.symbolRuntime.find((item) => item.symbol === "QQQ")?.durationMs, "number");
});

test("runTradingAgentsPrewarm rotates away from symbols still in cooldown", async () => {
  const snapshotCalls = [];
  let savedStatus = null;

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      provider: "deepseek",
      now: new Date("2026-04-24T10:00:00+08:00")
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ", "SOXX", "KWEB"]
        },
        providerChain: {
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ", "SOXX", "KWEB"]
        }
      }),
      loadStatus: async () => ({
        generatedAt: "2026-04-24T09:50:00+08:00",
        providers: {
          "deepseek/deepseek-v4-pro/deepseek-v4-pro": {
            provider: "deepseek",
            deepModel: "deepseek-v4-pro",
            quickModel: "deepseek-v4-pro",
            tradeDate: "2026-04-24",
            symbols: {
              QQQ: {
                symbol: "QQQ",
                tradeDate: "2026-04-24",
                status: "timeout",
                error: "provider_timeout:deepseek",
                lastAttemptAt: "2026-04-24T09:50:00+08:00",
                cooldownUntil: "2026-04-24T10:20:00+08:00"
              }
            }
          }
        }
      }),
      saveStatus: async (_root, payload) => {
        savedStatus = payload;
      },
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ", "SOXX", "KWEB"],
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

  assert.deepEqual(snapshotCalls, [["SOXX"]]);
  assert.deepEqual(result.warmTargets, ["SOXX"]);
  assert.equal(result.symbolRuntime.find((item) => item.symbol === "QQQ")?.status, "timeout");
  assert.equal(savedStatus.providers["deepseek/deepseek-v4-pro/deepseek-v4-pro"].symbols.SOXX.status, "fresh");
});

test("runTradingAgentsPrewarm can ignore symbol cooldown for manual refresh", async () => {
  const snapshotCalls = [];

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      provider: "deepseek",
      "ignore-cooldown": "1",
      now: new Date("2026-04-24T10:00:00+08:00")
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ", "SOXX"]
        },
        providerChain: {
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ", "SOXX"]
        }
      }),
      loadStatus: async () => ({
        providers: {
          "deepseek/deepseek-v4-pro/deepseek-v4-pro": {
            symbols: {
              QQQ: {
                symbol: "QQQ",
                tradeDate: "2026-04-24",
                status: "timeout",
                cooldownUntil: "2026-04-24T10:20:00+08:00"
              }
            }
          }
        }
      }),
      saveStatus: async () => {},
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ", "SOXX"],
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
});

test("runTradingAgentsPrewarm opens slow graph circuit breaker after repeated symbol timeouts", async () => {
  const snapshotCalls = [];
  let savedStatus = null;

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      provider: "deepseek",
      now: new Date("2026-04-24T10:00:00+08:00")
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ", "SOXX", "KWEB"],
          prewarmCircuitBreakerTimeoutThreshold: 3,
          prewarmCircuitBreakerCooldownMs: 7200000
        },
        providerChain: {
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ", "SOXX", "KWEB"]
        }
      }),
      loadStatus: async () => ({
        providers: {
          "deepseek/deepseek-v4-pro/deepseek-v4-pro": {
            symbols: {
              QQQ: {
                symbol: "QQQ",
                tradeDate: "2026-04-24",
                status: "timeout",
                error: "provider_timeout:deepseek",
                cooldownUntil: "2026-04-24T10:20:00+08:00"
              },
              SOXX: {
                symbol: "SOXX",
                tradeDate: "2026-04-24",
                status: "timeout",
                error: "provider_timeout:deepseek",
                cooldownUntil: "2026-04-24T10:20:00+08:00"
              }
            }
          }
        }
      }),
      saveStatus: async (_root, payload) => {
        savedStatus = payload;
      },
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ", "SOXX", "KWEB"],
        fullyFresh: false
      }),
      runSnapshot: (options) => {
        snapshotCalls.push(options.symbols);
        throw new Error("TimeoutError: provider_timeout:deepseek symbol=KWEB after 120s");
      }
    }
  );

  assert.deepEqual(snapshotCalls, [["KWEB"]]);
  assert.equal(result.failed[0].symbol, "KWEB");
  assert.equal(result.circuitBreaker.status, "open");
  assert.equal(result.circuitBreaker.active, true);
  assert.equal(result.circuitBreaker.reason, "tradingagents_original_graph_timeout");
  assert.deepEqual(result.circuitBreaker.timeoutSymbols, ["QQQ", "SOXX", "KWEB"]);
  assert.equal(savedStatus.providers["deepseek/deepseek-v4-pro/deepseek-v4-pro"].circuitBreaker.status, "open");
});

test("runTradingAgentsPrewarm skips work while slow graph circuit breaker is open", async () => {
  const snapshotCalls = [];
  let savedStatus = null;

  const result = await runTradingAgentsPrewarm(
    {
      portfolioRoot: "/tmp/prewarm-root",
      user: "main",
      tradeDate: "2026-04-24",
      provider: "deepseek",
      now: new Date("2026-04-24T10:00:00+08:00")
    },
    {
      loadConfig: async () => ({
        providerDefaults: {
          llmProvider: "glm",
          deepThinkModel: "glm-5.1",
          quickThinkModel: "glm-5",
          prewarmMaxSymbolsPerRun: 1,
          prewarmPrioritySymbols: ["QQQ", "SOXX", "KWEB"],
          prewarmCircuitBreakerTimeoutThreshold: 3
        },
        providerChain: {
          fallback: [
            {
              llmProvider: "deepseek",
              deepThinkModel: "deepseek-v4-pro",
              quickThinkModel: "deepseek-v4-pro"
            }
          ]
        },
        bucketProxyUniverse: {
          GLB_MOM: ["QQQ", "SOXX", "KWEB"]
        }
      }),
      loadStatus: async () => ({
        providers: {
          "deepseek/deepseek-v4-pro/deepseek-v4-pro": {
            circuitBreaker: {
              status: "open",
              active: true,
              reason: "tradingagents_original_graph_timeout",
              provider: "deepseek",
              deepModel: "deepseek-v4-pro",
              quickModel: "deepseek-v4-pro",
              tradeDate: "2026-04-24",
              openedAt: "2026-04-24T09:50:00+08:00",
              cooldownUntil: "2026-04-24T12:00:00+08:00",
              timeoutCount: 3,
              timeoutSymbols: ["QQQ", "SOXX", "KWEB"],
              threshold: 3
            },
            symbols: {
              QQQ: { symbol: "QQQ", tradeDate: "2026-04-24", status: "timeout" },
              SOXX: { symbol: "SOXX", tradeDate: "2026-04-24", status: "timeout" },
              KWEB: { symbol: "KWEB", tradeDate: "2026-04-24", status: "timeout" }
            }
          }
        }
      }),
      saveStatus: async (_root, payload) => {
        savedStatus = payload;
      },
      resolveMarketLakeDbPath: async () => "/tmp/market_lake.db",
      inspectCoverage: async () => ({
        freshSymbols: [],
        staleSymbols: [],
        missingSymbols: ["QQQ", "SOXX", "KWEB"],
        fullyFresh: false
      }),
      runSnapshot: (options) => {
        snapshotCalls.push(options.symbols);
        return { calls: [] };
      }
    }
  );

  assert.deepEqual(snapshotCalls, []);
  assert.deepEqual(result.warmTargets, []);
  assert.equal(result.skippedReason, "tradingagents_original_graph_circuit_breaker_open");
  assert.equal(result.circuitBreaker.active, true);
  assert.equal(savedStatus.providers["deepseek/deepseek-v4-pro/deepseek-v4-pro"].circuitBreaker.active, true);
});
