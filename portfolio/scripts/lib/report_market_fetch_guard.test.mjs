import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExternalSourceStatusLines,
  resolveQuoteFetchTimeoutMs,
  runGuardedFetch,
  summarizeGuardedBatch
} from "./report_market_fetch_guard.mjs";

test("resolveQuoteFetchTimeoutMs gives CME futures a longer timeout budget", () => {
  assert.equal(resolveQuoteFetchTimeoutMs("hf_ES", 5000), 12000);
  assert.equal(resolveQuoteFetchTimeoutMs("hf_NQ", 5000), 12000);
});

test("resolveQuoteFetchTimeoutMs keeps default timeout for non-CME quotes", () => {
  assert.equal(resolveQuoteFetchTimeoutMs("000300.SH", 5000), 5000);
  assert.equal(resolveQuoteFetchTimeoutMs("hf_XAU", 5000), 5000);
  assert.equal(resolveQuoteFetchTimeoutMs("", 5000), 5000);
});

test("runGuardedFetch returns ok result for resolved fetch", async () => {
  const result = await runGuardedFetch({
    source: "quotes",
    label: "行情报价",
    timeoutMs: 50,
    task: async () => ({ count: 3 })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, { count: 3 });
});

test("runGuardedFetch returns timeout result for stalled fetch", async () => {
  const result = await runGuardedFetch({
    source: "telegraphs",
    label: "市场电报",
    timeoutMs: 10,
    task: () => new Promise(() => {})
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.match(String(result.message ?? ""), /timed out/i);
});

test("summarizeGuardedBatch collapses partial quote failures into one degraded source status", () => {
  const result = summarizeGuardedBatch({
    source: "quotes",
    label: "行情报价",
    results: [
      { ok: true, status: "ok", source: "quote:000300.SH", label: "沪深300" },
      { ok: false, status: "timeout", source: "quote:r_hkHSI", label: "恒生指数", message: "Fetch timed out after 5000ms" },
      { ok: false, status: "error", source: "quote:hf_XAU", label: "伦敦金", message: "upstream 500" }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.match(String(result.message ?? ""), /2\/3/);
  assert.match(String(result.message ?? ""), /恒生指数/);
});

test("buildExternalSourceStatusLines renders degraded source warnings only", () => {
  const lines = buildExternalSourceStatusLines([
    { source: "quotes", label: "行情报价", ok: true, status: "ok" },
    { source: "telegraphs", label: "市场电报", ok: false, status: "timeout", message: "Fetch timed out after 6000ms" }
  ]);

  assert.deepEqual(lines, [
    "## 外部行情源状态",
    "",
    "- ⚠️ 市场电报：timeout，已按降级口径生成报告（Fetch timed out after 6000ms）。"
  ]);
});
