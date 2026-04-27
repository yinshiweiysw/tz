import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { syncMarketTopicReports } from "./market_report_sync.mjs";

test("syncMarketTopicReports copies legacy report pointers into simplified portfolio root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "market-report-sync-"));
  const sourceRoot = path.join(parent, "tz", "portfolio");
  const portfolioRoot = path.join(parent, "tz-main-simplified", "portfolio");
  await Promise.all([
    mkdir(path.join(sourceRoot, "market_pulses"), { recursive: true }),
    mkdir(path.join(sourceRoot, "market_briefs"), { recursive: true }),
    mkdir(path.join(sourceRoot, "data"), { recursive: true }),
    mkdir(portfolioRoot, { recursive: true })
  ]);

  const pulsePath = path.join(sourceRoot, "market_pulses", "2026-04-27-morning.md");
  const briefPath = path.join(sourceRoot, "market_briefs", "2026-04-24-market.md");
  const eventPath = path.join(sourceRoot, "data", "high_impact_event_calendar.json");
  await writeFile(pulsePath, "# 2026-04-27 早盘脉冲\n\n- 半导体偏强\n", "utf8");
  await writeFile(briefPath, "# 2026-04-24 市场日报\n\n- 结构轮动\n", "utf8");
  await writeFile(eventPath, "{\"events\":[]}\n", "utf8");
  await writeFile(
    path.join(sourceRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_morning_market_pulse: pulsePath,
          latest_market_brief: briefPath,
          high_impact_event_calendar: eventPath,
          latest_daily_brief: path.join(sourceRoot, "missing.md")
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify({ canonical_entrypoints: {} }, null, 2)}\n`,
    "utf8"
  );

  const result = await syncMarketTopicReports({
    portfolioRoot,
    sourcePortfolioRoot: sourceRoot
  });
  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));
  const syncStatus = JSON.parse(await readFile(path.join(portfolioRoot, "data", "market_topics_sync_status.json"), "utf8"));

  assert.equal(result.status, "synced");
  assert.equal(result.copied.length, 3);
  assert.equal(result.syncStatus.status, "synced");
  assert.equal(syncStatus.entryCount, 3);
  assert.equal(manifest.canonical_entrypoints.market_topics_sync_status, path.join(portfolioRoot, "data", "market_topics_sync_status.json"));
  assert.match(manifest.canonical_entrypoints.latest_morning_market_pulse, /tz-main-simplified\/portfolio\/market_pulses/);
  assert.equal(await readFile(manifest.canonical_entrypoints.latest_market_brief, "utf8"), "# 2026-04-24 市场日报\n\n- 结构轮动\n");
  assert.equal(manifest.canonical_entrypoints.latest_daily_brief, undefined);
});

test("syncMarketTopicReports skips cleanly when source manifest is unavailable", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "market-report-sync-missing-"));
  const result = await syncMarketTopicReports({
    portfolioRoot,
    sourcePortfolioRoot: path.join(portfolioRoot, "missing-source")
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "source_manifest_missing");
  assert.deepEqual(result.copied, []);
  assert.equal(result.syncStatus.status, "skipped");
  assert.equal(
    JSON.parse(await readFile(path.join(portfolioRoot, "data", "market_topics_sync_status.json"), "utf8")).reason,
    "source_manifest_missing"
  );
});
