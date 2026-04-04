const NOISE_KEYWORDS = [
  "盘面直播",
  "午评",
  "涨停分析",
  "快速拉升",
  "触及涨停",
  "触及跌停",
  "局部异动",
  "竞价看龙头"
];

function normalizeText(item = {}) {
  return `${item?.title ?? ""} ${item?.content ?? ""} ${(item?.subjects ?? []).join(" ")}`
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoisyInstitutionalStory(item = {}) {
  const text = normalizeText(item);
  return NOISE_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function selectInstitutionalStories(items = [], options = {}) {
  const {
    limit = 5,
    focusKeywords = [],
    authoritativeKeywords = [],
    minScore = 1,
    allowFillers = false
  } = options;

  const scored = (Array.isArray(items) ? items : [])
    .filter((item) => item && !isNoisyInstitutionalStory(item))
    .map((item, index) => {
      const text = normalizeText(item);
      let score = item?.isImportant ? 100 : 0;

      for (const keyword of focusKeywords) {
        if (text.includes(keyword)) {
          score += 12;
        }
      }

      for (const keyword of authoritativeKeywords) {
        if (text.includes(keyword)) {
          score += 18;
        }
      }

      if (text.includes("突发") || text.includes("最新") || text.includes("快讯")) {
        score += 6;
      }

      return {
        ...item,
        score,
        originalIndex: index
      };
    })
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);

  const relevant = scored.filter((item) => item.score >= minScore);
  if (allowFillers && relevant.length < limit) {
    return scored.slice(0, limit);
  }

  return relevant.slice(0, limit);
}
