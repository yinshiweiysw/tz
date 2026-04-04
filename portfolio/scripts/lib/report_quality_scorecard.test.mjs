import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalysisHitRateSummary,
  buildReportQualityScorecard
} from "./report_quality_scorecard.mjs";

function buildMemory() {
  return {
    days: {
      "2026-04-03": {
        morning: {
          trade_date: "2026-04-03",
          session: "morning",
          primary_driver: "中东地缘升级推动油价再定价",
          liquidity_regime: "neutral",
          trade_permission: "allowed",
          next_bias: "prepare"
        },
        noon: {
          trade_date: "2026-04-03",
          session: "noon",
          primary_driver: "中东地缘升级推动油价再定价",
          liquidity_regime: "neutral",
          trade_permission: "allowed",
          next_bias: "prepare"
        },
        close: {
          trade_date: "2026-04-03",
          session: "close",
          primary_driver: "中东地缘升级推动油价再定价",
          liquidity_regime: "neutral",
          trade_permission: "blocked",
          next_bias: "blocked"
        }
      },
      "2026-04-04": {
        morning: {
          trade_date: "2026-04-04",
          session: "morning",
          primary_driver: "中东地缘升级推动油价再定价",
          liquidity_regime: "neutral",
          trade_permission: "blocked",
          next_bias: "blocked"
        },
        noon: {
          trade_date: "2026-04-04",
          session: "noon",
          primary_driver: "美国就业与降息预期再定价",
          liquidity_regime: "risk_off",
          trade_permission: "restricted",
          next_bias: "observe"
        },
        close: {
          trade_date: "2026-04-04",
          session: "close",
          primary_driver: "美国就业与降息预期再定价",
          liquidity_regime: "risk_off",
          trade_permission: "restricted",
          next_bias: "observe"
        }
      }
    }
  };
}

test("buildReportQualityScorecard scores validation, attribution, and next-day bias from session memory", () => {
  const scorecard = buildReportQualityScorecard(buildMemory(), {
    asOfDate: "2026-04-04",
    windowSize: 20
  });

  assert.equal(scorecard.daily_records.length, 2);
  assert.equal(scorecard.daily_records[0].trade_date, "2026-04-03");
  assert.equal(scorecard.daily_records[0].morning_to_noon.status, "hit");
  assert.equal(scorecard.daily_records[0].morning_to_close.status, "hit");
  assert.equal(scorecard.daily_records[0].next_day_bias.status, "hit");
  assert.equal(scorecard.daily_records[1].morning_to_noon.status, "miss");
  assert.equal(scorecard.daily_records[1].next_day_bias.status, "pending");
});

test("buildAnalysisHitRateSummary aggregates settled hit rates and excludes pending chains", () => {
  const scorecard = buildReportQualityScorecard(buildMemory(), {
    asOfDate: "2026-04-04",
    windowSize: 20
  });
  const summary = buildAnalysisHitRateSummary(scorecard);

  assert.equal(summary.morning_to_noon.settled_count, 2);
  assert.equal(summary.morning_to_noon.hit_count, 1);
  assert.equal(summary.morning_to_close.hit_rate_pct, 50);
  assert.equal(summary.next_day_bias.settled_count, 1);
  assert.equal(summary.next_day_bias.hit_rate_pct, 100);
});
