import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  loadAutoEventsDefault,
  runHighImpactEventCalendarBuild
} from "./build_high_impact_event_calendar.mjs";

test("runHighImpactEventCalendarBuild writes canonical file and updates manifest entrypoints", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "high-impact-build-"));
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "high_impact_event_calendar.override.json"),
    `${JSON.stringify(
      {
        upserts: [
          {
            eventId: "us-cpi-2026-04",
            consensus: { value: 3.3, unit: "%" },
            source: "manual_override"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runHighImpactEventCalendarBuild(
    {
      portfolioRoot,
      user: "main"
    },
    {
      loadAutoEvents: async () => ({
        generatedAt: "2026-04-10T01:00:00.000Z",
        events: [
          {
            eventId: "us-cpi-2026-04",
            title: "US CPI",
            scheduledAt: "2026-04-11T20:30:00+08:00",
            importance: "high",
            source: "auto"
          }
        ]
      }),
      nowIso: () => "2026-04-10T01:10:00.000Z"
    }
  );

  const outputPath = path.join(portfolioRoot, "data", "high_impact_event_calendar.json");
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));

  assert.equal(result.outputPath, outputPath);
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.events[0].consensus.value, 3.3);
  assert.equal(
    manifest.canonical_entrypoints.high_impact_event_calendar,
    path.join(portfolioRoot, "data", "high_impact_event_calendar.json")
  );
  assert.equal(
    manifest.canonical_entrypoints.high_impact_event_calendar_builder,
    path.join(portfolioRoot, "scripts", "build_high_impact_event_calendar.mjs")
  );
  assert.equal(
    manifest.canonical_entrypoints.high_impact_event_calendar_override,
    path.join(portfolioRoot, "data", "high_impact_event_calendar.override.json")
  );
});

test("loadAutoEventsDefault degrades honestly when official sources are unavailable and cache is empty", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "high-impact-auto-"));
  await mkdir(path.join(portfolioRoot, "data"), { recursive: true });
  const autoPath = path.join(portfolioRoot, "data", "high_impact_event_calendar.auto.json");

  const payload = await loadAutoEventsDefault({
    autoPath,
    fetchImpl: async () => {
      throw new Error("upstream denied");
    },
    now: new Date("2026-04-10T08:00:00+08:00")
  });

  assert.equal(payload.events.length, 0);
  assert.equal(payload.coverage.readiness, "degraded");
  assert.equal(payload.sourceDiagnostics.cache.status, "miss");
  assert.equal(payload.sourceDiagnostics.sources.some((item) => item.status === "failed"), true);
  assert.match(payload.coverage.reasons.join(" "), /upstream denied/i);
});
