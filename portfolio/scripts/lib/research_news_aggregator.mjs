import { getMarketTelegraph } from "../../../market-mcp/src/providers/stock.js";
import {
  buildResearchNewsRegistry,
  getDefaultResearchNewsSourceIds,
  getResearchNewsSource
} from "./research_news_registry.mjs";

function normalizeTimestamp(value) {
  const parsed = new Date(value ?? "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeStory(sourceMeta, item = {}) {
  const summary = String(item?.summary ?? item?.content ?? item?.description ?? "").trim();
  const rawTitle = String(item?.title ?? item?.headline ?? "").trim();
  const title = rawTitle || summary;
  if (!title && !summary) {
    return null;
  }

  return {
    title,
    summary,
    content: summary,
    source: sourceMeta.source,
    sourceId: sourceMeta.sourceId,
    tier: sourceMeta.tier,
    defaultTrustScore: sourceMeta.defaultTrustScore ?? null,
    region: sourceMeta.region ?? null,
    marketScope: sourceMeta.marketScope ?? null,
    url: String(item?.url ?? item?.link ?? "").trim() || null,
    published_at: normalizeTimestamp(item?.publishedAt ?? item?.published_at ?? item?.pubDate ?? item?.date)
  };
}

function parseRssItems(xml = "") {
  const matches = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return matches.map((match) => {
    const chunk = match[1];
    const get = (tag) => chunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? "";
    const decode = (value) =>
      String(value)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");

    return {
      title: decode(get("title")).trim(),
      description: decode(get("description")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      link: decode(get("link")).trim(),
      pubDate: decode(get("pubDate")).trim()
    };
  });
}

function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value = "") {
  return decodeHtmlEntities(String(value).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function inferPublishedAtFromUrl(url = "") {
  const normalized = String(url ?? "").trim();
  const datedMatch = normalized.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (datedMatch) {
    return `${datedMatch[1]}-${datedMatch[2]}-${datedMatch[3]}T00:00:00.000Z`;
  }
  return null;
}

export function extractHtmlAnchorStories(
  html = "",
  {
    baseUrl = "",
    linkPattern = /.*/i,
    maxItems = 12
  } = {}
) {
  const anchors = [...String(html).matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const stories = [];
  const seen = new Set();

  for (const match of anchors) {
    const href = String(match[1] ?? "").trim();
    const title = stripHtml(match[2] ?? "");
    if (!href || !title || title.length < 8) {
      continue;
    }
    const url = href.startsWith("http") ? href : new URL(href, baseUrl).toString();
    if (!linkPattern.test(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    stories.push({
      title: title.split("|")[0].trim(),
      summary: title,
      url,
      publishedAt: inferPublishedAtFromUrl(url)
    });
    if (stories.length >= maxItems) {
      break;
    }
  }

  return stories;
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  return await response.text();
}

async function loadWsjWorld() {
  const text = await fetchText("https://feeds.a.dj.com/rss/RSSWorldNews.xml");
  return parseRssItems(text);
}

async function loadReutersWorld() {
  const text = await fetchText("https://feeds.reuters.com/reuters/businessNews");
  return parseRssItems(text);
}

async function loadWsjMarkets() {
  const text = await fetchText("https://feeds.a.dj.com/rss/RSSMarketsMain.xml");
  return parseRssItems(text);
}

async function loadMarketWatchTop() {
  const text = await fetchText("https://feeds.content.dowjones.io/public/rss/mw_topstories");
  return parseRssItems(text);
}

async function loadCnbcTop() {
  const text = await fetchText("https://www.cnbc.com/id/10001147/device/rss/rss.html");
  return parseRssItems(text);
}

async function loadWallstreetcnGlobal() {
  const response = await fetch("https://api-one-wscn.awtmt.com/apiv1/content/articles?limit=12&channel=global-market", {
    redirect: "follow",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.data?.items)
    ? payload.data.items.map((item) => ({
        title: item?.title ?? "",
        summary: item?.content_short ?? item?.content_text ?? "",
        publishedAt: item?.display_time ?? item?.ctime ? new Date(Number(item.ctime) * 1000).toISOString() : null,
        url: item?.uri ? `https://wallstreetcn.com/articles/${item.uri}` : null
      }))
    : [];
}

async function loadApBusiness() {
  const text = await fetchText("https://apnews.com/hub/business");
  return extractHtmlAnchorStories(text, {
    baseUrl: "https://apnews.com",
    linkPattern: /apnews\.com\/article\//i,
    maxItems: 12
  });
}

async function loadCaixinMacro() {
  const text = await fetchText("https://www.caixin.com");
  return extractHtmlAnchorStories(text, {
    baseUrl: "https://www.caixin.com",
    linkPattern: /caixin\.com\/20\d{2}-\d{2}-\d{2}\//i,
    maxItems: 12
  });
}

async function loadYicaiMacro() {
  const text = await fetchText("https://www.yicai.com");
  return extractHtmlAnchorStories(text, {
    baseUrl: "https://www.yicai.com",
    linkPattern: /yicai\.com\/(brief|news)\/\d+\.html|\/(brief|news)\/\d+\.html/i,
    maxItems: 12
  });
}

async function loadClsTelegraph() {
  const items = await getMarketTelegraph(12);
  return Array.isArray(items)
    ? items.map((item) => ({
        title: item?.title ?? "",
        content: item?.content ?? "",
        publishedAt: item?.publishedAt ?? item?.published_at ?? null,
        url: item?.url ?? null
      }))
    : [];
}

function tierWeight(tier) {
  if (tier === 1) {
    return 100;
  }
  if (tier === 2) {
    return 70;
  }
  return 40;
}

const STRONG_MARKET_SIGNAL_PATTERNS = [
  /停火|关税|制裁|谈判|加息|降息|美联储|央行|通胀|非农/u,
  /油价|原油|黄金|白银|美元|人民币|离岸人民币|在岸人民币|美债|收益率|汇率/u,
  /股市|股指|指数|期货|纳指|标普|恒生|创业板|A股|港股|MSCI|亚太|日经|东证|KOSPI|韩国|日韩/u,
  /风险偏好|流动性|避险|衰退|就业|GDP/u,
  /ceasefire|tariff|sanction|negotiation|fed|rate cut|rate hike|inflation|payrolls/i,
  /oil|crude|gold|silver|dollar|yuan|treasury|yield|fx|exchange rate/i,
  /stocks|equities|index|futures|nasdaq|s&p|hang seng|nikkei|kospi|asia/i,
  /risk-on|risk off|liquidity|recession|jobs|gdp/i
];

const WEAK_MARKET_PENALTY_PATTERNS = [
  /教育/u,
  /Promotion/i,
  /经营线索/u,
  /观察$/u,
  /revenue|sales|earnings|profit outlook|outlook|patients|treatment|launch|pill|bag fees|first time|list to buy|buy when/i,
  /营收|业绩|财报|销量|发售|发布|患者|治疗|清单/u
];

const HARD_NON_MARKET_PATTERNS = [
  /immigration detention|wife of us soldier|released from detention/i,
  /移民拘留|士兵妻子|获释/u,
  /celebrity|movie star|red carpet|fashion week/i,
  /明星|红毯|娱乐八卦/u
];

const MARKET_TAG_RULES = [
  {
    tag: "geopolitics",
    patterns: [/停火|冲突|中东|伊朗|以色列|ceasefire|iran|israel|middle east|war/i]
  },
  {
    tag: "liquidity",
    patterns: [/流动性|资金面|平仓|挤兑|liquidity|funding|forced selling|margin/i]
  },
  {
    tag: "rates",
    patterns: [/加息|降息|美联储|央行|收益率|fed|rate cut|rate hike|treasury yield|bond yield/i]
  },
  {
    tag: "fx",
    patterns: [/美元|人民币|汇率|dollar|yuan|fx|exchange rate/i]
  },
  {
    tag: "commodities",
    patterns: [/黄金|油价|原油|铜|大宗商品|gold|oil|crude|commodity|commodities/i]
  },
  {
    tag: "china_policy",
    patterns: [/国常会|财政|地产|刺激|稳增长|china policy|stimulus|property support/i]
  },
  {
    tag: "us_tech",
    patterns: [/纳指|纳斯达克|美股科技|英伟达|苹果|nasdaq|magnificent 7|semiconductor|chip stocks/i]
  },
  {
    tag: "asia_session",
    patterns: [/日韩|日经|东证|kospi|亚太|msci亚太|asia equities|nikkei|asian stocks/i]
  }
];

const CROSS_ASSET_IMPACT_BY_TAG = {
  geopolitics: ["oil", "gold", "risk_assets"],
  liquidity: ["gold", "equities", "usd"],
  rates: ["treasury", "growth_equities", "gold"],
  fx: ["usd", "cny", "gold"],
  commodities: ["gold", "oil", "commodity_equities"],
  china_policy: ["a_shares", "hk_china", "cny"],
  us_tech: ["nasdaq", "global_growth"],
  asia_session: ["a_shares", "hk_equities", "japan_equities", "korea_equities"]
};

function scoreMarketRelevanceText(text = "") {
  const input = String(text ?? "").trim();
  if (!input) {
    return 0;
  }

  let score = 0;
  for (const pattern of STRONG_MARKET_SIGNAL_PATTERNS) {
    if (pattern.test(input)) {
      score += 8;
    }
  }
  for (const pattern of WEAK_MARKET_PENALTY_PATTERNS) {
    if (pattern.test(input)) {
      score -= 4;
    }
  }
  return score;
}

function scoreMarketRelevance(story = {}) {
  const text = `${story?.title ?? ""} ${story?.summary ?? ""}`.trim();
  return scoreMarketRelevanceText(text);
}

function extractMarketTags(story = {}) {
  const text = `${story?.title ?? ""} ${story?.summary ?? ""}`.trim();
  const tags = [];
  for (const rule of MARKET_TAG_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      tags.push(rule.tag);
    }
  }
  return [...new Set(tags)];
}

function buildCrossAssetImpact(tags = []) {
  return [
    ...new Set(
      tags.flatMap((tag) => CROSS_ASSET_IMPACT_BY_TAG[tag] ?? [])
    )
  ];
}

function isHardFilteredNonMarketStory(story = {}) {
  const text = `${story?.title ?? ""} ${story?.summary ?? ""}`.trim();
  return HARD_NON_MARKET_PATTERNS.some((pattern) => pattern.test(text));
}

function scorePortfolioRelevance(tags = []) {
  let score = 0;
  if (tags.includes("china_policy")) {
    score += 2;
  }
  if (tags.includes("asia_session")) {
    score += 2;
  }
  if (tags.includes("us_tech")) {
    score += 3;
  }
  if (tags.includes("commodities")) {
    score += 3;
  }
  if (tags.includes("geopolitics")) {
    score += 2;
  }
  if (tags.includes("rates") || tags.includes("fx")) {
    score += 1;
  }
  return score;
}

function hasHeadlineMarketSignal(story = {}) {
  const headlineText = String(story?.title ?? "").trim() || String(story?.summary ?? "").trim();
  return scoreMarketRelevanceText(headlineText) >= 8;
}

function rankStory(now, story) {
  const publishedAt = normalizeTimestamp(story?.published_at);
  const ageHours =
    publishedAt === null ? 999 : Math.max((Number(now.getTime()) - Number(new Date(publishedAt).getTime())) / 3_600_000, 0);
  return (
    tierWeight(Number(story?.tier ?? 3)) +
    scoreMarketRelevance(story) +
    scorePortfolioRelevance(story?.marketTags ?? []) * 2 -
    Math.min(ageHours, 48)
  );
}

function isFreshHeadlineCandidate(now, story, maxAgeHours = 72) {
  const publishedAt = normalizeTimestamp(story?.published_at);
  if (publishedAt === null) {
    return true;
  }
  const ageHours = Math.max((Number(now.getTime()) - Number(new Date(publishedAt).getTime())) / 3_600_000, 0);
  return ageHours <= maxAgeHours;
}

function selectRepresentativeTopHeadlines(rankedStories = [], maxItems = 8) {
  const selected = [];
  const consumedIndexes = new Set();
  const representedSources = new Set();

  for (let index = 0; index < rankedStories.length; index += 1) {
    const story = rankedStories[index];
    const sourceId = String(story?.sourceId ?? "").trim();
    const sourceTier = Number(story?.tier ?? 3);
    if (!sourceId || representedSources.has(sourceId) || sourceTier > 2) {
      continue;
    }
    selected.push(story);
    representedSources.add(sourceId);
    consumedIndexes.add(index);
    if (selected.length >= maxItems) {
      return selected;
    }
  }

  for (let index = 0; index < rankedStories.length; index += 1) {
    if (consumedIndexes.has(index)) {
      continue;
    }
    selected.push(rankedStories[index]);
    if (selected.length >= maxItems) {
      break;
    }
  }

  return selected;
}

export async function aggregateResearchNews({
  sourceIds = getDefaultResearchNewsSourceIds(),
  now = new Date(),
  sourceLoaders = {}
} = {}) {
  const registry = buildResearchNewsRegistry();
  const defaultLoaders = {
    ap_business: loadApBusiness,
    reuters_world: loadReutersWorld,
    wsj_world: loadWsjWorld,
    wsj_markets: loadWsjMarkets,
    marketwatch_top: loadMarketWatchTop,
    cnbc_top: loadCnbcTop,
    caixin_macro: loadCaixinMacro,
    yicai_macro: loadYicaiMacro,
    wallstreetcn_global: loadWallstreetcnGlobal,
    cls_telegraph: loadClsTelegraph
  };
  const loaders = {
    ...defaultLoaders,
    ...sourceLoaders
  };
  const stories = [];
  const sourceHealth = [];

  for (const sourceId of sourceIds) {
    const sourceMeta = registry.find((item) => item.sourceId === sourceId) ?? getResearchNewsSource(sourceId);
    if (!sourceMeta) {
      continue;
    }

    const loader = loaders[sourceId];
    if (typeof loader !== "function") {
      sourceHealth.push({
        sourceId,
        source: sourceMeta.source,
        tier: sourceMeta.tier,
        status: "unsupported",
        storyCount: 0,
        requiresBrowserFetch: sourceMeta.requiresBrowserFetch === true
      });
      continue;
    }

    try {
      const loadedItems = await loader();
      const normalizedStories = (Array.isArray(loadedItems) ? loadedItems : [])
        .map((item) => normalizeStory(sourceMeta, item))
        .filter(Boolean);
      stories.push(...normalizedStories);
      sourceHealth.push({
        sourceId,
        source: sourceMeta.source,
        tier: sourceMeta.tier,
        status: "ok",
        storyCount: normalizedStories.length,
        requiresBrowserFetch: false
      });
    } catch (error) {
      sourceHealth.push({
        sourceId,
        source: sourceMeta.source,
        tier: sourceMeta.tier,
        status: "error",
        storyCount: 0,
        error: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        requiresBrowserFetch: false
      });
    }
  }

  const enrichedStories = stories.map((story) => {
    const marketTags = extractMarketTags(story);
    return {
      ...story,
      marketTags,
      portfolioRelevanceScore: scorePortfolioRelevance(marketTags),
      crossAssetImpact: buildCrossAssetImpact(marketTags)
    };
  });

  const marketMovingStoryExists = enrichedStories.some(
    (story) => story.marketTags.length > 0 && scoreMarketRelevance(story) > 0
  );

  const rankedStories = enrichedStories
    .filter((story) => !(marketMovingStoryExists && isHardFilteredNonMarketStory(story)))
    .slice()
    .sort((left, right) => rankStory(now, right) - rankStory(now, left));

  const tagFrequency = new Map();
  for (const story of rankedStories) {
    for (const tag of story.marketTags ?? []) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }
  const storiesWithConfirmation = rankedStories.map((story) => ({
    ...story,
    sourceConfirmationCount: Math.max(
      1,
      Math.max(...(story.marketTags ?? []).map((tag) => Number(tagFrequency.get(tag) ?? 0)), 1)
    )
  }));
  const trustedSources = new Set(storiesWithConfirmation.filter((item) => Number(item?.tier ?? 3) <= 2).map((item) => item.sourceId));
  const uniqueSources = new Set(storiesWithConfirmation.map((item) => item.sourceId));
  const analysisMode =
    uniqueSources.size >= 2 && trustedSources.size >= 1
      ? "multi_source_confirmed"
      : "single_source_degraded";
  const freshHeadlineCandidates = storiesWithConfirmation.filter((story) => isFreshHeadlineCandidate(now, story));
  const relevantHeadlineCandidates = freshHeadlineCandidates.filter((story) => hasHeadlineMarketSignal(story));
  const topHeadlines = selectRepresentativeTopHeadlines(
    relevantHeadlineCandidates.length > 0
      ? relevantHeadlineCandidates
      : freshHeadlineCandidates.length > 0
        ? freshHeadlineCandidates
        : storiesWithConfirmation,
    8
  );

  return {
    stories: storiesWithConfirmation,
    sourceHealth,
    coverage: {
      totalStories: storiesWithConfirmation.length,
      uniqueSourceCount: uniqueSources.size,
      trustedSourceCount: trustedSources.size
    },
    topHeadlines,
    degradedReason:
      analysisMode === "single_source_degraded"
        ? uniqueSources.size <= 1
          ? "single_source_only"
          : "trusted_source_missing"
        : null,
    analysisMode
  };
}
