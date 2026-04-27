import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentIntentRegistry } from "./agent_intent_registry.mjs";

test("buildAgentIntentRegistry exposes the simplified fund routes plus TradingAgents trading aliases", () => {
  const registry = buildAgentIntentRegistry("/tmp/portfolio");

  assert.deepEqual(Object.keys(registry), [
    "打开基金面板",
    "刷新基金状态",
    "记录基金交易",
    "生成交易建议",
    "今天该不该交易",
    "给我执行清单",
    "看看风险灯",
    "查看主链决策",
    "打开市场专题"
  ]);
  assert.equal(registry["打开基金面板"].routePath, "/");
  assert.equal(registry["打开市场专题"].routePath, "/market");
  assert.equal(registry["生成交易建议"].primaryScript.endsWith("run_tradingagents_decision_cycle.mjs"), true);
  assert.equal(registry["今天该不该交易"].routePath, "/advice");
  assert.equal(registry["给我执行清单"].routePath, "/advice");
});

test("simplified agent intent registry keeps fund truth local and routes trading aliases through decision cycle", () => {
  const registry = buildAgentIntentRegistry("/tmp/portfolio");

  assert.equal(registry["生成交易建议"].requiredReads.includes("config/tradingagents_bridge.json"), true);
  assert.equal(registry["生成交易建议"].requiredReads.includes("data/trading_decision_snapshot.json"), true);
  assert.equal(registry["生成交易建议"].forbiddenBehaviors.includes("不要写 execution_ledger.json"), true);
  assert.equal(registry["看看风险灯"].requiredReads.includes("data/trading_decision_snapshot.json"), true);
  assert.equal(registry["刷新基金状态"].requiredReads.includes("data/nightly_confirmed_nav_status.json"), true);
});
