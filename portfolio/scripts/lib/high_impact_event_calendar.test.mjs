import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHighImpactAutoPayloadFromOfficialSources,
  buildHighImpactAutoPayloadFromTradingEconomics,
  mergeHighImpactEventCalendar
} from "./high_impact_event_calendar.mjs";

test("mergeHighImpactEventCalendar applies upsert, remove, and append overrides", () => {
  const autoPayload = {
    generatedAt: "2026-04-10T01:00:00.000Z",
    events: [
      {
        eventId: "cn-cpi-2026-04",
        title: "China CPI",
        scheduledAt: "2026-04-11T09:30:00+08:00",
        importance: "high",
        source: "auto"
      },
      {
        eventId: "us-cpi-2026-04",
        title: "US CPI",
        scheduledAt: "2026-04-11T20:30:00+08:00",
        importance: "high",
        source: "auto"
      }
    ]
  };

  const overridePayload = {
    generatedAt: "2026-04-10T01:05:00.000Z",
    removeEventIds: ["cn-cpi-2026-04"],
    upserts: [
      {
        eventId: "us-cpi-2026-04",
        consensus: { value: 3.3, unit: "%" },
        source: "manual_override"
      }
    ],
    append: [
      {
        eventId: "us-iran-truce-window",
        title: "US-Iran ceasefire window expiry",
        scheduledAt: "2026-04-22T00:00:00+08:00",
        importance: "high",
        source: "manual_override"
      }
    ]
  };

  const merged = mergeHighImpactEventCalendar({
    autoPayload,
    overridePayload,
    generatedAt: "2026-04-10T01:10:00.000Z"
  });

  assert.equal(merged.events.length, 2);
  assert.deepEqual(
    merged.events.map((item) => item.eventId),
    ["us-cpi-2026-04", "us-iran-truce-window"]
  );
  assert.equal(merged.events[0].consensus.value, 3.3);
  assert.equal(merged.events[0].source, "manual_override");
  assert.equal(merged.stats.autoEventCount, 2);
  assert.equal(merged.stats.removeCount, 1);
  assert.equal(merged.stats.upsertCount, 1);
  assert.equal(merged.stats.appendCount, 1);
});

test("mergeHighImpactEventCalendar ignores invalid override entries and keeps sorted output", () => {
  const merged = mergeHighImpactEventCalendar({
    autoPayload: {
      events: [
        {
          eventId: "z",
          title: "Z event",
          scheduledAt: "2026-04-13T10:00:00+08:00",
          importance: "high"
        }
      ]
    },
    overridePayload: {
      upserts: [
        {
          title: "missing id should be ignored"
        }
      ],
      append: [
        {
          eventId: "a",
          title: "A event",
          scheduledAt: "2026-04-11T10:00:00+08:00",
          importance: "high"
        },
        {
          eventId: "",
          title: "invalid id"
        }
      ]
    },
    generatedAt: "2026-04-10T01:10:00.000Z"
  });

  assert.deepEqual(
    merged.events.map((item) => item.eventId),
    ["a", "z"]
  );
  assert.equal(merged.stats.upsertCount, 0);
  assert.equal(merged.stats.appendCount, 1);
});

test("mergeHighImpactEventCalendar marks empty payloads as degraded coverage", () => {
  const merged = mergeHighImpactEventCalendar({
    autoPayload: { events: [] },
    overridePayload: {},
    generatedAt: "2026-04-10T01:10:00.000Z"
  });

  assert.equal(merged.coverage.readiness, "degraded");
  assert.equal(merged.coverage.reasons[0], "No high-impact events available from auto or override sources.");
});

test("buildHighImpactAutoPayloadFromTradingEconomics keeps only supported high-impact macro and central-bank events", () => {
  const payload = buildHighImpactAutoPayloadFromTradingEconomics({
    generatedAt: "2026-04-10T02:00:00.000Z",
    rows: [
      {
        CalendarId: "1",
        Date: "2026-04-11T09:30:00",
        Country: "China",
        Category: "Inflation Rate YoY",
        Event: "Inflation Rate YoY",
        Reference: "Mar",
        Forecast: "0.5%",
        Previous: "0.7%",
        Importance: 3,
        Unit: "%"
      },
      {
        CalendarId: "2",
        Date: "2026-04-11T20:30:00",
        Country: "United States",
        Category: "Consumer Price Index CPI",
        Event: "Inflation Rate YoY",
        Reference: "Mar",
        Forecast: "2.5%",
        Previous: "2.8%",
        Importance: 3,
        Unit: "%"
      },
      {
        CalendarId: "3",
        Date: "2026-04-12T02:00:00",
        Country: "United States",
        Category: "Interest Rate Decision",
        Event: "Fed Interest Rate Decision",
        Reference: "Apr",
        Forecast: "4.50%",
        Previous: "4.50%",
        Importance: 3,
        Unit: "%"
      },
      {
        CalendarId: "4",
        Date: "2026-04-12T10:00:00",
        Country: "United States",
        Category: "Consumer Confidence",
        Event: "Michigan Consumer Sentiment",
        Reference: "Apr",
        Forecast: "54.2",
        Previous: "55.1",
        Importance: 3
      }
    ]
  });

  assert.deepEqual(
    payload.events.map((item) => item.eventType),
    ["macro_release", "macro_release", "central_bank"]
  );
  assert.equal(payload.events.length, 3);
  assert.equal(payload.events[0].consensus.value, "0.5%");
  assert.equal(payload.events[1].marketTags.includes("rates"), true);
  assert.equal(payload.events[2].eventType, "central_bank");
});

test("buildHighImpactAutoPayloadFromOfficialSources extracts high-impact events from official schedule snippets", () => {
  const payload = buildHighImpactAutoPayloadFromOfficialSources({
    generatedAt: "2026-04-10T02:00:00.000Z",
    fredPages: [
      {
        source: "fred_cpi",
        releaseName: "Consumer Price Index",
        html: `
          <tr class="odd">
            <td text-align="left" colspan="2">
              <span style="font-weight: bold;">Tuesday April 14, 2026</span>
            </td>
          </tr>
          <tr>
            <td nowrap style="width:5%; text-align:right">7:30 am</td>
            <td text-align="left">
              <a href="/release?rid=10">Consumer Price Index</a>
            </td>
          </tr>
        `
      },
      {
        source: "fred_ppi",
        releaseName: "Producer Price Index",
        html: `
          <tr class="odd">
            <td text-align="left" colspan="2">
              <span style="font-weight: bold;">Wednesday April 15, 2026</span>
            </td>
          </tr>
          <tr>
            <td nowrap style="width:5%; text-align:right">7:30 am</td>
            <td text-align="left">
              <a href="/release?rid=46">Producer Price Index</a>
            </td>
          </tr>
        `
      }
    ],
    beaHtml: `
      <tr class="scheduled-releases-type-press">
        <td class="scheduled-date no-wrap">
          <div class="release-date">April 30</div>
          <small class="text-muted">8:30 AM</small>
        </td>
        <td class="release-title views-field views-field-field-scheduled-releases-type">
          GDP (Advance Estimate), 1st Quarter 2026
        </td>
      </tr>
      <tr class="scheduled-releases-type-press">
        <td class="scheduled-date no-wrap">
          <div class="release-date">April 30</div>
          <small class="text-muted">8:30 AM</small>
        </td>
        <td class="release-title views-field views-field-field-scheduled-releases-type">
          Personal Income and Outlays, March 2026
        </td>
      </tr>
    `,
    fedFomcHtml: `
      <h4><a id="42828">2026 FOMC Meetings</a></h4>
      <div class="row fomc-meeting">
        <div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>May</strong></div>
        <div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">5-6*</div>
      </div>
    `,
    nbsAnnualCalendarHtml: `
      <h1 class="con_titles">Regular Press Release Calendar of NBS in 2026</h1>
      <table>
        <tr>
          <td>Content</td>
          <td>Jan.</td>
          <td>Feb.</td>
          <td>Mar.</td>
          <td>Apr.</td>
        </tr>
        <tr>
          <td rowspan="2">Monthly Report on Consumer Price Index (CPI)</td>
          <td>9/Fri</td>
          <td>11/Wed</td>
          <td>10/Tue</td>
          <td>9/Thu</td>
        </tr>
        <tr>
          <td>9:30</td>
          <td>9:30</td>
          <td>9:30</td>
          <td>9:30</td>
        </tr>
        <tr>
          <td rowspan="2">Monthly Report on Producer Price Index in the Industrial Sector</td>
          <td>9/Fri</td>
          <td>11/Wed</td>
          <td>10/Tue</td>
          <td>9/Thu</td>
        </tr>
        <tr>
          <td>9:30</td>
          <td>9:30</td>
          <td>9:30</td>
          <td>9:30</td>
        </tr>
      </table>
    `
  });

  assert.deepEqual(
    payload.events.map((event) => event.eventId),
    [
      "cn-cpi-2026-01-09",
      "cn-ppi-2026-01-09",
      "cn-cpi-2026-02-11",
      "cn-ppi-2026-02-11",
      "cn-cpi-2026-03-10",
      "cn-ppi-2026-03-10",
      "cn-cpi-2026-04-09",
      "cn-ppi-2026-04-09",
      "us-cpi-2026-04-14",
      "us-ppi-2026-04-15",
      "us-gdp-2026-04-30",
      "us-pce-2026-04-30",
      "us-fomc-2026-05-06"
    ]
  );
  const aprilChinaCpi = payload.events.find((event) => event.eventId === "cn-cpi-2026-04-09");
  const usCpi = payload.events.find((event) => event.eventId === "us-cpi-2026-04-14");
  const fomc = payload.events.find((event) => event.eventId === "us-fomc-2026-05-06");

  assert.equal(payload.coverage.readiness, "ready");
  assert.equal(payload.sourceDiagnostics.sources.length, 5);
  assert.equal(aprilChinaCpi?.scheduledAt, "2026-04-09T09:30:00+08:00");
  assert.equal(usCpi?.marketTags.includes("rates"), true);
  assert.equal(fomc?.eventType, "central_bank");
});
