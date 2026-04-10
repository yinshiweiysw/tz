import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { readJsonOrDefault, writeJsonAtomic } from "./lib/atomic_json_state.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import {
  buildHighImpactAutoPayloadFromOfficialSources,
  mergeHighImpactEventCalendar
} from "./lib/high_impact_event_calendar.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function formatLocalDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function filterWindowedEvents(events = [], { now = new Date(), lookbackDays = 2, lookaheadDays = 45 } = {}) {
  const startMs = addDays(now, -lookbackDays).getTime();
  const endMs = addDays(now, lookaheadDays).getTime();
  return (Array.isArray(events) ? events : []).filter((event) => {
    const scheduledMs = Date.parse(String(event?.scheduledAt ?? ""));
    return Number.isFinite(scheduledMs) && scheduledMs >= startMs && scheduledMs <= endMs;
  });
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html,application/json",
      "user-agent": "Mozilla/5.0 Codex"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

function mergeCoverage(baseCoverage = {}, extraReasons = []) {
  const reasons = [
    ...((Array.isArray(baseCoverage?.reasons) ? baseCoverage.reasons : []).map((reason) =>
      String(reason ?? "").trim()
    )),
    ...extraReasons.map((reason) => String(reason ?? "").trim())
  ].filter(Boolean);

  return {
    readiness: String(baseCoverage?.readiness ?? "degraded").trim() || "degraded",
    reasons
  };
}

async function fetchLatestNbsAnnualCalendarHtml(fetchImpl) {
  const indexUrl = "https://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/";
  const indexHtml = await fetchText(fetchImpl, indexUrl);
  const linkMatches = [...indexHtml.matchAll(
    /<a[^>]+href="([^"]+)"[^>]*>([^<]*Regular Press Release Calendar of NBS in (\d{4})[^<]*)<\/a>/gi
  )];
  const candidate = linkMatches
    .map((match) => ({
      href: match[1],
      year: Number(match[3])
    }))
    .filter((entry) => Number.isFinite(entry.year))
    .sort((left, right) => right.year - left.year)[0];

  if (!candidate?.href) {
    throw new Error("Latest NBS annual release calendar link not found.");
  }

  const annualUrl = new URL(candidate.href, indexUrl).toString();
  const annualHtml = await fetchText(fetchImpl, annualUrl);

  return {
    indexUrl,
    annualUrl,
    annualHtml
  };
}

export async function loadAutoEventsDefault({
  autoPath,
  fetchImpl = fetch,
  now = new Date()
} = {}) {
  const cached = (await readJsonOrDefault(autoPath, { events: [] })) ?? { events: [] };
  const currentYear = now.getFullYear();
  const diagnostics = [];
  const fredPages = [];
  const reasons = [];

  const officialSourceLoaders = [
    {
      source: "fred_cpi",
      run: async () => {
        fredPages.push({
          source: "fred_cpi",
          releaseName: "Consumer Price Index",
          html: await fetchText(
            fetchImpl,
            `https://fred.stlouisfed.org/releases/calendar?rid=10&y=${currentYear}`
          )
        });
      }
    },
    {
      source: "fred_ppi",
      run: async () => {
        fredPages.push({
          source: "fred_ppi",
          releaseName: "Producer Price Index",
          html: await fetchText(
            fetchImpl,
            `https://fred.stlouisfed.org/releases/calendar?rid=46&y=${currentYear}`
          )
        });
      }
    },
    {
      source: "fred_employment",
      run: async () => {
        fredPages.push({
          source: "fred_employment",
          releaseName: "Employment Situation",
          html: await fetchText(
            fetchImpl,
            `https://fred.stlouisfed.org/releases/calendar?rid=50&y=${currentYear}`
          )
        });
      }
    }
  ];

  let beaHtml = "";
  let fedFomcHtml = "";
  let nbsAnnualCalendarHtml = "";

  for (const loader of officialSourceLoaders) {
    try {
      await loader.run();
    } catch (error) {
      diagnostics.push({
        source: loader.source,
        status: "failed",
        eventCount: 0,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  try {
    beaHtml = await fetchText(fetchImpl, "https://www.bea.gov/news/schedule");
  } catch (error) {
    diagnostics.push({
      source: "bea_schedule",
      status: "failed",
      eventCount: 0,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    fedFomcHtml = await fetchText(fetchImpl, "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm");
  } catch (error) {
    diagnostics.push({
      source: "federal_reserve_fomc",
      status: "failed",
      eventCount: 0,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const nbsResult = await fetchLatestNbsAnnualCalendarHtml(fetchImpl);
    nbsAnnualCalendarHtml = nbsResult.annualHtml;
  } catch (error) {
    diagnostics.push({
      source: "nbs_release_calendar",
      status: "failed",
      eventCount: 0,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  const officialPayload = buildHighImpactAutoPayloadFromOfficialSources({
    generatedAt: now.toISOString(),
    fredPages,
    beaHtml,
    fedFomcHtml,
    nbsAnnualCalendarHtml,
    sourceDiagnostics: diagnostics
  });

  const filteredPayload = {
    ...officialPayload,
    events: filterWindowedEvents(officialPayload.events, { now })
  };
  filteredPayload.coverage = mergeCoverage(
    {
      readiness: filteredPayload.events.length > 0 ? "ready" : officialPayload.coverage.readiness,
      reasons: officialPayload.coverage.reasons
    },
    []
  );

  if (filteredPayload.events.length > 0) {
    const persistedPayload = {
      ...filteredPayload,
      generatedAt: now.toISOString(),
      sourceDiagnostics: {
        ...(filteredPayload.sourceDiagnostics ?? {}),
        cache: {
          status: "refreshed",
          eventCount: filteredPayload.events.length,
          asOf: now.toISOString()
        }
      }
    };
    await writeJsonAtomic(autoPath, persistedPayload);
    return persistedPayload;
  }

  if (Array.isArray(cached?.events) && cached.events.length > 0) {
    reasons.push("Using cached high-impact event calendar because live official sources returned no current events.");
    return {
      ...cached,
      generatedAt: now.toISOString(),
      coverage: mergeCoverage(
        {
          readiness: "degraded",
          reasons: filteredPayload.coverage.reasons
        },
        reasons
      ),
      sourceDiagnostics: {
        ...(filteredPayload.sourceDiagnostics ?? {}),
        cache: {
          status: "hit",
          eventCount: cached.events.length,
          generatedAt: cached.generatedAt ?? null
        }
      }
    };
  }

  reasons.push(`Window ${formatLocalDateKey(now)} -> ${formatLocalDateKey(addDays(now, 45))} produced no high-impact events.`);
  return {
    ...cached,
    generatedAt: now.toISOString(),
    events: [],
    coverage: mergeCoverage(
      {
        readiness: "degraded",
        reasons: filteredPayload.coverage.reasons
      },
      reasons
    ),
    sourceDiagnostics: {
      ...(filteredPayload.sourceDiagnostics ?? {}),
      cache: {
        status: "miss",
        eventCount: 0
      }
    }
  };
}

export async function runHighImpactEventCalendarBuild(rawOptions = {}, deps = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const outputPath = buildPortfolioPath(portfolioRoot, "data", "high_impact_event_calendar.json");
  const overridePath = buildPortfolioPath(
    portfolioRoot,
    "data",
    "high_impact_event_calendar.override.json"
  );
  const autoPath = buildPortfolioPath(portfolioRoot, "data", "high_impact_event_calendar.auto.json");

  const loadAutoEvents = deps.loadAutoEvents ?? loadAutoEventsDefault;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const autoPayload = await loadAutoEvents({ portfolioRoot, accountId, autoPath, options: rawOptions });
  const overridePayload = (await readJsonOrDefault(overridePath, {})) ?? {};

  const payload = mergeHighImpactEventCalendar({
    autoPayload,
    overridePayload,
    generatedAt: nowIso()
  });

  await writeJsonAtomic(outputPath, {
    ...payload,
    accountId,
    portfolioRoot
  });

  await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      high_impact_event_calendar: outputPath,
      high_impact_event_calendar_builder: buildPortfolioPath(
        portfolioRoot,
        "scripts",
        "build_high_impact_event_calendar.mjs"
      ),
      high_impact_event_calendar_override: overridePath
    }
  });

  return {
    accountId,
    portfolioRoot,
    outputPath,
    payload
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runHighImpactEventCalendarBuild(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
