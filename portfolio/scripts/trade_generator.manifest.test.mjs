import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "/Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py";

test("trade_generator does not repoint manifest trade-plan canonicals to ad-hoc temp outputs", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "trade-generator-manifest-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "signals"), { recursive: true }),
  ]);

  const canonicalJson = path.join(portfolioRoot, "data", "trade_plan_v4.json");
  const canonicalReport = path.join(portfolioRoot, "reports", "2026-04-07-next-trade-plan-regime-v4.md");
  const adHocJson = path.join(os.tmpdir(), "trade-generator-ad-hoc.json");
  const adHocReport = path.join(os.tmpdir(), "trade-generator-ad-hoc.md");

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_trade_plan_v4_json: canonicalJson,
          latest_trade_plan_v4_report: canonicalReport,
          latest_next_trade_generator: canonicalReport,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "state", "portfolio_state.json"),
    `${JSON.stringify(
      {
        account_id: "main",
        snapshot_date: "2026-04-07",
        positions: [],
        summary: {
          total_fund_assets: 0,
          available_cash_cny: 100000,
          pending_buy_confirm: 0,
          pending_sell_to_arrive: 0,
        },
        cash_ledger: {
          available_cash_cny: 100000,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "account_context.json"),
    `${JSON.stringify(
      {
        available_cash_cny: 100000,
        reported_total_assets_range_cny: { min: 450000, max: 450000 },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(portfolioRoot, "fund-watchlist.json"), `${JSON.stringify({ watchlist: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(portfolioRoot, "config", "asset_master.json"),
    `${JSON.stringify({ assets: [], buckets: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "data", "macro_state.json"),
    `${JSON.stringify({ generated_at: "2026-04-07T10:00:00+08:00", factors: {} }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(portfolioRoot, "signals", "regime_router_signals.json"),
    `${JSON.stringify({ generated_at: "2026-04-07T10:30:00+08:00", risk_budget: {}, signals: {}, errors: [] }, null, 2)}\n`,
    "utf8"
  );

  await execFileAsync("python3", [
    SCRIPT_PATH,
    "--portfolio-root",
    portfolioRoot,
    "--date",
    "2026-04-07",
    "--output-json",
    adHocJson,
    "--report-path",
    adHocReport,
  ], {
    cwd: "/Users/yinshiwei/codex/tz",
  });

  const manifest = JSON.parse(await readFile(path.join(portfolioRoot, "state-manifest.json"), "utf8"));
  assert.equal(manifest.canonical_entrypoints.latest_trade_plan_v4_json, canonicalJson);
  assert.equal(manifest.canonical_entrypoints.latest_trade_plan_v4_report, canonicalReport);
  assert.equal(manifest.canonical_entrypoints.latest_next_trade_generator, canonicalReport);
});
