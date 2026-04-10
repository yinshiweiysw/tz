function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return String(value ?? "").trim();
}

function pickEventTitle(event = {}) {
  return (
    asText(event.title) ||
    asText(event.eventTitle) ||
    asText(event.name) ||
    asText(event.eventId)
  );
}

function pickEventTime(event = {}) {
  return asText(event.scheduledAt) || asText(event.windowEndAt) || asText(event.windowStartAt);
}

function pickTelegraphTitle(item = {}) {
  return asText(item.title) || asText(item.content) || asText(item.headline);
}

function formatEventLine(prefix, event) {
  const title = pickEventTitle(event);
  if (!title) {
    return null;
  }

  const time = pickEventTime(event);
  const timePrefix = time ? `${time} ` : "";
  return `- ${timePrefix}[${prefix}] ${title}`;
}

function collectEventWatchPrimaryLines(eventWatch = {}, limit = 5) {
  const lines = [];
  const addBucket = (label, items) => {
    for (const item of asArray(items)) {
      const line = formatEventLine(label, item);
      if (line) {
        lines.push(line);
      }
      if (lines.length >= limit) {
        return;
      }
    }
  };

  addBucket("Tomorrow", eventWatch.tomorrow_risks);
  if (lines.length < limit) {
    addBucket("Week", eventWatch.this_week_catalysts);
  }
  if (lines.length < limit) {
    addBucket("Deadline", eventWatch.deadline_watch);
  }

  return lines.slice(0, limit);
}

export function buildReportHeadlineTape({
  researchBrain = {},
  headlineCandidates = [],
  telegraphCandidates = [],
  primaryLimit = 5,
  auxiliaryLimit = 6
} = {}) {
  const eventWatch = researchBrain?.event_watch ?? null;
  const eventLines = collectEventWatchPrimaryLines(eventWatch ?? {}, primaryLimit);
  const auxiliarySource = asArray(telegraphCandidates).length > 0 ? telegraphCandidates : headlineCandidates;
  const auxiliaryLines = auxiliarySource
    .map((item) => pickTelegraphTitle(item))
    .filter(Boolean)
    .slice(0, auxiliaryLimit)
    .map((title) => `- ${title}`);

  if (eventLines.length > 0) {
    return {
      primarySource: "event_watch",
      primaryLines: eventLines,
      auxiliaryLines
    };
  }

  return {
    primarySource: "degraded_event_watch_missing",
    primaryLines: [
      "- Event Watch 降级：research_brain.event_watch 当前不可用，主展示链保持降级提示。"
    ],
    auxiliaryLines
  };
}

