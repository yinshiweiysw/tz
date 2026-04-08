import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runStrategyDecisionContractBuild } from "./build_strategy_decision_contract.mjs";

test("runStrategyDecisionContractBuild writes canonical and observable position facts from runtime context", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "strategy-contract-"));
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    path.join(tmpRoot, "state-manifest.json"),
    JSON.stringify({ canonical_entrypoints: {} }, null, 2),
    "utf8"
  );

  await writeFile(
    path.join(dataDir, "agent_runtime_context.json"),
    JSON.stringify(
      {
        generatedAt: "2026-04-08T10:41:38.571Z",
        accountId: "main",
        snapshotDate: "2026-04-08",
        meta: {
          dataFreshnessSummary: "degraded"
        },
        portfolio: {
          settledCashCny: 52436.16,
          tradeAvailableCashCny: 52436.16,
          cashLikeFundAssetsCny: 105251.47,
          liquiditySleeveAssetsCny: 105251.47
        },
        positions: [
          {
            name: "华夏恒生互联网科技业ETF联接(QDII)D",
            code: "023764",
            bucketKey: "TACTICAL",
            category: "港股互联网/QDII",
            units: 111526.24574435,
            amount: 68800,
            observableAmount: 69414.58,
            costBasis: 88074.81,
            holdingPnl: -19274.81,
            observableHoldingPnl: -18660.23,
            quoteMode: "close_reference",
            quoteDate: "2026-04-08",
            confirmationState: "confirmed"
          }
        ],
        bucketView: [],
        systemState: {
          confirmedNavState: "partially_confirmed_normal_lag",
          blockedReason: null
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    path.join(dataDir, "trade_plan_v4.json"),
    JSON.stringify({ summary: { maxTotalBuyTodayCny: 18000 } }, null, 2),
    "utf8"
  );

  await mkdir(path.join(tmpRoot, "signals"), { recursive: true });
  await writeFile(
    path.join(tmpRoot, "signals", "regime_router_signals.json"),
    JSON.stringify({ market_regime: "risk_on_rebound" }, null, 2),
    "utf8"
  );

  const { outputPath, payload } = await runStrategyDecisionContractBuild({
    portfolioRoot: tmpRoot,
    user: "main"
  });

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(payload.positionFacts[0].amountCny, 69414.58);
  assert.equal(payload.positionFacts[0].decisionValueSource, "observable");
  assert.equal(written.cashSemantics.tradeAvailableCashCny, 52436.16);
  assert.equal(written.freshness.confirmedNavState, "partially_confirmed_normal_lag");

  const manifest = JSON.parse(await readFile(path.join(tmpRoot, "state-manifest.json"), "utf8"));
  assert.equal(manifest.canonical_entrypoints.strategy_decision_contract, outputPath);
  assert.equal(
    manifest.canonical_entrypoints.strategy_decision_contract_builder,
    path.join(tmpRoot, "scripts", "build_strategy_decision_contract.mjs")
  );
});
