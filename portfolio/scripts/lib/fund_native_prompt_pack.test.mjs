import assert from "node:assert/strict";
import test from "node:test";
import { buildFundNativeMessages } from "./fund_native_prompt_pack.mjs";

const context = {
  fundCode: "019736",
  fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
  fundTemplate: "qdii_index_fund",
  promptContext: "基金：宝盈纳斯达克100\n类型：QDII/指数\n代理资产：QQQ",
  guardrails: { reviewOnly: true }
};

test("buildFundNativeMessages contains original TradingAgents role topology with fund semantics", () => {
  const messages = buildFundNativeMessages({ context });
  const joined = messages.map((item) => item.content).join("\n");

  assert.equal(messages[0].role, "system");
  assert.ok(joined.includes("Fund Style Analyst"));
  assert.ok(joined.includes("Theme Sentiment Analyst"));
  assert.ok(joined.includes("Fund Profile Analyst"));
  assert.ok(joined.includes("Keep/Add Advocate"));
  assert.ok(joined.includes("Reduce/Replace Advocate"));
  assert.ok(joined.includes("Fund Allocation Reviewer"));
  assert.ok(joined.includes("Fund Committee Decision"));
  assert.ok(joined.includes("申购"));
  assert.ok(joined.includes("赎回"));
  assert.ok(joined.includes("review_only"));
  assert.ok(joined.includes("JSON"));
});
