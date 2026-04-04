function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeTime(value, fallback) {
  const text = normalizeText(value);
  return /^\d{2}:\d{2}$/.test(text) ? text : fallback;
}

function readExplicitCloseTime(source = {}) {
  return (
    source?.dashboard_close_time ??
    source?.dashboardCloseTime ??
    source?.valuation_close_time ??
    source?.valuationCloseTime ??
    source?.market_close_time ??
    source?.marketCloseTime ??
    null
  );
}

function inferProfile(asset = {}, position = {}) {
  const combined = [
    asset?.market,
    asset?.category,
    asset?.name,
    position?.market,
    position?.category,
    position?.name
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");

  if (/港股|恒生|H股|HK/i.test(combined)) {
    return "hk";
  }

  if (/黄金|上海金|AU9999|SGE|GOLD/i.test(combined)) {
    return "gold";
  }

  if (
    /QDII|美股|海外|纳斯达克|标普|日经|大宗商品|商品|GLOBAL|GLB|US/i.test(combined)
  ) {
    return "global_qdii";
  }

  return "domestic";
}

export function resolveFundMarketSessionPolicy({ asset = null, position = null } = {}) {
  const profile = inferProfile(asset ?? {}, position ?? {});
  const explicitCloseTime =
    readExplicitCloseTime(asset ?? {}) ?? readExplicitCloseTime(position ?? {});

  let closeTime = "15:00";
  if (profile === "gold") {
    closeTime = "15:30";
  } else if (profile === "hk") {
    closeTime = "16:10";
  }

  return {
    profile,
    openTime: "09:30",
    closeTime: normalizeTime(explicitCloseTime, closeTime),
    timeZone: "Asia/Shanghai"
  };
}

function getShanghaiTotalMinutes(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return Number(parts.hour ?? 0) * 60 + Number(parts.minute ?? 0);
}

function parseTimeToMinutes(value, fallbackMinutes) {
  const match = normalizeText(value).match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return fallbackMinutes;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return fallbackMinutes;
  }

  return hour * 60 + minute;
}

export function resolveFundQuoteSessionMode({
  quoteDate = null,
  today = null,
  updateTime = null,
  sessionPolicy = null,
  now = new Date()
} = {}) {
  const quoteDateText = normalizeText(quoteDate);
  const todayText = normalizeText(today);

  if (!quoteDateText) {
    return "unavailable";
  }

  if (!todayText || quoteDateText !== todayText) {
    return "confirmed_nav";
  }

  const policy = sessionPolicy ?? {
    openTime: "09:30",
    closeTime: "15:00"
  };
  const nowMinutes = getShanghaiTotalMinutes(now);
  const openMinutes = parseTimeToMinutes(policy?.openTime, 9 * 60 + 30);
  const closeMinutes = parseTimeToMinutes(policy?.closeTime, 15 * 60);
  const updateTimeText = normalizeText(updateTime);
  const hasClockTime = /\b\d{2}:\d{2}\b/.test(updateTimeText);
  const updateClockMatch = updateTimeText.match(/\b(\d{2}):(\d{2})\b/);
  const updateMinutes =
    updateClockMatch && Number.isFinite(Number(updateClockMatch[1])) && Number.isFinite(Number(updateClockMatch[2]))
      ? Number(updateClockMatch[1]) * 60 + Number(updateClockMatch[2])
      : null;

  if (!hasClockTime) {
    return "close_reference";
  }

  if (policy?.profile === "global_qdii" && Number.isFinite(updateMinutes) && updateMinutes < openMinutes) {
    return "confirmed_nav";
  }

  if (nowMinutes < openMinutes) {
    return "confirmed_nav";
  }

  if (nowMinutes >= closeMinutes) {
    return "close_reference";
  }

  return "live_estimate";
}
