import test from "node:test";
import assert from "node:assert/strict";

import { classifyResearchSession } from "./research_session.mjs";
import { buildMarketPulseSessionContext } from "./report_session_context.mjs";

test("buildMarketPulseSessionContext anchors noon reports to an intraday Shanghai session", () => {
  const context = buildMarketPulseSessionContext({
    session: "noon",
    dateText: "2026-04-03"
  });
  const sessionInfo = classifyResearchSession(context.referenceNow);

  assert.equal(sessionInfo.session, "intraday");
  assert.equal(sessionInfo.tradeDate, "2026-04-03");
  assert.equal(context.actionLabel, "午间观察");
});

test("buildMarketPulseSessionContext uses next-trading-day language for close reports", () => {
  const context = buildMarketPulseSessionContext({
    session: "close",
    dateText: "2026-04-03"
  });

  assert.equal(context.actionLabel, "下一交易日判断");
  assert.match(context.hint, /下一交易日/);
});
