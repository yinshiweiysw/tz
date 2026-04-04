import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { runFundsPluginChromeSync } from "./sync_funds_plugin_to_chrome.mjs";

test("runFundsPluginChromeSync refreshes canonical sidecars before submitting payload to Chrome", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-sync-success-"));
  const statusPath = path.join(portfolioRoot, "plugin_sync_status.json");
  const importFile = path.join(portfolioRoot, "funds-plugin-import.json");
  const callOrder = [];

  const result = await runFundsPluginChromeSync(
    {
      portfolioRoot,
      statusPath,
      output: importFile
    },
    {
      runRefreshAccountSidecars: async (options) => {
        callOrder.push(["refresh", options.scopes]);
        return { outputs: {} };
      },
      buildFundsPluginPayload: async () => {
        callOrder.push(["payload"]);
        return {
          fundListM: [{ code: "007339", num: 123.45 }]
        };
      },
      openExtensionOptionsTab: async () => {
        callOrder.push(["open"]);
        return "chrome-extension://demo/options/options.html";
      },
      executeChromeJavaScript: async () => {
        callOrder.push(["execute"]);
        return JSON.stringify({ ok: true, mode: "dom_file_input_dispatched" });
      }
    }
  );

  const expectedAccountId = path.basename(portfolioRoot);
  assert.deepEqual(callOrder, [
    ["refresh", "live_funds_snapshot,nightly_confirmed_nav_status"],
    ["payload"],
    ["open"],
    ["execute"]
  ]);
  assert.equal(result.status, "submitted_to_chrome_extension");
  assert.equal(result.error, null);

  const persistedStatus = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(persistedStatus.status, "submitted_to_chrome_extension");
  assert.equal(persistedStatus.error, null);
  assert.equal(persistedStatus.accountId, expectedAccountId);
  assert.equal(persistedStatus.portfolioRoot, portfolioRoot);
  assert.equal(persistedStatus.importFile, importFile);
});

test("runFundsPluginChromeSync writes stable failure status with readable error", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-sync-failure-"));
  const statusPath = path.join(portfolioRoot, "plugin_sync_status.json");
  const importFile = path.join(portfolioRoot, "funds-plugin-import.json");

  await assert.rejects(
    runFundsPluginChromeSync(
      {
        portfolioRoot,
        statusPath,
        output: importFile
      },
      {
        runRefreshAccountSidecars: async () => ({ outputs: {} }),
        buildFundsPluginPayload: async () => ({ fundListM: [] }),
        openExtensionOptionsTab: async () => "chrome-extension://demo/options/options.html",
        executeChromeJavaScript: async () => {
          throw new Error("Chrome JavaScript bridge unavailable");
        }
      }
    ),
    /Chrome JavaScript bridge unavailable/
  );

  const persistedStatus = JSON.parse(await readFile(statusPath, "utf8"));
  const expectedAccountId = path.basename(portfolioRoot);
  assert.equal(persistedStatus.status, "sync_failed");
  assert.match(persistedStatus.error ?? "", /Chrome JavaScript bridge unavailable/);
  assert.equal(persistedStatus.accountId, expectedAccountId);
  assert.equal(persistedStatus.portfolioRoot, portfolioRoot);
  assert.equal(persistedStatus.importFile, importFile);
  assert.equal(typeof persistedStatus.timestamp, "string");
});
