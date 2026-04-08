import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchEventDriver } from "./research_event_driver.mjs";

const marketSnapshotTemplate = {
  global_indices: [],
  commodities: [],
  rates_fx: []
};

test("promotes confirmed headline to active driver when cross-asset moves align", () => {
  const telegraphs = [
    {
      title: "特朗普称将扩大关税范围",
      content: "市场重定价全球风险资产。",
      published_at: "2026-04-02T08:05:00+08:00",
      source: "telegraph"
    }
  ];
  const marketSnapshot = {
    global_indices: [{ label: "纳斯达克100期货", change_pct: -1.9 }],
    commodities: [{ label: "伦敦金", change_pct: 1.3 }, { label: "WTI原油", change_pct: 2.1 }],
    rates_fx: [{ label: "美元指数", change_pct: 0.6 }]
  };

  const result = buildResearchEventDriver({ telegraphs, marketSnapshot });

  assert.equal(result.status, "active_market_driver");
  assert.ok(result.primary_driver.includes("关税"));
  assert.equal(result.driver_scope, "cross_asset");
  assert.ok(result.evidence.length >= 2);
  assert.equal(result.driver_type, "macro_policy");
  assert.equal(typeof result.expected_consensus, "string");
  assert.equal(typeof result.actual_market_reaction, "object");
  assert.equal(typeof result.expectation_gap, "string");
  assert.equal(typeof result.crowding_flag, "string");
});

test("degrades unclear telegraph to watch_only when market confirmation is missing", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "小作文传言刺激局部题材",
        content: "未经证实",
        published_at: "2026-04-02T09:15:00+08:00",
        source: "telegraph"
      }
    ],
    marketSnapshot: marketSnapshotTemplate
  });

  assert.equal(result.status, "watch_only");
  assert.equal(result.priced_in_assessment, "unclear");
});

test("relabels repeated memorized narratives as priced_in_noise when evidence is stale", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "市场继续讨论昨日已落地的降息决定",
        content: "增量信息有限",
        published_at: "2026-04-02T10:00:00+08:00",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "标普500期货", change_pct: 0.1 }],
      commodities: [{ label: "伦敦金", change_pct: 0.0 }],
      rates_fx: [{ label: "美元指数", change_pct: -0.1 }]
    }
  });

  assert.equal(result.status, "priced_in_noise");
});

test("uses persisted pct_change rows and preserves the telegraph timestamp in evidence", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "中东局势再度升温",
        content: "油金联动上行。",
        published_at: "2026-04-02T11:30:00.000Z",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100期货", pct_change: -0.9 }],
      commodities: [{ label: "COMEX黄金", pct_change: 1.1 }, { label: "WTI原油", pct_change: 2.3 }],
      rates_fx: [{ label: "美元指数", pct_change: 0.6 }]
    }
  });

  assert.equal(result.status, "active_market_driver");
  assert.equal(result.evidence[0].timestamp, "2026-04-02T11:30:00.000Z");
});

test("clusters multiple geopolitics and oil headlines into one thematic driver label", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "伊朗局势升级",
        content: "中东风险抬升。",
        published_at: "2026-04-02T12:00:00.000Z",
        source: "telegraph"
      },
      {
        title: "WTI原油期货快速拉升",
        content: "油价受地缘风险驱动上行。",
        published_at: "2026-04-02T12:03:00.000Z",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100期货", pct_change: -1.2 }],
      commodities: [{ label: "COMEX黄金", pct_change: 1.1 }, { label: "WTI原油", pct_change: 3.4 }],
      rates_fx: [{ label: "美元指数", pct_change: 0.6 }]
    }
  });

  assert.equal(result.status, "active_market_driver");
  assert.match(result.primary_driver ?? "", /中东/);
  assert.match(result.primary_driver ?? "", /油/);
  assert.equal(result.evidence.length >= 3, true);
});

test("downgrades repeated easing headlines to priced_in_noise when cross-asset confirmation is weak", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "市场继续讨论昨日已落地的降息决定",
        content: "增量信息有限。",
        published_at: "2026-04-02T09:00:00.000Z",
        source: "telegraph"
      },
      {
        title: "降息预期延续发酵",
        content: "但主要资产波动不大。",
        published_at: "2026-04-02T09:03:00.000Z",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "标普500期货", pct_change: 0.1 }],
      commodities: [{ label: "COMEX黄金", pct_change: 0.0 }],
      rates_fx: [{ label: "美元指数", pct_change: -0.1 }]
    }
  });

  assert.equal(result.status, "priced_in_noise");
  assert.equal(result.priced_in_assessment, "fully_priced_in");
});

test("ignores previous close reference rows when counting cross-asset confirmations", () => {
  const result = buildResearchEventDriver({
    telegraphs: [
      {
        title: "特朗普称将扩大关税范围",
        content: "市场重定价全球风险资产。",
        published_at: "2026-04-03T08:05:00+08:00",
        source: "telegraph"
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100期货", pct_change: -0.9, quote_usage: "live_today" }],
      commodities: [
        { label: "恒生指数", pct_change: -0.7, quote_usage: "previous_close_reference" },
        { label: "恒生科技", pct_change: -1.63, quote_usage: "previous_close_reference" }
      ],
      rates_fx: []
    }
  });

  assert.equal(result.status, "watch_only");
  assert.deepEqual(
    result.evidence.map((item) => item.headline),
    ["关税与贸易摩擦冲击全球风险偏好", "纳斯达克100期货"]
  );
});

test("prefers corroborated higher-tier stories over lower-tier telegraph noise", () => {
  const result = buildResearchEventDriver({
    stories: [
      {
        title: "Reuters: Trump says Iran ceasefire talks continue for two weeks",
        summary: "Ceasefire timeline remains the dominant macro headline.",
        published_at: "2026-04-08T09:20:00+08:00",
        source: "Reuters",
        sourceId: "reuters_world",
        tier: 1
      },
      {
        title: "WSJ: Ceasefire negotiations reshape risk appetite",
        summary: "Cross-asset risk rebound continues.",
        published_at: "2026-04-08T09:18:00+08:00",
        source: "WSJ",
        sourceId: "wsj_world",
        tier: 1
      },
      {
        title: "盘面直播：题材快速拉升",
        content: "低质量噪音。",
        published_at: "2026-04-08T09:19:00+08:00",
        source: "telegraph",
        sourceId: "cls_telegraph",
        tier: 3
      }
    ],
    marketSnapshot: {
      global_indices: [{ label: "纳斯达克100期货", pct_change: 1.2 }],
      commodities: [{ label: "COMEX黄金", pct_change: 0.6 }],
      rates_fx: [{ label: "美元指数", pct_change: -0.8 }]
    }
  });

  assert.equal(result.status, "active_market_driver");
  assert.match(result.primary_driver ?? "", /停火|关税|贸易|中东|风险偏好/u);
  assert.equal(result.evidence.some((item) => item.source === "Reuters"), true);
});
