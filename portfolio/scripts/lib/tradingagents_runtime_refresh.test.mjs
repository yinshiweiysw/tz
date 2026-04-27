import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  classifyTradingDecisionRefreshNeed,
  createTradingAgentsBackgroundScheduler
} from "./tradingagents_runtime_refresh.mjs";

test("classifyTradingDecisionRefreshNeed requires refresh for missing or degraded snapshots", () => {
  assert.deepEqual(classifyTradingDecisionRefreshNeed(null, {
    now: new Date("2026-04-25T09:30:00+08:00")
  }), {
    needsRefresh: true,
    reason: "decision_snapshot_missing"
  });

  assert.deepEqual(
    classifyTradingDecisionRefreshNeed(
      {
        mode: "fallback_fixture",
        asOf: "2026-04-25",
        diagnostics: {
          freshnessLabel: "fresh"
        }
      },
      {
        now: new Date("2026-04-25T09:30:00+08:00")
      }
    ),
    {
      needsRefresh: true,
      reason: "decision_snapshot_not_live"
    }
  );

  assert.deepEqual(
    classifyTradingDecisionRefreshNeed(
      {
        mode: "live",
        asOf: "2026-04-24",
        diagnostics: {
          freshnessLabel: "fresh"
        }
      },
      {
        now: new Date("2026-04-25T09:30:00+08:00")
      }
    ),
    {
      needsRefresh: true,
      reason: "decision_snapshot_out_of_date"
    }
  );
});

test("classifyTradingDecisionRefreshNeed skips refresh for same-day fresh live snapshot", () => {
  assert.deepEqual(
    classifyTradingDecisionRefreshNeed(
      {
        mode: "live",
        asOf: "2026-04-25",
        diagnostics: {
          freshnessLabel: "fresh"
        }
      },
      {
        now: new Date("2026-04-25T09:30:00+08:00")
      }
    ),
    {
      needsRefresh: false,
      reason: "decision_snapshot_fresh"
    }
  );
});

test("classifyTradingDecisionRefreshNeed backs off recent provider failures", () => {
  assert.deepEqual(
    classifyTradingDecisionRefreshNeed(
      {
        generatedAt: "2026-04-25T01:20:00.000Z",
        mode: "fallback_fixture",
        asOf: "2026-04-25",
        diagnostics: {
          providerError: "provider_rate_limited:glm",
          freshnessLabel: "fresh"
        }
      },
      {
        now: new Date("2026-04-25T09:30:00+08:00")
      }
    ),
    {
      needsRefresh: false,
      reason: "provider_cooldown:provider_rate_limited:glm"
    }
  );

  assert.deepEqual(
    classifyTradingDecisionRefreshNeed(
      {
        generatedAt: "2026-04-25T00:30:00.000Z",
        mode: "fallback_fixture",
        asOf: "2026-04-25",
        diagnostics: {
          providerError: "provider_rate_limited:glm",
          freshnessLabel: "fresh"
        }
      },
      {
        now: new Date("2026-04-25T09:30:00+08:00")
      }
    ),
    {
      needsRefresh: true,
      reason: "decision_snapshot_not_live"
    }
  );
});

test("classifyTradingDecisionRefreshNeed backs off recent cache warmup failures", () => {
  assert.deepEqual(
    classifyTradingDecisionRefreshNeed(
      {
        generatedAt: "2026-04-25T01:20:00.000Z",
        mode: "fallback_fixture",
        asOf: "2026-04-25",
        diagnostics: {
          providerError: "tradingagents_symbol_cache_incomplete fresh=none missing=QQQ stale=none",
          freshnessLabel: "fresh"
        }
      },
      {
        now: new Date("2026-04-25T09:30:00+08:00")
      }
    ),
    {
      needsRefresh: false,
      reason: "cache_warmup_cooldown:tradingagents_symbol_cache_incomplete fresh=none missing=QQQ stale=none"
    }
  );
});

test("createTradingAgentsBackgroundScheduler runs prewarm then decision cycle and debounces repeated requests", async () => {
  const spawnCalls = [];
  const fakeSpawn = (command, args) => {
    spawnCalls.push([command, args]);
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.stdout.setEncoding = () => {};
    process.stderr.setEncoding = () => {};

    queueMicrotask(() => {
      process.stdout.emit(
        "data",
        `${JSON.stringify({
          ok: true,
          script: args[0]
        })}\n`
      );
      process.emit("close", 0, null);
    });

    return process;
  };

  let tick = 0;
  const scheduler = createTradingAgentsBackgroundScheduler({
    spawnFn: fakeSpawn,
    nodeBinary: "node",
    now: () => new Date(`2026-04-25T09:${String(30 + tick++).padStart(2, "0")}:00+08:00`)
  });

  const first = scheduler.schedule({
    accountId: "main",
    portfolioRoot: "/tmp/portfolio",
    snapshot: null,
    reason: "api_trading_decision_read"
  });
  const second = scheduler.schedule({
    accountId: "main",
    portfolioRoot: "/tmp/portfolio",
    snapshot: null,
    reason: "api_trading_decision_read"
  });

  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, false);
  assert.equal(second.reason, "background_refresh_inflight");

  await scheduler.getState("main").currentPromise;

  assert.equal(spawnCalls.length, 2);
  assert.match(spawnCalls[0][1][0], /run_tradingagents_prewarm\.mjs$/);
  assert.match(spawnCalls[1][1][0], /run_tradingagents_decision_cycle\.mjs$/);
  assert.equal(spawnCalls[1][1].includes("--cache-only"), true);
  assert.equal(scheduler.getState("main").lastError, null);

  const third = scheduler.schedule({
    accountId: "main",
    portfolioRoot: "/tmp/portfolio",
    snapshot: null,
    reason: "api_trading_decision_read"
  });
  assert.equal(third.scheduled, false);
  assert.equal(third.reason, "background_refresh_debounced");
});
