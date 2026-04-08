import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  buildNightlyConfirmedNavStatusPath,
  readNightlyConfirmedNavStatus,
  resolveNightlyConfirmedNavReadiness,
  writeNightlyConfirmedNavStatus
} from "./nightly_confirmed_nav_status.mjs";

test("writeNightlyConfirmedNavStatus persists payload under data/nightly_confirmed_nav_status.json", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "nightly-nav-status-"));
  const payload = {
    generatedAt: "2026-04-02T14:30:05.000Z",
    runType: "scheduled_primary",
    targetDate: "2026-04-01",
    accounts: [
      {
        accountId: "main",
        success: true,
        snapshotDate: "2026-04-01"
      }
    ],
    successCount: 1,
    failureCount: 0
  };

  const statusPath = await writeNightlyConfirmedNavStatus(payload, {
    portfolioRoot: workspace
  });

  assert.equal(
    statusPath,
    buildNightlyConfirmedNavStatusPath({ portfolioRoot: workspace })
  );

  const reloaded = await readNightlyConfirmedNavStatus({
    portfolioRoot: workspace
  });
  assert.deepEqual(reloaded, payload);

  const raw = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(raw.accounts[0].accountId, "main");
});

test("resolveNightlyConfirmedNavReadiness marks matching successful reconcile as confirmed_nav_ready", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-01T14:30:05.000Z",
      runType: "scheduled_primary",
      targetDate: "2026-04-01",
      accounts: [
        {
          accountId: "wenge",
          success: true,
          snapshotDate: "2026-04-01",
          finishedAt: "2026-04-01T14:30:07.000Z"
        }
      ]
    },
    accountId: "wenge",
    snapshotDate: "2026-04-01",
    now: new Date("2026-04-02T00:30:00.000Z")
  });

  assert.equal(readiness.state, "confirmed_nav_ready");
  assert.equal(readiness.shouldTriggerSelfHeal, false);
  assert.equal(readiness.accountRun?.snapshotDate, "2026-04-01");
});

test("resolveNightlyConfirmedNavReadiness returns blocked when prior-night reconcile is missing after morning cutoff", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-01T14:30:05.000Z",
      runType: "scheduled_primary",
      targetDate: "2026-04-01",
      accounts: []
    },
    accountId: "main",
    snapshotDate: "2026-04-01",
    now: new Date("2026-04-02T00:30:00.000Z")
  });

  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.shouldTriggerSelfHeal, false);
  assert.equal(readiness.targetDate, "2026-04-01");
});

test("resolveNightlyConfirmedNavReadiness returns blocked when latest reconcile run failed on missing dependency", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-02T00:31:05.000Z",
      runType: "self_heal_on_read",
      targetDate: "2026-04-01",
      accounts: [
        {
          accountId: "main",
          success: false,
          snapshotDate: "2026-04-01",
          runType: "self_heal_on_read",
          error: "network timeout"
        }
      ]
    },
    accountId: "main",
    snapshotDate: "2026-04-01",
    now: new Date("2026-04-02T00:40:00.000Z")
  });

  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.shouldTriggerSelfHeal, false);
  assert.match(readiness.reason ?? "", /network timeout/i);
});

test("resolveNightlyConfirmedNavReadiness anchors morning status to the prior-night reconcile even if live snapshot_date already advanced to today", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-02T00:31:05.000Z",
      runType: "scheduled_primary",
      targetDate: "2026-04-01",
      accounts: [
        {
          accountId: "main",
          success: true,
          snapshotDate: "2026-04-01",
          runType: "scheduled_primary"
        }
      ]
    },
    accountId: "main",
    snapshotDate: "2026-04-02",
    now: new Date("2026-04-02T02:30:00.000Z")
  });

  assert.equal(readiness.state, "confirmed_nav_ready");
  assert.equal(readiness.targetDate, "2026-04-01");
  assert.equal(readiness.accountRun?.snapshotDate, "2026-04-01");
});

test("resolveNightlyConfirmedNavReadiness treats acceptable overseas lag as partially_confirmed_normal_lag", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-03T01:31:05.000Z",
      runType: "self_heal_on_read",
      targetDate: "2026-04-02",
      accounts: [
        {
          accountId: "main",
          success: true,
          snapshotDate: "2026-04-02",
          runType: "self_heal_on_read",
          stats: {
            fullyConfirmedForDate: false,
            normalLagFundCount: 7,
            holidayDelayFundCount: 0,
            lateMissingFundCount: 0,
            sourceMissingFundCount: 0
          }
        }
      ]
    },
    accountId: "main",
    snapshotDate: "2026-04-03",
    now: new Date("2026-04-03T02:40:00.000Z")
  });

  assert.equal(readiness.state, "partially_confirmed_normal_lag");
  assert.equal(readiness.shouldTriggerSelfHeal, false);
  assert.equal(readiness.targetDate, "2026-04-02");
});

test("resolveNightlyConfirmedNavReadiness anchors to previous CN trading day across holidays", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-07T01:31:05.000Z",
      runType: "scheduled_primary",
      targetDate: "2026-04-03",
      accounts: [
        {
          accountId: "main",
          success: true,
          snapshotDate: "2026-04-03",
          runType: "scheduled_primary"
        }
      ]
    },
    accountId: "main",
    snapshotDate: "2026-04-07",
    now: new Date("2026-04-07T02:40:00.000Z")
  });

  assert.equal(readiness.state, "confirmed_nav_ready");
  assert.equal(readiness.targetDate, "2026-04-03");
  assert.equal(readiness.accountRun?.snapshotDate, "2026-04-03");
});

test("resolveNightlyConfirmedNavReadiness surfaces source_missing when reconcile stats report source gaps", () => {
  const readiness = resolveNightlyConfirmedNavReadiness({
    statusPayload: {
      generatedAt: "2026-04-03T01:31:05.000Z",
      runType: "scheduled_primary",
      targetDate: "2026-04-02",
      accounts: [
        {
          accountId: "main",
          success: false,
          snapshotDate: "2026-04-02",
          stats: {
            normalLagFundCount: 0,
            holidayDelayFundCount: 0,
            lateMissingFundCount: 0,
            sourceMissingFundCount: 2
          }
        }
      ]
    },
    accountId: "main",
    snapshotDate: "2026-04-02",
    now: new Date("2026-04-03T02:40:00.000Z")
  });

  assert.equal(readiness.state, "source_missing");
  assert.equal(readiness.shouldTriggerSelfHeal, false);
});
