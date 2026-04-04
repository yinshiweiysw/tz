import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultPortfolioRoot,
  isValidDiscoverableAccountId,
  resolveAccountId,
  resolvePortfolioRoot
} from "./account_root.mjs";

test("resolveAccountId falls back to main when boolean user flag leaks in", () => {
  assert.equal(resolveAccountId({ user: true }), "main");
});

test("resolveAccountId falls back to main for reserved invalid string ids", () => {
  assert.equal(resolveAccountId({ user: "true" }), "main");
  assert.equal(resolveAccountId({ user: "false" }), "main");
  assert.equal(resolveAccountId({ user: "undefined" }), "main");
});

test("resolvePortfolioRoot falls back to default root for invalid account ids", () => {
  assert.equal(resolvePortfolioRoot({ user: true }), defaultPortfolioRoot);
  assert.equal(resolvePortfolioRoot({ user: "true" }), defaultPortfolioRoot);
});

test("isValidDiscoverableAccountId rejects boolean-like garbage and accepts normal ids", () => {
  assert.equal(isValidDiscoverableAccountId("true"), false);
  assert.equal(isValidDiscoverableAccountId("false"), false);
  assert.equal(isValidDiscoverableAccountId("undefined"), false);
  assert.equal(isValidDiscoverableAccountId("wenge"), true);
  assert.equal(isValidDiscoverableAccountId("main"), true);
});
