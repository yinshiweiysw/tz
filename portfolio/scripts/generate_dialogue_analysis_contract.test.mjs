import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDialogueAnalysisContractBuild } from "./generate_dialogue_analysis_contract.mjs";

test("runDialogueAnalysisContractBuild rebuilds research brain when report context is missing it", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "dialogue-contract-"));
  const outputPath = path.join(portfolioRoot, "data", "dialogue_analysis_contract.json");
  let builderCalled = 0;

  const result = await runDialogueAnalysisContractBuild(
    {
      portfolioRoot,
      now: new Date("2026-04-03T10:00:00+08:00"),
      output: outputPath
    },
    {
      ensureReportContext: async () => ({
        payloads: {
          cnMarketSnapshot: {
            sections: {
              southbound_flow: {
                latest_summary_net_buy_100m_hkd: 198.28
              }
            }
          },
          opportunityPool: {
            candidates: [{ theme_name: "红利低波", action_bias: "watch" }]
          },
          speculativePlan: {
            instructions: ["- 观察左侧信号，不追高。"]
          },
          tradePlan: {
            summary: {
              actionable_trade_count: 1,
              gross_buy_cny: 4000
            },
            trades: [
              {
                symbol: "007339",
                execution_action: "Buy",
                planned_trade_amount_cny: 4000
              }
            ]
          },
          researchBrain: null
        },
        freshness: {
          staleKeys: [],
          missingKeys: ["research_brain"],
          refreshRecommendedKeys: []
        },
        refresh: {
          mode: "auto",
          triggered: false,
          refreshedTargets: [],
          skippedTargets: [],
          errors: []
        }
      }),
      runResearchBrainBuild: async () => {
        builderCalled += 1;
        return {
          output: {
            generated_at: "2026-04-03T10:00:00+08:00",
            meta: {
              market_session: "intraday",
              trade_date: "2026-04-03"
            },
            freshness_guard: {
              overall_status: "aligned",
              stale_dependencies: [],
              missing_dependencies: []
            },
            coverage_guard: {
              overall_status: "sufficient",
              weak_domains: []
            },
            decision_readiness: {
              level: "ready",
              analysis_allowed: true,
              trading_allowed: true,
              reasons: []
            },
            event_driver: {
              status: "active_market_driver",
              primary_driver: "关税与贸易摩擦冲击全球风险偏好",
              priced_in_assessment: "underpriced",
              evidence: [{ headline: "纳斯达克100期货" }]
            },
            analysis_mode: "multi_source_confirmed",
            top_headlines: [
              {
                source: "Reuters",
                title: "Trump says Iran ceasefire talks continue",
                published_at: "2026-04-03T09:20:00+08:00"
              }
            ],
            gold_factor_model: {
              dominantGoldDriver: "liquidity_deleveraging",
              goldRegime: "forced_liquidation",
              goldActionBias: "avoid_chasing_dip",
              secondaryGoldDrivers: ["headline_geopolitics_overlay"],
              goldRiskNotes: ["黄金下跌并非单纯避险失效。"]
            },
            flow_macro_radar: {
              liquidity_regime: "neutral",
              summary: "流动性中性，需等待更清晰信号。"
            },
            actionable_decision: {
              desk_conclusion: {
                trade_permission: "allowed",
                one_sentence_order: "允许围绕现有组合做选择性进攻。",
                must_not_do: ["不要脱离组合框架追涨"]
              },
              portfolio_actions: [
                {
                  target_key: "007339",
                  stance: "hold",
                  execution_note: "仅在既定计划范围内执行。"
                }
              ],
              new_watchlist_actions: []
            }
          }
        };
      }
    }
  );

  const persisted = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(builderCalled, 1);
  assert.equal(result.rebuiltResearchBrain, true);
  assert.equal(result.contract.market_core.active_driver, "关税与贸易摩擦冲击全球风险偏好");
  assert.equal(result.contract.news_context.analysis_mode, "multi_source_confirmed");
  assert.equal(result.contract.news_context.top_headlines[0]?.source, "Reuters");
  assert.equal(result.contract.gold_factor_model.dominantGoldDriver, "liquidity_deleveraging");
  assert.ok(
    result.contract.shared_research_sections.some(
      (section) => section.heading === "## Institutional Research Readiness"
    )
  );
  assert.ok(
    result.contract.shared_research_sections.some((section) => section.heading === "## Headline Tape")
  );
  assert.ok(
    result.contract.shared_research_sections.some(
      (section) => section.heading === "## Gold Factor Model"
    )
  );
  assert.equal(
    persisted.contract.dialogue_cues.allowed_actions[0],
    "允许围绕现有组合做选择性进攻。"
  );
});

test("runDialogueAnalysisContractBuild reuses an existing research brain when it is already present", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "dialogue-contract-existing-"));
  let builderCalled = 0;

  const result = await runDialogueAnalysisContractBuild(
    {
      portfolioRoot,
      now: new Date("2026-04-03T10:00:00+08:00")
    },
    {
      ensureReportContext: async () => ({
        payloads: {
          cnMarketSnapshot: {},
          opportunityPool: {},
          speculativePlan: {},
          tradePlan: {},
          researchBrain: {
            generated_at: "2026-04-03T10:05:00+08:00",
            meta: {
              market_session: "intraday",
              trade_date: "2026-04-03"
            },
            freshness_guard: {
              overall_status: "aligned",
              stale_dependencies: [],
              missing_dependencies: []
            },
            coverage_guard: {
              overall_status: "sufficient",
              weak_domains: []
            },
            decision_readiness: {
              level: "ready",
              analysis_allowed: true,
              trading_allowed: true,
              reasons: []
            },
            event_driver: {
              status: "watch_only",
              primary_driver: "消息待验证",
              priced_in_assessment: "unclear",
              evidence: []
            },
            flow_macro_radar: {
              liquidity_regime: "neutral",
              summary: "流动性中性，需等待更清晰信号。"
            },
            actionable_decision: {
              desk_conclusion: {
                trade_permission: "restricted",
                one_sentence_order: "当前只允许条件式观察，不建议直接下强结论交易单。",
                must_not_do: ["不要把降级分析直接转化为强买卖动作"]
              },
              portfolio_actions: [],
              new_watchlist_actions: []
            }
          }
        },
        freshness: {
          staleKeys: [],
          missingKeys: [],
          refreshRecommendedKeys: []
        },
        refresh: {
          mode: "auto",
          triggered: false,
          refreshedTargets: [],
          skippedTargets: [],
          errors: []
        }
      }),
      runResearchBrainBuild: async () => {
        builderCalled += 1;
        return { output: null };
      }
    }
  );

  assert.equal(builderCalled, 0);
  assert.equal(result.rebuiltResearchBrain, false);
  assert.equal(result.contract.market_core.active_driver, "消息待验证");
});

test("runDialogueAnalysisContractBuild defaults refresh mode to auto", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "dialogue-contract-refresh-"));
  let receivedRefresh = null;

  await runDialogueAnalysisContractBuild(
    {
      portfolioRoot,
      now: new Date("2026-04-03T10:00:00+08:00")
    },
    {
      ensureReportContext: async ({ options }) => {
        receivedRefresh = options?.refresh ?? null;
        return {
          payloads: {
            cnMarketSnapshot: {},
            opportunityPool: {},
            speculativePlan: {},
            tradePlan: {},
            researchBrain: {
              generated_at: "2026-04-03T10:05:00+08:00",
              meta: {
                market_session: "intraday",
                trade_date: "2026-04-03"
              },
              freshness_guard: {
                overall_status: "aligned",
                stale_dependencies: [],
                missing_dependencies: []
              },
              coverage_guard: {
                overall_status: "sufficient",
                weak_domains: []
              },
              decision_readiness: {
                level: "ready",
                analysis_allowed: true,
                trading_allowed: true,
                reasons: []
              },
              event_driver: {
                status: "watch_only",
                primary_driver: "消息待验证",
                priced_in_assessment: "unclear",
                evidence: []
              },
              flow_macro_radar: {
                liquidity_regime: "neutral",
                summary: "流动性中性，需等待更清晰信号。"
              },
              actionable_decision: {
                desk_conclusion: {
                  trade_permission: "restricted",
                  one_sentence_order: "当前只允许条件式观察，不建议直接下强结论交易单。",
                  must_not_do: ["不要把降级分析直接转化为强买卖动作"]
                },
                portfolio_actions: [],
                new_watchlist_actions: []
              }
            }
          },
          freshness: {
            staleKeys: [],
            missingKeys: [],
            refreshRecommendedKeys: []
          },
          refresh: {
            mode: "auto",
            triggered: false,
            refreshedTargets: [],
            skippedTargets: [],
            errors: []
          }
        };
      }
    }
  );

  assert.equal(receivedRefresh, "auto");
});

test("runDialogueAnalysisContractBuild rebuilds research brain into session-scoped path when session is explicit", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "dialogue-contract-session-"));
  let receivedOutput = null;

  await runDialogueAnalysisContractBuild(
    {
      portfolioRoot,
      session: "noon",
      now: new Date("2026-04-03T12:00:00+08:00")
    },
    {
      ensureReportContext: async () => ({
        paths: {
          reportSessionMemoryPath: path.join(portfolioRoot, "data", "report_session_memory.json")
        },
        payloads: {
          latest: {
            snapshot_date: "2026-04-03"
          },
          cnMarketSnapshot: {},
          opportunityPool: {},
          speculativePlan: {},
          tradePlan: {},
          researchBrain: null
        },
        freshness: {
          staleKeys: [],
          missingKeys: ["research_brain"],
          refreshRecommendedKeys: []
        },
        refresh: {
          mode: "auto",
          triggered: false,
          refreshedTargets: [],
          skippedTargets: [],
          errors: []
        }
      }),
      runResearchBrainBuild: async (options) => {
        receivedOutput = options?.output ?? null;
        return {
          output: {
            generated_at: "2026-04-03T12:00:00+08:00",
            meta: {
              market_session: "intraday",
              trade_date: "2026-04-03"
            },
            freshness_guard: {
              overall_status: "aligned",
              stale_dependencies: [],
              missing_dependencies: []
            },
            coverage_guard: {
              overall_status: "sufficient",
              weak_domains: []
            },
            decision_readiness: {
              level: "ready",
              analysis_allowed: true,
              trading_allowed: true,
              reasons: []
            },
            event_driver: {
              status: "watch_only",
              primary_driver: "测试主线",
              priced_in_assessment: "unclear",
              evidence: []
            },
            flow_macro_radar: {
              liquidity_regime: "neutral",
              summary: "测试摘要"
            },
            actionable_decision: {
              desk_conclusion: {
                trade_permission: "allowed",
                one_sentence_order: "测试动作"
              },
              portfolio_actions: [],
              new_watchlist_actions: []
            }
          }
        };
      }
    }
  );

  assert.equal(receivedOutput, path.join(portfolioRoot, "data", "research_brain.2026-04-03.noon.json"));
});

test("runDialogueAnalysisContractBuild reads unified agent entry artifacts into the contract", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "dialogue-contract-agent-entry-"));
  const dataDir = path.join(portfolioRoot, "data");
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    path.join(dataDir, "agent_runtime_context.json"),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-08T11:26:27.761Z",
        accountId: "main",
        snapshotDate: "2026-04-08",
        portfolio: {
          settledCashCny: 52436.16,
          tradeAvailableCashCny: 52436.16,
          cashLikeFundAssetsCny: 105251.47,
          liquiditySleeveAssetsCny: 105251.47
        },
        positions: [
          {
            code: "023764",
            name: "华夏恒生互联网科技业ETF联接(QDII)D",
            observableAmount: 69414.58,
            quoteMode: "close_reference"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "strategy_decision_contract.json"),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-08T11:26:27.766Z",
        accountId: "main",
        freshness: {
          confirmedNavState: "late_missing"
        },
        cashSemantics: {
          settledCashCny: 52436.16,
          tradeAvailableCashCny: 52436.16,
          cashLikeFundAssetsCny: 105251.47,
          liquiditySleeveAssetsCny: 105251.47
        },
        regime: {
          tradePermission: "blocked",
          overallStance: "freeze"
        },
        executionGuardrails: {
          maxTotalBuyTodayCny: 20000
        },
        positionFacts: [
          {
            code: "023764",
            name: "华夏恒生互联网科技业ETF联接(QDII)D",
            amountCny: 69414.58,
            decisionValueSource: "observable",
            quoteMode: "close_reference"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "agent_bootstrap_context.json"),
    `${JSON.stringify(
      {
        entrypointIntegrity: {
          accountIdsAligned: true,
          cashSemanticsAligned: true,
          positionFactsAligned: true
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runDialogueAnalysisContractBuild(
    {
      portfolioRoot,
      now: new Date("2026-04-08T15:00:00+08:00"),
      output: path.join(dataDir, "dialogue_analysis_contract.json")
    },
    {
      ensureReportContext: async () => ({
        payloads: {
          cnMarketSnapshot: {},
          opportunityPool: {},
          speculativePlan: {},
          tradePlan: {},
          researchBrain: {
            generated_at: "2026-04-08T14:55:00+08:00",
            meta: {
              market_session: "post_close",
              trade_date: "2026-04-08"
            },
            freshness_guard: {
              overall_status: "aligned",
              stale_dependencies: [],
              missing_dependencies: []
            },
            coverage_guard: {
              overall_status: "sufficient",
              weak_domains: []
            },
            decision_readiness: {
              level: "ready",
              analysis_allowed: true,
              trading_allowed: false,
              reasons: []
            },
            event_driver: {
              status: "watch_only",
              primary_driver: "地缘风险边际降温",
              priced_in_assessment: "repricing"
            },
            flow_macro_radar: {
              liquidity_regime: "neutral",
              summary: "等待收盘后确认。"
            },
            actionable_decision: {
              desk_conclusion: {
                trade_permission: "blocked",
                one_sentence_order: "不追高，等二次确认。"
              },
              portfolio_actions: [],
              new_watchlist_actions: []
            }
          }
        },
        freshness: {
          staleKeys: [],
          missingKeys: [],
          refreshRecommendedKeys: []
        },
        refresh: {
          mode: "auto",
          triggered: false,
          refreshedTargets: [],
          skippedTargets: [],
          errors: []
        }
      }),
      runResearchBrainBuild: async () => {
        throw new Error("should not rebuild research brain");
      }
    }
  );

  const persisted = JSON.parse(await readFile(path.join(dataDir, "dialogue_analysis_contract.json"), "utf8"));
  assert.equal(result.contract.agent_entry_snapshot.entrypoint_integrity.cashSemanticsAligned, true);
  assert.equal(result.contract.agent_entry_snapshot.cash_semantics.tradeAvailableCashCny, 52436.16);
  assert.equal(result.contract.agent_entry_snapshot.strategy_snapshot.maxTotalBuyTodayCny, 20000);
  assert.equal(result.contract.agent_entry_snapshot.top_positions[0].code, "023764");
  assert.equal(
    persisted.contract.agent_entry_snapshot.entrypoint_integrity.positionFactsAligned,
    true
  );
});
