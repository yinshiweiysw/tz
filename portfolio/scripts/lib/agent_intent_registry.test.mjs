import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentIntentRegistry } from "./agent_intent_registry.mjs";

test("buildAgentIntentRegistry exposes every supported top-level user intent", () => {
  const registry = buildAgentIntentRegistry("/tmp/portfolio");

  assert.deepEqual(Object.keys(registry), [
    "分析当前行情",
    "今天该不该交易",
    "给我执行清单",
    "我刚买了/卖了/转换了",
    "看看我现在持仓",
    "打开基金面板",
    "基金面板为什么不对",
    "刷新市场数据",
    "做回测",
    "收盘后生成日报"
  ]);
  assert.equal(registry["分析当前行情"].requiresExternalNewsRefresh, true);
  assert.equal(registry["分析当前行情"].minimumNewsSources, 2);
});

test("agent intent registry requires runtime context and strategy decision contract for all investment intents", () => {
  const registry = buildAgentIntentRegistry("/tmp/portfolio");
  for (const key of ["分析当前行情", "今天该不该交易", "给我执行清单", "看看我现在持仓"]) {
    const reads = registry[key].requiredReads;
    assert.equal(reads.includes("data/agent_runtime_context.json"), true);
    assert.equal(reads.includes("data/strategy_decision_contract.json"), true);
  }
});
