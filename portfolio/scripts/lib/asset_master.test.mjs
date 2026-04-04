import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThemeConfigMap,
  resolveThemeKey,
  resolveThemeLabel
} from "./asset_master.mjs";

function buildAssetMasterFixture() {
  return {
    fallback_theme_key: "UNCLASSIFIED",
    themes: {
      CN_CORE: { label: "A股核心", bucket_keys: ["A_CORE"] },
      HK_TECH: { label: "港股科技", bucket_keys: ["TACTICAL"] },
      GOLD: { label: "黄金", bucket_keys: ["HEDGE"] },
      UNCLASSIFIED: { label: "未分类主题", bucket_keys: [] }
    },
    theme_mapping_rules: [
      {
        theme_key: "CN_CORE",
        bucket_keys: ["A_CORE"],
        category_equals: ["A股宽基", "A股主动"],
        name_patterns: ["沪深300", "量化增强"]
      },
      {
        theme_key: "HK_TECH",
        bucket_keys: ["TACTICAL"],
        category_equals: ["港股互联网/QDII", "港股科技/QDII"],
        name_patterns: ["恒生科技", "恒生互联网", "港股互联网"]
      },
      {
        theme_key: "GOLD",
        bucket_keys: ["HEDGE"],
        category_equals: ["黄金"],
        name_patterns: ["黄金"]
      }
    ]
  };
}

test("buildThemeConfigMap returns normalized theme entries", () => {
  const configMap = buildThemeConfigMap(buildAssetMasterFixture());

  assert.equal(configMap.CN_CORE.label, "A股核心");
  assert.deepEqual(configMap.HK_TECH.bucketKeys, ["TACTICAL"]);
});

test("resolveThemeKey respects bucket guard and theme rules", () => {
  const themeKey = resolveThemeKey(buildAssetMasterFixture(), {
    bucket: "TACTICAL",
    category: "港股科技/QDII",
    name: "恒生科技ETF联接(QDII)C"
  });

  assert.equal(themeKey, "HK_TECH");
});

test("resolveThemeKey falls back when no theme rule matches", () => {
  const themeKey = resolveThemeKey(buildAssetMasterFixture(), {
    bucket: "TACTICAL",
    category: "未知分类",
    name: "未知资产"
  });

  assert.equal(themeKey, "UNCLASSIFIED");
  assert.equal(resolveThemeLabel(buildAssetMasterFixture(), themeKey), "未分类主题");
});
