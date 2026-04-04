import test from "node:test";
import assert from "node:assert/strict";

import { classifyResearchSession } from "./research_session.mjs";

function expectPolicyShape(policy) {
  assert.equal(typeof policy, "object");
  assert.equal(typeof policy.acceptPreviousCloseForDomestic, "boolean");
  assert.equal(typeof policy.requiresLiveDomesticSnapshot, "boolean");
  assert.equal(typeof policy.requiresOvernightRiskProxies, "boolean");
  assert.equal(typeof policy.domesticTradeDateMustMatch, "boolean");
}

test("classifyResearchSession returns pre_open before 09:30 Shanghai time", () => {
  const result = classifyResearchSession(new Date("2026-04-02T09:29:59+08:00"));
  assert.equal(result.session, "pre_open");
  assert.equal(result.tradeDate, "2026-04-02");
  assert.equal(result.shanghaiClock, "09:29:59");
  expectPolicyShape(result.policy);
  assert.equal(result.policy.acceptPreviousCloseForDomestic, true);
  assert.equal(result.policy.requiresLiveDomesticSnapshot, false);
  assert.equal(result.policy.requiresOvernightRiskProxies, true);
  assert.equal(result.policy.domesticTradeDateMustMatch, false);
});

test("classifyResearchSession returns intraday during cash trading hours", () => {
  const result = classifyResearchSession(new Date("2026-04-02T10:15:00+08:00"));
  assert.equal(result.session, "intraday");
  assert.equal(result.tradeDate, "2026-04-02");
  assert.equal(result.shanghaiClock, "10:15:00");
  expectPolicyShape(result.policy);
  assert.equal(result.policy.acceptPreviousCloseForDomestic, false);
  assert.equal(result.policy.requiresLiveDomesticSnapshot, true);
  assert.equal(result.policy.requiresOvernightRiskProxies, false);
  assert.equal(result.policy.domesticTradeDateMustMatch, true);
});

test("classifyResearchSession returns post_close after 15:00 but before evening", () => {
  const result = classifyResearchSession(new Date("2026-04-02T16:10:00+08:00"));
  assert.equal(result.session, "post_close");
  assert.equal(result.tradeDate, "2026-04-02");
  assert.equal(result.shanghaiClock, "16:10:00");
  expectPolicyShape(result.policy);
  assert.equal(result.policy.acceptPreviousCloseForDomestic, true);
  assert.equal(result.policy.requiresLiveDomesticSnapshot, false);
  assert.equal(result.policy.requiresOvernightRiskProxies, false);
  assert.equal(result.policy.domesticTradeDateMustMatch, true);
});

test("classifyResearchSession returns overnight at or after 19:00 Shanghai time", () => {
  const result = classifyResearchSession(new Date("2026-04-02T19:00:00+08:00"));
  assert.equal(result.session, "overnight");
  assert.equal(result.tradeDate, "2026-04-02");
  assert.equal(result.shanghaiClock, "19:00:00");
  expectPolicyShape(result.policy);
  assert.equal(result.policy.acceptPreviousCloseForDomestic, true);
  assert.equal(result.policy.requiresLiveDomesticSnapshot, false);
  assert.equal(result.policy.requiresOvernightRiskProxies, true);
  assert.equal(result.policy.domesticTradeDateMustMatch, false);
});

test("classifyResearchSession keeps intraday during lunch break but does not require live domestic snapshot", () => {
  const result = classifyResearchSession(new Date("2026-04-02T12:00:00+08:00"));
  assert.equal(result.session, "intraday");
  assert.equal(result.tradeDate, "2026-04-02");
  assert.equal(result.shanghaiClock, "12:00:00");
  assert.equal(result.policy.requiresLiveDomesticSnapshot, false);
  assert.equal(result.policy.acceptPreviousCloseForDomestic, false);
  assert.equal(result.policy.requiresOvernightRiskProxies, false);
  assert.equal(result.policy.domesticTradeDateMustMatch, true);
});

test("classifyResearchSession returns a non-shared policy object", () => {
  const first = classifyResearchSession(new Date("2026-04-02T10:00:00+08:00"));
  first.policy.requiresLiveDomesticSnapshot = false;

  const second = classifyResearchSession(new Date("2026-04-02T10:00:00+08:00"));
  assert.equal(second.policy.requiresLiveDomesticSnapshot, true);
  assert.notEqual(first.policy, second.policy);
});

test("classifyResearchSession downgrades to market_closed on mainland holiday intraday clock", () => {
  const result = classifyResearchSession(new Date("2026-10-02T10:00:00+08:00"));

  assert.equal(result.session, "market_closed");
  assert.equal(result.tradeDate, "2026-10-02");
  assert.equal(result.shanghaiClock, "10:00:00");
  assert.equal(result.policy.acceptPreviousCloseForDomestic, true);
  assert.equal(result.policy.requiresLiveDomesticSnapshot, false);
  assert.equal(result.policy.domesticTradeDateMustMatch, false);
});
