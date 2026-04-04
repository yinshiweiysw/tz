# External Market Fetch Timeouts Design

**Date:** 2026-04-02

**Goal:** Prevent `market_brief` and `market_pulse` from hanging indefinitely when quote/news/board fetches stall, while preserving degraded report generation.

## Scope

- Apply request-level timeout guards in report-layer code only.
- Cover these external fetches:
  - `getStockQuote`
  - `getHotBoards`
  - `getMarketTelegraph`
  - `getHotStocks`
- Keep existing report rendering logic and output shape largely intact.

## Chosen Approach

Use a shared helper under `portfolio/scripts/lib/` that wraps async market fetches with:

- deterministic timeout handling
- structured status objects
- lightweight Markdown status-line generation

This keeps the change local to report generation and avoids changing `market-mcp` provider contracts.

## Data Contract

Each guarded fetch returns:

```json
{
  "ok": true,
  "status": "ok",
  "source": "quotes",
  "data": {}
}
```

or degraded:

```json
{
  "ok": false,
  "status": "timeout",
  "source": "telegraphs",
  "message": "Fetch timed out after 6000ms"
}
```

Supported statuses:

- `ok`
- `timeout`
- `error`

## Rendering Policy

- If all external sources succeed: render nothing extra.
- If any source times out/errors: insert a short warning block near the top of the report.
- Existing sections continue rendering from whatever data is available.
- Missing quote/news data remains degradable and must not abort report generation.

## Timeout Budget

- quotes: `5000ms` per request
- boards / telegraphs / hot stocks: `6000ms`

These are intentionally conservative enough to avoid long hangs while allowing normal provider latency.

## Testing Strategy

- Add unit tests for the shared helper:
  - resolves successful fetches
  - converts stalled fetches into `timeout`
  - formats degraded status lines
- Re-run report-context tests and both report scripts with `--refresh`.
