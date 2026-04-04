# Funds Dashboard Valuation Status Design

**Date:** 2026-04-02

## Goal

Stabilize the `8766` funds dashboard so that after-hours fund rows, summary metrics, and status labels clearly distinguish between:

- live intraday estimate
- same-day close-like / published daily NAV
- prior-day confirmed NAV

The dashboard must stop treating every same-day quote as a live estimate.

## Confirmed Problems

1. `quoteDate == today` is currently treated as "fresh", even when the upstream payload is a close-like `"YYYY-MM-DD 净值"` record.
2. Current-day rows and live-estimate rows are not separated cleanly, which causes after-hours numbers to look like continuously updating intraday estimates.
3. Status copy ("估算净值", "实时估值") is therefore wrong for a subset of same-day rows.
4. Drift diagnostics can produce nonsensical `-100%` values when valuation-like fields are unusable.

## Design

### 1. Introduce quote mode semantics

Replace the effective binary interpretation with a small status model:

- `live_estimate`: same-day quote with a real valuation timestamp such as `YYYY-MM-DD HH:MM`
- `today_close`: same-day quote that is already expressed as `YYYY-MM-DD 净值`
- `confirmed_nav`: prior-day or stale confirmed NAV
- `unavailable`: no usable quote

The implementation can stay lightweight. It does not need a new large data model, but it must derive a reliable mode from `quoteDate`, `today`, and `updateTime`.

### 2. Split current-day data from live-estimate labeling

`today_close` rows are still valid current-day data and should continue to contribute to:

- displayed current amount
- displayed today pnl
- summary-level current-day pnl

What must change is the label and status, not the presence of the update itself.

Only `live_estimate` rows should be described as "实时估值". `today_close` rows should be treated as published same-day NAV.

### 3. Correct the labels

Rendering must map to mode explicitly:

- `live_estimate` -> label `估算净值`, status `实时估值`
- `today_close` -> label `当日净值`, status `今日净值`
- `confirmed_nav` -> label `确认净值`, status `<date>净值`
- `unavailable` -> `暂无估值`

This keeps the user's mental model aligned with the actual data source.

### 4. Harden drift diagnostics

Drift diagnostics should only compute when valuation and net value are both positive finite numbers and the record is truly estimate-like. Otherwise return `null`.

## Testing Strategy

Add or extend unit tests around:

- mode classification for live vs close-like same-day rows
- overlay semantics for same-day close-like rows
- card label/status rendering for each mode
- drift calculation guardrails against zero / unusable valuations

## Files

- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
