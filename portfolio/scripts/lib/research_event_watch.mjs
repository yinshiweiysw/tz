function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toShanghaiDateKey(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(parsed);
}

function addDays(value, days) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeEvent(event = {}) {
  const eventId = String(event?.eventId ?? "").trim();
  const scheduledAt = String(event?.scheduledAt ?? "").trim();
  if (!eventId || !scheduledAt) {
    return null;
  }

  return {
    ...event,
    eventId,
    title: String(event?.title ?? "").trim() || eventId,
    importance: String(event?.importance ?? "").trim().toLowerCase() || "high",
    scheduledAt,
    deadlineAt: String(event?.window?.endAt ?? event?.deadlineAt ?? "").trim() || null
  };
}

function sortEvents(events = []) {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left?.scheduledAt ?? "");
    const rightTime = Date.parse(right?.scheduledAt ?? "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
  });
}

function isHighImpact(event = {}) {
  return String(event?.importance ?? "").trim().toLowerCase() === "high";
}

function isDeadlineEvent(event = {}) {
  const eventType = String(event?.eventType ?? "").trim().toLowerCase();
  return eventType === "geopolitical_window" || eventType === "policy_deadline";
}

export function buildResearchEventWatch({ calendar, now = new Date() } = {}) {
  const normalizedNow = now instanceof Date ? now : new Date(now);
  const tomorrowKey = toShanghaiDateKey(addDays(normalizedNow, 1));
  const weekEndMs = addDays(normalizedNow, 7).getTime();
  const events = sortEvents(
    asArray(calendar?.events)
      .map((event) => normalizeEvent(event))
      .filter(Boolean)
      .filter((event) => isHighImpact(event))
  );
  const futureEvents = events.filter((event) => {
    const scheduledMs = Date.parse(event?.scheduledAt ?? "");
    return Number.isFinite(scheduledMs) ? scheduledMs >= normalizedNow.getTime() : false;
  });
  const tomorrowRisks = futureEvents.filter(
    (event) => toShanghaiDateKey(event?.scheduledAt) === tomorrowKey
  );
  const thisWeekCatalysts = futureEvents.filter((event) => {
    const scheduledMs = Date.parse(event?.scheduledAt ?? "");
    return Number.isFinite(scheduledMs) && scheduledMs <= weekEndMs && !isDeadlineEvent(event);
  });
  const deadlineWatch = futureEvents.filter((event) => isDeadlineEvent(event));

  return {
    readiness: calendar
      ? String(
          calendar?.coverage?.readiness ??
            (events.length > 0 ? "ready" : "degraded")
        ).trim() || (events.length > 0 ? "ready" : "degraded")
      : "degraded",
    generated_at: String(calendar?.generated_at ?? calendar?.generatedAt ?? "").trim() || null,
    next_event: futureEvents[0] ?? null,
    summary: {
      total_high_impact_events: events.length,
      tomorrow_risk_count: tomorrowRisks.length,
      this_week_catalyst_count: thisWeekCatalysts.length,
      deadline_watch_count: deadlineWatch.length
    },
    tomorrow_risks: tomorrowRisks,
    this_week_catalysts: thisWeekCatalysts,
    deadline_watch: deadlineWatch
  };
}
