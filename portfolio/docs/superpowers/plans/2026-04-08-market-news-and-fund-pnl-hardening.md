# Market News And Fund PnL Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade market analysis from single-source telegraph heuristics to a multi-source, multi-factor analysis pipeline, and repair fund holding-profit accounting so dashboard PnL is durable and correct.

**Architecture:** Keep the existing `generate_dialogue_analysis_contract.mjs -> generate_research_brain.mjs -> research_event_driver.mjs` chain as the canonical market-analysis entry, but insert a structured news aggregation layer with source ranking, freshness tracking, and cross-asset confirmation. In parallel, harden the fund accounting chain so `portfolio_state.json` carries an explicit, reconstructible holding-cost basis instead of inferring cost from mutable current amount.

**Tech Stack:** Node.js ESM scripts, existing `market-mcp` providers, portfolio JSON state artifacts, dashboard API `8766`, Node test runner, Python/web fallback only when structured source coverage is missing.

---

## Current Findings

- Current market-analysis news input is still single-source on the canonical path:
  - [stock.js](/Users/yinshiwei/codex/tz/market-mcp/src/providers/stock.js#L689)
  - [generate_research_brain.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs#L283)
  - [research_event_driver.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.mjs#L184)
- Report scripts and canonical dialogue-analysis use different implicit news standards, so the same day can produce different “main driver” judgments.
- The current event-driver model is too narrow for gold and macro assets; it over-compresses gold into “避险” and misses liquidity / real-rate / USD / positioning / central-bank / commodity interactions.
- The fund dashboard issue is not front-end only. In current canonical state, at least 5 active funds have `amount > 0` and `holding_pnl = 0`, including:
  - `022502` 国泰黄金ETF联接E
  - `021482` 华夏中证红利低波动ETF发起式联接A
  - `025209` 永赢先锋半导体智选混合C
  - `016482` 兴全恒信债券C
  - `021142` 华夏港股通央企红利ETF联接A
- Root accounting defect:
  - [confirmed_nav_reconciler.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/confirmed_nav_reconciler.mjs#L289) only recalculates `holding_pnl` when `previousHoldingPnl` already exists.
  - Several positions entered `latest_raw.json` with `holding_pnl = 0`, so later reconciliation preserved a fake zero-profit cost basis forever.

## Phase Split

- **P0:** Market-analysis source contract hardening
- **P1:** Multi-source event-driver and gold multi-factor model
- **P2:** Fund holding-cost / holding-profit repair and dashboard regression

## P0 Acceptance Criteria

- `分析当前行情` no longer depends on single-source telegraph alone.
- The canonical analysis payload explicitly says which news sources were used, which were unavailable, and whether the result is `single_source_degraded` or `multi_source_confirmed`.
- Agent bootstrap / routing docs explicitly require external headline refresh before final market commentary.

## P1 Acceptance Criteria

- Canonical event-driver ranking uses source priority, freshness, and market confirmation.
- Gold analysis must expose at least these factor lenses when relevant:
  - real rates
  - USD
  - liquidity squeeze / deleveraging
  - geopolitics
  - commodity / oil inflation pass-through
  - central-bank / reserve demand
- A major external headline from AP / Reuters / Caixin / Yicai class sources must be able to outrank lower-grade telegraph noise.

## P2 Acceptance Criteria

- `portfolio_state.json` stores a durable holding-cost basis field for OTC funds.
- `holding_pnl` for previously zero-locked positions is reconstructed or marked explicitly unreconstructable.
- `8766` dashboard shows non-zero holding-profit for positions where confirmed cost basis exists.
- No GET request path writes repo state.

### Task 1: Build News Source Registry And Source Health Contract

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_news_registry.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_news_registry.test.mjs`
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md](/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md)

- [ ] Define source tiers and fallback policy in `research_news_registry.mjs`.
  - Tier 1: Reuters / AP / Bloomberg / FT / WSJ / official exchange-calendar / official macro-stat sources.
  - Tier 2: 财新 / 第一财经 / 21世纪 / 经济观察报 / 中国证券报 / 上海证券报 / 证券时报 / 新华财经 / 华尔街见闻 / 澎湃财经.
  - Tier 3: 财联社电报 and other telegraph-style real-time feeds.
- [ ] Expose registry metadata:
  - `sourceId`
  - `tier`
  - `sourceType`
  - `region`
  - `marketScope`
  - `defaultTrustScore`
  - `requiresBrowserFetch`
- [ ] Write failing tests for:
  - source tier ordering
  - fallback behavior when Tier 1 sources are missing
  - market-analysis intent metadata requiring external headline refresh
- [ ] Update bootstrap routing so `分析当前行情` and `今天该不该交易` declare required external sources and forbidden single-source completion.
- [ ] Update protocol doc so “实时行情分析必须补最新新闻” becomes a machine-enforced contract, not just prose.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_news_registry.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.test.mjs
```

### Task 2: Add Canonical Multi-Source News Aggregator

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_news_aggregator.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_news_aggregator.test.mjs`
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/generate_dialogue_analysis_contract.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_dialogue_analysis_contract.mjs)

- [ ] Replace `loadTelegraphEvidence()` as the sole canonical input with a news-aggregation step that returns:
  - `stories`
  - `sourceHealth`
  - `coverage`
  - `topHeadlines`
  - `degradedReason`
- [ ] Keep telegraph support as one source, not the whole system.
- [ ] Ensure `research_brain.json` persists:
  - `news_source_health`
  - `news_coverage`
  - `news_story_count`
  - `top_headlines`
  - `analysis_mode: multi_source_confirmed | single_source_degraded`
- [ ] Ensure dialogue-analysis output surfaces these fields so new agents cannot silently present degraded commentary as full-spectrum analysis.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_news_aggregator.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_dialogue_analysis_contract.test.mjs
```

### Task 3: Replace Keyword-Only Event Ranking With Source-Weighted Driver Ranking

**Files:**
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs)

- [ ] Change driver ranking inputs from `telegraphs` to normalized `stories`.
- [ ] Score by:
  - source tier
  - recency decay
  - direct market relevance
  - cross-asset confirmation breadth
  - duplicate corroboration across multiple outlets
- [ ] Keep `watch_only` / `priced_in_noise` / `active_market_driver`, but make them dependent on both source quality and market confirmation.
- [ ] Add regression tests where:
  - Reuters/AP-class ceasefire headline outranks lower-tier telegraph filler.
  - Same theme reported by multiple outlets gets promoted over one-off noisy keywords.
  - A high-tier headline without market confirmation remains `watch_only`.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_event_driver.test.mjs
```

### Task 4: Expand Gold Into A Multi-Factor Analysis Module

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_gold_factor_model.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_gold_factor_model.test.mjs`
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.mjs)

- [ ] Build a gold-factor model that reads:
  - gold spot / futures
  - USD / DXY proxy if available
  - US rates / yield proxies if available
  - oil / commodity inflation proxies
  - equity drawdown / liquidity squeeze markers
  - geopolitics headline confirmation
- [ ] Output:
  - `dominantGoldDriver`
  - `secondaryGoldDrivers`
  - `goldRegime`
  - `goldActionBias`
  - `goldRiskNotes`
- [ ] Render this in the canonical research-brain output so gold is no longer explained with a single-label narrative.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_gold_factor_model.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_brain_render.test.mjs
```

### Task 5: Introduce Durable Fund Cost Basis In Canonical State

**Files:**
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/lib/confirmed_nav_reconciler.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/confirmed_nav_reconciler.mjs)
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/holding_cost_basis.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/holding_cost_basis.test.mjs`

- [ ] Add a canonical field for OTC positions:
  - `holding_cost_basis_cny`
- [ ] Stop inferring cost from `previousAmount - previousHoldingPnl` when `previousHoldingPnl` is fake zero.
- [ ] Materializer must preserve and update cost basis through:
  - buy
  - sell
  - conversion
  - same-day raw-snapshot unwind
  - confirmed NAV reconciliation
- [ ] Reconciler should recompute `holding_pnl` from:
  - `reconciledAmount - holding_cost_basis_cny`
  - not from “current amount equals cost when pnl missing”

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/holding_cost_basis.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/lib/confirmed_nav_reconciler.test.mjs
```

### Task 6: Backfill Zero-Locked Holdings And Preserve Auditability

**Files:**
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/backfill_holding_cost_basis.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/backfill_holding_cost_basis.test.mjs`
- Modify: [/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json](/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json) via script only
- Modify: [/Users/yinshiwei/codex/tz/portfolio/snapshots/latest_raw.json](/Users/yinshiwei/codex/tz/portfolio/snapshots/latest_raw.json) via script only when allowed by contract

- [ ] Build a one-time backfill that classifies zero-locked positions into:
  - `reconstructed_from_trade_history`
  - `reconstructed_from_units_and_known_buy_amount`
  - `manual_review_required`
- [ ] Do not silently fabricate cost basis where history is insufficient.
- [ ] Emit audit fields:
  - `holding_cost_basis_source`
  - `holding_cost_basis_backfilled_at`
  - `holding_cost_basis_confidence`
- [ ] Use current broken sample set as regression fixtures, including `022502`.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/backfill_holding_cost_basis.test.mjs
```

### Task 7: Rebuild Dashboard Summary And Row Contracts Against Canonical Cost Basis

**Files:**
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs)
- Modify: [/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs)

- [ ] Make dashboard rows read `holding_cost_basis_cny` / canonical `holding_pnl`.
- [ ] Ensure `holdingProfit` summary is derived from canonical state and not masked by zero-locked rows.
- [ ] Add tests that verify `国泰黄金ETF联接E` style positions produce non-zero holding profit once cost basis is backfilled.
- [ ] Keep live estimate overlay separate from holding-profit accounting.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

### Task 8: Full Regression And Runtime Validation

**Files:**
- No new source files; run full suites and targeted smoke checks.

- [ ] Run targeted Node suites for research, dashboard, state materialization, reconciler, bootstrap.
- [ ] Rebuild canonical artifacts:
  - `agent_bootstrap_context.json`
  - `research_brain.json`
  - `dialogue_analysis_contract.json`
  - `dashboard_state.json`
- [ ] Validate runtime:
  - `8766` `/api/live-funds`
  - market analysis output includes source health and top headlines
  - gold row holding-profit is non-zero if basis reconstructed
- [ ] Record any positions still marked `manual_review_required`.

**Run:**

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/generate_dialogue_analysis_contract.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs
```

## Execution Notes

- Do not start from UI. The accounting repair must land before any dashboard interpretation change.
- Do not treat “holding_pnl = 0” as neutral data. For legacy seeded holdings it is often a broken placeholder, not a real zero-profit position.
- Do not let canonical market-analysis finish without exposing source coverage.
- Do not let a high-tier external headline bypass market confirmation; the model should elevate it, not blindly obey it.

## Self-Review

- Spec coverage:
  - Multi-source finance news: covered by Tasks 1-3.
  - “Every market analysis must first check major financial sites”: covered by Tasks 1-2 and protocol hardening.
  - Gold multi-factor analysis: covered by Task 4.
  - Fund dashboard holding-profit not updating: covered by Tasks 5-7.
- Placeholder scan:
  - No `TODO` / `TBD` markers remain.
- Type consistency:
  - Canonical cost-basis field name is fixed as `holding_cost_basis_cny`.
  - Canonical analysis source-health names are fixed as `news_source_health`, `news_coverage`, `top_headlines`.

## Execution Handoff

Plan complete and saved to `/Users/yinshiwei/codex/tz/portfolio/docs/superpowers/plans/2026-04-08-market-news-and-fund-pnl-hardening.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks
2. Inline Execution - execute tasks in this session in P0 -> P1 -> P2 order
