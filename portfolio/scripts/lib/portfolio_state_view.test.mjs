import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { loadCanonicalPortfolioState } from "./portfolio_state_view.mjs";

test("loadCanonicalPortfolioState returns portfolio_state and ignores latest compatibility payload", async () => {
  const portfolioRoot = await mkdtemp(path.join(tmpdir(), "portfolio-state-view-"));
  await mkdir(path.join(portfolioRoot, "state"), { recursive: true });
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    JSON.stringify({ positions: [], snapshot_date: "2026-04-03" }),
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "latest.json"),
    JSON.stringify({ holdings: [{ code: "007339" }], snapshot_date: "2026-04-02" }),
    "utf8"
  );

  const result = await loadCanonicalPortfolioState({ portfolioRoot });

  assert.equal(result.sourceKind, "portfolio_state");
  assert.equal(result.payload.snapshot_date, "2026-04-03");
  assert.deepEqual(result.payload.positions, []);
});

test("loadCanonicalPortfolioState fails fast instead of falling back to latest compatibility view", async () => {
  const portfolioRoot = await mkdtemp(path.join(tmpdir(), "portfolio-state-view-"));
  await writeFile(
    path.join(portfolioRoot, "latest.json"),
    JSON.stringify({ holdings: [{ code: "007339" }], snapshot_date: "2026-04-02" }),
    "utf8"
  );

  await assert.rejects(
    () => loadCanonicalPortfolioState({ portfolioRoot }),
    /portfolio_state\.json is required/i
  );
});
