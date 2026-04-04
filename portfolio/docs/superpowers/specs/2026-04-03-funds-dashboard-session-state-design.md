# Funds Dashboard Session State Design

**Date:** 2026-04-03

## Goal

Make the `8766` funds dashboard follow a strict separation between display-time estimates and ledger-time confirmed NAV:

- intraday estimates may update the screen
- market-close reference values may stay on screen after close
- only confirmed NAV may update `latest` / raw snapshot accounting

The dashboard must stop using one global `15:00` rule for all OTC funds.

## Problems To Fix

1. The current quote-mode logic uses a single late-close threshold and does not model A-share, gold, and Hong Kong close times separately.
2. The screen can show same-day data, but the semantics are not explicit enough for “intraday estimate” versus “close reference”.
3. Ledger writeback already has an environment gate, but the writeback path itself still accepts a live payload shape instead of enforcing confirmed-only settlement semantics.
4. The user’s intended timeline is stricter than the current implementation:
   - `09:30` start intraday estimate
   - per-product market close freezes same-day reference
   - evening confirmed NAV replaces the reference
   - only confirmed NAV advances the accounting snapshot

## Design

### 1. Add product-aware market session policy

Introduce a focused helper that resolves the display session for each OTC fund using existing asset metadata and row identity. The first version should support:

- domestic equity / bond funds: close at `15:00`
- gold-related OTC funds: close at `15:00` or `15:30` based on product mapping
- Hong Kong related funds: close at `16:10`
- global QDII / US-related funds: do not pretend to have same-day domestic close estimates unless the source clearly provides them

The helper should return a stable policy object rather than scattered booleans.

### 2. Replace the binary quote interpretation with a 4-state session model

For row rendering and summary aggregation, use these explicit states:

- `live_estimate`: market open and quote is still live for this product
- `close_reference`: the same-day market session has closed; keep showing the frozen same-day reference until confirmed NAV arrives
- `confirmed_nav`: use confirmed NAV / prior-day official NAV
- `unavailable`: no usable quote

This is a display model. It is not the accounting model.

### 3. Keep two separate amount layers

Each row should continue to carry:

- ledger/base amount and holding profit from the materialized snapshot
- display/live amount and holding profit after optional overlay

Overlay rules:

- `live_estimate` may overlay the row amount and holding profit
- `close_reference` may also overlay the row amount and holding profit for the screen, but must be clearly labeled as reference
- `confirmed_nav` must not be treated as intraday overlay; it is the official value

### 4. Restrict persistence to confirmed NAV only

The materialization/writeback path must refuse to persist a payload unless the payload snapshot is confirmed for the relevant date.

Operational rule:

- display payload can use `live_estimate` or `close_reference`
- persistence may only happen when the payload is in confirmed mode for the target snapshot

If confirmed NAV is not ready, the dashboard may still render reference values, but it must not advance `snapshot_date`, `holding_profit`, `yesterday_profit`, or fund `amount` in the raw/accounting snapshot.

### 5. Update UI wording to match the state machine

Render explicit labels:

- `live_estimate` -> `盘中估值`
- `close_reference` -> `收盘参考`
- `confirmed_nav` -> `确认净值`

This avoids mixing a screen-time estimate with an accounting-time confirmation.

## Testing Strategy

Add focused tests for:

1. session classification by fund type and wall-clock time
2. `15:00` domestic close versus `15:30` gold versus `16:10` Hong Kong close
3. row overlay behavior for `live_estimate` and `close_reference`
4. summary `estimatedDailyPnl` semantics after close
5. writeback rejection when confirmed NAV is not ready
6. writeback acceptance when confirmed NAV is ready

## Files

- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_market_session_policy.mjs`
- Create: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/fund_market_session_policy.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/live_dashboard_today_pnl.test.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs`
