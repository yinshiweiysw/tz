import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapPortfolioUser } from "./bootstrap_portfolio_user.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("bootstrapPortfolioUser preserves existing account ledgers and notes on rerun", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-user-"));
  const defaultRoot = path.join(root, "portfolio");
  const usersRoot = path.join(root, "portfolio_users");
  const sharedManifestPath = path.join(defaultRoot, "state-manifest.json");

  await writeJson(sharedManifestPath, {
    canonical_entrypoints: {
      latest_macro_radar: path.join(defaultRoot, "data", "macro_radar.json"),
      latest_cn_market_snapshot: path.join(defaultRoot, "cn_market_snapshots", "latest.json")
    }
  });

  const materializeCalls = [];
  await bootstrapPortfolioUser({
    user: "demo",
    date: "2026-04-02",
    defaultRoot,
    usersRoot,
    materialize: async (options) => {
      materializeCalls.push(options);
    }
  });

  const userRoot = path.join(usersRoot, "demo");
  const latestRawPath = path.join(userRoot, "snapshots", "latest_raw.json");
  const executionLedgerPath = path.join(userRoot, "ledger", "execution_ledger.json");
  const watchlistPath = path.join(userRoot, "fund-watchlist.json");
  const accountContextPath = path.join(userRoot, "account_context.json");
  const hypothesesPath = path.join(userRoot, "hypotheses.md");
  const manifestPath = path.join(userRoot, "state-manifest.json");

  await writeJson(latestRawPath, { account_id: "demo", marker: "keep-latest-raw" });
  await writeJson(executionLedgerPath, {
    account_id: "demo",
    entries: [{ id: "keep-entry" }]
  });
  await writeJson(watchlistPath, {
    account_id: "demo",
    watchlist: [{ code: "123456" }]
  });
  await writeJson(accountContextPath, {
    account_id: "demo",
    notes: ["keep-account-context"]
  });
  await writeFile(hypothesesPath, "# keep-hypotheses\n", "utf8");

  const existingManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  existingManifest.custom_field = "keep-manifest";
  await writeJson(manifestPath, existingManifest);

  await bootstrapPortfolioUser({
    user: "demo",
    date: "2026-04-02",
    defaultRoot,
    usersRoot,
    materialize: async (options) => {
      materializeCalls.push(options);
    }
  });

  assert.deepEqual(JSON.parse(await readFile(latestRawPath, "utf8")), {
    account_id: "demo",
    marker: "keep-latest-raw"
  });
  assert.deepEqual(JSON.parse(await readFile(executionLedgerPath, "utf8")), {
    account_id: "demo",
    entries: [{ id: "keep-entry" }]
  });
  assert.deepEqual(JSON.parse(await readFile(watchlistPath, "utf8")), {
    account_id: "demo",
    watchlist: [{ code: "123456" }]
  });
  assert.deepEqual(JSON.parse(await readFile(accountContextPath, "utf8")), {
    account_id: "demo",
    notes: ["keep-account-context"]
  });
  assert.equal(await readFile(hypothesesPath, "utf8"), "# keep-hypotheses\n");

  const rerunManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(rerunManifest.custom_field, "keep-manifest");
  assert.equal(
    rerunManifest.canonical_entrypoints.latest_research_brain,
    path.join(userRoot, "data", "research_brain.json")
  );
  assert.equal(materializeCalls.length, 1);
});

test("bootstrapPortfolioUser rejects valueless boolean user input", async () => {
  await assert.rejects(
    () =>
      bootstrapPortfolioUser({
        user: true
      }),
    /Missing required --user <account_id>\./
  );
});
