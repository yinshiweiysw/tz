import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildReportSessionInheritanceLines,
  buildReportSessionRecord,
  isClosingSessionRecord,
  isClosingSessionSlot,
  mergeReportSessionMemory,
  readReportSessionMemory,
  resolveReportSessionSlot,
  updateReportSessionMemory
  ,
  writeReportSessionMemory
} from "./report_session_memory.mjs";

function buildResearchBrain({
  primaryDriver = "关税与贸易摩擦冲击全球风险偏好",
  liquidityRegime = "risk_off",
  tradePermission = "restricted",
  generatedAt = "2026-04-03T04:00:00.000Z"
} = {}) {
  return {
    generated_at: generatedAt,
    event_driver: {
      status: "active_market_driver",
      primary_driver: primaryDriver,
      expectation_gap: "现实反应强于盘前预期。"
    },
    flow_macro_radar: {
      liquidity_regime: liquidityRegime,
      summary: "美元与黄金同步走强。"
    },
    actionable_decision: {
      desk_conclusion: {
        trade_permission: tradePermission,
        one_sentence_order: "仅允许小步执行。"
      }
    },
    section_confidence: {
      actionable_decision: "medium"
    }
  };
}

test("updateReportSessionMemory stores morning and noon snapshots under the same trade date", () => {
  const morningRecord = buildReportSessionRecord({
    tradeDate: "2026-04-03",
    session: "morning",
    reportType: "market_pulse",
    researchBrain: buildResearchBrain()
  });
  const noonRecord = buildReportSessionRecord({
    tradeDate: "2026-04-03",
    session: "noon",
    reportType: "market_pulse",
    researchBrain: buildResearchBrain({
      liquidityRegime: "risk_off",
      tradePermission: "restricted",
      generatedAt: "2026-04-03T08:00:00.000Z"
    })
  });

  let memory = updateReportSessionMemory({}, morningRecord);
  memory = updateReportSessionMemory(memory, noonRecord);

  assert.equal(memory.days["2026-04-03"].morning.primary_driver, "关税与贸易摩擦冲击全球风险偏好");
  assert.equal(memory.days["2026-04-03"].noon.trade_permission, "restricted");
});

test("buildReportSessionInheritanceLines validates noon session against morning hypothesis", () => {
  const memory = updateReportSessionMemory(
    {},
    buildReportSessionRecord({
      tradeDate: "2026-04-03",
      session: "morning",
      reportType: "market_pulse",
      researchBrain: buildResearchBrain()
    })
  );
  const currentRecord = buildReportSessionRecord({
    tradeDate: "2026-04-03",
    session: "noon",
    reportType: "market_pulse",
    researchBrain: buildResearchBrain({
      liquidityRegime: "risk_off",
      tradePermission: "restricted"
    })
  });

  const lines = buildReportSessionInheritanceLines({
    memory,
    tradeDate: "2026-04-03",
    session: "noon",
    currentRecord
  });

  assert.ok(lines.some((line) => line.includes("早盘假设")));
  assert.ok(lines.some((line) => line.includes("午间验证：已验证")));
});

test("buildReportSessionInheritanceLines emits next-trading-day bias on close", () => {
  let memory = updateReportSessionMemory(
    {},
    buildReportSessionRecord({
      tradeDate: "2026-04-03",
      session: "morning",
      reportType: "market_pulse",
      researchBrain: buildResearchBrain()
    })
  );
  memory = updateReportSessionMemory(
    memory,
    buildReportSessionRecord({
      tradeDate: "2026-04-03",
      session: "noon",
      reportType: "market_pulse",
      researchBrain: buildResearchBrain()
    })
  );
  const currentRecord = buildReportSessionRecord({
    tradeDate: "2026-04-03",
    session: "close",
    reportType: "market_brief",
    researchBrain: buildResearchBrain({
      tradePermission: "allowed"
    })
  });

  const lines = buildReportSessionInheritanceLines({
    memory,
    tradeDate: "2026-04-03",
    session: "close",
    currentRecord
  });

  assert.ok(lines.some((line) => line.includes("收盘归因")));
  assert.ok(lines.some((line) => line.includes("下一交易日偏置")));
});

test("resolveReportSessionSlot maps research brain market_session into report memory slots", () => {
  assert.equal(
    resolveReportSessionSlot({
      researchBrain: {
        meta: {
          market_session: "pre_open"
        }
      }
    }),
    "morning"
  );
  assert.equal(
    resolveReportSessionSlot({
      researchBrain: {
        meta: {
          market_session: "intraday"
        }
      }
    }),
    "noon"
  );
  assert.equal(
    resolveReportSessionSlot({
      researchBrain: {
        meta: {
          market_session: "post_close"
        }
      }
    }),
    "close"
  );
});

test("isClosingSessionSlot only treats close memory slot as terminal close state", () => {
  assert.equal(isClosingSessionSlot("morning"), false);
  assert.equal(isClosingSessionSlot("noon"), false);
  assert.equal(isClosingSessionSlot("close"), true);
});

test("isClosingSessionRecord rejects intraday records that were previously mislabeled as close", () => {
  assert.equal(
    isClosingSessionRecord({
      session: "close",
      market_session: "intraday",
      generated_at: "2026-04-03T06:56:39.273Z"
    }),
    false
  );
  assert.equal(
    isClosingSessionRecord({
      session: "close",
      market_session: "post_close",
      generated_at: "2026-04-03T08:30:00.000Z"
    }),
    true
  );
});

test("mergeReportSessionMemory preserves unrelated newer slots from disk and prefers fresher records", () => {
  const existingMemory = {
    generated_at: "2026-04-03T00:30:00.000Z",
    updated_at: "2026-04-03T04:00:00.000Z",
    days: {
      "2026-04-03": {
        morning: {
          session: "morning",
          generated_at: "2026-04-03T00:30:00.000Z",
          primary_driver: "盘前主线"
        },
        noon: {
          session: "noon",
          generated_at: "2026-04-03T04:00:00.000Z",
          primary_driver: "午间主线"
        }
      }
    }
  };
  const incomingMemory = {
    generated_at: "2026-04-03T00:30:00.000Z",
    updated_at: "2026-04-03T07:20:00.000Z",
    days: {
      "2026-04-03": {
        noon: {
          session: "noon",
          generated_at: "2026-04-03T03:30:00.000Z",
          primary_driver: "过期午间主线"
        },
        close: {
          session: "close",
          generated_at: "2026-04-03T07:20:00.000Z",
          market_session: "post_close",
          primary_driver: "收盘主线"
        }
      }
    }
  };

  const merged = mergeReportSessionMemory(existingMemory, incomingMemory);

  assert.equal(merged.days["2026-04-03"].morning.primary_driver, "盘前主线");
  assert.equal(merged.days["2026-04-03"].noon.primary_driver, "午间主线");
  assert.equal(merged.days["2026-04-03"].close.primary_driver, "收盘主线");
  assert.equal(merged.updated_at, "2026-04-03T07:20:00.000Z");
});

test("writeReportSessionMemory re-reads and merges current disk state before persisting", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "report-session-memory-"));
  const filePath = path.join(tempDir, "report_session_memory.json");
  const diskState = {
    generated_at: "2026-04-03T00:30:00.000Z",
    updated_at: "2026-04-03T04:00:00.000Z",
    days: {
      "2026-04-03": {
        morning: {
          session: "morning",
          generated_at: "2026-04-03T00:30:00.000Z",
          primary_driver: "盘前主线"
        },
        noon: {
          session: "noon",
          generated_at: "2026-04-03T04:00:00.000Z",
          primary_driver: "午间主线"
        }
      }
    }
  };

  await writeReportSessionMemory(filePath, diskState);

  const staleCallerMemory = {
    generated_at: "2026-04-03T00:30:00.000Z",
    updated_at: "2026-04-03T07:20:00.000Z",
    days: {
      "2026-04-03": {
        morning: {
          session: "morning",
          generated_at: "2026-04-03T00:30:00.000Z",
          primary_driver: "盘前主线"
        },
        close: {
          session: "close",
          generated_at: "2026-04-03T07:20:00.000Z",
          market_session: "post_close",
          primary_driver: "收盘主线"
        }
      }
    }
  };

  await writeReportSessionMemory(filePath, staleCallerMemory);
  const persisted = await readReportSessionMemory(filePath);
  const entries = await readdir(tempDir);

  assert.equal(persisted.days["2026-04-03"].morning.primary_driver, "盘前主线");
  assert.equal(persisted.days["2026-04-03"].noon.primary_driver, "午间主线");
  assert.equal(persisted.days["2026-04-03"].close.primary_driver, "收盘主线");
  assert.deepEqual(entries, ["report_session_memory.json"]);
});
