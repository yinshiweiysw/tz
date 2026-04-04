import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  buildAnalyticsFreshness,
  buildAnalyticsPaths,
  resolveScopedResearchBrainPath,
  runRefreshStep,
  shouldBlockTradePlanRefresh,
  shouldRefreshResearchBrain,
  shouldRefreshSpeculativePlan,
  shouldRefreshTradePlan
} from "./report_context.mjs";

async function loadNamedFunction(relativePath, functionName) {
  const scriptPath = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = await readFile(scriptPath, "utf8");
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^function ${escapedName}\\([^)]*\\) \\{[\\s\\S]*?^}\\n`, "m"));
  assert.ok(match, `${functionName} not found in ${scriptPath}`);
  return vm.runInNewContext(`(${match[0]})`);
}

async function loadParseArgsFunction(relativePath) {
  return loadNamedFunction(relativePath, "parseArgs");
}

async function readSource(relativePath) {
  const scriptPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(scriptPath, "utf8");
}

function buildAlignedPayloads(anchorDate = "2026-04-02") {
  const generatedAt = `${anchorDate}T10:00:00.000Z`;

  return {
    latest: {
      snapshot_date: anchorDate,
      generated_at: generatedAt
    },
    cnMarketSnapshot: {
      trade_date: anchorDate,
      generated_at: generatedAt
    },
    signalMatrix: {
      generated_at: generatedAt,
      signals: {
        core: {
          signal_date: anchorDate
        }
      }
    },
    macroRadar: {
      generated_at: generatedAt,
      dimensions: {
        growth: {
          signal_date: anchorDate
        }
      }
    },
    macroState: {
      generated_at: generatedAt
    },
    regimeSignals: {
      generated_at: generatedAt,
      signals: {
        core: {
          execution_context: {
            price_date: anchorDate
          }
        }
      }
    },
    quantMetrics: {
      as_of: anchorDate,
      generated_at: generatedAt
    },
    riskDashboard: {
      as_of: anchorDate,
      generated_at: generatedAt
    },
    performanceAttribution: {
      as_of: anchorDate,
      generated_at: generatedAt
    },
    opportunityPool: {
      as_of: anchorDate,
      generated_at: generatedAt
    },
    researchBrain: {
      meta: {
        trade_date: anchorDate
      },
      generated_at: generatedAt
    },
    speculativePlan: {
      as_of: anchorDate,
      generated_at: generatedAt
    },
    tradePlan: {
      plan_date: anchorDate,
      generated_at: generatedAt
    }
  };
}

test("buildAnalyticsPaths exposes speculative plan path with canonical fallback", () => {
  const paths = buildAnalyticsPaths("/tmp/pf", {
    canonical_entrypoints: {}
  });

  assert.equal(paths.speculativePlanJsonPath, "/tmp/pf/data/speculative_plan.json");
});

test("buildAnalyticsPaths exposes research brain path from canonical latest_research_brain", () => {
  const paths = buildAnalyticsPaths("/tmp/pf", {
    canonical_entrypoints: {
      latest_research_brain: "/tmp/pf/custom/research_brain.json"
    }
  });

  assert.equal(paths.researchBrainPath, "/tmp/pf/custom/research_brain.json");
});

test("resolveScopedResearchBrainPath returns session-specific research brain path for market pulse style reports", () => {
  const path = resolveScopedResearchBrainPath({
    portfolioRoot: "/tmp/pf",
    options: {
      session: "noon"
    },
    anchorDate: "2026-04-03"
  });

  assert.equal(path, "/tmp/pf/data/research_brain.2026-04-03.noon.json");
});

test("resolveScopedResearchBrainPath returns null when report does not request explicit session scoping", () => {
  const path = resolveScopedResearchBrainPath({
    portfolioRoot: "/tmp/pf",
    options: {},
    anchorDate: "2026-04-03"
  });

  assert.equal(path, null);
});

test("buildAnalyticsPaths exposes institutional sidecar paths with canonical fallback", () => {
  const paths = buildAnalyticsPaths("/tmp/pf", {
    canonical_entrypoints: {}
  });

  assert.equal(paths.marketDataQualityPath, "/tmp/pf/data/market_data_quality.json");
  assert.equal(paths.marketFlowMatrixPath, "/tmp/pf/data/market_flow_matrix.json");
  assert.equal(paths.driverExpectationMatrixPath, "/tmp/pf/data/driver_expectation_matrix.json");
  assert.equal(paths.reportSessionMemoryPath, "/tmp/pf/data/report_session_memory.json");
  assert.equal(paths.reportQualityScorecardPath, "/tmp/pf/data/report_quality_scorecard.json");
  assert.equal(paths.analysisHitRatePath, "/tmp/pf/data/analysis_hit_rate.json");
});

test("market reports use next-trading-day wording instead of next-day wording", async () => {
  const [marketBriefSource, marketPulseSource, reportSessionContextSource, dailyBriefSource, fundsDashboardSource] = await Promise.all([
    readSource("../generate_market_brief.mjs"),
    readSource("../generate_market_pulse.mjs"),
    readSource("./report_session_context.mjs"),
    readSource("../generate_daily_brief.mjs"),
    readSource("../serve_funds_live_dashboard.mjs")
  ]);

  assert.match(marketBriefSource, /下一交易日观察与行动偏置/);
  assert.match(marketPulseSource, /buildMarketPulseSessionContext/);
  assert.match(reportSessionContextSource, /下一交易日判断/);
  assert.match(dailyBriefSource, /下一交易日/);
  assert.match(fundsDashboardSource, /下一交易日/);
  assert.doesNotMatch(marketBriefSource, /## 次日观察与行动偏置/);
  assert.doesNotMatch(dailyBriefSource, /待次日计收益买入/);
  assert.doesNotMatch(fundsDashboardSource, /次日起计收益/);
});

test("generate_market_brief parseArgs keeps valueless flags separate from following options", async () => {
  const parseArgs = await loadParseArgsFunction("../generate_market_brief.mjs");
  const parsed = parseArgs(["--refresh", "--date", "2026-04-01"]);

  assert.equal(parsed.refresh, true);
  assert.equal(parsed.date, "2026-04-01");
});

test("generate_market_pulse parseArgs keeps valueless flags separate from following options", async () => {
  const parseArgs = await loadParseArgsFunction("../generate_market_pulse.mjs");
  const parsed = parseArgs(["--session", "morning", "--refresh", "--date", "2026-04-01"]);

  assert.equal(parsed.session, "morning");
  assert.equal(parsed.refresh, true);
  assert.equal(parsed.date, "2026-04-01");
});

test("runRefreshStep times out stalled child processes instead of hanging indefinitely", async () => {
  const result = await runRefreshStep("stall_probe", "python3", ["-c", "import time; time.sleep(1)"], {
    timeoutMs: 50
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, "stall_probe");
  assert.equal(result.timedOut, true);
  assert.match(String(result.message ?? ""), /timeout|timed out/i);
});

test("shared research renderer defines Institutional Research Readiness and reports consume it", async () => {
  const [rendererSource, marketBriefSource, marketPulseSource] = await Promise.all([
    readSource("./research_brain_render.mjs"),
    readSource("../generate_market_brief.mjs"),
    readSource("../generate_market_pulse.mjs")
  ]);

  assert.match(rendererSource, /## Institutional Research Readiness/);
  assert.match(marketBriefSource, /buildUnifiedResearchSections/);
  assert.match(marketPulseSource, /buildUnifiedResearchSections/);
});

test("market reports use institutional story filtering and session memory helpers", async () => {
  const [marketBriefSource, marketPulseSource, dailyBriefSource] = await Promise.all([
    readSource("../generate_market_brief.mjs"),
    readSource("../generate_market_pulse.mjs"),
    readSource("../generate_daily_brief.mjs")
  ]);

  assert.match(marketBriefSource, /selectInstitutionalStories/);
  assert.match(marketPulseSource, /selectInstitutionalStories/);
  assert.match(marketBriefSource, /buildReportSessionInheritanceLines/);
  assert.match(marketPulseSource, /buildReportSessionInheritanceLines/);
  assert.match(dailyBriefSource, /readReportSessionMemory/);
  assert.match(dailyBriefSource, /研究质量回看/);
  assert.match(dailyBriefSource, /reportQualityScorecardPath|analysisHitRatePath/);
});

test("close-form reports request close-scoped research brain context instead of canonical latest only", async () => {
  const [marketBriefSource, dailyBriefSource] = await Promise.all([
    readSource("../generate_market_brief.mjs"),
    readSource("../generate_daily_brief.mjs")
  ]);

  assert.match(marketBriefSource, /session:\s*"close"/);
  assert.match(dailyBriefSource, /session:\s*"close"/);
});

test("market brief, market pulse, and daily brief reuse buildUnifiedResearchSections", async () => {
  const [marketBriefSource, marketPulseSource, dailyBriefSource] = await Promise.all([
    readSource("../generate_market_brief.mjs"),
    readSource("../generate_market_pulse.mjs"),
    readSource("../generate_daily_brief.mjs")
  ]);

  assert.match(marketBriefSource, /buildUnifiedResearchSections/);
  assert.match(marketPulseSource, /buildUnifiedResearchSections/);
  assert.match(dailyBriefSource, /buildUnifiedResearchSections/);
});

test("market reports keep the last research brain payload for rendering even if refresh failed", async () => {
  const [
    selectBriefResearchBrain,
    selectPulseResearchBrain,
    selectBriefDecisionResearchBrain,
    selectPulseDecisionResearchBrain,
    buildOpportunityPoolFallbackLines
  ] = await Promise.all([
    loadNamedFunction("../generate_market_brief.mjs", "selectResearchBrainForRender"),
    loadNamedFunction("../generate_market_pulse.mjs", "selectResearchBrainForRender"),
    loadNamedFunction("../generate_market_brief.mjs", "selectResearchBrainForDecision"),
    loadNamedFunction("../generate_market_pulse.mjs", "selectResearchBrainForDecision"),
    loadNamedFunction("../generate_market_brief.mjs", "buildOpportunityPoolFallbackLines")
  ]);
  const payload = {
    decision_readiness: {
      level: "analysis_degraded"
    }
  };
  const failedRefreshSteps = new Set(["research_brain"]);

  assert.equal(selectBriefResearchBrain(payload, failedRefreshSteps), payload);
  assert.equal(selectPulseResearchBrain(payload, failedRefreshSteps), payload);
  assert.equal(selectBriefResearchBrain(null, failedRefreshSteps), null);
  assert.equal(selectPulseResearchBrain(null, failedRefreshSteps), null);

  assert.equal(selectBriefDecisionResearchBrain(payload, failedRefreshSteps), null);
  assert.equal(selectPulseDecisionResearchBrain(payload, failedRefreshSteps), null);
  assert.equal(selectBriefDecisionResearchBrain(payload, new Set()), payload);
  assert.equal(selectPulseDecisionResearchBrain(payload, new Set()), payload);

  assert.deepEqual([...buildOpportunityPoolFallbackLines(null, new Set(["opportunity_pool"]))], [
    "- ⚠️ 机会池本轮刷新失败，本节不沿用旧候选池结论。"
  ]);
  assert.deepEqual([...buildOpportunityPoolFallbackLines(null, new Set())], [
    "- ⚠️ 机会池当前缺失，本节仅保留空白降级口径，不输出候选池结论。"
  ]);
});

test("buildAnalyticsFreshness includes speculative_plan entry with as_of and generated_at", () => {
  const freshness = buildAnalyticsFreshness({
    anchorDate: "2026-04-01",
    payloads: {
      latest: { snapshot_date: "2026-04-01" },
      speculativePlan: {
        as_of: "2026-04-01",
        generated_at: "2026-04-01T16:27:12.814Z"
      }
    }
  });

  const entry = freshness.entries.find((item) => item.key === "speculative_plan");
  assert.ok(entry);
  assert.equal(entry.asOf, "2026-04-01");
  assert.equal(entry.generatedAt, "2026-04-01T16:27:12.814Z");
  assert.equal(entry.status, "aligned");
});

test("buildAnalyticsFreshness flags same-day dependency drift for speculative and trade plans", () => {
  const freshness = buildAnalyticsFreshness({
    anchorDate: "2026-04-01",
    payloads: {
      latest: {
        snapshot_date: "2026-04-01",
        generated_at: "2026-04-01T15:30:00.000Z"
      },
      signalMatrix: {
        generated_at: "2026-04-01T11:00:00.000Z"
      },
      opportunityPool: {
        as_of: "2026-04-01",
        generated_at: "2026-04-01T12:00:00.000Z"
      },
      speculativePlan: {
        as_of: "2026-04-01",
        generated_at: "2026-04-01T10:00:00.000Z"
      },
      tradePlan: {
        plan_date: "2026-04-01",
        generated_at: "2026-04-01T09:00:00.000Z"
      }
    }
  });

  assert.equal(freshness.needsRefresh, true);
  assert.ok(freshness.refreshRecommendedKeys.includes("speculative_plan"));
  assert.ok(freshness.refreshRecommendedKeys.includes("trade_plan"));
});

test("shouldRefreshResearchBrain requests a rebuild when the target report session mismatches the cached research brain session", () => {
  const payloads = buildAlignedPayloads("2026-04-03");
  payloads.researchBrain.meta.market_session = "pre_open";

  const shouldRefresh = shouldRefreshResearchBrain({
    refreshMode: "auto",
    refreshedKeys: new Set(),
    payloads,
    freshness: {
      staleKeys: [],
      missingKeys: [],
      refreshRecommendedKeys: []
    },
    referenceNow: "2026-04-03T12:00:00+08:00"
  });

  assert.equal(shouldRefresh, true);
});

test("buildAnalyticsFreshness excludes performance attribution when caller does not consume it", () => {
  const payloads = buildAlignedPayloads("2026-04-02");
  payloads.performanceAttribution = {
    as_of: "2026-04-01",
    generated_at: "2026-04-01T10:00:00.000Z"
  };

  const excluded = buildAnalyticsFreshness({
    anchorDate: "2026-04-02",
    payloads,
    includePerformanceAttribution: false
  });
  const included = buildAnalyticsFreshness({
    anchorDate: "2026-04-02",
    payloads,
    includePerformanceAttribution: true
  });

  assert.equal(excluded.entries.some((entry) => entry.key === "performance_attribution"), false);
  assert.equal(excluded.refreshRecommendedKeys.includes("performance_attribution"), false);
  assert.equal(excluded.needsRefresh, false);

  assert.equal(included.entries.some((entry) => entry.key === "performance_attribution"), true);
  assert.equal(included.refreshRecommendedKeys.includes("performance_attribution"), true);
  assert.equal(included.needsRefresh, true);
});

test("shouldRefreshSpeculativePlan honors force, upstream refresh, and stale/missing freshness", () => {
  const staleFreshness = {
    staleKeys: ["speculative_plan"],
    missingKeys: [],
    refreshRecommendedKeys: ["speculative_plan"]
  };
  const cleanFreshness = {
    staleKeys: [],
    missingKeys: [],
    refreshRecommendedKeys: []
  };

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "force",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["signals_matrix"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["opportunity_pool"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: staleFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        opportunityPool: {
          generated_at: "2026-04-01T11:00:00.000Z"
        },
        signalMatrix: {
          generated_at: "2026-04-01T10:00:00.000Z"
        },
        speculativePlan: {
          generated_at: "2026-04-01T09:00:00.000Z"
        }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshSpeculativePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    false
  );
});

test("shouldRefreshTradePlan reruns when speculative or opportunity layers refreshed", () => {
  const cleanFreshness = {
    staleKeys: [],
    missingKeys: [],
    refreshRecommendedKeys: []
  };

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["regime_router_signals"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["speculative_plan"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(["opportunity_pool"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        tradePlan: {
          generated_at: "2026-04-01T08:00:00.000Z"
        },
        speculativePlan: {
          generated_at: "2026-04-01T09:00:00.000Z"
        }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshTradePlan({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    false
  );
});

test("shouldRefreshResearchBrain reruns when upstream dependencies are newer", () => {
  const cleanFreshness = {
    staleKeys: [],
    missingKeys: [],
    refreshRecommendedKeys: []
  };

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(["risk_dashboard"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(["cn_market_snapshot"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(["macro_state"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(["opportunity_pool"]),
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        latest: { generated_at: "2026-04-02T12:30:00.000Z" },
        researchBrain: { generated_at: "2026-04-02T11:00:00.000Z" }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        cnMarketSnapshot: { generated_at: "2026-04-02T12:45:00.000Z" },
        researchBrain: { generated_at: "2026-04-02T11:00:00.000Z" }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      payloads: {
        riskDashboard: { generated_at: "2026-04-02T12:00:00.000Z" },
        researchBrain: { generated_at: "2026-04-02T11:00:00.000Z" }
      },
      freshness: cleanFreshness
    }),
    true
  );

  assert.equal(
    shouldRefreshResearchBrain({
      refreshMode: "auto",
      refreshedKeys: new Set(),
      freshness: cleanFreshness
    }),
    false
  );
});

test("shouldBlockTradePlanRefresh blocks overwrite when speculative refresh failed", () => {
  assert.equal(
    shouldBlockTradePlanRefresh({
      speculativeRefreshRequested: true,
      refreshErrors: [{ step: "speculative_plan", message: "boom" }]
    }),
    true
  );

  assert.equal(
    shouldBlockTradePlanRefresh({
      speculativeRefreshRequested: true,
      opportunityPoolRefreshRequested: true,
      refreshErrors: [{ step: "opportunity_pool", message: "boom" }]
    }),
    true
  );

  assert.equal(
    shouldBlockTradePlanRefresh({
      speculativeRefreshRequested: false,
      opportunityPoolRefreshRequested: false,
      refreshErrors: [{ step: "opportunity_pool", message: "boom" }]
    }),
    false
  );
});
