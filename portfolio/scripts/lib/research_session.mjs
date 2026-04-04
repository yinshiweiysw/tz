import { classifyExchangeClock } from "./market_schedule_guard.mjs";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const SESSION_POLICIES = {
  pre_open: {
    acceptPreviousCloseForDomestic: true,
    requiresLiveDomesticSnapshot: false,
    requiresOvernightRiskProxies: true,
    domesticTradeDateMustMatch: false
  },
  intraday: {
    acceptPreviousCloseForDomestic: false,
    requiresLiveDomesticSnapshot: true,
    requiresOvernightRiskProxies: false,
    domesticTradeDateMustMatch: true
  },
  post_close: {
    acceptPreviousCloseForDomestic: true,
    requiresLiveDomesticSnapshot: false,
    requiresOvernightRiskProxies: false,
    domesticTradeDateMustMatch: true
  },
  overnight: {
    acceptPreviousCloseForDomestic: true,
    requiresLiveDomesticSnapshot: false,
    requiresOvernightRiskProxies: true,
    domesticTradeDateMustMatch: false
  },
  market_closed: {
    acceptPreviousCloseForDomestic: true,
    requiresLiveDomesticSnapshot: false,
    requiresOvernightRiskProxies: true,
    domesticTradeDateMustMatch: false
  }
};

function getShanghaiClockParts(now) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    tradeDate: `${parts.year}-${parts.month}-${parts.day}`,
    shanghaiClock: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function classifySession(hour, minute) {
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 9 * 60 + 30) {
    return "pre_open";
  }
  if (totalMinutes < 15 * 60) {
    return "intraday";
  }
  if (totalMinutes < 19 * 60) {
    return "post_close";
  }
  return "overnight";
}

export function classifyResearchSession(now = new Date()) {
  const { tradeDate, shanghaiClock, hour, minute } = getShanghaiClockParts(now);
  const totalMinutes = hour * 60 + minute;
  const domesticClock = classifyExchangeClock({
    market: "CN_A",
    now
  });

  if (domesticClock.isTradingDay === false) {
    return {
      session: "market_closed",
      tradeDate,
      shanghaiClock,
      policy: {
        ...SESSION_POLICIES.market_closed
      }
    };
  }

  const session = classifySession(hour, minute);
  const isLunchBreak = totalMinutes >= 11 * 60 + 30 && totalMinutes < 13 * 60;
  const basePolicy = SESSION_POLICIES[session];
  const policy = {
    ...basePolicy,
    ...(session === "intraday" && isLunchBreak
      ? { requiresLiveDomesticSnapshot: false }
      : {})
  };

  return {
    session,
    tradeDate,
    shanghaiClock,
    policy
  };
}
