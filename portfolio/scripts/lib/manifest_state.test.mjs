import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readManifestState,
  updateManifestCanonicalEntrypoints
} from "./manifest_state.mjs";
import { buildPortfolioStatePaths } from "./portfolio_state_view.mjs";

test("updateManifestCanonicalEntrypoints preserves newer disk entries while applying requested updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manifest-state-"));
  const manifestPath = path.join(tempDir, "state-manifest.json");

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        account_id: "main",
        canonical_entrypoints: {
          latest_market_brief: "/reports/on-disk-market.md",
          latest_noon_market_pulse: "/reports/on-disk-noon.md"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const updated = await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: {
      account_id: "stale",
      canonical_entrypoints: {
        latest_market_brief: "/reports/stale-market.md"
      }
    },
    entries: {
      latest_daily_brief: "/reports/new-daily.md"
    }
  });

  assert.equal(updated.account_id, "main");
  assert.equal(updated.canonical_entrypoints.latest_market_brief, "/reports/on-disk-market.md");
  assert.equal(updated.canonical_entrypoints.latest_noon_market_pulse, "/reports/on-disk-noon.md");
  assert.equal(updated.canonical_entrypoints.latest_daily_brief, "/reports/new-daily.md");
});

test("updateManifestCanonicalEntrypoints writes via atomic replace without leaving temp files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manifest-state-atomic-"));
  const manifestPath = path.join(tempDir, "state-manifest.json");

  const updated = await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: {
      account_id: "main",
      canonical_entrypoints: {}
    },
    entries: {
      latest_market_brief: "/reports/final-market.md"
    }
  });

  const persisted = await readManifestState(manifestPath);
  const entries = await readdir(tempDir);

  assert.equal(updated.canonical_entrypoints.latest_market_brief, "/reports/final-market.md");
  assert.equal(persisted.canonical_entrypoints.latest_market_brief, "/reports/final-market.md");
  assert.deepEqual(entries, ["state-manifest.json"]);
});

test("buildPortfolioStatePaths prefers latest_compat_view over latest_snapshot", () => {
  const paths = buildPortfolioStatePaths("/tmp/demo", {
    canonical_entrypoints: {
      portfolio_state: "/tmp/demo/state/portfolio_state.json",
      latest_snapshot: "/tmp/demo/latest-old.json",
      latest_compat_view: "/tmp/demo/latest-new.json"
    }
  });

  assert.equal(paths.portfolioStatePath, "/tmp/demo/state/portfolio_state.json");
  assert.equal(paths.latestCompatPath, "/tmp/demo/latest-new.json");
});

test("updateManifestCanonicalEntrypoints keeps latest alias keys aligned when latest_compat_view is updated", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manifest-state-compat-alias-"));
  const manifestPath = path.join(tempDir, "state-manifest.json");

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_snapshot: "/reports/legacy-latest.json"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const updated = await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      latest_compat_view: "/reports/compat-latest.json"
    }
  });
  const persisted = await readManifestState(manifestPath);

  assert.equal(updated.canonical_entrypoints.latest_compat_view, "/reports/compat-latest.json");
  assert.equal(updated.canonical_entrypoints.latest_snapshot, "/reports/compat-latest.json");
  assert.equal(persisted.canonical_entrypoints.latest_compat_view, "/reports/compat-latest.json");
  assert.equal(persisted.canonical_entrypoints.latest_snapshot, "/reports/compat-latest.json");
});

test("updateManifestCanonicalEntrypoints keeps latest alias keys aligned when latest_snapshot is updated", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manifest-state-legacy-alias-"));
  const manifestPath = path.join(tempDir, "state-manifest.json");

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_compat_view: "/reports/compat-latest.json"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const updated = await updateManifestCanonicalEntrypoints({
    manifestPath,
    entries: {
      latest_snapshot: "/reports/legacy-latest-next.json"
    }
  });
  const persisted = await readManifestState(manifestPath);

  assert.equal(updated.canonical_entrypoints.latest_compat_view, "/reports/legacy-latest-next.json");
  assert.equal(updated.canonical_entrypoints.latest_snapshot, "/reports/legacy-latest-next.json");
  assert.equal(persisted.canonical_entrypoints.latest_compat_view, "/reports/legacy-latest-next.json");
  assert.equal(persisted.canonical_entrypoints.latest_snapshot, "/reports/legacy-latest-next.json");
});
