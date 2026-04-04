# Dialogue Analysis Contract Design

**Date:** 2026-04-03
**Scope:** Add a shared dialogue analysis contract helper so conversational market analysis and trade discussion use the same upstream research brain, flow validation, and action bias as the generated reports.

---

## Goal

The system already has a unified report-side research contract, but dialogue analysis still risks drifting because it can pull from multiple files ad hoc.

This design adds one shared helper that assembles a structured “dialogue analysis contract” from the existing upstream state:

- `research_brain.json`
- `cn_market_snapshot`
- `opportunity_pool.json`
- `speculative_plan.json`
- `trade_plan_v4.json`

The helper must not create a new persisted JSON artifact. It exists to make future dialogue analysis read from the same upstream brain as morning/noon/close pulses and market briefs.

---

## Recommended Approach

### Approach A: Keep relying on report markdown

Read `market_brief` and `market_pulse` markdown files during dialogue and infer conclusions from prose.

**Pros**
- No new code

**Cons**
- Still couples dialogue to rendered prose instead of structured state
- Hard to keep stable as report copy evolves

### Approach B: Add one shared dialogue contract helper

Create `portfolio/scripts/lib/dialogue_analysis_contract.mjs` that derives a normalized contract from the same JSON/state inputs used by reports and trading logic.

**Pros**
- Dialogue and reports share one upstream state contract
- No extra persisted artifact
- Easy to test and extend

**Cons**
- Requires one new helper and tests

### Approach C: Create a new dialogue JSON file

Persist a separate `dialogue_analysis_context.json`.

**Pros**
- Explicit artifact

**Cons**
- Reintroduces refresh drift and another state file

### Recommendation

Choose **Approach B**.

---

## Data Contract

The new helper returns a single in-memory object with these blocks:

- `meta`
  - `generated_at`
  - `trade_permission`
  - `readiness_level`
- `market_core`
  - `active_driver`
  - `priced_in_assessment`
  - `liquidity_regime`
  - `flow_summary`
  - `northbound_net_buy_100m_cny`
  - `southbound_net_buy_100m_hkd`
- `portfolio_actions`
  - normalized from `research_brain.actionable_decision.portfolio_actions`
- `watchlist_actions`
  - normalized from `research_brain.actionable_decision.new_watchlist_actions`
- `opportunity_candidates`
  - top 1-3 candidates from `opportunity_pool`
- `speculative_overlay`
  - `data_state`
  - `instruction_count`
  - `conclusion_lines`
- `trade_plan_summary`
  - actionable/suppressed counts
  - gross buy/sell
  - first actionable trade summary
- `shared_research_sections`
  - the same sections produced by `buildUnifiedResearchSections`
- `dialogue_cues`
  - `opening_brief`
  - `allowed_actions`
  - `blocked_actions`
  - `analyst_focus`

---

## Reuse Rules

The helper must reuse existing shared render logic instead of rebuilding new text logic:

- `buildUnifiedResearchSections`
- `flattenResearchSections`
- `extractSpeculativeConclusionLines`

This keeps dialogue and reports aligned on:

- active event driver
- flow/macro framing
- northbound/southbound validation
- desk action conclusion

---

## Documentation Update

`OPERATING_PROTOCOL.md` should explicitly say:

When the user asks for “分析当前行情 / 是否可以买卖 / A股港股黄金怎么看”, first derive the dialogue analysis contract from the helper, then answer from that contract plus any fresh real-time quotes/news required for the current timestamp.

This keeps “conversation analysis” and “generated reports” on one brain.
