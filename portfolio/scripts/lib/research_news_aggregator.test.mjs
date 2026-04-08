import test from "node:test";
import assert from "node:assert/strict";

import { aggregateResearchNews, extractHtmlAnchorStories } from "./research_news_aggregator.mjs";

test("aggregateResearchNews returns multi_source_confirmed when multiple trusted sources provide fresh stories", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["marketwatch_top", "wallstreetcn_global", "cls_telegraph"],
    now: new Date("2026-04-08T10:00:00+08:00"),
    sourceLoaders: {
      marketwatch_top: async () => [
        {
          title: "Trump says Iran ceasefire talks continue",
          summary: "US markets weigh ceasefire details.",
          publishedAt: "2026-04-08T09:20:00+08:00"
        }
      ],
      wallstreetcn_global: async () => [
        {
          title: "中东停火预期升温",
          summary: "风险资产延续反弹，黄金同步走强。",
          publishedAt: "2026-04-08T09:25:00+08:00"
        }
      ],
      cls_telegraph: async () => [
        {
          title: "特朗普称两周内推动停火",
          content: "财联社电报。",
          publishedAt: "2026-04-08T09:10:00+08:00"
        }
      ]
    }
  });

  assert.equal(result.analysisMode, "multi_source_confirmed");
  assert.equal(result.stories.length, 3);
  assert.equal(result.topHeadlines.length >= 2, true);
  assert.equal(result.sourceHealth.every((item) => item.status === "ok"), true);
});

test("aggregateResearchNews marks single telegraph source as degraded", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["cls_telegraph"],
    now: new Date("2026-04-08T10:00:00+08:00"),
    sourceLoaders: {
      cls_telegraph: async () => [
        {
          title: "市场继续讨论停火",
          content: "单一电报源。",
          publishedAt: "2026-04-08T09:10:00+08:00"
        }
      ]
    }
  });

  assert.equal(result.analysisMode, "single_source_degraded");
  assert.match(result.degradedReason ?? "", /single_source/i);
});

test("extractHtmlAnchorStories parses AP/Caixin/Yicai-style headline links", () => {
  const html = `
    <a href="https://apnews.com/article/example-1">Ceasefire hopes lift global stocks as oil tumbles</a>
    <a href="https://finance.caixin.com/2026-04-08/102431692.html">全球市场交易“美伊停战”：黄金重燃、美元熄火</a>
    <a href="/brief/103122904.html">MSCI亚太指数上涨5% | MSCI亚太指数涨幅扩大至5%</a>
  `;

  const apStories = extractHtmlAnchorStories(html, {
    baseUrl: "https://apnews.com",
    linkPattern: /apnews\.com\/article\//i
  });
  const caixinStories = extractHtmlAnchorStories(html, {
    baseUrl: "https://www.caixin.com",
    linkPattern: /caixin\.com\/20\d{2}-\d{2}-\d{2}\//i
  });
  const yicaiStories = extractHtmlAnchorStories(html, {
    baseUrl: "https://www.yicai.com",
    linkPattern: /\/brief\/\d+\.html/i
  });

  assert.equal(apStories[0]?.title.includes("Ceasefire hopes lift global stocks"), true);
  assert.equal(caixinStories[0]?.title.includes("全球市场交易"), true);
  assert.equal(yicaiStories[0]?.title.includes("MSCI亚太指数上涨5%"), true);
});

test("aggregateResearchNews ranks market-moving headlines ahead of generic commentary", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["caixin_macro"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      caixin_macro: async () => [
        {
          title: "银行年报的经营线索",
          summary: "偏评论类内容。",
          publishedAt: "2026-04-08T09:00:00+08:00"
        },
        {
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          summary: "停火、黄金、美元、油价成为当日主驱动。",
          publishedAt: "2026-04-08T08:50:00+08:00"
        }
      ]
    }
  });

  assert.equal(result.topHeadlines[0]?.title.includes("美伊停战"), true);
});

test("aggregateResearchNews topHeadlines preserves cross-source representation before repeating one source", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["caixin_macro", "ap_business", "yicai_macro"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      caixin_macro: async () => [
        {
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          summary: "停火、黄金、美元、油价成为当日主驱动。",
          publishedAt: "2026-04-08T13:35:00+08:00"
        },
        {
          title: "美伊同意停战两周 国际油价一度暴跌17.5%",
          summary: "油价暴跌驱动全球风险资产反弹。",
          publishedAt: "2026-04-08T13:30:00+08:00"
        },
        {
          title: "特朗普称美伊同意双向停火两周 伊朗确定谈判将展开",
          summary: "谈判继续推进。",
          publishedAt: "2026-04-08T13:20:00+08:00"
        }
      ],
      ap_business: async () => [
        {
          title: "Ceasefire hopes lift global stocks as oil tumbles",
          summary: "Asia equities surge while crude slumps.",
          publishedAt: "2026-04-08T13:25:00+08:00"
        }
      ],
      yicai_macro: async () => [
        {
          title: "MSCI亚太指数涨幅扩大至5%",
          summary: "日韩股市同步走高。",
          publishedAt: "2026-04-08T13:15:00+08:00"
        }
      ]
    }
  });

  const leadingSources = result.topHeadlines.slice(0, 3).map((item) => item.sourceId);
  assert.equal(new Set(leadingSources).size, 3);
  assert.equal(leadingSources.includes("caixin_macro"), true);
  assert.equal(leadingSources.includes("ap_business"), true);
  assert.equal(leadingSources.includes("yicai_macro"), true);
});

test("aggregateResearchNews falls back to telegraph content when title is missing", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["cls_telegraph"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      cls_telegraph: async () => [
        {
          title: "",
          content: "特朗普称美国与伊朗同意停战两周，国际油价大跌，全球风险资产反弹。",
          publishedAt: "2026-04-08T13:30:00+08:00"
        }
      ]
    }
  });

  assert.equal(
    result.topHeadlines[0]?.title,
    "特朗普称美国与伊朗同意停战两周，国际油价大跌，全球风险资产反弹。"
  );
});

test("aggregateResearchNews excludes stale old headlines from representative top headlines when fresh coverage exists", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["wsj_world", "marketwatch_top", "caixin_macro"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      wsj_world: async () => [
        {
          title: "Stocks Sink in Broad AI Rout Sparked by China's DeepSeek",
          summary: "Very old article.",
          publishedAt: "2025-01-27T19:26:00.000Z"
        }
      ],
      marketwatch_top: async () => [
        {
          title: "Stock futures surge, oil prices slide as Trump announces two-week cease-fire with Iran",
          summary: "Fresh global risk-on story.",
          publishedAt: "2026-04-08T13:15:00+08:00"
        }
      ],
      caixin_macro: async () => [
        {
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          summary: "停火、黄金、美元、油价成为当日主驱动。",
          publishedAt: "2026-04-08T13:10:00+08:00"
        }
      ]
    }
  });

  assert.equal(
    result.topHeadlines.some((item) => item.title.includes("DeepSeek")),
    false
  );
});

test("aggregateResearchNews omits non-macro company headlines from top headlines when market-moving coverage exists", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["marketwatch_top", "cnbc_top", "caixin_macro"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      marketwatch_top: async () => [
        {
          title: "Stock futures surge, oil prices slide as Trump announces two-week cease-fire with Iran",
          summary: "Fresh global risk-on story.",
          publishedAt: "2026-04-08T13:15:00+08:00"
        }
      ],
      cnbc_top: async () => [
        {
          title: "Levi Strauss revenue jumps again, with DTC making up more than half of sales for the first time",
          summary: "Company-specific earnings story.",
          publishedAt: "2026-04-08T13:18:00+08:00"
        }
      ],
      caixin_macro: async () => [
        {
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          summary: "停火、黄金、美元、油价成为当日主驱动。",
          publishedAt: "2026-04-08T13:10:00+08:00"
        }
      ]
    }
  });

  assert.equal(
    result.topHeadlines.some((item) => item.title.includes("Levi Strauss")),
    false
  );
});

test("aggregateResearchNews does not force tier3 telegraph into representative headlines ahead of tier1 or tier2 follow-ups", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["marketwatch_top", "caixin_macro", "cls_telegraph"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      marketwatch_top: async () => [
        {
          title: "Stock futures surge, oil prices slide as Trump announces two-week cease-fire with Iran",
          summary: "Fresh global risk-on story.",
          publishedAt: "2026-04-08T13:15:00+08:00"
        }
      ],
      caixin_macro: async () => [
        {
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          summary: "停火、黄金、美元、油价成为当日主驱动。",
          publishedAt: "2026-04-08T13:10:00+08:00"
        },
        {
          title: "美伊同意停战两周 国际油价一度暴跌17.5%",
          summary: "油价暴跌驱动全球风险资产反弹。",
          publishedAt: "2026-04-08T13:05:00+08:00"
        }
      ],
      cls_telegraph: async () => [
        {
          title: "财联社4月8日电，迪拜股市应声上涨，涨幅高达6.8%。",
          content: "停火后区域股市反弹。",
          publishedAt: "2026-04-08T13:20:00+08:00"
        }
      ]
    }
  });

  assert.deepEqual(
    result.topHeadlines.slice(0, 3).map((item) => item.sourceId),
    ["marketwatch_top", "caixin_macro", "caixin_macro"]
  );
});

test("aggregateResearchNews annotates market tags and suppresses generic AP social headlines when macro coverage exists", async () => {
  const result = await aggregateResearchNews({
    sourceIds: ["marketwatch_top", "caixin_macro", "ap_business"],
    now: new Date("2026-04-08T13:40:00+08:00"),
    sourceLoaders: {
      marketwatch_top: async () => [
        {
          title: "Stock futures surge, oil prices slide as Trump announces two-week cease-fire with Iran",
          summary: "Gold, oil and Asia equities all reprice after the cease-fire headline.",
          publishedAt: "2026-04-08T13:15:00+08:00"
        }
      ],
      caixin_macro: async () => [
        {
          title: "全球市场交易“美伊停战”：黄金重燃、美元熄火",
          summary: "停火、黄金、美元、油价成为当日主驱动，日韩股市同步走强。",
          publishedAt: "2026-04-08T13:10:00+08:00"
        }
      ],
      ap_business: async () => [
        {
          title: "Wife of US soldier released from federal immigration detention",
          summary: "A non-market social story.",
          publishedAt: "2026-04-08T13:20:00+08:00"
        }
      ]
    }
  });

  assert.equal(
    result.topHeadlines.some((item) => item.title.includes("immigration detention")),
    false
  );
  assert.equal(result.topHeadlines[0]?.marketTags.includes("geopolitics"), true);
  assert.equal(result.topHeadlines[0]?.portfolioRelevanceScore > 0, true);
  assert.equal(result.topHeadlines[0]?.sourceConfirmationCount >= 2, true);
  assert.equal(result.topHeadlines[0]?.crossAssetImpact.includes("gold"), true);
});
