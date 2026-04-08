import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dispatch protocol references runtime context and strategy contract as mandatory entry files", async () => {
  const protocol = await readFile("/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md", "utf8");
  assert.match(protocol, /agent_runtime_context\.json/);
  assert.match(protocol, /strategy_decision_contract\.json/);
  assert.match(protocol, /所有投资类 agent 在输出建议前必须读取/);
});
