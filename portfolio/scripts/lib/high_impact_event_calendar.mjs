function normalizeEvent(rawEvent = {}) {
  const eventId = String(rawEvent?.eventId ?? "").trim();
  if (!eventId) {
    return null;
  }

  const title = String(rawEvent?.title ?? "").trim() || eventId;
  const importance = String(rawEvent?.importance ?? "").trim().toLowerCase() || "high";
  const source = String(rawEvent?.source ?? "").trim() || "auto";
  const scheduledAt = String(rawEvent?.scheduledAt ?? "").trim() || null;
  const status = String(rawEvent?.status ?? "").trim() || "scheduled";

  return {
    ...rawEvent,
    eventId,
    title,
    importance,
    source,
    status,
    scheduledAt
  };
}

const MONTH_INDEX = new Map([
  ["january", 1],
  ["jan", 1],
  ["jan.", 1],
  ["february", 2],
  ["feb", 2],
  ["feb.", 2],
  ["march", 3],
  ["mar", 3],
  ["mar.", 3],
  ["april", 4],
  ["apr", 4],
  ["apr.", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["jun.", 6],
  ["july", 7],
  ["jul", 7],
  ["jul.", 7],
  ["august", 8],
  ["aug", 8],
  ["aug.", 8],
  ["september", 9],
  ["sep", 9],
  ["sep.", 9],
  ["sept", 9],
  ["sept.", 9],
  ["october", 10],
  ["oct", 10],
  ["oct.", 10],
  ["november", 11],
  ["nov", 11],
  ["nov.", 11],
  ["december", 12],
  ["dec", 12],
  ["dec.", 12]
]);

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTradingEconomicsTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  return text.includes("T") ? `${text}+08:00` : null;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatIsoWithOffset({ year, month, day, hour, minute, offset }) {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00${offset}`;
}

function inferUsEasternOffset(month) {
  return month >= 3 && month <= 11 ? "-04:00" : "-05:00";
}

function parseClockText(clockText, { defaultHour = 9, defaultMinute = 30 } = {}) {
  const text = String(clockText ?? "").trim().toLowerCase();
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) {
    return { hour: defaultHour, minute: defaultMinute };
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = String(match[3] ?? "").toLowerCase();
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

function parseEnglishMonth(value) {
  return MONTH_INDEX.get(String(value ?? "").trim().toLowerCase()) ?? null;
}

function parseUsDateLabel(label) {
  const match = String(label ?? "")
    .trim()
    .match(/(?:[A-Za-z]+,?\s+)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) {
    return null;
  }

  const month = parseEnglishMonth(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null;
  }

  return { year, month, day };
}

function parseMonthDayText(value, year) {
  const match = String(value ?? "")
    .trim()
    .match(/([A-Za-z]+)\s+(\d{1,2})/);
  if (!match) {
    return null;
  }

  const month = parseEnglishMonth(match[1]);
  const day = Number(match[2]);
  if (!month || !Number.isFinite(day)) {
    return null;
  }

  return { year, month, day };
}

function extractTableCellTexts(rowHtml) {
  return [...String(rowHtml ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
    stripHtml(match[1])
  );
}

function buildSourceDiagnostic(source, status, eventCount, reason = null) {
  return {
    source,
    status,
    eventCount,
    reason: reason ? String(reason).trim() : null
  };
}

function appendSourceEvents(targetEvents, targetDiagnostics, { source, events = [], reason = null }) {
  const normalizedEvents = normalizeEvents(events);
  targetEvents.push(...normalizedEvents);
  targetDiagnostics.push(
    buildSourceDiagnostic(
      source,
      normalizedEvents.length > 0 ? "ready" : "empty",
      normalizedEvents.length,
      reason
    )
  );
}

function buildOfficialCoverage({ events, diagnostics, generatedAt }) {
  const hasEvents = events.length > 0;
  const failedReasons = diagnostics
    .filter((entry) => entry?.status === "failed" && entry?.reason)
    .map((entry) => `${entry.source}: ${entry.reason}`);
  const emptySources = diagnostics.filter((entry) => entry?.status === "empty").map((entry) => entry.source);
  const reasons = [];

  if (!hasEvents) {
    reasons.push("No high-impact events available from official auto sources.");
  }
  if (failedReasons.length > 0) {
    reasons.push(...failedReasons);
  }
  if (!hasEvents && emptySources.length > 0) {
    reasons.push(`Empty official sources: ${emptySources.join(", ")}`);
  }

  return {
    generatedAt,
    events: sortEvents(normalizeEvents(events)),
    coverage: {
      readiness: hasEvents ? "ready" : "degraded",
      reasons
    },
    sourceDiagnostics: {
      sources: diagnostics
    }
  };
}

function buildFredEventConfig(releaseName = "", source = "fred") {
  const text = String(releaseName).toLowerCase();
  if (text.includes("consumer price index")) {
    return {
      source,
      eventKey: "cpi",
      title: "United States CPI",
      country: "United States",
      eventType: "macro_release",
      marketTags: ["rates", "fx", "gold"]
    };
  }
  if (text.includes("producer price index")) {
    return {
      source,
      eventKey: "ppi",
      title: "United States PPI",
      country: "United States",
      eventType: "macro_release",
      marketTags: ["rates", "fx", "commodities"]
    };
  }
  if (text.includes("employment situation")) {
    return {
      source,
      eventKey: "employment",
      title: "United States Employment Situation",
      country: "United States",
      eventType: "macro_release",
      marketTags: ["rates", "fx", "us_tech"]
    };
  }
  return null;
}

function buildFredEventsFromCalendarHtml({ html, releaseName, source = "fred_release_calendar" } = {}) {
  const config = buildFredEventConfig(releaseName, source);
  if (!config) {
    return [];
  }

  const matches = [...String(html ?? "").matchAll(
    /<tr[^>]*class="(?:odd|even)?"?[^>]*>\s*<td[^>]*colspan="2"[^>]*>[\s\S]*?<span[^>]*font-weight:\s*bold[^>]*>([^<]+)<\/span>[\s\S]*?<\/tr>\s*<tr[^>]*>[\s\S]*?<td[^>]*>\s*([^<]+?)\s*<\/td>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi
  )];

  return matches
    .map((match) => {
      const parsedDate = parseUsDateLabel(stripHtml(match[1]));
      if (!parsedDate) {
        return null;
      }
      const { hour, minute } = parseClockText(stripHtml(match[2]), { defaultHour: 8, defaultMinute: 30 });
      const offset = inferUsEasternOffset(parsedDate.month);
      const scheduledAt = formatIsoWithOffset({
        ...parsedDate,
        hour,
        minute,
        offset
      });

      return {
        eventId: slugify(`us-${config.eventKey}-${parsedDate.year}-${pad2(parsedDate.month)}-${pad2(parsedDate.day)}`),
        title: config.title,
        country: config.country,
        eventType: config.eventType,
        scheduledAt,
        importance: "high",
        status: "scheduled",
        marketTags: config.marketTags,
        source
      };
    })
    .filter(Boolean);
}

function buildBeaEventsFromScheduleHtml({ html, source = "bea_schedule" } = {}) {
  const rows = [...String(html ?? "").matchAll(
    /<tr[^>]*scheduled-releases-type-press[^>]*>[\s\S]*?<div class="release-date">([\s\S]*?)<\/div>[\s\S]*?<small class="text-muted">([\s\S]*?)<\/small>[\s\S]*?<td class="release-title[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
  )];

  return rows
    .map((match) => {
      const title = stripHtml(match[3]);
      let config = null;
      if (/\bGDP\b/i.test(title)) {
        config = {
          eventKey: "gdp",
          title: "United States GDP Release",
          marketTags: ["rates", "fx", "us_tech"]
        };
      } else if (/Personal Income and Outlays/i.test(title)) {
        config = {
          eventKey: "pce",
          title: "United States Personal Income and Outlays",
          marketTags: ["rates", "fx", "gold"]
        };
      }
      if (!config) {
        return null;
      }

      const dateParts = parseMonthDayText(stripHtml(match[1]), inferBeaYearFromTitle(title));
      if (!dateParts) {
        return null;
      }
      const { hour, minute } = parseClockText(stripHtml(match[2]), { defaultHour: 8, defaultMinute: 30 });
      const offset = inferUsEasternOffset(dateParts.month);

      return {
        eventId: slugify(
          `us-${config.eventKey}-${dateParts.year}-${pad2(dateParts.month)}-${pad2(dateParts.day)}`
        ),
        title: config.title,
        country: "United States",
        eventType: "macro_release",
        scheduledAt: formatIsoWithOffset({
          ...dateParts,
          hour,
          minute,
          offset
        }),
        importance: "high",
        status: "scheduled",
        marketTags: config.marketTags,
        source,
        notes: title
      };
    })
    .filter(Boolean);
}

function inferBeaYearFromTitle(title) {
  const match = String(title ?? "").match(/\b(20\d{2})\b/);
  return Number(match?.[1] ?? new Date().getUTCFullYear());
}

function buildFedFomcEventsFromHtml({ html, source = "federal_reserve_fomc" } = {}) {
  const sectionMatches = [...String(html ?? "").matchAll(
    /<h4><a id="[^"]+">(\d{4}) FOMC Meetings<\/a><\/h4>([\s\S]*?)(?=<h4><a id="[^"]+">|$)/gi
  )];

  const events = [];
  for (const section of sectionMatches) {
    const year = Number(section[1]);
    const body = section[2];
    const rowMatches = [...body.matchAll(
      /<div class="[^"]*fomc-meeting__month[^"]*"><strong>([^<]+)<\/strong><\/div>[\s\S]*?<div class="[^"]*fomc-meeting__date[^"]*">([^<]+)<\/div>/gi
    )];
    for (const row of rowMatches) {
      const month = parseEnglishMonth(stripHtml(row[1]));
      if (!month) {
        continue;
      }
      const rawDate = stripHtml(row[2]).replace(/\*/g, "");
      const dayMatches = [...rawDate.matchAll(/(\d{1,2})/g)].map((match) => Number(match[1]));
      const day = dayMatches.length > 0 ? dayMatches[dayMatches.length - 1] : null;
      if (!Number.isFinite(day)) {
        continue;
      }
      const offset = inferUsEasternOffset(month);
      events.push({
        eventId: slugify(`us-fomc-${year}-${pad2(month)}-${pad2(day)}`),
        title: "United States FOMC Rate Decision",
        country: "United States",
        eventType: "central_bank",
        scheduledAt: formatIsoWithOffset({
          year,
          month,
          day,
          hour: 14,
          minute: 0,
          offset
        }),
        importance: "high",
        status: "scheduled",
        marketTags: ["rates", "fx", "gold", "us_tech"],
        source
      });
    }
  }

  return events;
}

function extractNbsCalendarYear(html) {
  const match = String(html ?? "").match(/Regular Press Release Calendar of NBS in (\d{4})/i);
  return Number(match?.[1] ?? new Date().getUTCFullYear());
}

function buildNbsMonthlyEventsFromHtml({
  html,
  rowTitle,
  eventKey,
  title,
  marketTags,
  source = "nbs_release_calendar"
} = {}) {
  const match = String(html ?? "").match(
    new RegExp(
      `<tr[^>]*>\\s*<td[^>]*rowspan="2"[^>]*>[\\s\\S]*?${rowTitle}[\\s\\S]*?<\\/td>([\\s\\S]*?)<\\/tr>\\s*<tr[^>]*>([\\s\\S]*?)<\\/tr>`,
      "i"
    )
  );
  if (!match) {
    return [];
  }

  const year = extractNbsCalendarYear(html);
  const dateCells = extractTableCellTexts(match[1]);
  const timeCells = extractTableCellTexts(match[2]);

  return dateCells
    .map((dateCell, index) => {
      const dayMatch = String(dateCell).match(/(\d{1,2})\//);
      if (!dayMatch) {
        return null;
      }
      const day = Number(dayMatch[1]);
      const { hour, minute } = parseClockText(timeCells[index], { defaultHour: 9, defaultMinute: 30 });
      return {
        eventId: slugify(`cn-${eventKey}-${year}-${pad2(index + 1)}-${pad2(day)}`),
        title,
        country: "China",
        eventType: "macro_release",
        scheduledAt: formatIsoWithOffset({
          year,
          month: index + 1,
          day,
          hour,
          minute,
          offset: "+08:00"
        }),
        importance: "high",
        status: "scheduled",
        marketTags,
        source
      };
    })
    .filter(Boolean);
}

export function buildHighImpactAutoPayloadFromOfficialSources({
  generatedAt = new Date().toISOString(),
  fredPages = [],
  beaHtml = "",
  fedFomcHtml = "",
  nbsAnnualCalendarHtml = "",
  sourceDiagnostics = []
} = {}) {
  const events = [];
  const diagnostics = Array.isArray(sourceDiagnostics) ? [...sourceDiagnostics] : [];

  const fredSources = Array.isArray(fredPages) ? fredPages : [];
  for (const page of fredSources) {
    appendSourceEvents(events, diagnostics, {
      source: page?.source ?? page?.releaseName ?? "fred_release_calendar",
      events: buildFredEventsFromCalendarHtml(page)
    });
  }

  if (String(beaHtml ?? "").trim()) {
    appendSourceEvents(events, diagnostics, {
      source: "bea_schedule",
      events: buildBeaEventsFromScheduleHtml({ html: beaHtml })
    });
  }
  if (String(fedFomcHtml ?? "").trim()) {
    appendSourceEvents(events, diagnostics, {
      source: "federal_reserve_fomc",
      events: buildFedFomcEventsFromHtml({ html: fedFomcHtml })
    });
  }
  if (String(nbsAnnualCalendarHtml ?? "").trim()) {
    appendSourceEvents(events, diagnostics, {
      source: "nbs_release_calendar",
      events: [
        ...buildNbsMonthlyEventsFromHtml({
          html: nbsAnnualCalendarHtml,
          rowTitle: "Monthly Report on Consumer Price Index \\(CPI\\)",
          eventKey: "cpi",
          title: "China CPI",
          marketTags: ["rates", "fx", "china_policy"]
        }),
        ...buildNbsMonthlyEventsFromHtml({
          html: nbsAnnualCalendarHtml,
          rowTitle:
            "Monthly Report on (?:Producer Price Index in the Industrial Sector|Industrial Producer Price Index)",
          eventKey: "ppi",
          title: "China PPI",
          marketTags: ["rates", "fx", "china_policy", "commodities"]
        })
      ]
    });
  }

  return buildOfficialCoverage({ events, diagnostics, generatedAt });
}

function isSupportedTradingEconomicsEvent(row = {}) {
  const importance = Number(row?.Importance ?? 0);
  if (!Number.isFinite(importance) || importance < 3) {
    return false;
  }

  const text = `${row?.Category ?? ""} ${row?.Event ?? ""}`.toLowerCase();
  return [
    "cpi",
    "consumer price",
    "inflation",
    "ppi",
    "producer price",
    "non farm payroll",
    "interest rate decision",
    "fed interest rate decision",
    "fomc",
    "gdp",
    "unemployment rate",
    "retail sales",
    "pce",
    "pmi"
  ].some((keyword) => text.includes(keyword));
}

function deriveEventType(row = {}) {
  const text = `${row?.Category ?? ""} ${row?.Event ?? ""}`.toLowerCase();
  if (text.includes("interest rate decision") || text.includes("fomc")) {
    return "central_bank";
  }
  return "macro_release";
}

function deriveMarketTags(row = {}) {
  const country = String(row?.Country ?? "").toLowerCase();
  const text = `${row?.Category ?? ""} ${row?.Event ?? ""}`.toLowerCase();
  const tags = new Set();

  if (
    text.includes("cpi") ||
    text.includes("inflation") ||
    text.includes("ppi") ||
    text.includes("pce")
  ) {
    tags.add("rates");
    tags.add("fx");
    tags.add("gold");
  }
  if (text.includes("interest rate decision") || text.includes("fomc")) {
    tags.add("rates");
    tags.add("fx");
  }
  if (text.includes("non farm payroll") || text.includes("unemployment")) {
    tags.add("rates");
    tags.add("fx");
  }
  if (country.includes("china")) {
    tags.add("china_policy");
  }
  if (country.includes("united states")) {
    tags.add("us_tech");
  }

  return [...tags];
}

export function buildHighImpactAutoPayloadFromTradingEconomics({
  rows = [],
  generatedAt = new Date().toISOString()
} = {}) {
  const events = normalizeEvents(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => isSupportedTradingEconomicsEvent(row))
      .map((row) => {
        const country = String(row?.Country ?? "").trim();
        const eventLabel = String(row?.Event ?? row?.Category ?? "").trim();
        const reference = String(row?.Reference ?? "").trim();
        const scheduledAt = normalizeTradingEconomicsTimestamp(row?.Date);
        const eventId = slugify(`${country}-${eventLabel}-${reference || row?.CalendarId || scheduledAt}`);

        return {
          eventId,
          title: reference ? `${country} ${eventLabel} (${reference})` : `${country} ${eventLabel}`,
          country,
          eventType: deriveEventType(row),
          scheduledAt,
          importance: "high",
          status: "scheduled",
          marketTags: deriveMarketTags(row),
          source: "tradingeconomics_auto",
          sourceUrl: String(row?.URL ?? "").trim() || null,
          consensus: {
            value: String(row?.Forecast ?? row?.TEForecast ?? "").trim() || null,
            unit: String(row?.Unit ?? "").trim() || null
          },
          previous: {
            value: String(row?.Previous ?? "").trim() || null,
            unit: String(row?.Unit ?? "").trim() || null
          }
        };
      })
  );

  return {
    generatedAt,
    events: sortEvents(events)
  };
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }
  return events.map((event) => normalizeEvent(event)).filter(Boolean);
}

function sortEvents(events = []) {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(String(left?.scheduledAt ?? ""));
    const rightTime = Date.parse(String(right?.scheduledAt ?? ""));
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);

    if (leftValid && rightValid && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (leftValid !== rightValid) {
      return leftValid ? -1 : 1;
    }
    return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
  });
}

function applyUpserts(eventMap, upserts) {
  let upsertCount = 0;
  for (const rawEntry of Array.isArray(upserts) ? upserts : []) {
    const eventId = String(rawEntry?.eventId ?? "").trim();
    if (!eventId) {
      continue;
    }
    const previous = eventMap.get(eventId) ?? {};
    const mergedCandidate = normalizeEvent({ ...previous, ...rawEntry, eventId });
    if (!mergedCandidate) {
      continue;
    }
    eventMap.set(eventId, mergedCandidate);
    upsertCount += 1;
  }
  return upsertCount;
}

function applyRemovals(eventMap, removeEventIds) {
  let removeCount = 0;
  for (const rawId of Array.isArray(removeEventIds) ? removeEventIds : []) {
    const eventId = String(rawId ?? "").trim();
    if (!eventId) {
      continue;
    }
    if (eventMap.delete(eventId)) {
      removeCount += 1;
    }
  }
  return removeCount;
}

function applyAppends(eventMap, append) {
  let appendCount = 0;
  for (const rawEntry of Array.isArray(append) ? append : []) {
    const entry = normalizeEvent(rawEntry);
    if (!entry) {
      continue;
    }
    eventMap.set(entry.eventId, entry);
    appendCount += 1;
  }
  return appendCount;
}

export function mergeHighImpactEventCalendar({
  autoPayload = {},
  overridePayload = {},
  generatedAt = new Date().toISOString()
} = {}) {
  const autoEvents = normalizeEvents(autoPayload?.events);
  const eventMap = new Map(autoEvents.map((event) => [event.eventId, event]));
  const upsertCount = applyUpserts(eventMap, overridePayload?.upserts);
  const removeCount = applyRemovals(eventMap, overridePayload?.removeEventIds);
  const appendCount = applyAppends(eventMap, overridePayload?.append);
  const events = sortEvents([...eventMap.values()]);
  const inheritedReasons = Array.isArray(autoPayload?.coverage?.reasons)
    ? autoPayload.coverage.reasons
        .map((reason) => String(reason ?? "").trim())
        .filter(Boolean)
    : [];
  const inheritedReadiness = String(autoPayload?.coverage?.readiness ?? "").trim().toLowerCase();
  const coverageReasons = [];

  if (events.length === 0) {
    coverageReasons.push("No high-impact events available from auto or override sources.");
  }
  coverageReasons.push(...inheritedReasons);

  return {
    generatedAt,
    sourceGeneratedAt: String(autoPayload?.generatedAt ?? "").trim() || null,
    overrideGeneratedAt: String(overridePayload?.generatedAt ?? "").trim() || null,
    events,
    coverage: {
      readiness:
        events.length > 0 ? (inheritedReadiness === "degraded" ? "degraded" : "ready") : "degraded",
      reasons: events.length > 0 && inheritedReadiness !== "degraded" ? [] : coverageReasons
    },
    sourceDiagnostics: autoPayload?.sourceDiagnostics ?? null,
    stats: {
      autoEventCount: autoEvents.length,
      upsertCount,
      removeCount,
      appendCount,
      totalEventCount: events.length
    }
  };
}
