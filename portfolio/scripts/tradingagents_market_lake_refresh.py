#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.append(str(SCRIPT_DIR))

from core_data_ingestion import (  # noqa: E402
    DB_PATH,
    DailyPriceRecord,
    build_yfinance_records,
    ensure_schema,
    fetch_table_counts,
    rebind_runtime_paths,
    resolve_portfolio_root,
    update_manifest,
    upsert_records,
)

import akshare as ak  # noqa: E402
import pandas as pd  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh TradingAgents proxy symbols into local market_lake.db before decision cycle."
    )
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--trade-date", required=True)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--period", default="10y")
    parser.add_argument("--max-stale-days", type=int, default=4)
    return parser.parse_args()


def parse_symbols(raw: str) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for item in str(raw or "").split(","):
        symbol = item.strip().upper()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        deduped.append(symbol)
    return deduped


def inspect_symbol_freshness(db_path: Path, symbols: list[str], trade_date: str, max_stale_days: int) -> list[dict[str, Any]]:
    if not symbols:
        return []

    placeholders = ",".join("?" for _ in symbols)
    rows_by_symbol: dict[str, tuple[str | None, int]] = {}
    with sqlite3.connect(db_path) as connection:
        cursor = connection.execute(
            f"""
            SELECT symbol, MAX(date) AS latest_date, COUNT(*) AS row_count
            FROM daily_prices
            WHERE symbol IN ({placeholders})
            GROUP BY symbol
            """,
            symbols,
        )
        for symbol, latest_date, row_count in cursor.fetchall():
            rows_by_symbol[str(symbol).upper()] = (latest_date, int(row_count or 0))

    threshold_date = (
        datetime.strptime(trade_date, "%Y-%m-%d").date() - timedelta(days=max(0, int(max_stale_days)))
    ).isoformat()

    results: list[dict[str, Any]] = []
    for symbol in symbols:
        latest_date, row_count = rows_by_symbol.get(symbol, (None, 0))
        if row_count <= 0 or not latest_date:
            status = "missing"
            gap_days = None
        else:
            latest = datetime.strptime(str(latest_date), "%Y-%m-%d").date()
            target = datetime.strptime(trade_date, "%Y-%m-%d").date()
            gap_days = (target - latest).days
            status = "fresh" if str(latest_date) >= threshold_date else "stale"

        results.append(
            {
                "symbol": symbol,
                "status": status,
                "latestDate": latest_date,
                "rowCount": row_count,
                "gapDays": gap_days,
                "thresholdDate": threshold_date,
            }
        )
    return results


def build_symbol_spec(symbol: str) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "name": symbol,
        "provider": "yfinance",
        "asset_type": "global_market",
        "close_source": "yfinance_close_series",
        "source_tags": "tradingagents,decision_cycle",
    }


def supports_akshare_us_daily(symbol: str) -> bool:
    normalized = str(symbol or "").strip().upper()
    if not normalized or normalized.startswith("^") or "=" in normalized:
        return False
    return all(char.isalnum() or char in {".", "-"} for char in normalized)


def build_akshare_us_daily_records(spec: dict[str, Any], period: str) -> list[DailyPriceRecord]:
    symbol = str(spec.get("symbol") or "").strip().upper()
    if not supports_akshare_us_daily(symbol):
        raise ValueError(f"akshare stock_us_daily does not support symbol={symbol}")

    raw_df = ak.stock_us_daily(symbol=symbol, adjust="")
    if raw_df is None or raw_df.empty:
        raise ValueError(f"AkShare stock_us_daily returned empty dataframe for symbol={symbol}")

    working = raw_df.copy().rename(
        columns={
            "Date": "date",
            "日期": "date",
            "Open": "open",
            "开盘": "open",
            "High": "high",
            "最高": "high",
            "Low": "low",
            "最低": "low",
            "Close": "close",
            "收盘": "close",
            "Volume": "volume",
            "成交量": "volume",
        }
    )
    required_columns = ["date", "open", "high", "low", "close", "volume"]
    missing_columns = [column for column in required_columns if column not in working.columns]
    if missing_columns:
        raise ValueError(f"missing AkShare US daily columns: {', '.join(missing_columns)}")

    working["date"] = pd.to_datetime(working["date"], errors="coerce")
    for column in ["open", "high", "low", "close", "volume"]:
        working[column] = pd.to_numeric(working[column], errors="coerce")
    working = (
        working.dropna(subset=["date", "open", "high", "low", "close"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
    )
    if working.empty:
        raise ValueError(f"AkShare US daily history is empty after cleaning for symbol={symbol}")

    records: list[DailyPriceRecord] = []
    for _, row in working.iterrows():
        volume_value = row.get("volume")
        if volume_value is not None and (pd.isna(volume_value) or not math.isfinite(float(volume_value))):
            volume_value = None
        close_value = float(row["close"])
        records.append(
            DailyPriceRecord(
                symbol=symbol,
                date=row["date"],
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=close_value,
                adj_close=close_value,
                volume=float(volume_value) if volume_value is not None else None,
                provider="akshare",
                asset_type=spec.get("asset_type") or "global_market",
                name=spec.get("name"),
                close_source="akshare_stock_us_daily",
                source_tags=spec.get("source_tags"),
            )
        )

    return records


def build_proxy_records(spec: dict[str, Any], period: str) -> list[DailyPriceRecord]:
    symbol = str(spec.get("symbol") or "").strip().upper()
    try:
        return build_akshare_us_daily_records(spec, period)
    except Exception as akshare_error:
        print(
            f"[warn] akshare stock_us_daily failed for {symbol}; "
            f"switching to yfinance: {akshare_error}"
        )
    return build_yfinance_records(spec, period=period)


def refresh_symbols(db_path: Path, symbols: list[str], period: str) -> dict[str, Any]:
    successes: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    with sqlite3.connect(db_path) as connection:
        ensure_schema(connection)

        for symbol in symbols:
            stdout_buffer = io.StringIO()
            stderr_buffer = io.StringIO()
            try:
                with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
                    records = build_proxy_records(build_symbol_spec(symbol), period)
                with connection:
                    rows_written = upsert_records(connection, records)
                latest_record = records[-1] if records else None
                successes.append(
                    {
                        "symbol": symbol,
                        "rowsWritten": rows_written,
                        "recordCount": len(records),
                        "latestDate": latest_record.date.isoformat() if latest_record else None,
                        "closeSource": latest_record.close_source if latest_record else None,
                        "logs": "\n".join(
                            line
                            for line in (
                                stdout_buffer.getvalue().strip(),
                                stderr_buffer.getvalue().strip(),
                            )
                            if line
                        )
                        or None,
                    }
                )
            except Exception as exc:  # pragma: no cover - network/provider dependent
                errors.append(
                    {
                        "symbol": symbol,
                        "error": str(exc),
                        "logs": "\n".join(
                            line
                            for line in (
                                stdout_buffer.getvalue().strip(),
                                stderr_buffer.getvalue().strip(),
                            )
                            if line
                        )
                        or None,
                    }
                )

        table_counts = fetch_table_counts(connection)

    update_manifest(db_path)
    return {
        "requestedSymbols": len(symbols),
        "successCount": len(successes),
        "errorCount": len(errors),
        "successes": successes,
        "errors": errors,
        "tableRowCounts": table_counts,
    }


def summarize_status(freshness: list[dict[str, Any]]) -> dict[str, list[str]]:
    summary = {
        "fresh": [],
        "stale": [],
        "missing": [],
    }
    for item in freshness:
        status = str(item.get("status") or "").strip()
        if status in summary:
            summary[status].append(str(item.get("symbol") or "").strip())
    return summary


def main() -> int:
    args = parse_args()
    symbols = parse_symbols(args.symbols)
    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    rebind_runtime_paths(portfolio_root)
    db_path = Path(args.db).expanduser() if args.db else DB_PATH
    db_path.parent.mkdir(parents=True, exist_ok=True)

    before = inspect_symbol_freshness(db_path, symbols, args.trade_date, args.max_stale_days)
    before_summary = summarize_status(before)
    stale_or_missing = before_summary["stale"] + before_summary["missing"]

    result: dict[str, Any] = {
        "tradeDate": args.trade_date,
        "dbPath": str(db_path),
        "symbols": symbols,
        "maxStaleDays": int(args.max_stale_days),
        "freshnessBefore": before,
        "triggered": False,
    }

    if not symbols:
        result["status"] = "skipped_no_symbols"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if not stale_or_missing:
        result["status"] = "skipped_fresh"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    result["triggered"] = True
    refresh_result = refresh_symbols(db_path, stale_or_missing, args.period)
    after = inspect_symbol_freshness(db_path, symbols, args.trade_date, args.max_stale_days)
    after_summary = summarize_status(after)
    still_stale = after_summary["stale"] + after_summary["missing"]

    result["refresh"] = refresh_result
    result["freshnessAfter"] = after
    if refresh_result["errorCount"] == 0 and not still_stale:
        result["status"] = "refreshed"
    elif refresh_result["successCount"] > 0:
        result["status"] = "degraded"
    else:
        result["status"] = "failed"

    result["requestedRefreshSymbols"] = stale_or_missing
    result["remainingStaleSymbols"] = still_stale
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
