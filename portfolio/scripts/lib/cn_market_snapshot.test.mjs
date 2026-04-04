import test from "node:test";
import assert from "node:assert/strict";

import { buildCnMarketBriefLines } from "./cn_market_snapshot.mjs";

test("buildCnMarketBriefLines renders southbound flow when available", () => {
  const lines = buildCnMarketBriefLines({
    status: "ok",
    sections: {
      southbound_flow: {
        latest_date: "2026-04-02",
        latest_summary_net_buy_100m_hkd: 198.28,
        latest_intraday_time: "15:00",
        latest_intraday_net_inflow_100m_hkd: 198.28
      }
    },
    notes: []
  });

  assert.ok(lines.some((line) => line.includes("南向资金")));
  assert.ok(lines.some((line) => line.includes("198.28")));
});
