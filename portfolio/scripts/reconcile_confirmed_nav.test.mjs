import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { runConfirmedNavReconcile } from "./reconcile_confirmed_nav.mjs";

async function writeJson(targetPath, payload) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("runConfirmedNavReconcile refreshes only live snapshot and nightly status sidecars", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "reconcile-confirmed-nav-"));
  const latestRawPath = path.join(portfolioRoot, "snapshots", "latest_raw.json");
  const watchlistPath = path.join(portfolioRoot, "fund-watchlist.json");
  const assetMasterPath = path.join(portfolioRoot, "config", "asset_master.json");

  await writeJson(latestRawPath, {
    snapshot_date: "2026-04-06",
    positions: [
      {
        name: "兴全恒信债券C",
        code: "016482",
        symbol: "016482",
        fund_code: "016482",
        amount: 70000,
        status: "active",
        execution_type: "OTC"
      }
    ],
    summary: {
      total_fund_assets: 70000,
      available_cash_cny: 1000
    }
  });
  await writeJson(watchlistPath, {
    account_id: "main",
    as_of: "2026-04-06",
    watchlist: [{ code: "016482", name: "兴全恒信债券C" }]
  });
  await writeJson(assetMasterPath, {
    assets: [{ symbol: "016482", name: "兴全恒信债券C", bucket: "INCOME" }]
  });

  let receivedRefreshOptions = null;
  let receivedNightlyStatusPayload = null;

  const result = await runConfirmedNavReconcile(
    {
      portfolioRoot,
      user: "main",
      date: "2026-04-06"
    },
    {
      getFundQuotes: async () => [
        {
          code: "016482",
          netValue: 1.0001,
          netValueDate: "2026-04-06",
          valuation: 1.0001,
          valuationTime: "2026-04-06 15:00",
          valuationChangePercent: 0.01,
          growthRate: 0.01
        }
      ],
      reconcileRawSnapshotWithConfirmedQuotes: ({ rawSnapshot }) => ({
        rawSnapshot: {
          ...rawSnapshot,
          snapshot_date: "2026-04-06"
        },
        watchlistConfig: null,
        stats: {
          fullyConfirmedForDate: true
        }
      }),
      materializePortfolioRoot: async () => ({ stats: { updated: true } }),
      runRefreshAccountSidecars: async (options) => {
        receivedRefreshOptions = options;
        return {
          outputs: {
            liveFundsSnapshotPath: path.join(portfolioRoot, "data", "live_funds_snapshot.json")
          }
        };
      },
      writeNightlyConfirmedNavStatus: async (payload) => {
        receivedNightlyStatusPayload = payload;
        return path.join(portfolioRoot, "data", "nightly_confirmed_nav_status.json");
      }
    }
  );

  assert.equal(receivedRefreshOptions?.scopes, "live_funds_snapshot");
  assert.equal(receivedNightlyStatusPayload?.accounts?.[0]?.success, true);
  assert.equal(receivedNightlyStatusPayload?.accounts?.[0]?.stats?.fullyConfirmedForDate, true);
  assert.equal(result.snapshotDate, "2026-04-06");

  const persistedRaw = JSON.parse(await readFile(latestRawPath, "utf8"));
  assert.equal(persistedRaw.snapshot_date, "2026-04-06");
});
