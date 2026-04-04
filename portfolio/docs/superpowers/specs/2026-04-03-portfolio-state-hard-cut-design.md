# Portfolio State Hard Cut Design

## Goal

Eliminate the remaining double-source behavior in the portfolio stack by making `portfolio/state/portfolio_state.json` the only business truth, forcing action guidance to obey research gating, and moving the funds dashboard to consume the same state model directly.

## Problem Statement

Three production-grade inconsistencies remain:

1. The daily brief action memo can still surface stale `trade_plan` instructions even when the research chain has already downgraded the session to `trading_blocked`.
2. Core consumers still tolerate both `holdings` and `positions`, which allows old compatibility structures to leak back into decision logic.
3. OTC fund accounting already models `profit_effective_on`, but some presentation paths still behave as if same-day buys should participate in same-day profit and loss.

This creates a dangerous split between research, accounting, and UI.

## Chosen Approach

Use `portfolio_state.json` as the single source of truth, retain `latest.json` only as a compatibility export, and move the dashboard plus report consumers to the `portfolio_state` schema directly.

This is a hard cut at the consumption layer:

- business logic reads `positions` and `pending_profit_effective_positions`
- action rendering reads research gating first and treats trade plans as subordinate
- dashboard display fields are derived from `portfolio_state`, not from legacy holdings snapshots

## Rejected Alternatives

### 1. Keep a compatibility mapping layer indefinitely

This lowers migration risk short term, but keeps the old contract alive and guarantees future drift.

### 2. Continue using `latest.json` as the front-end truth

This minimizes work today, but preserves the exact ambiguity that produced the current bugs.

## Architecture

### Truth Model

`portfolio/state/portfolio_state.json` becomes the only authoritative state object for:

- active positions
- pending OTC buys not yet profit-effective
- cash and settlement balances
- performance snapshot
- trade lifecycle summary

The only business collections that matter are:

- `positions`
- `pending_profit_effective_positions`

`latest.json` remains a generated compatibility artifact and may still be written for old tooling, but no decision-making or reporting code should use it as an input.

### Action Hierarchy

Action guidance must obey this priority:

1. `research_brain.actionable_decision.desk_conclusion.trade_permission`
2. freshness / missing dependency guardrails
3. `trade_plan` details, only if action generation is still allowed

This means:

- `trade_permission = blocked | research_invalid` suppresses all "可执行" language
- `trade_plan` can explain sequencing only when the desk is not blocked
- the daily brief, market pulse, and market brief must render one consistent action stance

### Dashboard Contract

The dashboard should read `portfolio_state.json` directly and compute one normalized display view per fund:

- identity: `fund_code`, `name`
- state: `status`, `execution_type`, `confirmation_state`, `profit_effective_on`
- value: `amount`, `holding_pnl`, `daily_pnl`
- quote mode: `live_estimate`, `confirmed_nav`, `close_reference`, `unavailable`
- quote metadata: `last_confirmed_nav`, `last_confirmed_nav_date`, `last_confirmed_nav_time`

For OTC buys that are not yet profit-effective:

- they remain outside same-day `daily_pnl`
- they are shown as pending positions with explicit state
- the dashboard can present them as "已买入，明日开始计收益"

## Data Flow

### Action Memo

1. `generate_research_brain.mjs` computes `actionable_decision`
2. `generate_daily_brief.mjs` reads research decision first
3. `trade_plan` markdown is only consulted if the research decision still permits action
4. rendered memo lines must never contradict the desk conclusion

### Portfolio State

1. raw platform snapshot + execution ledger enter `portfolio_state_materializer`
2. materializer outputs `portfolio_state`
3. all consumers read `portfolio_state`
4. `latest.json` is generated only as a compatibility view, never as an input

### OTC Profit Recognition

1. manual trade recorder writes `profit_effective_on`
2. state materializer puts not-yet-effective OTC buys into `pending_profit_effective_positions`
3. dashboard and reports display them explicitly, but exclude them from same-day PnL

## Error Handling

- If `portfolio_state.json` is missing required arrays, consumers should fail fast instead of silently falling back to `holdings`.
- If research readiness is blocked or invalid, action renderers must emit blocked text and stop reading executable trade instructions.
- If dashboard quote freshness is degraded, the UI should mark the quote mode and timestamp explicitly rather than blending stale and live states.

## Testing Strategy

### Action Consistency

- blocked research state + stale trade plan must still render blocked action memo
- allowed research state + fresh trade plan may render executable guidance

### State Contract

- consumers should prefer `positions` only
- tests should fail if old `holdings` fallback is the only input

### OTC Accounting

- same-day OTC buys remain outside same-day PnL
- pending buys appear in `pending_profit_effective_positions`
- EXCHANGE trades still bypass pending-profit scheduling

### Dashboard Rendering

- dashboard output must include pending OTC buys with explicit state
- global QDII early-morning updates must not be treated as same-day domestic PnL

## Success Criteria

- No user-facing report can show "可执行" when research has already blocked trading.
- No core script depends on `holdings` as a decision input.
- The funds dashboard and reports agree on whether a same-day OTC buy is pending or profit-effective.
- `portfolio_state.json` is sufficient to rebuild all primary portfolio views.
