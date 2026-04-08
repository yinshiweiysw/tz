import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  listDiscoveredPortfolioAccounts,
  defaultPortfolioRoot,
  isValidDiscoverableAccountId,
  resolveAccountId,
  resolvePortfolioRoot,
  portfolioUsersRoot
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

test("listDiscoveredPortfolioAccounts includes account directories even before state anchors are restored", async () => {
  const accountId = "__codex_test_discovery__";
  const accountRoot = path.join(portfolioUsersRoot, accountId);

  await mkdir(path.join(accountRoot, "reports"), { recursive: true });

  try {
    const accounts = await listDiscoveredPortfolioAccounts({ includeMain: false });
    assert.equal(accounts.some((item) => item.id === accountId), true);
  } finally {
    await rm(accountRoot, { recursive: true, force: true });
  }
});
