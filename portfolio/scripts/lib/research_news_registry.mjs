const RESEARCH_NEWS_REGISTRY = [
  {
    sourceId: "ap_business",
    source: "AP",
    tier: 1,
    sourceType: "wire",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.97,
    requiresBrowserFetch: false
  },
  {
    sourceId: "reuters_world",
    source: "Reuters",
    tier: 1,
    sourceType: "wire",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.98,
    requiresBrowserFetch: true
  },
  {
    sourceId: "bloomberg_markets",
    source: "Bloomberg",
    tier: 1,
    sourceType: "terminal_media",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.97,
    requiresBrowserFetch: true
  },
  {
    sourceId: "ft_markets",
    source: "Financial Times",
    tier: 1,
    sourceType: "newspaper",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.96,
    requiresBrowserFetch: true
  },
  {
    sourceId: "wsj_world",
    source: "WSJ",
    tier: 1,
    sourceType: "newspaper",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.95,
    requiresBrowserFetch: false
  },
  {
    sourceId: "wsj_markets",
    source: "WSJ Markets",
    tier: 1,
    sourceType: "newspaper",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.95,
    requiresBrowserFetch: false
  },
  {
    sourceId: "marketwatch_top",
    source: "MarketWatch",
    tier: 1,
    sourceType: "market_media",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.91,
    requiresBrowserFetch: false
  },
  {
    sourceId: "cnbc_top",
    source: "CNBC",
    tier: 1,
    sourceType: "broadcast_media",
    region: "global",
    marketScope: "macro",
    defaultTrustScore: 0.9,
    requiresBrowserFetch: false
  },
  {
    sourceId: "caixin_macro",
    source: "财新",
    tier: 2,
    sourceType: "finance_media",
    region: "CN",
    marketScope: "macro",
    defaultTrustScore: 0.92,
    requiresBrowserFetch: false
  },
  {
    sourceId: "yicai_macro",
    source: "第一财经",
    tier: 2,
    sourceType: "finance_media",
    region: "CN",
    marketScope: "macro",
    defaultTrustScore: 0.89,
    requiresBrowserFetch: false
  },
  {
    sourceId: "wallstreetcn_global",
    source: "华尔街见闻",
    tier: 2,
    sourceType: "finance_media",
    region: "CN",
    marketScope: "macro",
    defaultTrustScore: 0.87,
    requiresBrowserFetch: false
  },
  {
    sourceId: "cls_telegraph",
    source: "财联社电报",
    tier: 3,
    sourceType: "telegraph",
    region: "CN",
    marketScope: "macro",
    defaultTrustScore: 0.72,
    requiresBrowserFetch: false
  }
];

export function buildResearchNewsRegistry() {
  return RESEARCH_NEWS_REGISTRY.map((item) => ({ ...item }));
}

export function getResearchNewsSource(sourceId) {
  return buildResearchNewsRegistry().find((item) => item.sourceId === sourceId) ?? null;
}

export function getDefaultResearchNewsSourceIds() {
  return buildResearchNewsRegistry()
    .filter((item) => item.requiresBrowserFetch !== true)
    .map((item) => item.sourceId);
}
