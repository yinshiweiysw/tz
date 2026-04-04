import test from "node:test";
import assert from "node:assert/strict";

import { resolveNightlyBatchConfig } from "./run_nightly_confirmed_nav.mjs";

test("resolveNightlyBatchConfig lets dashed CLI run-type override the default manual label", () => {
  const config = resolveNightlyBatchConfig({
    runType: "manual",
    "run-type": "scheduled_primary",
    date: "2026-04-01"
  });

  assert.equal(config.runType, "scheduled_primary");
  assert.equal(config.targetDate, "2026-04-01");
});
