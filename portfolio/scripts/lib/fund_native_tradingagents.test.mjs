import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistFundNativeAnalysisSnapshot,
  resolveFundNativeAnalysisPath,
  runFundNativeTradingAgents
} from "./fund_native_tradingagents.mjs";

const decisionSnapshot = {
  accountId: "main",
  status: "risk_watch",
  riskLight: "green",
  bucketActions: [{ bucket: "GLB_MOM", verdict: "observe_only", proxySymbols: ["QQQ"] }],
  fundAnalyses: [],
  portfolioAnalysis: {
    deepDiveCandidates: [
      {
        fundCode: "019736",
        fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
        bucket: "GLB_MOM",
        amountCny: 10000,
        factorProfile: { primaryFactor: "US_TECH", proxySymbols: ["QQQ"] },
        researchProfile: { fundName: "宝盈纳斯达克100指数发起(QDII)A人民币", analysisTemplate: "qdii_index_fund" }
      }
    ]
  }
};

test("runFundNativeTradingAgents uses fake provider and returns normalized snapshot", async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "部分赎回候选",
              riskLight: "yellow",
              confidence: 0.7,
              oneLine: "可考虑卖出一部分，尾盘前复核。",
              styleEnvironment: { label: "中性", reason: "前收参考" },
              fundQuality: { label: "可用", reason: "指数工具" },
              lookThrough: { label: "清晰", reason: "美股科技" },
              peerRole: { label: "代表候选", reason: "同类核心" },
              riskReview: { riskLight: "yellow", notes: ["QDII 滞后"] },
              uncertainties: ["前收参考"],
              rawEvidence: "## Fund Committee Decision"
            })
          }
        }
      ]
    })
  });

  const snapshot = await runFundNativeTradingAgents({
    decisionSnapshot,
    bridgeConfig: {
      providerChain: {
        primary: [{ provider: "glm", backendUrl: "https://example.test/v4", deepThinkModel: "glm-5.1", quickThinkModel: "glm-5" }]
      }
    },
    env: { ZHIPU_API_KEY: "test-key" },
    fetchFn,
    scope: "deep_dive",
    limit: 1,
    now: new Date("2026-04-28T08:00:00.000Z")
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.analyses[0].fundCode, "019736");
  assert.equal(snapshot.analyses[0].provider, "glm");
  assert.equal(snapshot.analyses[0].verdict, "partial_redeem_review");
});

test("persistFundNativeAnalysisSnapshot writes canonical snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fund-native-"));
  try {
    const snapshot = { status: "ready", analyses: [] };
    const outputPath = await persistFundNativeAnalysisSnapshot({ portfolioRoot: root, snapshot });
    assert.equal(outputPath, resolveFundNativeAnalysisPath(root));
    const saved = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(saved.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
