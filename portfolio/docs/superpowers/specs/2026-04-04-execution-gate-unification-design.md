# Execution Gate Unification Design

## Goal

Make `portfolio/state/portfolio_state.json` the only runtime business state input and make manual trade recording obey the same research permission contract that already drives the reporting layer.

## Problem Statement

The system has improved materially, but three structural inconsistencies remain:

1. `state-manifest.json` still presents `latest.json` as `latest_snapshot`, even though the manifest text says `portfolio_state.json` is the canonical analytical state.
2. `record_manual_fund_trades.mjs` enforces structural and IPS constraints through `trade_pre_flight_gate`, but it does not enforce `research_brain.actionable_decision.desk_conclusion.trade_permission`.
3. Compatibility inputs still exist in helper paths and source metadata, which keeps the old `latest.json` mental model alive and increases the chance of future drift.

This means the system can reach a logically inconsistent state:

- research says `blocked`
- reports say `blocked`
- but the write path can still accept a new buy if the structural gate passes

For an execution system, that is the wrong failure mode.

## Chosen Approach

Implement a narrow first-slice hardening pass with three concrete changes:

1. Introduce a unified execution-permission helper that combines:
   - structural/IPS gate results
   - research trade permission
2. Wire `record_manual_fund_trades.mjs` to this unified gate before any transaction file is written.
3. Tighten manifest/state semantics so runtime readers prefer:
   - `portfolio_state`
   - `latest_compat_view`
   instead of continuing to elevate `latest_snapshot` as a primary pointer.

This is intentionally not a full manifest rewrite. It is a contract-clarification pass with immediate execution impact.

## Rejected Alternatives

### 1. Keep research gating in the rendering layer only

This preserves current behavior and keeps reports internally consistent, but it leaves the actual write path weaker than the analysis layer. That is unacceptable for a portfolio operating system.

### 2. Merge research logic directly into `trade_pre_flight_gate`

This would reduce one layer, but it mixes two separate concerns:

- structural safety: cash, concentration, drawdown, bucket limits
- information quality / market readiness: whether the research stack currently permits action

Keeping them separate but composing them at the execution boundary is cleaner.

### 3. Perform a full `state-manifest.json` split now

This is probably the eventual right direction, but it touches too many scripts in one pass. The first optimization slice should reduce runtime ambiguity without forcing a repository-wide manifest migration.

## Architecture

### 1. Truth Model

The runtime truth hierarchy becomes:

1. `portfolio/state/portfolio_state.json`
2. `portfolio/data/research_brain.json`
3. derived sidecars (`risk_dashboard.json`, `live_funds_snapshot.json`, `nightly_confirmed_nav_status.json`, reports)
4. `latest.json` as compatibility export only

Only `portfolio_state.json` is allowed to drive:

- current positions
- cash
- pending profit-effective positions
- exposure and concentration inputs used by execution gating

`latest.json` may still be written for legacy tooling, but it should not be treated as a canonical runtime read source.

### 2. Execution Gate Hierarchy

The write path should evaluate permissions in this order:

1. Load canonical portfolio state
2. Build proposed trades and run `trade_pre_flight_gate`
3. Load `research_brain` and read `actionable_decision.desk_conclusion.trade_permission`
4. Combine both into one execution result
5. Only write transaction payload if the combined result is allowed

The unified gate should behave as follows:

- `trade_permission = blocked`
  - reject all new manual trade writes
- `trade_permission = restricted`
  - allow pure sells / de-risking actions
  - block net new risk-increasing buys
- `trade_permission = allowed`
  - defer to structural gate result only

This gives the system a real difference between:

- “research cannot support execution”
- “research allows observation and de-risking only”
- “research allows normal action inside IPS”

### 3. Manifest Semantics

`state-manifest.json` should stop implying that `latest.json` is the main snapshot entrypoint.

The first-slice contract is:

- `canonical_entrypoints.portfolio_state` remains the primary business state pointer
- `canonical_entrypoints.latest_compat_view` is added as the compatibility export pointer
- `canonical_entrypoints.latest_snapshot` is treated as legacy alias only

Helper behavior should be:

- runtime readers prefer `latest_compat_view`
- if only `latest_snapshot` exists, treat it as compatibility alias
- manifest writers keep both fields aligned during the transition window

This avoids a breaking migration while removing naming ambiguity from new code.

### 4. Sidecar Relationship

`refresh_account_sidecars.mjs` remains the rebuild entrypoint for derived state.

This slice does not change sidecar generation order. It changes only the contract:

- sidecars are rebuilt from canonical state
- transaction writes are denied earlier if research permission is not sufficient

That keeps the refresh chain stable while making the write boundary stricter.

## Data Flow

### Manual Trade Recording

1. CLI parses buy/sell/conversion input
2. CLI loads canonical portfolio state via `loadCanonicalPortfolioState`
3. CLI builds proposed trades with bucket/theme metadata
4. CLI runs structural gate
5. CLI loads `research_brain`
6. CLI derives execution permission
7. CLI either:
   - exits with explicit blocking reasons
   - or writes transaction payload and continues merge/materialize/refresh flow

### State Reading

1. runtime readers ask manifest helper for portfolio state paths
2. helper returns `portfolio_state` plus compatibility view path
3. canonical consumers hard-fail if `portfolio_state` is missing
4. compatibility-only readers may still read `latest_compat_view`

## Error Handling

- If `portfolio_state.json` is missing, manual trade recording fails fast.
- If `research_brain.json` is missing or malformed, execution permission should degrade to at least `restricted`, not silently `allowed`.
- If `trade_permission = blocked`, the CLI must print blocking reasons that explicitly mention research gating.
- If manifest fields are mixed (`latest_snapshot` exists but `latest_compat_view` does not), helpers should normalize behavior instead of producing divergent read paths.

## Testing Strategy

### Unified Gate

- blocked research state rejects a normal buy even when structural gate passes
- restricted research state allows a sell
- restricted research state rejects a buy
- allowed research state still respects structural gate failures

### Manual Trade CLI

- no transaction file is created when research permission is blocked
- sell-only command remains allowed under restricted state
- mixed buy/sell payload is rejected when restricted state would disallow the buy leg

### Manifest Semantics

- path helpers prefer `latest_compat_view` when present
- old manifests using only `latest_snapshot` still work as compatibility aliases
- manifest updates keep canonical and compatibility keys synchronized

## Success Criteria

- Manual trade writes can no longer bypass research `trade_permission`.
- `portfolio_state.json` remains the only canonical business-state input for execution logic.
- New code no longer treats `latest_snapshot` as the primary runtime state pointer.
- The transition keeps current sidecar rebuild behavior intact and backward-compatible.
