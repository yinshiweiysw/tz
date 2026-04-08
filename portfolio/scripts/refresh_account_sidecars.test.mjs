import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { runRefreshAccountSidecars } from "./refresh_account_sidecars.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("runRefreshAccountSidecars rebuilds canonical sidecars in a fixed order and updates session memory first", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "refresh-sidecars-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const portfolioStatePath = path.join(portfolioRoot, "state", "portfolio_state.json");
  const riskDashboardPath = path.join(portfolioRoot, "risk_dashboard.json");
  const liveFundsSnapshotPath = path.join(portfolioRoot, "data", "live_funds_snapshot.json");
  const researchBrainPath = path.join(portfolioRoot, "data", "research_brain.json");
  const reportSessionMemoryPath = path.join(portfolioRoot, "data", "report_session_memory.json");
  const reportQualityScorecardPath = path.join(portfolioRoot, "data", "report_quality_scorecard.json");
  const analysisHitRatePath = path.join(portfolioRoot, "data", "analysis_hit_rate.json");
  const nightlyStatusPath = path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json");
  const agentRuntimeContextPath = path.join(portfolioRoot, "data", "agent_runtime_context.json");
  const strategyDecisionContractPath = path.join(
    portfolioRoot,
    "data",
    "strategy_decision_contract.json"
  );
  const agentBootstrapContextPath = path.join(portfolioRoot, "data", "agent_bootstrap_context.json");

  await writeJson(manifestPath, {
    version: 3,
    account_id: "main",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      portfolio_state: portfolioStatePath
    }
  });
  await writeJson(portfolioStatePath, {
    account_id: "main",
    snapshot_date: "2026-04-04",
    summary: {
      total_fund_assets: 333646.59,
      yesterday_profit: -414.66,
      holding_profit: -21823.65
    },
    positions: [
      {
        name: "兴全恒信债券D",
        code: "016482",
        amount: 90077.95,
        status: "active"
      }
    ]
  });

  const callOrder = [];
  const researchBrain = {
    generated_at: "2026-04-04T15:30:00.000Z",
    meta: {
      market_session: "post_close"
    },
    event_driver: {
      status: "active_market_driver",
      primary_driver: "关税冲击继续压制风险偏好",
      expectation_gap: "风险资产修复力度弱于预期。"
    },
    flow_macro_radar: {
      liquidity_regime: "risk_off",
      summary: "美元和黄金同步偏强。"
    },
    actionable_decision: {
      desk_conclusion: {
        trade_permission: "restricted",
        one_sentence_order: "只允许观察，不放行新增进攻性交易。"
      }
    },
    section_confidence: {
      actionable_decision: "high"
    }
  };

  const result = await runRefreshAccountSidecars(
    {
      portfolioRoot,
      user: "main",
      date: "2026-04-04"
    },
    {
      runRiskDashboardBuild: async () => {
        callOrder.push("risk");
        await writeJson(riskDashboardPath, {
          generated_at: "2026-04-04T15:31:00.000Z",
          portfolio_risk: {
            matched_positions: [
              {
                code: "016482",
                amount_cny: 90077.95
              }
            ]
          }
        });
        return { outputPath: riskDashboardPath };
      },
      runLiveFundsSnapshotBuild: async () => {
        callOrder.push("live");
        const payload = {
          generatedAt: "2026-04-04T15:32:00.000Z",
          accountId: "main",
          portfolioRoot,
          summary: {
            totalFundAssets: 333646.59,
            confirmedFundCount: 1,
            normalLagFundCount: 0,
            holidayDelayFundCount: 0,
            lateMissingFundCount: 0,
            sourceMissingFundCount: 0,
            confirmationCoveragePct: 100
          },
          confirmedNavStatus: {
            state: "confirmed_nav_ready",
            targetDate: "2026-04-04"
          }
        };
        await writeJson(liveFundsSnapshotPath, payload);
        return {
          outputPath: liveFundsSnapshotPath,
          payload
        };
      },
      upsertNightlyConfirmedNavStatus: async (input) => {
        callOrder.push("nightly");
        await writeJson(nightlyStatusPath, {
          stats: {
            totalFundAssets: input.portfolioState?.summary?.total_fund_assets ?? null,
            confirmedFundCount: input.livePayload?.summary?.confirmedFundCount ?? null
          }
        });
        return {
          statusPath: nightlyStatusPath
        };
      },
      runResearchBrainBuild: async () => {
        callOrder.push("research");
        await writeJson(researchBrainPath, researchBrain);
        return {
          outputPath: researchBrainPath,
          output: researchBrain
        };
      },
      runAgentEntrypointRefresh: async () => {
        callOrder.push("agent");
        await writeJson(agentRuntimeContextPath, {
          generatedAt: "2026-04-04T15:32:30.000Z"
        });
        await writeJson(strategyDecisionContractPath, {
          generatedAt: "2026-04-04T15:32:40.000Z"
        });
        await writeJson(agentBootstrapContextPath, {
          generatedAt: "2026-04-04T15:32:50.000Z"
        });
        return {
          runtimeContextPath: agentRuntimeContextPath,
          strategyDecisionContractPath,
          bootstrapAgentContextPath: agentBootstrapContextPath
        };
      },
      runReportQualityScorecardBuild: async () => {
        callOrder.push("scorecard");
        const persistedMemory = JSON.parse(await readFile(reportSessionMemoryPath, "utf8"));
        assert.equal(
          persistedMemory.days["2026-04-04"].close.primary_driver,
          "关税冲击继续压制风险偏好"
        );
        await writeJson(reportQualityScorecardPath, {
          record_count: 1
        });
        await writeJson(analysisHitRatePath, {
          generated_at: "2026-04-04T15:33:00.000Z"
        });
        return {
          reportQualityScorecardPath,
          analysisHitRatePath
        };
      }
    }
  );

  assert.deepEqual(callOrder, ["risk", "live", "nightly", "research", "agent", "scorecard"]);

  const persistedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(
    persistedManifest.canonical_entrypoints.sidecar_refresh_script,
    path.join(portfolioRoot, "scripts", "refresh_account_sidecars.mjs")
  );
  assert.equal(persistedManifest.canonical_entrypoints.risk_dashboard, riskDashboardPath);
  assert.equal(
    persistedManifest.canonical_entrypoints.latest_live_funds_snapshot,
    liveFundsSnapshotPath
  );
  assert.equal(
    persistedManifest.canonical_entrypoints.latest_report_session_memory,
    reportSessionMemoryPath
  );
  assert.equal(
    persistedManifest.canonical_entrypoints.agent_runtime_context,
    agentRuntimeContextPath
  );
  assert.equal(
    persistedManifest.canonical_entrypoints.strategy_decision_contract,
    strategyDecisionContractPath
  );
  assert.equal(
    persistedManifest.canonical_entrypoints.latest_agent_bootstrap_context,
    agentBootstrapContextPath
  );
  assert.equal(
    persistedManifest.canonical_entrypoints.latest_report_quality_scorecard,
    reportQualityScorecardPath
  );
  assert.equal(
    persistedManifest.canonical_entrypoints.latest_analysis_hit_rate,
    analysisHitRatePath
  );

  const persistedStatus = JSON.parse(await readFile(nightlyStatusPath, "utf8"));
  assert.equal(persistedStatus.stats.totalFundAssets, 333646.59);
  assert.equal(persistedStatus.stats.confirmedFundCount, 1);

  assert.equal(result.outputs.riskDashboardPath, riskDashboardPath);
  assert.equal(result.outputs.liveFundsSnapshotPath, liveFundsSnapshotPath);
  assert.equal(result.outputs.nightlyConfirmedNavStatusPath, nightlyStatusPath);
  assert.equal(result.outputs.researchBrainPath, researchBrainPath);
  assert.equal(result.outputs.agentRuntimeContextPath, agentRuntimeContextPath);
  assert.equal(result.outputs.strategyDecisionContractPath, strategyDecisionContractPath);
  assert.equal(result.outputs.agentBootstrapContextPath, agentBootstrapContextPath);
  assert.equal(result.outputs.reportSessionMemoryPath, reportSessionMemoryPath);
  assert.equal(result.outputs.reportQualityScorecardPath, reportQualityScorecardPath);
  assert.equal(result.outputs.analysisHitRatePath, analysisHitRatePath);
});
