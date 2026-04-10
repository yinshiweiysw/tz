import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchEventWatch } from "./research_event_watch.mjs";

test("buildResearchEventWatch groups high-impact events into tomorrow, week, and deadline buckets", () => {
  const now = new Date("2026-04-10T08:00:00+08:00");
  const calendar = {
    generated_at: "2026-04-10T07:50:00+08:00",
    events: [
      {
        eventId: "cn-cpi-2026-04-11",
        title: "China CPI/PPI",
        eventType: "macro_release",
        importance: "high",
        scheduledAt: "2026-04-11T09:30:00+08:00",
        marketTags: ["china_policy", "rates"]
      },
      {
        eventId: "us-cpi-2026-04-11",
        title: "US CPI",
        eventType: "macro_release",
        importance: "high",
        scheduledAt: "2026-04-11T20:30:00+08:00",
        marketTags: ["rates", "fx"]
      },
      {
        eventId: "iran-truce-expiry",
        title: "US-Iran Truce Window Expiry",
        eventType: "geopolitical_window",
        importance: "high",
        scheduledAt: "2026-04-22T00:00:00+08:00",
        window: {
          endAt: "2026-04-24T23:59:59+08:00"
        },
        marketTags: ["geopolitics", "commodities"]
      },
      {
        eventId: "low-impact",
        title: "Minor event",
        eventType: "macro_release",
        importance: "low",
        scheduledAt: "2026-04-11T10:00:00+08:00"
      }
    ]
  };

  const watch = buildResearchEventWatch({
    calendar,
    now
  });

  assert.equal(watch.summary.total_high_impact_events, 3);
  assert.equal(watch.tomorrow_risks.length, 2);
  assert.equal(watch.this_week_catalysts.length, 2);
  assert.equal(watch.deadline_watch.length, 1);
  assert.equal(watch.next_event.eventId, "cn-cpi-2026-04-11");
  assert.equal(watch.deadline_watch[0].eventId, "iran-truce-expiry");
});

test("buildResearchEventWatch handles missing calendar with degraded readiness", () => {
  const watch = buildResearchEventWatch({
    calendar: null,
    now: new Date("2026-04-10T08:00:00+08:00")
  });

  assert.equal(watch.readiness, "degraded");
  assert.equal(watch.summary.total_high_impact_events, 0);
  assert.deepEqual(watch.tomorrow_risks, []);
  assert.deepEqual(watch.this_week_catalysts, []);
  assert.deepEqual(watch.deadline_watch, []);
});

test("buildResearchEventWatch treats empty calendars as degraded instead of ready", () => {
  const watch = buildResearchEventWatch({
    calendar: {
      coverage: {
        readiness: "degraded",
        reasons: ["No high-impact events available from auto or override sources."]
      },
      events: []
    },
    now: new Date("2026-04-10T08:00:00+08:00")
  });

  assert.equal(watch.readiness, "degraded");
  assert.equal(watch.summary.total_high_impact_events, 0);
});
