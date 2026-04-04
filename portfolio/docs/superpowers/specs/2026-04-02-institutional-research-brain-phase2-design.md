# Institutional Research Brain Phase 2 Design

**Date:** 2026-04-02
**Scope:** Expand the Phase 1 `research_brain.json` substrate into a unified institutional analysis brain that can identify active event drivers, summarize flow and macro anchors, and produce one session-aware actionable decision contract for reports and dialogue.

---

## 1. Goal

Phase 2 upgrades the research layer from a freshness and coverage gate into a real institutional analysis brain.

The goal is to fix three structural failures that still exist after Phase 1:

1. The system can be fresh but still miss the true market driver of the day.
2. Reports and dialogue still need a unified interpretation layer for flows, macro anchors, and action bias.
3. Actionable conclusions are still too scattered and can drift between reports, dialogue, and trade discussion.

This phase must keep `research_brain.json` as the single source of truth and expand it without creating a second decision substrate.

---

## 2. Recommended Approach

Three implementation approaches were considered:

### Approach A: Keep reports smart

Add event, flow, and action logic directly to `generate_market_brief.mjs` and `generate_market_pulse.mjs`.

**Pros**
- Fast visible output changes

**Cons**
- Recreates the fragmented logic Phase 1 was designed to eliminate
- Reports would silently diverge from dialogue logic again

### Approach B: Expand `research_brain` with modular interpretation layers

Add new focused modules for:
- `event_driver`
- `flow_macro_radar`
- `actionable_decision`

Then orchestrate them inside `generate_research_brain.mjs`, and make reports consume only the normalized result.

**Pros**
- Preserves SSOT
- Keeps interpretation logic testable and isolated
- Gives dialogue and reports one common upstream contract

**Cons**
- Requires a few new modules and regression tests
- Some report rendering needs to be refactored toward shared helpers

### Approach C: Create a second `decision_brain.json`

Keep `research_brain.json` as facts, then create a second file for decisions only.

**Pros**
- Clear separation between data and recommendation layers

**Cons**
- Adds another artifact to refresh, track, and keep coherent
- Reintroduces synchronization risk between research and decision layers

### Recommendation

**Approach B** is recommended.

`research_brain.json` remains the only upstream state contract. Facts stay in `research_snapshot`, interpretation layers live in focused helper modules, and every downstream consumer reads the same decision contract.

---

## 3. Scope

Phase 2 adds three new top-level blocks to `research_brain.json`:

- `event_driver`
- `flow_macro_radar`
- `actionable_decision`

Phase 2 also updates the main report scripts so they consume and render these blocks:

- `generate_market_brief.mjs`
- `generate_market_pulse.mjs`

Dialogue alignment in this phase means the system should be able to answer "what is the market trading" and "should I act" from the same normalized `research_brain` contract used by reports. It does **not** require a separate chat-serving daemon or a new state file.

Out of scope:

- Full sell-side research note generation
- A new portfolio optimizer
- Rewriting `opportunity_pool.json`
- Replacing Phase 1 freshness or coverage policy

---

## 4. Architecture

Phase 2 keeps the Phase 1 pipeline and inserts three interpretation layers after the existing snapshot normalization:

`research_snapshot + market_snapshot + freshness/coverage/readiness`
→ `event_driver`
→ `flow_macro_radar`
→ `actionable_decision`
→ `research_brain.json`

The ordering matters:

1. `research_snapshot` provides stable normalized facts.
2. `event_driver` explains what the market is trading right now.
3. `flow_macro_radar` explains where money and macro pressure are flowing.
4. `decision_readiness` continues to define whether conclusions may be strong, degraded, or blocked.
5. `actionable_decision` produces the final desk stance using all prior layers plus existing portfolio constraints.

Reports and future dialogue consumers must read the resulting decision contract instead of recomputing their own tactical view.

---

## 5. Data Contract

### 5.1 `event_driver`

Purpose: identify the dominant active market driver and separate real catalysts from already-priced noise.

Fields:

- `status`
  - `active_market_driver`
  - `priced_in_noise`
  - `watch_only`
  - `unavailable`
- `primary_driver`
- `secondary_drivers[]`
- `driver_scope`
  - `a_share`
  - `hong_kong`
  - `us_overnight`
  - `commodities`
  - `cross_asset`
- `surprise_level`
  - `high`
  - `medium`
  - `low`
- `priced_in_assessment`
  - `underpriced`
  - `partially_priced_in`
  - `fully_priced_in`
  - `unclear`
- `evidence[]`
  - source type, timestamp, headline, matched assets, note
- `market_impact`
  - per-market summary for A-share, Hong Kong, gold, oil, USD, rates

Principles:

- No driver may be labeled active unless it has both headline evidence and cross-asset or index confirmation.
- If evidence is thin, the module should downgrade to `watch_only` instead of fabricating conviction.

### 5.2 `flow_macro_radar`

Purpose: summarize liquidity, capital flow, macro anchors, and current risk appetite.

Sub-blocks:

- `cross_asset_anchors`
  - `us10y_yield`
  - `dxy`
  - `gold`
  - `oil`
  - `fed_cut_probability`
  - `cpi_status`
  - `ppi_status`
- `china_flows`
  - `northbound`
  - `sector_flow`
  - `a_share_breadth`
- `hong_kong_flows`
  - `southbound`
  - `hang_seng_leadership`
  - `hk_tech_relative_strength`
- `liquidity_regime`
  - `risk_on`
  - `neutral`
  - `risk_off`
  - `stress`
- `confidence`
- `summary`
- `alerts[]`

Principles:

- Anchor data may be incomplete, but missing critical fields must lower confidence and can restrict downstream action conclusions.
- The radar should summarize direction and regime, not just dump quotes.

### 5.3 `actionable_decision`

Purpose: produce one unified operational conclusion for reports and dialogue.

Sub-blocks:

- `portfolio_actions[]`
  - current holdings or existing buckets only
  - fields:
    - `target_type`
    - `target_key`
    - `stance`
    - `urgency`
    - `reason_chain`
    - `execution_note`
- `new_watchlist_actions[]`
  - at most 1-3 ideas
  - sourced from `opportunity_pool` first, then event/flow-confirmed dynamic ideas
  - each item must include:
    - `theme`
    - `stance`
    - `why_now`
    - `why_not_in_portfolio_yet`
    - `trigger_to_act`
- `desk_conclusion`
  - `overall_stance`
    - `defensive`
    - `selective_offense`
    - `offense`
    - `freeze`
  - `trade_permission`
    - `allowed`
    - `restricted`
    - `blocked`
  - `one_sentence_order`
  - `must_not_do[]`
  - `decision_basis[]`

Principles:

- `actionable_decision` must never outrun `decision_readiness`.
- `analysis_degraded` may permit market commentary but should restrict action language.
- `trading_blocked` or `research_invalid` must explicitly block strong trading conclusions.

---

## 6. Source Hierarchy

Phase 2 should continue to use existing local and guarded data sources before introducing new pipelines.

Priority order:

1. Existing normalized artifacts already loaded by Phase 1:
   - `macro_state`
   - `macro_radar`
   - `risk_dashboard`
   - `regime_router_signals`
   - `opportunity_pool`
   - `portfolio_state`
2. Live cross-asset market snapshot already fetched for Phase 1
3. Guarded telegraph/headline fetches already used by market reports
4. Existing China market snapshot sections, especially:
   - northbound flow
   - sector fund flow
   - market breadth / phase

Phase 2 may extend report-time guarded fetches to include additional anchors, but the resulting normalized interpretation must be written back through `research_brain`, not left only inside report scripts.

---

## 7. Event Driver Logic

The event layer should answer: "What is the market actually repricing today?"

Recommended logic:

1. Build a candidate event set from telegraphs/headlines using keyword + authority scoring.
2. Group semantically similar items into a single driver bucket.
3. Confirm whether the proposed driver matches observed market behavior:
   - relevant indices
   - gold/oil/USD/rates direction
   - Hong Kong or A-share relative response
4. Score whether the catalyst appears:
   - fresh and surprising
   - partially priced
   - mostly noise / already digested
5. Output one `primary_driver` and up to three `secondary_drivers`.

The system should favor honesty over coverage. If no driver clears the evidence threshold, it must report `watch_only`.

---

## 8. Flow & Macro Radar Logic

The flow and macro layer should answer: "How supportive or hostile is the current liquidity backdrop?"

Recommended interpretation:

- `northbound` and `southbound` flows should be treated as confirmation, not standalone strategy.
- `US10Y`, `DXY`, gold, and oil should be read jointly, because the same move can mean inflation fear, growth fear, or geopolitical premium depending on the combination.
- Fed cut probability and inflation prints should influence how strong the liquidity conclusion may be, but absence of these fields should degrade confidence instead of failing the whole report.

Example regimes:

- Falling yields + softer USD + resilient equities
  - usually `risk_on` or `selective_offense`
- Oil spike + gold spike + stronger USD + weaker equities
  - usually `risk_off` or `stress`
- Strong southbound + stronger HK tech relative strength
  - supports Hong Kong tactical risk appetite
- Weak breadth + weak northbound + shrinking volume
  - weak A-share chase conditions

---

## 9. Actionable Decision Logic

The action layer should answer: "What should the desk do now?"

Decision order:

1. Check `decision_readiness`
2. Read `event_driver`
3. Read `flow_macro_radar`
4. Read existing portfolio constraints and risk state
5. Generate:
   - bucket/holding actions
   - 1-3 new watchlist actions
   - one desk conclusion

Behavior rules:

- Existing holdings and buckets remain first priority.
- New opportunities may only be proposed if they are:
  - already in `opportunity_pool`, or
  - dynamically confirmed by both event and flow evidence
- New ideas must default to watchlist or small trial bias unless portfolio and regime support are unusually strong.
- The system should continue to be disciplined on risk, but no longer ignore left-side or tactical opportunity discussion when the evidence is real.

---

## 10. Report Integration

### 10.1 `generate_market_brief.mjs`

This becomes the main desk note for:

- market driver of the day
- macro and liquidity regime
- unified action conclusion

New or revised sections should include:

- `Institutional Research Readiness`
- `Active Market Driver`
- `Flow & Macro Radar`
- `Desk Action Conclusion`

The report should render these blocks from `research_brain.json` rather than recomputing them ad hoc.

### 10.2 `generate_market_pulse.mjs`

This becomes the intraday or close monitoring layer for:

- whether the primary driver changed
- whether flows confirm or reject the morning thesis
- whether the desk conclusion stays valid

New or revised sections should include:

- `Driver Check`
- `Liquidity Change`
- `Action Drift`

---

## 11. Dialogue Alignment

The user frequently asks:

- "现在行情怎么样"
- "今天该不该买"
- "黄金还能不能加"
- "港股为什么跌"

Phase 2 should make these questions answerable from the same decision contract used by reports.

That means:

- no separate decision file
- no second tactical engine
- answers should be explainable from:
  - `event_driver`
  - `flow_macro_radar`
  - `actionable_decision`
  - `decision_readiness`

The chat layer may still add nuanced explanation, but it should not invent a second stance.

---

## 12. Degradation Policy

The system must remain institutionally honest.

### `ready`

- Full analysis allowed
- Full action language allowed

### `analysis_degraded`

- Market commentary allowed
- Action language restricted to conditional or lower-confidence guidance

### `trading_blocked`

- Commentary allowed
- Explicitly block trade instructions

### `research_invalid`

- Do not emit normal tactical conclusions
- Reports may render a failure state, but not a fake research view

Additional rules:

- Missing `event_driver` evidence should degrade the driver status, not fabricate conviction.
- Missing key flow or macro anchors should lower `flow_macro_radar.confidence` and may force `trade_permission = restricted`.
- New watchlist actions without full evidence must remain watch-only.

---

## 13. Testing Strategy

Phase 2 should remain deterministic and test-first.

Minimum required test families:

- `research_event_driver.test.mjs`
- `research_flow_macro_radar.test.mjs`
- `research_actionable_decision.test.mjs`
- `generate_research_brain.test.mjs` expansion
- `report_context.test.mjs` expansion
- report rendering regression tests for market brief and market pulse

Key cases:

- fresh but driverless market day
- active geopolitical shock with cross-asset confirmation
- strong Hong Kong southbound confirmation
- degraded macro anchors
- blocked trading due to stale research despite rich event headlines

---

## 14. Success Criteria

Phase 2 is successful when:

1. `research_brain.json` contains stable, tested `event_driver`, `flow_macro_radar`, and `actionable_decision` blocks.
2. Reports render those blocks directly instead of recomputing separate tactical views.
3. The system can explicitly distinguish:
   - real driver
   - priced-in noise
   - weak evidence / watch-only
4. The system can mention 1-3 non-holding opportunities without abandoning portfolio-first discipline.
5. If upstream freshness or coverage degrades, tactical language visibly degrades with it.

---

## 15. Risks

### Risk: The event layer becomes a headline popularity contest

Mitigation:

- require market confirmation
- require evidence arrays
- allow `watch_only`

### Risk: The flow layer becomes a raw data dump

Mitigation:

- normalize into regime summaries and alerts
- keep direction, confidence, and interpretation distinct

### Risk: The action layer becomes too aggressive

Mitigation:

- bind all action output to `decision_readiness`
- keep portfolio-first ordering
- cap new external ideas to 1-3 watchlist entries

### Risk: Reports silently drift again

Mitigation:

- centralize render helpers around the new contract
- regression test market brief and market pulse against shared contract fields
