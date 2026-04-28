import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFundNativeAnalysis,
  sanitizeFundExecutionLanguage
} from "./fund_native_output.mjs";

const context = {
  fundCode: "019736",
  fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
  fundTemplate: "qdii_index_fund"
};

test("sanitizeFundExecutionLanguage rewrites stock intraday wording", () => {
  assert.equal(sanitizeFundExecutionLanguage("建议开盘市价卖出并设置止损线"), "建议尾盘前复核赎回并设置复核条件");
  assert.equal(sanitizeFundExecutionLanguage("跌破支撑后立即清仓"), "跌破支撑后进入清仓赎回复核");
});

test("normalizeFundNativeAnalysis maps provider JSON into stable fund contract", () => {
  const result = normalizeFundNativeAnalysis({
    parsed: {
      verdict: "SELL",
      riskLight: "yellow",
      confidence: 0.82,
      oneLine: "建议开盘市价卖出并设置止损线",
      styleEnvironment: { label: "中性偏弱", reason: "纳指高波" },
      fundQuality: { label: "可用", reason: "指数工具清晰" },
      lookThrough: { label: "暴露清晰", reason: "重仓美股科技" },
      peerRole: { label: "代表候选", reason: "同类中资料较完整" },
      riskReview: { riskLight: "yellow", notes: ["QDII 滞后"] },
      uncertainties: ["前收参考"],
      rawEvidence: "long markdown"
    },
    context,
    provider: "glm"
  });

  assert.equal(result.fundCode, "019736");
  assert.equal(result.mode, "fund_native");
  assert.equal(result.verdict, "partial_redeem_review");
  assert.equal(result.tradeDirection, "sell");
  assert.equal(result.execution.executionIntent, "review_only");
  assert.equal(result.execution.fundExecutionStyle, "end_of_day_t1_review");
  assert.ok(result.oneLine.includes("尾盘前复核赎回"));
  assert.ok(!result.oneLine.includes("市价"));
  assert.equal(result.riskLight, "yellow");
  assert.equal(result.confidence, 0.82);
});
