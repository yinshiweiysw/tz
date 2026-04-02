import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadOpportunityMaster,
  normalizeOpportunityTheme
} from "./opportunity_master.mjs";
import { getSpeculativeSleeveConfig, resolveBucketKey } from "./asset_master.mjs";

test("normalizeOpportunityTheme keeps required research fields", () => {
  const theme = normalizeOpportunityTheme({
    theme_name: " 黄金 ",
    market: "GLOBAL",
    driver: "地缘+真实利率",
    tradable_proxies: [
      { symbol: "022502", name: "国泰黄金ETF联接E", account_scope: ["main"] }
    ],
    action_bias_default: "研究观察"
  });

  assert.equal(theme.theme_name, "黄金");
  assert.equal(theme.tradable_proxies[0].symbol, "022502");
  assert.equal(theme.action_bias_default, "研究观察");
});

test("loadOpportunityMaster reads theme_order and normalizes each theme", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "opportunity-master-"));
  const configPath = path.join(tempDir, "opportunity_master.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        theme_order: ["黄金", "A股核心", "港股互联网"],
        themes: [
          {
            theme_name: " 黄金 ",
            market: "GLOBAL",
            driver: "地缘+真实利率",
            tradable_proxies: [
              {
                symbol: "022502",
                name: "国泰黄金ETF联接E",
                account_scope: ["main"]
              }
            ]
          },
          {
            theme_name: "A股核心",
            market: "CN",
            driver: "估值与盈利周期",
            action_bias_default: "体系外动作",
            tradable_proxies: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const loaded = await loadOpportunityMaster(configPath);
  assert.deepEqual(loaded.theme_order, ["黄金", "A股核心"]);
  assert.equal(loaded.themes[0].theme_name, "黄金");
  assert.equal(loaded.themes[1].action_bias_default, "研究观察");
});

test("getSpeculativeSleeveConfig clamps sleeve max at 15%", () => {
  const sleeve = getSpeculativeSleeveConfig({
    speculative_sleeve: {
      max_pct: 0.18,
      default_exit: "反弹分批止盈",
      allowed_trigger_sources: ["valuation_momentum_exhaustion"]
    }
  });

  assert.equal(sleeve.maxPct, 0.15);
  assert.equal(sleeve.defaultExit, "反弹分批止盈");
  assert.deepEqual(sleeve.allowedTriggerSources, ["valuation_momentum_exhaustion"]);
});

test("resolveBucketKey falls back to uppercase TACTICAL when fallback key is missing", () => {
  const bucketKey = resolveBucketKey(
    {
      bucket_mapping_rules: []
    },
    {
      category: "未知分类",
      name: "未知标的"
    }
  );

  assert.equal(bucketKey, "TACTICAL");
});
