# Institutional Research Brain Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single session-aware `research_brain.json` substrate that stops stale/incomplete market analysis from flowing into reports and future trade decisions.

**Architecture:** Add a new orchestrator script that reads canonical portfolio artifacts, fetches a minimal live cross-asset snapshot, runs freshness and coverage guards, derives a unified readiness level, and writes one normalized `research_brain.json` per account. Existing report scripts keep their current rendering shells, but they must start consuming the new readiness/freshness/coverage contract from `research_brain.json` instead of inventing their own partial view.

**Tech Stack:** Node.js ESM, `node:test`, existing `market-mcp` stock/CME providers, existing account-root/report-context helpers, JSON state manifests.

---

## File Structure

### New files

- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs`
  Orchestration-only entrypoint that resolves account paths, loads upstream payloads, fetches the live market snapshot, runs the guards, derives decision readiness, and writes `research_brain.json`.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`
  Lightweight contract test for the orchestrator write path using a temporary account root and stubbed snapshot fetcher.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.mjs`
  Shanghai-time session classifier and session policy helper.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs`
  Deterministic tests for `pre_open`, `intraday`, `post_close`, and `overnight`.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.mjs`
  Dependency freshness policy engine.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs`
  Deterministic freshness tests for `ok`, `stale`, `missing`, and `optional_missing`.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.mjs`
  Breadth/coverage validator for market domains and portfolio/risk state.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs`
  Deterministic tests for weak domains and critical missing domains.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.mjs`
  Minimal live cross-asset snapshot fetcher/normalizer.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs`
  Tests for quote normalization and partial-fetch degradation.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.mjs`
  Normalizes existing artifacts into a stable `research_snapshot` block with timestamps and availability flags.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.test.mjs`
  Tests for sparse and complete upstream payload normalization.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.mjs`
  Collapses freshness + coverage + session constraints into one readiness contract.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs`
  Tests for `ready`, `analysis_degraded`, `trading_blocked`, and `research_invalid`.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
  Targeted regression test for `ensureReportContext` refresh wiring once `research_brain` becomes a first-class payload.

### Existing files to modify

- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.mjs`
  Add `research_brain` path loading, refresh sequencing, and outward-facing readiness data so reports do not re-derive their own policy state.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
  Render session/readiness/freshness/coverage messages from `research_brain.json`.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
  Render degraded/blocked analysis state from `research_brain.json`.
- `/Users/yinshiwei/codex/tz/portfolio/state-manifest.json`
  Register `latest_research_brain` in main-account canonical entrypoints.
- `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.mjs`
  Seed `latest_research_brain` path for child accounts such as `wenge`.

## Implementation Notes

- Treat `research_brain.json` as an additive substrate, not a replacement for all existing report-specific data fetches in Phase 1.
- Keep policy logic out of report renderers. Reports should read the research contract, not invent freshness heuristics.
- Use one vocabulary everywhere:
  - sessions: `pre_open`, `intraday`, `post_close`, `overnight`
  - freshness statuses: `ok`, `stale`, `missing`, `optional_missing`
  - readiness levels: `ready`, `analysis_degraded`, `trading_blocked`, `research_invalid`
- Child accounts must write their own `data/research_brain.json`, even when some upstream market artifacts are shared from main.

### Task 1: Build the session taxonomy

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs`

- [ ] **Step 1: Write the failing session-classification tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { classifyResearchSession } from "./research_session.mjs";

test("classifyResearchSession returns pre_open before 09:30 Shanghai time", () => {
  const result = classifyResearchSession(new Date("2026-04-02T00:20:00.000Z"));
  assert.equal(result.session, "pre_open");
  assert.equal(result.tradeDate, "2026-04-02");
  assert.equal(result.policy.acceptPreviousCloseForDomestic, true);
});

test("classifyResearchSession returns intraday during cash trading hours", () => {
  const result = classifyResearchSession(new Date("2026-04-02T02:35:00.000Z"));
  assert.equal(result.session, "intraday");
  assert.equal(result.policy.requiresLiveDomesticSnapshot, true);
});

test("classifyResearchSession returns post_close after 15:00 but before evening", () => {
  const result = classifyResearchSession(new Date("2026-04-02T08:10:00.000Z"));
  assert.equal(result.session, "post_close");
  assert.equal(result.policy.domesticTradeDateMustMatch, true);
});

test("classifyResearchSession returns overnight after 19:00 Shanghai time", () => {
  const result = classifyResearchSession(new Date("2026-04-02T13:30:00.000Z"));
  assert.equal(result.session, "overnight");
  assert.equal(result.policy.requiresOvernightRiskProxies, true);
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `research_session.mjs`.

- [ ] **Step 3: Write the minimal session module**

```js
const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

function shanghaiParts(now = new Date()) {
  const entries = Object.fromEntries(
    shanghaiFormatter.formatToParts(now).map((part) => [part.type, part.value])
  );
  return {
    tradeDate: `${entries.year}-${entries.month}-${entries.day}`,
    hour: Number(entries.hour),
    minute: Number(entries.minute)
  };
}

function buildPolicy(session) {
  if (session === "pre_open") {
    return {
      acceptPreviousCloseForDomestic: true,
      requiresLiveDomesticSnapshot: false,
      requiresOvernightRiskProxies: true,
      domesticTradeDateMustMatch: false
    };
  }
  if (session === "intraday") {
    return {
      acceptPreviousCloseForDomestic: false,
      requiresLiveDomesticSnapshot: true,
      requiresOvernightRiskProxies: false,
      domesticTradeDateMustMatch: true
    };
  }
  if (session === "post_close") {
    return {
      acceptPreviousCloseForDomestic: false,
      requiresLiveDomesticSnapshot: false,
      requiresOvernightRiskProxies: false,
      domesticTradeDateMustMatch: true
    };
  }
  return {
    acceptPreviousCloseForDomestic: true,
    requiresLiveDomesticSnapshot: false,
    requiresOvernightRiskProxies: true,
    domesticTradeDateMustMatch: false
  };
}

export function classifyResearchSession(now = new Date()) {
  const { tradeDate, hour, minute } = shanghaiParts(now);
  const clock = hour * 60 + minute;
  const session =
    clock < 570 ? "pre_open" : clock < 900 ? "intraday" : clock < 1140 ? "post_close" : "overnight";

  return {
    session,
    tradeDate,
    shanghaiClock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    policy: buildPolicy(session)
  };
}
```

- [ ] **Step 4: Run the tests to verify the classifier passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs`

Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs
git commit -m "feat: add research session classifier"
```

### Task 2: Build the freshness guard

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs`

- [ ] **Step 1: Write the failing freshness-policy tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchFreshnessGuard } from "./research_freshness_guard.mjs";

const sessionInfo = {
  session: "intraday",
  tradeDate: "2026-04-02",
  policy: {
    acceptPreviousCloseForDomestic: false,
    requiresLiveDomesticSnapshot: true,
    requiresOvernightRiskProxies: false,
    domesticTradeDateMustMatch: true
  }
};

test("buildResearchFreshnessGuard marks same-day required inputs as ok", () => {
  const guard = buildResearchFreshnessGuard({
    now: new Date("2026-04-02T03:00:00.000Z"),
    sessionInfo,
    dependencies: [
      {
        key: "portfolio_state",
        label: "组合状态",
        required: true,
        effectiveTimestamp: "2026-04-02T10:55:00+08:00",
        tradeDate: "2026-04-02",
        domain: "portfolio_state"
      }
    ]
  });

  assert.equal(guard.overall_status, "ok");
  assert.equal(guard.dependencies[0].status, "ok");
});

test("buildResearchFreshnessGuard blocks stale trade dependencies intraday", () => {
  const guard = buildResearchFreshnessGuard({
    now: new Date("2026-04-02T03:00:00.000Z"),
    sessionInfo,
    dependencies: [
      {
        key: "risk_dashboard",
        label: "风控盘",
        required: true,
        effectiveTimestamp: "2026-04-01T18:00:00+08:00",
        tradeDate: "2026-04-01",
        domain: "risk_state"
      }
    ]
  });

  assert.equal(guard.overall_status, "stale");
  assert.equal(guard.dependencies[0].status, "stale");
});

test("buildResearchFreshnessGuard marks optional gaps as optional_missing", () => {
  const guard = buildResearchFreshnessGuard({
    now: new Date("2026-04-02T00:20:00.000Z"),
    sessionInfo: {
      session: "pre_open",
      tradeDate: "2026-04-02",
      policy: {
        acceptPreviousCloseForDomestic: true,
        requiresLiveDomesticSnapshot: false,
        requiresOvernightRiskProxies: true,
        domesticTradeDateMustMatch: false
      }
    },
    dependencies: [
      {
        key: "performance_attribution",
        label: "归因分析",
        required: false,
        effectiveTimestamp: null,
        tradeDate: null,
        domain: "performance"
      }
    ]
  });

  assert.equal(guard.dependencies[0].status, "optional_missing");
});
```

- [ ] **Step 2: Run the test to verify the guard is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the minimal freshness engine**

```js
function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function lagHours(now, effectiveTimestamp) {
  const parsed = parseTimestamp(effectiveTimestamp);
  if (!parsed) {
    return null;
  }
  return Number(((now.getTime() - parsed.getTime()) / 36e5).toFixed(2));
}

function resolveDependencyStatus({ sessionInfo, dependency, now }) {
  if (!dependency.effectiveTimestamp) {
    return dependency.required ? "missing" : "optional_missing";
  }

  if (
    sessionInfo.policy.domesticTradeDateMustMatch &&
    dependency.tradeDate &&
    dependency.tradeDate !== sessionInfo.tradeDate &&
    ["portfolio_state", "risk_state", "market_snapshot"].includes(dependency.domain)
  ) {
    return "stale";
  }

  const age = lagHours(now, dependency.effectiveTimestamp);
  if (dependency.domain === "market_snapshot" && sessionInfo.policy.requiresLiveDomesticSnapshot && age !== null && age > 2) {
    return "stale";
  }
  if (dependency.domain === "global_risk" && sessionInfo.policy.requiresOvernightRiskProxies && age !== null && age > 18) {
    return "stale";
  }
  if (dependency.required && age !== null && age > 48) {
    return "stale";
  }
  return "ok";
}

export function buildResearchFreshnessGuard({ now = new Date(), sessionInfo, dependencies = [] }) {
  const normalized = dependencies.map((dependency) => {
    const status = resolveDependencyStatus({ sessionInfo, dependency, now });
    return {
      key: dependency.key,
      label: dependency.label,
      required: dependency.required,
      status,
      effective_timestamp: dependency.effectiveTimestamp,
      lag_hours: lagHours(now, dependency.effectiveTimestamp),
      reason:
        status === "stale"
          ? `${dependency.label} 已超出 ${sessionInfo.session} 可接受时效`
          : status === "missing"
            ? `${dependency.label} 缺失`
            : status === "optional_missing"
              ? `${dependency.label} 缺失但当前非阻断`
              : `${dependency.label} 时效正常`
    };
  });

  const stale_dependencies = normalized.filter((item) => item.status === "stale").map((item) => item.key);
  const missing_dependencies = normalized
    .filter((item) => item.status === "missing" || item.status === "optional_missing")
    .map((item) => item.key);

  return {
    overall_status:
      stale_dependencies.length > 0
        ? "stale"
        : normalized.some((item) => item.status === "missing")
          ? "missing"
          : "ok",
    dependencies: normalized,
    stale_dependencies,
    missing_dependencies
  };
}
```

- [ ] **Step 4: Run the tests to verify the guard passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs
git commit -m "feat: add research freshness guard"
```

### Task 3: Build the coverage guard

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs`

- [ ] **Step 1: Write the failing coverage tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchCoverageGuard } from "./research_coverage_guard.mjs";

test("buildResearchCoverageGuard marks missing Hong Kong coverage as weak but not invalid", () => {
  const result = buildResearchCoverageGuard({
    marketSnapshot: {
      a_share_indices: [{ fetch_status: "ok" }],
      hong_kong_indices: [{ fetch_status: "missing" }],
      global_indices: [{ fetch_status: "ok" }],
      commodities: [{ fetch_status: "ok" }],
      rates_fx: [{ fetch_status: "ok" }]
    },
    researchSnapshot: {
      portfolio_state: { available: true },
      risk_dashboard: { available: true }
    }
  });

  assert.equal(result.domains.hong_kong.status, "weak");
  assert.equal(result.overall_status, "degraded");
});

test("buildResearchCoverageGuard marks portfolio and risk gaps as critical", () => {
  const result = buildResearchCoverageGuard({
    marketSnapshot: {
      a_share_indices: [{ fetch_status: "ok" }],
      hong_kong_indices: [{ fetch_status: "ok" }],
      global_indices: [{ fetch_status: "ok" }],
      commodities: [{ fetch_status: "ok" }],
      rates_fx: [{ fetch_status: "ok" }]
    },
    researchSnapshot: {
      portfolio_state: { available: false },
      risk_dashboard: { available: false }
    }
  });

  assert.equal(result.domains.portfolio_state.status, "missing");
  assert.equal(result.domains.risk_state.status, "missing");
  assert.equal(result.overall_status, "critical");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the minimal coverage validator**

```js
function quoteStatus(items = []) {
  const okCount = items.filter((item) => item?.fetch_status === "ok").length;
  if (okCount === 0) {
    return "missing";
  }
  return okCount === items.length ? "ok" : "weak";
}

export function buildResearchCoverageGuard({ marketSnapshot = {}, researchSnapshot = {} }) {
  const domains = {
    a_share: { status: quoteStatus(marketSnapshot.a_share_indices) },
    hong_kong: { status: quoteStatus(marketSnapshot.hong_kong_indices) },
    global_risk: { status: quoteStatus(marketSnapshot.global_indices) },
    macro_anchors: {
      status:
        quoteStatus(marketSnapshot.commodities) === "missing" && quoteStatus(marketSnapshot.rates_fx) === "missing"
          ? "missing"
          : quoteStatus(marketSnapshot.commodities) === "ok" && quoteStatus(marketSnapshot.rates_fx) === "ok"
            ? "ok"
            : "weak"
    },
    portfolio_state: { status: researchSnapshot.portfolio_state?.available ? "ok" : "missing" },
    risk_state: { status: researchSnapshot.risk_dashboard?.available ? "ok" : "missing" }
  };

  const missing_domains = Object.entries(domains)
    .filter(([, value]) => value.status === "missing")
    .map(([key]) => key);
  const weak_domains = Object.entries(domains)
    .filter(([, value]) => value.status === "weak")
    .map(([key]) => key);

  return {
    overall_status: missing_domains.some((key) => ["portfolio_state", "risk_state"].includes(key))
      ? "critical"
      : missing_domains.length > 0 || weak_domains.length > 0
        ? "degraded"
        : "ok",
    domains,
    missing_domains,
    weak_domains
  };
}
```

- [ ] **Step 4: Run the tests to verify the guard passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs
git commit -m "feat: add research coverage guard"
```

### Task 4: Build the live market snapshot module

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs`

- [ ] **Step 1: Write the failing snapshot tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchMarketSnapshot } from "./research_market_snapshot.mjs";

test("buildResearchMarketSnapshot normalizes quote payloads into coverage groups", async () => {
  const snapshot = await buildResearchMarketSnapshot({
    quoteFetcher: async (codes) =>
      codes.map((code) => ({
        stockCode: code,
        latestPrice: 100,
        changePercent: 1.23,
        quoteTime: "2026-04-02 14:30:00"
      })),
    now: new Date("2026-04-02T06:30:00.000Z")
  });

  assert.ok(snapshot.a_share_indices.length >= 3);
  assert.equal(snapshot.a_share_indices[0].fetch_status, "ok");
  assert.ok(snapshot.rates_fx.some((item) => item.label.includes("美元")));
});

test("buildResearchMarketSnapshot preserves missing quote failures as degraded rows", async () => {
  const snapshot = await buildResearchMarketSnapshot({
    quoteFetcher: async () => [
      {
        stockCode: "000300.SH",
        latestPrice: 3900,
        changePercent: -0.45,
        quoteTime: "2026-04-02 14:30:00"
      }
    ],
    now: new Date("2026-04-02T06:30:00.000Z")
  });

  const hsi = snapshot.hong_kong_indices.find((item) => item.code === "r_hkHSI");
  assert.equal(hsi.fetch_status, "missing");
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the minimal snapshot fetcher**

```js
import { getStockQuote } from "../../../market-mcp/src/providers/stock.js";

const GROUPS = {
  a_share_indices: [
    { label: "上证指数", code: "000001.SH" },
    { label: "沪深300", code: "000300.SH" },
    { label: "创业板指", code: "399006.SZ" }
  ],
  hong_kong_indices: [
    { label: "恒生指数", code: "r_hkHSI" },
    { label: "恒生科技指数", code: "r_hkHSTECH" }
  ],
  global_indices: [
    { label: "标普500期货", code: "hf_ES" },
    { label: "纳斯达克100期货", code: "hf_NQ" }
  ],
  commodities: [
    { label: "伦敦金", code: "hf_XAU" },
    { label: "WTI原油", code: "hf_CL" }
  ],
  rates_fx: [
    { label: "美元指数", code: "DXY.OTC" },
    { label: "10Y美债收益率", code: "US10Y.OTC" }
  ]
};

function normalizeQuote(config, quote) {
  if (!quote) {
    return { ...config, latest_price: null, pct_change: null, quote_time: null, fetch_status: "missing" };
  }
  return {
    ...config,
    latest_price: Number(quote.latestPrice ?? quote.latest_price ?? 0),
    pct_change: Number(quote.changePercent ?? quote.pct_change ?? 0),
    quote_time: quote.quoteTime ?? quote.quote_time ?? null,
    fetch_status: "ok"
  };
}

function normalizeFallbackMetric(config, metric) {
  if (metric?.latest_price === null || metric?.latest_price === undefined) {
    return { ...config, latest_price: null, pct_change: null, quote_time: null, fetch_status: "missing" };
  }
  return {
    ...config,
    latest_price: Number(metric.latest_price),
    pct_change: Number(metric.pct_change ?? 0),
    quote_time: metric.quote_time ?? null,
    fetch_status: "ok"
  };
}

export async function buildResearchMarketSnapshot({
  quoteFetcher = getStockQuote,
  macroStateFallback = {},
  now = new Date()
} = {}) {
  const configs = Object.entries(GROUPS)
    .filter(([groupKey]) => groupKey !== "rates_fx")
    .flatMap(([, items]) => items);
  const quotes = await quoteFetcher(configs.map((item) => item.code));
  return {
    generated_at: now.toISOString(),
    ...Object.fromEntries(
      Object.entries(GROUPS).map(([groupKey, items]) => [
        groupKey,
        items.map((config) =>
          normalizeQuote(
            config,
            quotes.find((quote) => String(quote.stockCode ?? "").trim().toUpperCase() === config.code.toUpperCase())
          )
        )
      ])
    ),
    rates_fx: [
      normalizeFallbackMetric(GROUPS.rates_fx[0], {
        latest_price: macroStateFallback?.market_surface?.dxy?.latest_price ?? macroStateFallback?.dxy?.latest_price ?? null,
        pct_change: macroStateFallback?.market_surface?.dxy?.pct_change ?? macroStateFallback?.dxy?.pct_change ?? null,
        quote_time: macroStateFallback?.market_surface?.dxy?.quote_time ?? macroStateFallback?.generated_at ?? null
      }),
      normalizeFallbackMetric(GROUPS.rates_fx[1], {
        latest_price:
          macroStateFallback?.market_surface?.us_10y_yield?.latest_price ??
          macroStateFallback?.treasury_10y?.latest_price ??
          null,
        pct_change:
          macroStateFallback?.market_surface?.us_10y_yield?.pct_change ??
          macroStateFallback?.treasury_10y?.pct_change ??
          null,
        quote_time:
          macroStateFallback?.market_surface?.us_10y_yield?.quote_time ??
          macroStateFallback?.generated_at ??
          null
      })
    ]
  };
}
```

- [ ] **Step 4: Run the tests to verify the fetcher passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs
git commit -m "feat: add research market snapshot builder"
```

### Task 5: Build the research snapshot normalizer

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.test.mjs`

- [ ] **Step 1: Write the failing snapshot-builder tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildResearchSnapshot } from "./research_snapshot_builder.mjs";

test("buildResearchSnapshot preserves availability and timestamps for complete payloads", () => {
  const snapshot = buildResearchSnapshot({
    payloads: {
      latest: { snapshot_date: "2026-04-02", generated_at: "2026-04-02T15:10:00+08:00" },
      riskDashboard: { as_of: "2026-04-02", generated_at: "2026-04-02T18:10:00+08:00" },
      macroState: { generated_at: "2026-04-02T17:10:00+08:00" }
    }
  });

  assert.equal(snapshot.portfolio_state.available, true);
  assert.equal(snapshot.risk_dashboard.as_of, "2026-04-02");
  assert.equal(snapshot.macro_state.generated_at, "2026-04-02T17:10:00+08:00");
});

test("buildResearchSnapshot marks absent artifacts as unavailable without throwing", () => {
  const snapshot = buildResearchSnapshot({ payloads: {} });
  assert.equal(snapshot.opportunity_pool.available, false);
  assert.equal(snapshot.performance_attribution.available, false);
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the minimal normalizer**

```js
function normalizeArtifact(key, payload, extractAsOf) {
  return {
    key,
    available: Boolean(payload),
    generated_at: payload?.generated_at ?? null,
    as_of: extractAsOf(payload),
    payload: payload ?? null
  };
}

export function buildResearchSnapshot({ payloads = {} }) {
  return {
    portfolio_state: normalizeArtifact(
      "portfolio_state",
      payloads.latest,
      (payload) => String(payload?.snapshot_date ?? "").slice(0, 10) || null
    ),
    risk_dashboard: normalizeArtifact(
      "risk_dashboard",
      payloads.riskDashboard,
      (payload) => String(payload?.as_of ?? "").slice(0, 10) || null
    ),
    macro_state: normalizeArtifact("macro_state", payloads.macroState, () => null),
    macro_radar: normalizeArtifact("macro_radar", payloads.macroRadar, () => null),
    regime_router_signals: normalizeArtifact(
      "regime_router_signals",
      payloads.regimeSignals,
      (payload) => String(payload?.signal_date ?? payload?.generated_at ?? "").slice(0, 10) || null
    ),
    opportunity_pool: normalizeArtifact(
      "opportunity_pool",
      payloads.opportunityPool,
      (payload) => String(payload?.as_of ?? "").slice(0, 10) || null
    ),
    performance_attribution: normalizeArtifact(
      "performance_attribution",
      payloads.performanceAttribution,
      (payload) => String(payload?.as_of ?? payload?.snapshot_date ?? "").slice(0, 10) || null
    )
  };
}
```

- [ ] **Step 4: Run the tests to verify the builder passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.test.mjs`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.test.mjs
git commit -m "feat: normalize research snapshot payloads"
```

### Task 6: Build the readiness policy layer

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs`

- [ ] **Step 1: Write the failing readiness tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { deriveResearchDecisionReadiness } from "./research_decision_readiness.mjs";

test("deriveResearchDecisionReadiness returns ready when freshness and coverage are clean", () => {
  const readiness = deriveResearchDecisionReadiness({
    sessionInfo: { session: "post_close" },
    freshnessGuard: { overall_status: "ok", stale_dependencies: [], missing_dependencies: [], dependencies: [] },
    coverageGuard: { overall_status: "ok", weak_domains: [], missing_domains: [] }
  });

  assert.equal(readiness.level, "ready");
  assert.equal(readiness.analysis_allowed, true);
  assert.equal(readiness.trading_allowed, true);
});

test("deriveResearchDecisionReadiness returns analysis_degraded for weak market coverage", () => {
  const readiness = deriveResearchDecisionReadiness({
    sessionInfo: { session: "overnight" },
    freshnessGuard: { overall_status: "ok", stale_dependencies: [], missing_dependencies: [], dependencies: [] },
    coverageGuard: { overall_status: "degraded", weak_domains: ["hong_kong"], missing_domains: [] }
  });

  assert.equal(readiness.level, "analysis_degraded");
  assert.equal(readiness.analysis_allowed, true);
  assert.equal(readiness.trading_allowed, false);
});

test("deriveResearchDecisionReadiness returns trading_blocked for stale trading inputs", () => {
  const readiness = deriveResearchDecisionReadiness({
    sessionInfo: { session: "intraday" },
    freshnessGuard: { overall_status: "stale", stale_dependencies: ["risk_dashboard"], missing_dependencies: [], dependencies: [] },
    coverageGuard: { overall_status: "ok", weak_domains: [], missing_domains: [] }
  });

  assert.equal(readiness.level, "trading_blocked");
});

test("deriveResearchDecisionReadiness returns research_invalid for critical missing domains", () => {
  const readiness = deriveResearchDecisionReadiness({
    sessionInfo: { session: "pre_open" },
    freshnessGuard: { overall_status: "missing", stale_dependencies: [], missing_dependencies: ["portfolio_state"], dependencies: [] },
    coverageGuard: { overall_status: "critical", weak_domains: [], missing_domains: ["portfolio_state"] }
  });

  assert.equal(readiness.level, "research_invalid");
  assert.equal(readiness.analysis_allowed, false);
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the minimal readiness reducer**

```js
export function deriveResearchDecisionReadiness({
  sessionInfo,
  freshnessGuard,
  coverageGuard
}) {
  const reasons = [];
  let level = "ready";
  let analysis_allowed = true;
  let trading_allowed = true;

  if (coverageGuard.overall_status === "critical") {
    level = "research_invalid";
    analysis_allowed = false;
    trading_allowed = false;
    reasons.push("关键研究域缺失，无法形成有效研究判断");
  } else if (freshnessGuard.overall_status === "stale") {
    level = "trading_blocked";
    analysis_allowed = true;
    trading_allowed = false;
    reasons.push("交易依赖存在时效问题，禁止输出明确交易指令");
  } else if (coverageGuard.overall_status === "degraded" || freshnessGuard.overall_status === "missing") {
    level = "analysis_degraded";
    analysis_allowed = true;
    trading_allowed = false;
    reasons.push("市场覆盖或辅助上下文不完整，只允许低置信度分析");
  }

  return {
    level,
    analysis_allowed,
    trading_allowed,
    reasons,
    stale_dependencies: freshnessGuard.stale_dependencies ?? [],
    missing_dependencies: freshnessGuard.missing_dependencies ?? [],
    session_constraints:
      sessionInfo.session === "intraday" && !trading_allowed
        ? ["盘中依赖未满足，禁止把旧数据伪装成当下交易建议"]
        : []
  };
}
```

- [ ] **Step 4: Run the tests to verify the reducer passes**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs`

Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs
git commit -m "feat: add research decision readiness reducer"
```

### Task 7: Wire the research brain orchestrator and account manifests

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs`
- Test: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/state-manifest.json`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.mjs`

- [ ] **Step 1: Write the failing orchestrator contract test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runResearchBrainBuild } from "./generate_research_brain.mjs";

test("runResearchBrainBuild writes research_brain.json with readiness and market snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-brain-"));
  await mkdir(path.join(root, "state"), { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "signals"), { recursive: true });
  await writeFile(
    path.join(root, "state-manifest.json"),
    JSON.stringify({
      canonical_entrypoints: {
        latest_snapshot: path.join(root, "state", "portfolio_state.json"),
        risk_dashboard: path.join(root, "risk_dashboard.json"),
        latest_macro_state: path.join(root, "data", "macro_state.json"),
        latest_macro_radar: path.join(root, "data", "macro_radar.json"),
        latest_regime_router_signals: path.join(root, "signals", "regime_router_signals.json"),
        latest_opportunity_pool_json: path.join(root, "data", "opportunity_pool.json"),
        latest_performance_attribution: path.join(root, "data", "performance_attribution.json"),
        latest_research_brain: path.join(root, "data", "research_brain.json")
      }
    })
  );

  await writeFile(path.join(root, "state", "portfolio_state.json"), JSON.stringify({ snapshot_date: "2026-04-02" }));
  await writeFile(path.join(root, "risk_dashboard.json"), JSON.stringify({ as_of: "2026-04-02" }));
  await writeFile(path.join(root, "data", "macro_state.json"), JSON.stringify({ generated_at: "2026-04-02T17:00:00+08:00" }));
  await writeFile(path.join(root, "data", "macro_radar.json"), JSON.stringify({ generated_at: "2026-04-02T17:10:00+08:00" }));
  await writeFile(path.join(root, "signals", "regime_router_signals.json"), JSON.stringify({ generated_at: "2026-04-02T18:00:00+08:00" }));
  await writeFile(path.join(root, "data", "opportunity_pool.json"), JSON.stringify({ as_of: "2026-04-02", generated_at: "2026-04-02T18:10:00+08:00" }));
  await writeFile(path.join(root, "data", "performance_attribution.json"), JSON.stringify({ as_of: "2026-04-02", generated_at: "2026-04-02T18:20:00+08:00" }));

  const result = await runResearchBrainBuild({
    portfolioRoot: root,
    now: new Date("2026-04-02T08:00:00.000Z"),
    quoteFetcher: async () => []
  });

  const saved = JSON.parse(await readFile(result.outputPath, "utf8"));
  assert.equal(saved.meta.market_session, "post_close");
  assert.ok(saved.decision_readiness.level);
  assert.ok(saved.market_snapshot);
});
```

- [ ] **Step 2: Run the test to verify the script contract fails**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs`

Expected: FAIL because `generate_research_brain.mjs` does not exist yet.

- [ ] **Step 3: Write the orchestrator and manifest wiring**

```js
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { classifyResearchSession } from "./lib/research_session.mjs";
import { buildResearchFreshnessGuard } from "./lib/research_freshness_guard.mjs";
import { buildResearchCoverageGuard } from "./lib/research_coverage_guard.mjs";
import { buildResearchMarketSnapshot } from "./lib/research_market_snapshot.mjs";
import { buildResearchSnapshot } from "./lib/research_snapshot_builder.mjs";
import { deriveResearchDecisionReadiness } from "./lib/research_decision_readiness.mjs";
import { buildAnalyticsPaths } from "./lib/report_context.mjs";

async function readJsonOrNull(targetPath) {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

export async function runResearchBrainBuild({ portfolioRoot = resolvePortfolioRoot(), now = new Date(), quoteFetcher } = {}) {
  const manifest = JSON.parse(await readFile(buildPortfolioPath(portfolioRoot, "state-manifest.json"), "utf8"));
  const paths = buildAnalyticsPaths(portfolioRoot, manifest, null);
  const payloads = {
    latest: await readJsonOrNull(paths.latestPath),
    riskDashboard: await readJsonOrNull(paths.riskDashboardPath),
    macroState: await readJsonOrNull(paths.macroStatePath),
    macroRadar: await readJsonOrNull(paths.macroRadarPath),
    regimeSignals: await readJsonOrNull(paths.regimeSignalsPath),
    opportunityPool: await readJsonOrNull(paths.opportunityPoolJsonPath),
    performanceAttribution: await readJsonOrNull(paths.performanceAttributionPath)
  };

  const sessionInfo = classifyResearchSession(now);
  const researchSnapshot = buildResearchSnapshot({ payloads });
  const marketSnapshot = await buildResearchMarketSnapshot({
    quoteFetcher,
    macroStateFallback: payloads.macroState,
    now
  });
  const freshnessGuard = buildResearchFreshnessGuard({
    now,
    sessionInfo,
    dependencies: [
      {
        key: "portfolio_state",
        label: "组合状态",
        required: true,
        effectiveTimestamp: payloads.latest?.generated_at ?? payloads.latest?.snapshot_date ?? null,
        tradeDate: String(payloads.latest?.snapshot_date ?? "").slice(0, 10) || null,
        domain: "portfolio_state"
      },
      {
        key: "risk_dashboard",
        label: "风控盘",
        required: true,
        effectiveTimestamp: payloads.riskDashboard?.generated_at ?? payloads.riskDashboard?.as_of ?? null,
        tradeDate: String(payloads.riskDashboard?.as_of ?? "").slice(0, 10) || null,
        domain: "risk_state"
      },
      {
        key: "market_snapshot",
        label: "跨市场快照",
        required: true,
        effectiveTimestamp: marketSnapshot.generated_at,
        tradeDate: sessionInfo.tradeDate,
        domain: "market_snapshot"
      },
      {
        key: "macro_state",
        label: "宏观状态",
        required: true,
        effectiveTimestamp: payloads.macroState?.generated_at ?? null,
        tradeDate: sessionInfo.tradeDate,
        domain: "macro_state"
      },
      {
        key: "macro_radar",
        label: "宏观雷达",
        required: true,
        effectiveTimestamp: payloads.macroRadar?.generated_at ?? null,
        tradeDate: sessionInfo.tradeDate,
        domain: "macro_radar"
      },
      {
        key: "regime_router_signals",
        label: "制度化信号路由",
        required: true,
        effectiveTimestamp: payloads.regimeSignals?.generated_at ?? null,
        tradeDate: sessionInfo.tradeDate,
        domain: "regime_router_signals"
      },
      {
        key: "opportunity_pool",
        label: "机会池",
        required: false,
        effectiveTimestamp: payloads.opportunityPool?.generated_at ?? null,
        tradeDate: String(payloads.opportunityPool?.as_of ?? "").slice(0, 10) || null,
        domain: "opportunity_pool"
      },
      {
        key: "performance_attribution",
        label: "业绩归因",
        required: false,
        effectiveTimestamp: payloads.performanceAttribution?.generated_at ?? null,
        tradeDate: String(payloads.performanceAttribution?.as_of ?? payloads.performanceAttribution?.snapshot_date ?? "").slice(0, 10) || null,
        domain: "performance_attribution"
      }
    ]
  });
  const coverageGuard = buildResearchCoverageGuard({ marketSnapshot, researchSnapshot });
  const decisionReadiness = deriveResearchDecisionReadiness({ sessionInfo, freshnessGuard, coverageGuard });

  const output = {
    meta: {
      account_id: resolveAccountId({ portfolioRoot }),
      portfolio_root: portfolioRoot,
      trade_date: sessionInfo.tradeDate,
      generated_at: now.toISOString(),
      market_session: sessionInfo.session,
      data_cutoff_time: sessionInfo.shanghaiClock,
      schema_version: 1
    },
    freshness_guard: freshnessGuard,
    coverage_guard: coverageGuard,
    research_snapshot: researchSnapshot,
    market_snapshot: marketSnapshot,
    decision_readiness: decisionReadiness
  };

  const outputPath =
    manifest?.canonical_entrypoints?.latest_research_brain ?? buildPortfolioPath(portfolioRoot, "data", "research_brain.json");
  await mkdir(buildPortfolioPath(portfolioRoot, "data"), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return { outputPath, output };
}
```

Also patch the manifests:

```json
{
  "canonical_entrypoints": {
    "latest_research_brain": "/Users/yinshiwei/codex/tz/portfolio/data/research_brain.json"
  }
}
```

```js
const stateManifest = {
  canonical_entrypoints: {
    latest_research_brain: buildPortfolioPath(userRoot, "data", "research_brain.json")
  }
};
```

- [ ] **Step 4: Run the orchestrator tests and smoke runs**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs --user wenge
```

Expected:
- the contract test passes
- `portfolio/data/research_brain.json` exists
- `portfolio_users/wenge/data/research_brain.json` exists
- both files contain `meta.market_session`, `freshness_guard`, `coverage_guard`, and `decision_readiness`

- [ ] **Step 5: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs /Users/yinshiwei/codex/tz/portfolio/state-manifest.json /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.mjs
git commit -m "feat: add research brain orchestrator"
```

### Task 8: Converge report context and report renderers onto `research_brain`

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`

- [ ] **Step 1: Write the failing report-context regression test**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalyticsPaths,
  shouldRefreshResearchBrain
} from "./report_context.mjs";

test("buildAnalyticsPaths exposes researchBrainPath", () => {
  const paths = buildAnalyticsPaths("/tmp/demo", {
    canonical_entrypoints: {
      latest_research_brain: "/tmp/demo/data/research_brain.json"
    }
  });

  assert.equal(paths.researchBrainPath, "/tmp/demo/data/research_brain.json");
});

test("shouldRefreshResearchBrain returns true when upstream dependencies refreshed", () => {
  const result = shouldRefreshResearchBrain({
    refreshMode: "auto",
    refreshedKeys: new Set(["risk_dashboard"]),
    payloads: {
      researchBrain: { generated_at: "2026-04-02T08:00:00+08:00" },
      riskDashboard: { generated_at: "2026-04-02T18:00:00+08:00" }
    }
  });

  assert.equal(result, true);
});
```

- [ ] **Step 2: Run the test to verify the current exports are missing**

Run: `node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs`

Expected: FAIL because `researchBrainPath` and `shouldRefreshResearchBrain` do not exist yet.

- [ ] **Step 3: Update `report_context.mjs` to treat `research_brain` as first-class**

```js
export function buildAnalyticsPaths(portfolioRoot, manifest, sharedManifest = null) {
  const canonical = manifest?.canonical_entrypoints ?? {};
  return {
    // existing paths ...
    researchBrainPath:
      canonical.latest_research_brain ??
      buildPortfolioPath(portfolioRoot, "data", "research_brain.json")
  };
}

async function loadPayloads(paths) {
  const [researchBrain] = await Promise.all([
    readJsonOrNull(paths.researchBrainPath)
  ]);
  return {
    // existing payloads ...
    researchBrain
  };
}

export function shouldRefreshResearchBrain({
  refreshMode,
  refreshedKeys = new Set(),
  payloads = {},
  freshness = {}
}) {
  if (refreshMode === "force") {
    return true;
  }

  if (
    refreshedKeys.has("cn_market_snapshot") ||
    refreshedKeys.has("macro_state") ||
    refreshedKeys.has("risk_dashboard") ||
    refreshedKeys.has("opportunity_pool")
  ) {
    return true;
  }

  return isGeneratedAfter(payloads.latest, payloads.researchBrain) ||
    isGeneratedAfter(payloads.riskDashboard, payloads.researchBrain) ||
    Array.isArray(freshness?.missingKeys) && freshness.missingKeys.includes("research_brain");
}
```

Then refresh it inside `ensureReportContext`:

```js
  if (shouldRefreshResearchBrain({ refreshMode, refreshedKeys, payloads, freshness })) {
    const result = await runRefreshStep("research_brain", "node", [
      buildPortfolioPath(workspaceRoot, "portfolio", "scripts", "generate_research_brain.mjs"),
      "--portfolio-root",
      portfolioRoot
    ]);
    if (result.ok) {
      refreshedKeys.add("research_brain");
      refresh.refreshedTargets.push("research_brain");
    } else {
      refresh.errors.push(result);
    }
  }
```

- [ ] **Step 4: Update both report scripts to render the new contract**

Add a shared report block pattern:

```js
function buildResearchGuardLines(reportContext) {
  const researchBrain = reportContext?.payloads?.researchBrain ?? {};
  const readiness = researchBrain?.decision_readiness ?? {};
  const coverage = researchBrain?.coverage_guard ?? {};

  return [
    `- 研究会话：${researchBrain?.meta?.market_session ?? "unknown"}。`,
    `- 决策状态：${readiness.level ?? "unknown"}。`,
    ...(readiness.reasons ?? []).map((reason) => `- 风险说明：${reason}`),
    ...(coverage.weak_domains ?? []).map((domain) => `- 覆盖降级：${domain} 域不完整，以下结论仅作低置信度参考。`)
  ];
}
```

Use it in `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs` near the context header and in `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs` near the freshness section so the output visibly says:

```md
## Institutional Research Readiness

- 研究会话：intraday。
- 决策状态：trading_blocked。
- 风险说明：交易依赖存在时效问题，禁止输出明确交易指令。
```

- [ ] **Step 5: Run regression tests and report smoke runs**

Run:

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs
node --check /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs
node --check /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --user main --refresh auto
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user main --session morning --refresh auto
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user wenge --session close --refresh auto
```

Expected:
- `report_context.test.mjs` passes
- both scripts pass `node --check`
- the generated Markdown files include a readiness block sourced from `research_brain.json`
- a stale/incomplete account shows `analysis_degraded` or `trading_blocked` instead of silently pretending everything is current

- [ ] **Step 6: Commit**

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs
git commit -m "feat: consume research brain in market reports"
```

## Final Verification

- [ ] Run the full unit suite for the new modules:

```bash
node --test \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.test.mjs \
  /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs
```

Expected: PASS with all tests green.

- [ ] Run the cross-account smoke flow:

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs --user wenge
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs --user main --refresh auto
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --user wenge --session noon --refresh auto
```

Expected:
- both accounts emit `data/research_brain.json`
- main and child account reports show the same policy vocabulary
- no report renders a confident trade conclusion when readiness is `analysis_degraded`, `trading_blocked`, or `research_invalid`

- [ ] Create the completion commit:

```bash
git add /Users/yinshiwei/codex/tz/portfolio/scripts /Users/yinshiwei/codex/tz/portfolio/state-manifest.json /Users/yinshiwei/codex/tz/portfolio/docs/superpowers/plans/2026-04-02-institutional-research-brain-phase1-plan.md
git commit -m "feat: add institutional research brain phase 1"
```
