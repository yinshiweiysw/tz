import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResearchNewsRegistry,
  getDefaultResearchNewsSourceIds
} from "./research_news_registry.mjs";

test("buildResearchNewsRegistry orders source trust tiers from tier1 to tier3", () => {
  const registry = buildResearchNewsRegistry();
  const reuters = registry.find((item) => item.sourceId === "reuters_world");
  const wallstreetcn = registry.find((item) => item.sourceId === "wallstreetcn_global");
  const telegraph = registry.find((item) => item.sourceId === "cls_telegraph");

  assert.equal(reuters?.tier, 1);
  assert.equal(wallstreetcn?.tier, 2);
  assert.equal(telegraph?.tier, 3);
});

test("getDefaultResearchNewsSourceIds excludes browser-only sources from direct runtime fetch list", () => {
  const sourceIds = getDefaultResearchNewsSourceIds();

  assert.equal(sourceIds.includes("cls_telegraph"), true);
  assert.equal(sourceIds.includes("ap_business"), true);
  assert.equal(sourceIds.includes("caixin_macro"), true);
  assert.equal(sourceIds.includes("yicai_macro"), true);
  assert.equal(sourceIds.includes("wallstreetcn_global"), true);
  assert.equal(sourceIds.includes("marketwatch_top"), true);
  assert.equal(sourceIds.includes("cnbc_top"), true);
  assert.equal(sourceIds.includes("wsj_markets"), true);
  assert.equal(sourceIds.includes("reuters_world"), false);
});
