import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExecutionPermission } from "./execution_permission_gate.mjs";

test("blocked research permission rejects buy even when structural gate passes", () => {
  const result = evaluateExecutionPermission({
    structuralGate: { allowed: true, blockingReasons: [], warnings: [] },
    researchDecision: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "blocked",
          one_sentence_order: "Research gate blocked."
        }
      }
    },
    proposedTrades: [{ type: "buy", fund_code: "007339", amount_cny: 1000 }]
  });

  assert.equal(result.allowed, false);
  assert.equal(result.mode, "research_blocked");
  assert.match(result.blockingReasons[0], /research/i);
});

test("restricted research permission allows sell-only de-risking", () => {
  const result = evaluateExecutionPermission({
    structuralGate: { allowed: true, blockingReasons: [], warnings: [] },
    researchDecision: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "restricted"
        }
      }
    },
    proposedTrades: [{ type: "sell", fund_code: "007339", amount_cny: 1000 }]
  });

  assert.equal(result.allowed, true);
  assert.equal(result.mode, "research_restricted_sell_only");
});

test("restricted research permission rejects buy", () => {
  const result = evaluateExecutionPermission({
    structuralGate: { allowed: true, blockingReasons: [], warnings: [] },
    researchDecision: {
      actionable_decision: {
        desk_conclusion: {
          trade_permission: "restricted"
        }
      }
    },
    proposedTrades: [{ type: "buy", fund_code: "022502", amount_cny: 1000 }]
  });

  assert.equal(result.allowed, false);
  assert.equal(result.mode, "research_restricted");
  assert.match(result.blockingReasons[0], /restricted/i);
});

