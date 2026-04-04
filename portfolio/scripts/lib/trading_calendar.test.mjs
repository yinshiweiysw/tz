import test from "node:test";
import assert from "node:assert/strict";

import { isTradingHoliday, nextTradingDay, secondTradingDay } from "./trading_calendar.mjs";

test("nextTradingDay skips weekends", () => {
  assert.equal(nextTradingDay("2026-04-10"), "2026-04-13");
});

test("nextTradingDay skips configured exchange holidays", () => {
  assert.equal(nextTradingDay("2026-04-03"), "2026-04-07");
});

test("secondTradingDay skips holiday clusters", () => {
  assert.equal(secondTradingDay("2026-04-03"), "2026-04-08");
});

test("isTradingHoliday reads long holiday windows from external calendar source", () => {
  assert.equal(isTradingHoliday("2026-10-05"), true);
});

test("nextTradingDay skips national-day holiday window from external calendar source", () => {
  assert.equal(nextTradingDay("2026-10-01"), "2026-10-08");
});
