# Institutional Research Brain Phase 1 Design

**Date:** 2026-04-02
**Branch:** `codex/phase-a-ledger-foundation`
**Scope:** Build the first production-grade foundation for a unified institutional research brain that can become the single upstream source for market analysis, reports, dialogue answers, and trade readiness decisions.

---

## 1. Goal

Phase 1 establishes a unified research middleware layer for the portfolio system.

The immediate goal is not to make the system "smarter" in every dimension yet. The goal is to ensure the system stops producing analysis from stale or incomplete inputs, and that every downstream consumer reads from a common research state instead of assembling its own temporary view.

This phase must solve four concrete failures:

1. Reports or analysis can silently render with yesterday's data.
2. Different scripts can analyze the same market state using inconsistent upstream inputs.
3. The system does not yet have a formal analysis-readiness or trading-readiness gate.
4. The current analysis layer is too fragmented to support future event, flow, macro, and opportunity engines cleanly.

---

## 2. Recommended Approach

Three implementation approaches were considered:

### Approach A: Lightweight wrapper

Read existing artifacts, wrap them into a new file, and add basic freshness flags.

**Pros**
- Fastest to ship
- Lowest immediate engineering risk

**Cons**
- Mostly cosmetic
- Leaves too much implicit logic in old scripts
- Weak foundation for future event/flow/macro modules

### Approach B: Modular research middleware

Create a new `generate_research_brain.mjs` entrypoint and a focused set of helper modules:
- session classification
- freshness guard
- coverage guard
- market snapshot assembly
- research snapshot builder
- decision readiness synthesis

**Pros**
- Cleanest foundation for future phases
- Keeps boundaries explicit
- Lets old reports consume the new research object without rewriting everything immediately

**Cons**
- Slightly more work in Phase 1
- Requires a few new files and tests

### Approach C: Rewrite report scripts directly

Push freshness and readiness logic directly into `generate_market_brief.mjs`, `generate_market_pulse.mjs`, and related scripts.

**Pros**
- Fast visible output changes

**Cons**
- Continues the current fragmentation
- Makes large scripts larger
- Not suitable for long-term institutional architecture

### Recommendation

**Approach B** is recommended.

It preserves the current report shell while replacing the research substrate underneath it. That is the safest path to a real institutional-grade architecture.

---

## 3. Phase 1 Architecture

Phase 1 introduces a new unified artifact:

- `portfolio/data/research_brain.json`
- `portfolio_users/<user>/data/research_brain.json`

This artifact becomes the primary analysis substrate for:

- dialogue-based market analysis
- morning / midday / close market reports
- next-trade decision readiness
- dashboard warning layers

The architecture is:

`canonical portfolio state + existing research artifacts + live market snapshot`
→ `freshness / coverage validation`
→ `decision readiness synthesis`
→ `research_brain.json`

Downstream scripts should consume the resulting unified object instead of rebuilding their own temporary state as much as possible.

---

## 4. Core Modules

### 4.1 `generate_research_brain.mjs`

The new orchestrator entrypoint.

Responsibilities:
- resolve account root and canonical paths
- load existing state artifacts
- fetch the minimum live market snapshot needed for session-aware analysis
- run freshness guard and coverage guard
- synthesize decision readiness
- write `research_brain.json`

This file should remain orchestration-only and avoid containing the actual validation logic.

### 4.2 `research_session.mjs`

Classifies the current time into a stable market session vocabulary:

- `pre_open`
- `intraday`
- `post_close`
- `overnight`

Responsibilities:
- infer current session from Shanghai time
- determine the expected data shape for each session
- expose session-aware rules for "acceptable" upstream timestamps

This module is critical because freshness should not mean the same thing at 08:20 and 14:35.

### 4.3 `research_freshness_guard.mjs`

Validates whether each upstream dependency is recent enough for the current session.

Inputs:
- portfolio state snapshot date / generation time
- macro state / macro radar timestamps
- regime signals effective dates
- risk dashboard timestamps
- live market snapshot timestamps

Outputs per dependency:
- `ok | stale | missing | optional_missing`
- effective timestamp
- lag hours
- reason text

This module answers: "Is the system reading data from the right time?"

### 4.4 `research_coverage_guard.mjs`

Validates whether the analysis has enough breadth to make a serious statement.

Coverage domains in Phase 1:
- A-share core index coverage
- Hong Kong market coverage
- global risk proxy coverage
- macro anchor baseline coverage
- portfolio-state and risk artifacts coverage

The purpose is to prevent the system from sounding confident when key domains are absent.

### 4.5 `research_market_snapshot.mjs`

Fetches a minimal but high-value live cross-asset snapshot for analysis gating.

Phase 1 coverage should include at least:
- A-share core indices
- Hong Kong core indices
- US futures / overnight risk proxies
- gold
- oil
- USD index proxy
- US Treasury yield anchors where already available through current providers or local state

This snapshot is not yet the full macro engine. It is the baseline live surface needed to avoid stale or under-informed analysis.

### 4.6 `research_snapshot_builder.mjs`

Normalizes existing mature artifacts into one object:

- `portfolio_state`
- `risk_dashboard`
- `macro_state`
- `macro_radar`
- `regime_router_signals`
- `opportunity_pool`
- optional `performance_attribution`

This builder does not reinterpret the research deeply in Phase 1. It standardizes shape, timestamps, and availability.

### 4.7 `research_decision_readiness.mjs`

Collapses freshness + coverage + session rules into a single operational status.

Allowed readiness levels:
- `ready`
- `analysis_degraded`
- `trading_blocked`
- `research_invalid`

Outputs:
- whether analysis is allowed
- whether trading conclusions are allowed
- reasons
- stale dependency list
- missing dependency list

This is the policy layer that makes the system honest.

---

## 5. Data Contract

Phase 1 `research_brain.json` should contain these top-level blocks.

### 5.1 `meta`

Fields:
- `account_id`
- `portfolio_root`
- `trade_date`
- `generated_at`
- `market_session`
- `data_cutoff_time`
- `schema_version`

### 5.2 `freshness_guard`

Fields:
- `overall_status`
- `dependencies[]`
- `stale_dependencies[]`
- `missing_dependencies[]`

Each dependency entry should include:
- `key`
- `label`
- `status`
- `effective_timestamp`
- `lag_hours`
- `required`
- `reason`

### 5.3 `coverage_guard`

Fields:
- `overall_status`
- `domains`
- `missing_domains`
- `weak_domains`

Domains should include at minimum:
- `a_share`
- `hong_kong`
- `global_risk`
- `macro_anchors`
- `portfolio_state`
- `risk_state`

### 5.4 `research_snapshot`

Aggregated references to normalized upstream payloads.

Fields:
- `portfolio_state`
- `risk_dashboard`
- `macro_state`
- `macro_radar`
- `regime_router_signals`
- `opportunity_pool`
- `performance_attribution`

These should be the normalized payloads, not just file paths.

### 5.5 `market_snapshot`

Live cross-asset price surface used for gating and report context.

Fields should include:
- `a_share_indices`
- `hong_kong_indices`
- `global_indices`
- `commodities`
- `rates_fx`

Each item should include:
- label
- code
- latest price
- pct change
- quote time if available
- fetch status

### 5.6 `decision_readiness`

Fields:
- `level`
- `analysis_allowed`
- `trading_allowed`
- `reasons[]`
- `stale_dependencies[]`
- `missing_dependencies[]`
- `session_constraints[]`

This is the primary decision layer for downstream consumers.

---

## 6. Freshness and Coverage Policy

### 6.1 Freshness policy

Freshness must be session-aware.

#### `pre_open`

Acceptable:
- previous close for A-share / Hong Kong cash market
- latest overnight futures / global proxies
- latest available macro state

Unacceptable:
- stale portfolio signal artifacts beyond configured tolerance
- missing overnight risk proxies

#### `intraday`

Acceptable:
- live or same-session market snapshot
- same-trade-date portfolio / risk stack

Unacceptable:
- prior-day-only market context presented as current intraday state

#### `post_close`

Acceptable:
- same-day cash market close
- same-day portfolio state

#### `overnight`

Acceptable:
- most recent close for domestic markets
- latest overseas futures / global risk proxies

### 6.2 Coverage policy

Coverage should be enough to support the requested use.

Examples:
- If the user asks about Hong Kong trading, Hong Kong index coverage cannot be missing.
- If the user asks for a trading plan, portfolio state, regime signals, and risk state cannot be stale.
- If the user asks for a macro read, macro anchors cannot be mostly absent.

Coverage failure should not always block analysis, but it must always lower confidence and sometimes block trading conclusions.

---

## 7. Readiness Rules

### Level `ready`

Conditions:
- no required stale dependencies
- no critical missing domains
- session constraints satisfied

Effects:
- allow full analysis
- allow explicit trading conclusions

### Level `analysis_degraded`

Conditions:
- some secondary domains missing
- major context present, but confidence reduced

Effects:
- allow directional analysis
- disallow aggressive or high-confidence trading instructions

### Level `trading_blocked`

Conditions:
- analysis can still describe the market
- trading dependencies are stale or inconsistent

Effects:
- allow market commentary
- explicitly block trade advice

### Level `research_invalid`

Conditions:
- critical dependencies missing or contradictory

Effects:
- block report-quality analysis
- block trade conclusions
- output only the failure reasons and dependency gaps

---

## 8. Downstream Integration Strategy

Phase 1 will not rewrite all consumers.

Instead:

### `generate_market_brief.mjs`

Will continue to render the report, but should begin reading:
- session classification
- decision readiness
- freshness notes
- coverage notes

### `generate_market_pulse.mjs`

Will continue to generate intraday output, but should read:
- whether analysis is degraded
- whether trading is blocked
- which dependencies are stale

### `generate_next_trade_plan.mjs`

Will continue to use its current strict trade freshness guard, but should become capable of reading `research_brain.json` as an upstream readiness layer in later phases.

This keeps Phase 1 focused while making future adoption straightforward.

---

## 9. File Plan

### Create

- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_research_brain.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_snapshot_builder.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_session.test.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_freshness_guard.test.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_coverage_guard.test.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_market_snapshot.test.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/research_decision_readiness.test.mjs`

### Modify

- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/report_context.mjs`

Phase 1 may also add the new canonical file path to:
- `/Users/yinshiwei/codex/tz/portfolio/state-manifest.json`
- bootstrap paths for child accounts if needed

---

## 10. Testing Strategy

Phase 1 must be test-first and focus on deterministic policy logic.

Required tests:

- session classification by Shanghai time
- freshness classification for fresh / stale / missing dependencies
- coverage classification for critical and secondary domains
- readiness classification across all four output levels
- snapshot builder normalization from sparse and complete upstream payloads

Validation should include at least one real-world smoke run on:
- main account
- one child account such as `wenge`

The smoke run should verify:
- output file creation
- stable JSON schema
- correct degraded or blocked status when inputs are stale or incomplete

---

## 11. Risks and Mitigations

### Risk: Phase 1 becomes too ambitious

Mitigation:
- keep event logic, deep flow logic, and macro interpretation out of Phase 1
- Phase 1 only builds the substrate

### Risk: Old scripts and new substrate drift

Mitigation:
- downstream consumers should read readiness and freshness from `research_brain.json` as soon as possible
- minimize duplicated policy logic in report renderers

### Risk: False confidence from incomplete live market coverage

Mitigation:
- the coverage guard must explicitly downgrade analysis when domains are incomplete

### Risk: Child-account compatibility

Mitigation:
- `research_brain.json` should be emitted under each account root
- shared market-wide sources can still point to shared data artifacts when appropriate

---

## 12. Out of Scope for Phase 1

The following are explicitly deferred:

- deep event clustering and narrative scoring
- northbound / southbound / ETF flow analytics
- macro regime inference from oil, rates, USD, inflation, and cut probabilities
- new sector opportunity ranking engine
- full report language rewrite

These belong to later phases and should attach to the research brain once the substrate exists.

---

## 13. Success Criteria

Phase 1 is successful when:

1. The system emits a unified `research_brain.json` for main and child accounts.
2. The object exposes explicit freshness, coverage, and readiness status.
3. Reports can consume readiness status instead of silently assuming validity.
4. The system no longer presents stale or incomplete research as if it were institution-grade real-time analysis.
5. The architecture is ready for future event, flow, macro, and opportunity engines without another structural rewrite.
