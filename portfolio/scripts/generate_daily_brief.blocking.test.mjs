import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { buildInstitutionalActionLines } from "./lib/dual_trade_plan_render.mjs";

async function loadNamedFunction(relativePath, functionName) {
  const scriptPath = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = await readFile(scriptPath, "utf8");
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^(?:async\\s+)?function ${escapedName}\\([^)]*\\) \\{[\\s\\S]*?^}\\n`, "m"));
  assert.ok(match, `${functionName} not found in ${scriptPath}`);
  return vm.runInNewContext(`(${match[0]})`, {
    readFile,
  });
}

test("daily brief action memo helper can be forced into blocked mode even when trade-plan text is executable", () => {
  const lines = buildInstitutionalActionLines({
    thesis: "当前组合主线仍由 A股核心 驱动，执行以双轨计划优先级为准。",
    expectationGap: "当前计划以先减后买的内部再平衡为主。",
    allowedActions: ["主系统优先处理 核心仓 / 招商量化精选股票A / 5,000.00 元，状态：可执行"],
    blockedActions: ["禁止跳过 trade card / journal 直接下单"],
    tradePermission: "blocked",
    blockedOrder: "研究闸门未通过，当前禁止生成交易指令。"
  });

  assert.equal(lines.some((line) => line.includes("可执行")), false);
  assert.equal(lines[2], "- 允许动作：仅允许观察与记录，不生成交易指令");
  assert.equal(lines[3], "- 禁止动作：研究闸门未通过，当前禁止生成交易指令。");
});

test("selectDailyBriefQualityArtifacts recomputes scorecard when persisted artifacts lag session memory", async () => {
  const selectDailyBriefQualityArtifacts = await loadNamedFunction(
    "./generate_daily_brief.mjs",
    "selectDailyBriefQualityArtifacts"
  );

  const result = selectDailyBriefQualityArtifacts({
    briefDate: "2026-04-03",
    reportSessionMemory: {
      updated_at: "2026-04-03T07:14:01.598Z",
      days: {
        "2026-04-03": {
          morning: {},
          noon: {},
          close: {}
        }
      }
    },
    persistedReportQualityScorecard: {
      generated_at: "2026-04-03T06:00:00.000Z",
      stale: true
    },
    persistedAnalysisHitRate: {
      generated_at: "2026-04-03T06:00:00.000Z",
      stale: true
    },
    buildReportQualityScorecard: (memory, options) => ({
      generated_at: memory.updated_at,
      derived_from: options.asOfDate
    }),
    buildAnalysisHitRateSummary: (scorecard) => ({
      generated_at: scorecard.generated_at,
      source: "derived"
    })
  });

  assert.equal(result.reportQualityScorecard.stale, undefined);
  assert.equal(result.reportQualityScorecard.generated_at, "2026-04-03T07:14:01.598Z");
  assert.equal(result.analysisHitRate.source, "derived");
});

test("selectDailyBriefQualityArtifacts reuses persisted artifacts when they are not older than session memory", async () => {
  const selectDailyBriefQualityArtifacts = await loadNamedFunction(
    "./generate_daily_brief.mjs",
    "selectDailyBriefQualityArtifacts"
  );

  const persistedScorecard = {
    generated_at: "2026-04-03T07:30:00.000Z",
    source: "persisted"
  };
  const persistedHitRate = {
    generated_at: "2026-04-03T07:30:00.000Z",
    source: "persisted"
  };

  const result = selectDailyBriefQualityArtifacts({
    briefDate: "2026-04-03",
    reportSessionMemory: {
      updated_at: "2026-04-03T07:14:01.598Z",
      days: {
        "2026-04-03": {
          morning: {},
          noon: {},
          close: {}
        }
      }
    },
    persistedReportQualityScorecard: persistedScorecard,
    persistedAnalysisHitRate: persistedHitRate,
    buildReportQualityScorecard: () => {
      throw new Error("should not recompute scorecard");
    },
    buildAnalysisHitRateSummary: () => {
      throw new Error("should not recompute hit rate");
    }
  });

  assert.equal(result.reportQualityScorecard, persistedScorecard);
  assert.equal(result.analysisHitRate, persistedHitRate);
});

test("buildDailyBriefTradePlanCandidates ignores stale manifest latest pointers from previous dates", async () => {
  const buildDailyBriefTradePlanCandidates = await loadNamedFunction(
    "./generate_daily_brief.mjs",
    "buildDailyBriefTradePlanCandidates"
  );

  const candidates = buildDailyBriefTradePlanCandidates({
    briefDate: "2026-04-03",
    portfolioRoot: "/tmp/pf",
    manifest: {
      canonical_entrypoints: {
        latest_trade_plan_v4_report: "/tmp/pf/reports/2026-04-02-next-trade-plan-regime-v4.md",
        latest_next_trade_generator: "/tmp/pf/reports/2026-04-02-next-trade-generator.md"
      }
    }
  });

  assert.equal(
    JSON.stringify(candidates),
    JSON.stringify([
      "/tmp/pf/reports/2026-04-03-next-trade-plan-regime-v4.md",
      "/tmp/pf/reports/2026-04-03-next-trade-generator.md"
    ])
  );
});

test("readOptionalText returns fallback text when optional artifact is missing", async () => {
  const readOptionalText = await loadNamedFunction(
    "./generate_daily_brief.mjs",
    "readOptionalText"
  );

  const result = await readOptionalText("/tmp/this-file-should-not-exist-daily-brief.txt", "fallback");
  assert.equal(result, "fallback");
});
