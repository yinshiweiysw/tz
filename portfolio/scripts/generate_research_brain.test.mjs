import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runResearchBrainBuild } from "./generate_research_brain.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("runResearchBrainBuild writes research_brain.json with session, readiness level, and market snapshot", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");

  const manifest = {
    version: 1,
    account_id: "contract",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      latest_cn_market_snapshot: path.join(portfolioRoot, "cn_market_snapshot.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  };

  await writeJson(manifestPath, manifest);
  await writeJson(manifest.canonical_entrypoints.latest_snapshot, { snapshot_date: "2026-04-02" });
  await writeJson(manifest.canonical_entrypoints.risk_dashboard, { as_of: "2026-04-02" });
  await writeJson(manifest.canonical_entrypoints.latest_macro_state, {
    generated_at: "2026-04-02T17:00:00+08:00"
  });
  await writeJson(manifest.canonical_entrypoints.latest_macro_radar, {
    generated_at: "2026-04-02T17:10:00+08:00"
  });
  await writeJson(manifest.canonical_entrypoints.latest_regime_router_signals, {
    generated_at: "2026-04-02T18:00:00+08:00"
  });
  await writeJson(manifest.canonical_entrypoints.latest_opportunity_pool_json, {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T18:10:00+08:00"
  });
  await writeJson(manifest.canonical_entrypoints.latest_performance_attribution, {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T18:20:00+08:00"
  });

  const now = new Date("2026-04-02T08:00:00.000Z");
  const quoteFetcher = async () => [];

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher
  });
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(result.outputPath, outputPath);
  assert.equal(result.output?.meta?.market_session, "post_close");
  assert.equal(typeof result.output?.decision_readiness?.level, "string");
  assert.equal(typeof result.output?.market_snapshot, "object");

  assert.equal(persisted?.meta?.market_session, "post_close");
  assert.equal(typeof persisted?.decision_readiness?.level, "string");
  assert.equal(typeof persisted?.market_snapshot, "object");
});

test("runResearchBrainBuild honors explicit output override for session-scoped research brain artifacts", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-output-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const canonicalOutputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const scopedOutputPath = path.join(portfolioRoot, "data", "research_brain.2026-04-03.noon.json");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "contract",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: canonicalOutputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-03"
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-03"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    generated_at: "2026-04-03T11:00:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    generated_at: "2026-04-03T11:10:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    generated_at: "2026-04-03T11:20:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-03",
    generated_at: "2026-04-03T11:30:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-03",
    generated_at: "2026-04-03T11:40:00+08:00"
  });

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now: new Date("2026-04-03T04:00:00.000Z"),
    output: scopedOutputPath,
    quoteFetcher: async () => []
  });

  const scopedPersisted = JSON.parse(await readFile(scopedOutputPath, "utf8"));

  assert.equal(result.outputPath, scopedOutputPath);
  assert.equal(scopedPersisted.meta.trade_date, "2026-04-03");
  await assert.rejects(readFile(canonicalOutputPath, "utf8"));
});

test("runResearchBrainBuild preserves extended meta contract from manifest-backed account context", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-meta-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const now = new Date("2026-04-02T08:00:00.000Z");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "contract",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-02"
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-02"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    generated_at: "2026-04-02T17:00:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    generated_at: "2026-04-02T17:10:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    generated_at: "2026-04-02T18:00:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T18:10:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T18:20:00+08:00"
  });

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher: async () => []
  });
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));

  for (const candidate of [result.output, persisted]) {
    assert.equal(candidate?.meta?.account_id, "contract");
    assert.equal(candidate?.meta?.portfolio_root, portfolioRoot);
    assert.equal(candidate?.meta?.generated_at, now.toISOString());
    assert.equal(candidate?.meta?.trade_date, "2026-04-02");
    assert.equal(candidate?.meta?.market_session, "post_close");
    assert.equal(candidate?.meta?.data_cutoff_time, "16:00:00");
    assert.equal(candidate?.meta?.schema_version, 1);
  }
});

test("runResearchBrainBuild blocks intraday trading when domestic live snapshot timestamps are missing", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-intraday-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const now = new Date("2026-04-02T02:30:00.000Z");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "intraday",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-02",
    generated_at: "2026-04-02T02:00:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:01:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:02:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:03:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:04:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:05:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:06:00.000Z"
  });

  const domesticCodes = new Set(["000001.SH", "399001.SZ", "hkHSI", "hkHSTECH"]);
  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher: async (code) => {
      if (domesticCodes.has(code)) {
        return {
          latestPrice: 100,
          changePercent: 0.1,
          quoteTime: null
        };
      }

      return {
        latestPrice: 200,
        changePercent: -0.2,
        quoteTime: "2026-04-02T02:30:00.000Z"
      };
    }
  });

  assert.equal(result.output.meta.market_session, "intraday");
  assert.equal(result.output.decision_readiness.level, "trading_blocked");
  assert.equal(result.output.decision_readiness.trading_allowed, false);
  assert.equal(
    result.output.freshness_guard.missing_dependencies.some(
      (dependency) => dependency.key === "market_snapshot"
    ),
    true
  );
});

test("runResearchBrainBuild does not let fresh hong kong quotes mask missing a-share timestamps intraday", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-intraday-mixed-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const now = new Date("2026-04-02T02:30:00.000Z");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "intraday-mixed",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-02",
    generated_at: "2026-04-02T02:00:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:01:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:02:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:03:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:04:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:05:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:06:00.000Z"
  });

  const mixedQuoteFetcher = async (code) => {
    if (code === "000001.SH" || code === "399001.SZ") {
      return {
        latestPrice: 100,
        changePercent: 0.2,
        quoteTime: null
      };
    }

    return {
      latestPrice: 200,
      changePercent: -0.1,
      quoteTime: "2026-04-02T02:30:00.000Z"
    };
  };

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher: mixedQuoteFetcher
  });

  assert.equal(result.output.meta.market_session, "intraday");
  assert.equal(result.output.decision_readiness.level, "trading_blocked");
  assert.equal(result.output.decision_readiness.trading_allowed, false);
  assert.equal(
    result.output.freshness_guard.missing_dependencies.some(
      (dependency) => dependency.key === "market_snapshot"
    ),
    true
  );
});

test("runResearchBrainBuild restricts trade permission when tradability-relevant flow section is blocked", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-quality-gate-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const now = new Date("2026-04-02T08:00:00.000Z");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "quality-gate",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      latest_cn_market_snapshot: path.join(portfolioRoot, "cn_market_snapshot.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-02",
    positions: [{ fund_code: "007339", fund_name: "易方达沪深300ETF联接C" }]
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-02"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    generated_at: "2026-04-02T17:00:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    generated_at: "2026-04-02T17:10:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    generated_at: "2026-04-02T18:00:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T18:10:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T18:20:00+08:00"
  });
  await writeJson(path.join(portfolioRoot, "cn_market_snapshot.json"), {
    meta: {
      trade_date: "2026-04-02"
    },
    sections: {
      northbound_flow: {
        latest_date: "2026-04-01",
        latest_summary_net_buy_100m_cny: 0,
        latest_intraday_net_inflow_100m_cny: 0,
        note: "北向回零，仅供参考，暂不做强解释"
      },
      southbound_flow: {
        latest_date: "2026-04-02",
        latest_summary_net_buy_100m_hkd: 12.5,
        latest_intraday_net_inflow_100m_hkd: 6.2
      }
    }
  });

  const quoteFetcher = async () => ({
    latestPrice: 100,
    changePercent: 0.5,
    quoteTime: "2026-04-02T08:00:00.000Z"
  });

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher
  });

  assert.equal(result.output.market_data_quality.sections.northbound_flow.tradability_relevance, "blocked");
  assert.equal(result.output.decision_readiness.trading_allowed, false);
  assert.equal(result.output.actionable_decision.desk_conclusion.trade_permission, "restricted");
});

test("runResearchBrainBuild rejects valueless boolean user input", async () => {
  await assert.rejects(
    () =>
      runResearchBrainBuild({
        user: true
      }),
    /Missing required --user <account_id>\./
  );
});

test("runResearchBrainBuild writes event driver, flow radar, and actionable decision blocks", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-phase2-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const now = new Date("2026-04-02T13:30:00.000Z");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "phase2",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-02",
    generated_at: "2026-04-02T12:00:00.000Z",
    holdings: [{ code: "968012", name: "港股科技测试仓" }]
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T12:05:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    generated_at: "2026-04-02T12:10:00.000Z",
    inflation: {
      cpi_status: "cooling",
      ppi_status: "weak"
    },
    fed_watch: {
      implied_cut_probability_next_meeting: 68
    }
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    generated_at: "2026-04-02T12:20:00.000Z",
    dimensions: {
      capital_flow: {
        state: "usd_headwind",
        dxy_change_60d_pct: 2.03,
        dxy_percentile_1y: 92.86
      }
    }
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    generated_at: "2026-04-02T12:30:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T12:40:00.000Z",
    candidates: [
      {
        theme_name: "港股科技",
        expected_vs_actual: "事件驱动与相对强弱共振。",
        action_bias: "允许试单"
      }
    ]
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T12:50:00.000Z"
  });

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher: async (code) => {
      const positiveMoves = new Map([
        ["hkHSI", 0.6],
        ["hkHSTECH", 1.8],
        ["usINX", -0.9],
        ["usNDX", -1.4],
        ["hf_XAU", 1.2],
        ["hf_CL", 2.4],
        ["USDX", 0.5]
      ]);
      return {
        latestPrice: 100,
        changePercent: positiveMoves.get(code) ?? 0.2,
        quoteTime: "2026-04-02T13:20:00.000Z"
      };
    },
    telegraphFetcher: async () => [
      {
        title: "特朗普称将扩大关税范围",
        content: "市场重新定价全球风险资产。",
        published_at: "2026-04-02T13:00:00.000Z",
        source: "telegraph"
      }
    ]
  });
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));

  for (const candidate of [result.output, persisted]) {
    assert.equal(typeof candidate?.event_driver?.status, "string");
    assert.equal(typeof candidate?.flow_macro_radar?.liquidity_regime, "string");
    assert.equal(typeof candidate?.actionable_decision?.desk_conclusion?.trade_permission, "string");
  }
});

test("runResearchBrainBuild blocks actionable decision when intraday research blocks trading", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-phase2-blocked-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const now = new Date("2026-04-02T02:35:00.000Z");

  await writeJson(manifestPath, {
    version: 1,
    account_id: "phase2-blocked",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(portfolioRoot, "signals", "regime_router_signals.json"),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(portfolioRoot, "data", "performance_attribution.json"),
      latest_research_brain: outputPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-02",
    generated_at: "2026-04-02T02:00:00.000Z",
    holdings: [{ code: "007339", name: "沪深300测试仓" }]
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:01:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    generated_at: "2026-04-02T02:02:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    generated_at: "2026-04-02T02:03:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    generated_at: "2026-04-02T02:04:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:05:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-02",
    generated_at: "2026-04-02T02:06:00.000Z"
  });

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now,
    quoteFetcher: async (code) => {
      if (code === "000001.SH" || code === "399001.SZ") {
        return {
          latestPrice: 100,
          changePercent: -0.4,
          quoteTime: null
        };
      }

      return {
        latestPrice: 100,
        changePercent: 0.2,
        quoteTime: "2026-04-02T02:30:00.000Z"
      };
    },
    telegraphFetcher: async () => [
      {
        title: "中东局势继续扰动",
        content: "风险资产波动放大。",
        published_at: "2026-04-02T02:20:00.000Z",
        source: "telegraph"
      }
    ]
  });

  assert.equal(result.output.decision_readiness.level, "trading_blocked");
  assert.equal(result.output.actionable_decision?.desk_conclusion?.trade_permission, "blocked");
});

test("runResearchBrainBuild writes institutional sidecars and exposes section confidence", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "research-brain-sidecars-"));
  const manifestPath = path.join(portfolioRoot, "state-manifest.json");
  const outputPath = path.join(portfolioRoot, "data", "research_brain.json");
  const marketDataQualityPath = path.join(portfolioRoot, "data", "market_data_quality.json");
  const marketFlowMatrixPath = path.join(portfolioRoot, "data", "market_flow_matrix.json");
  const driverExpectationMatrixPath = path.join(
    portfolioRoot,
    "data",
    "driver_expectation_matrix.json"
  );

  await writeJson(manifestPath, {
    version: 1,
    account_id: "phase3-sidecars",
    portfolio_root: portfolioRoot,
    canonical_entrypoints: {
      latest_snapshot: path.join(portfolioRoot, "state", "portfolio_state.json"),
      risk_dashboard: path.join(portfolioRoot, "risk_dashboard.json"),
      latest_macro_state: path.join(portfolioRoot, "data", "macro_state.json"),
      latest_macro_radar: path.join(portfolioRoot, "data", "macro_radar.json"),
      latest_regime_router_signals: path.join(
        portfolioRoot,
        "signals",
        "regime_router_signals.json"
      ),
      latest_opportunity_pool_json: path.join(portfolioRoot, "data", "opportunity_pool.json"),
      latest_performance_attribution: path.join(
        portfolioRoot,
        "data",
        "performance_attribution.json"
      ),
      latest_research_brain: outputPath,
      latest_market_data_quality: marketDataQualityPath,
      latest_market_flow_matrix: marketFlowMatrixPath,
      latest_driver_expectation_matrix: driverExpectationMatrixPath
    }
  });
  await writeJson(path.join(portfolioRoot, "state", "portfolio_state.json"), {
    snapshot_date: "2026-04-03",
    generated_at: "2026-04-03T09:00:00.000Z",
    holdings: [{ code: "007339", name: "沪深300测试仓" }]
  });
  await writeJson(path.join(portfolioRoot, "risk_dashboard.json"), {
    as_of: "2026-04-03",
    generated_at: "2026-04-03T09:01:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_state.json"), {
    generated_at: "2026-04-03T09:02:00.000Z",
    inflation: {
      cpi_status: "sticky",
      ppi_status: "soft"
    },
    fed_watch: {
      implied_cut_probability_next_meeting: 42
    }
  });
  await writeJson(path.join(portfolioRoot, "data", "macro_radar.json"), {
    generated_at: "2026-04-03T09:03:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "signals", "regime_router_signals.json"), {
    generated_at: "2026-04-03T09:04:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "data", "opportunity_pool.json"), {
    as_of: "2026-04-03",
    generated_at: "2026-04-03T09:05:00.000Z",
    candidates: []
  });
  await writeJson(path.join(portfolioRoot, "data", "performance_attribution.json"), {
    as_of: "2026-04-03",
    generated_at: "2026-04-03T09:06:00.000Z"
  });
  await writeJson(path.join(portfolioRoot, "cn_market_snapshot.json"), {
    trade_date: "2026-04-03",
    generated_at: "2026-04-03T09:07:00.000Z",
    sections: {
      northbound_flow: {
        latest_date: "2026-04-02",
        latest_summary_net_buy_100m_cny: 0,
        latest_intraday_net_inflow_100m_cny: 0,
        note: "当前北向端点可返回通道状态，但当日净流入数值回零，暂不做强解释。"
      },
      southbound_flow: {
        latest_date: "2026-04-03",
        latest_summary_net_buy_100m_hkd: 128.2,
        latest_intraday_time: "14:10",
        latest_intraday_net_inflow_100m_hkd: 108.4
      }
    }
  });

  const result = await runResearchBrainBuild({
    portfolioRoot,
    now: new Date("2026-04-03T06:20:00.000Z"),
    quoteFetcher: async () => ({
      latestPrice: 100,
      changePercent: 0.3,
      quoteTime: "2026-04-03T06:15:00.000Z"
    }),
    telegraphFetcher: async () => [
      {
        title: "美联储官员称通胀仍需观察",
        content: "市场重新评估年内降息路径。",
        published_at: "2026-04-03T13:40:00+08:00",
        source: "telegraph"
      }
    ]
  });

  const marketDataQuality = JSON.parse(await readFile(marketDataQualityPath, "utf8"));
  const marketFlowMatrix = JSON.parse(await readFile(marketFlowMatrixPath, "utf8"));
  const driverExpectationMatrix = JSON.parse(
    await readFile(driverExpectationMatrixPath, "utf8")
  );

  assert.equal(typeof result.output.section_confidence?.event_driver, "string");
  assert.equal(Array.isArray(result.output.data_quality_flags), true);
  assert.equal(marketDataQuality.sections.northbound_flow.status, "degraded");
  assert.equal(typeof marketFlowMatrix.liquidity_regime, "string");
  assert.equal(typeof driverExpectationMatrix.expectation_gap, "string");
});
