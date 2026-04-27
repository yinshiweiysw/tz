#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from typing import Optional

import pandas as pd
import yfinance as yf

_PATCH_INSTALLED = False
_FRAME_CACHE = {}
_METHOD_RESULT_CACHE = {}
_CACHE_TTL_SECONDS = {
    "get_news": 6 * 3600,
    "get_global_news": 3 * 3600,
    "get_fundamentals": 24 * 3600,
    "get_balance_sheet": 24 * 3600,
    "get_cashflow": 24 * 3600,
    "get_income_statement": 24 * 3600,
    "get_insider_transactions": 12 * 3600,
}


def _env_positive_int(name: str, fallback: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip())
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _market_data_tool_max_rows() -> int:
    return _env_positive_int("TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS", 120)


def _indicator_tool_max_lookback_days() -> int:
    return _env_positive_int("TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS", 30)


def _candidate_market_lake_paths() -> list[Path]:
    explicit = str(os.environ.get("TRADINGAGENTS_MARKET_LAKE_DB", "")).strip()
    script_root = Path(__file__).resolve().parent
    workspace_root = script_root.parent.parent

    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())

    candidates.append(workspace_root / "portfolio" / "data" / "market_lake.db")
    return candidates


def resolve_market_lake_db_path() -> Optional[Path]:
    for candidate in _candidate_market_lake_paths():
        if candidate.exists():
            return candidate.resolve()
    return None


def _warn_market_lake_diagnostic(code: str, db_path: Path, detail: str = "") -> None:
    suffix = f": {detail}" if detail else ""
    print(f"[tradingagents] {code} db={db_path}{suffix}", file=sys.stderr)


def _candidate_vendor_cache_roots() -> list[Path]:
    explicit = str(os.environ.get("TRADINGAGENTS_VENDOR_CACHE_DIR", "")).strip()
    portfolio_root = str(os.environ.get("PORTFOLIO_ROOT", "")).strip()
    script_root = Path(__file__).resolve().parent
    workspace_root = script_root.parent.parent
    codex_root = workspace_root.parent

    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if portfolio_root:
        candidates.append(Path(portfolio_root).expanduser() / "data" / "tradingagents_vendor_cache")
    candidates.extend(
        [
            workspace_root / "portfolio" / "data" / "tradingagents_vendor_cache",
            codex_root / "tz-main-simplified" / "portfolio" / "data" / "tradingagents_vendor_cache",
            Path.home() / ".tradingagents" / "cache" / "vendor",
        ]
    )
    return candidates


def resolve_vendor_cache_root() -> Path:
    for candidate in _candidate_vendor_cache_roots():
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate.resolve()
        except Exception:
            continue
    fallback = Path.home() / ".tradingagents" / "cache" / "vendor"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback.resolve()


def _normalize_cache_value(value):
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_normalize_cache_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _normalize_cache_value(item) for key, item in sorted(value.items())}
    return value


def _build_method_cache_key(method_name: str, args: tuple, kwargs: dict) -> str:
    payload = {
        "method": method_name,
        "args": _normalize_cache_value(args),
        "kwargs": _normalize_cache_value(kwargs),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha1(raw.encode("utf-8")).hexdigest()


def _method_cache_path(method_name: str, args: tuple, kwargs: dict) -> Path:
    return resolve_vendor_cache_root() / method_name / f"{_build_method_cache_key(method_name, args, kwargs)}.json"


def _looks_like_error_result(result) -> bool:
    if result is None:
        return True
    text = str(result).strip()
    if not text:
        return True
    return text.lower().startswith("error ")


def _read_cached_method_result(method_name: str, args: tuple, kwargs: dict, ttl_seconds: int, allow_stale: bool = False):
    cache_path = _method_cache_path(method_name, args, kwargs)
    if not cache_path.exists():
        return None

    memory_key = (str(cache_path), ttl_seconds, allow_stale)
    cached = _METHOD_RESULT_CACHE.get(memory_key)
    if cached is not None:
        return cached

    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    created_at = payload.get("createdAt")
    created_dt = None
    if created_at:
        try:
            created_dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        except ValueError:
            created_dt = None

    age_seconds = None
    if created_dt is not None:
        if created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=timezone.utc)
        age_seconds = max(0.0, (datetime.now(timezone.utc) - created_dt.astimezone(timezone.utc)).total_seconds())

    if not allow_stale and age_seconds is not None and age_seconds > ttl_seconds:
        return None

    result = payload.get("result")
    next_value = {
        "result": result,
        "createdAt": created_at,
        "ageSeconds": age_seconds,
        "path": cache_path,
    }
    _METHOD_RESULT_CACHE[memory_key] = next_value
    return next_value


def _write_cached_method_result(method_name: str, args: tuple, kwargs: dict, result) -> None:
    cache_path = _method_cache_path(method_name, args, kwargs)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "method": method_name,
        "args": _normalize_cache_value(args),
        "kwargs": _normalize_cache_value(kwargs),
        "result": result,
    }
    cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _METHOD_RESULT_CACHE.clear()


def _wrap_cached_vendor_method(method_name: str, func):
    ttl_seconds = int(_CACHE_TTL_SECONDS.get(method_name, 6 * 3600))

    def wrapped(*args, **kwargs):
        fresh_cached = _read_cached_method_result(method_name, args, kwargs, ttl_seconds, allow_stale=False)
        if fresh_cached is not None:
            return fresh_cached["result"]

        stale_cached = _read_cached_method_result(method_name, args, kwargs, ttl_seconds, allow_stale=True)

        try:
            result = func(*args, **kwargs)
        except Exception:
            if stale_cached is not None:
                return stale_cached["result"]
            raise

        if not _looks_like_error_result(result):
            _write_cached_method_result(method_name, args, kwargs, result)
            return result

        if stale_cached is not None:
            return stale_cached["result"]
        return result

    return wrapped


def _normalize_price_frame(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return frame

    working = frame.copy()
    working["Date"] = pd.to_datetime(working["Date"], errors="coerce")
    price_columns = ["Open", "High", "Low", "Close", "Adj Close", "Volume"]
    for column in price_columns:
        if column not in working.columns:
            working[column] = None
        working[column] = pd.to_numeric(working[column], errors="coerce")

    working = working.dropna(subset=["Date", "Close"]).drop_duplicates(subset=["Date"], keep="last")
    if working.empty:
        return working

    working["Adj Close"] = working["Adj Close"].where(working["Adj Close"].notna(), working["Close"])
    for column in ["Open", "High", "Low"]:
        working[column] = working[column].where(working[column].notna(), working["Close"])
    working["Volume"] = working["Volume"].fillna(0)

    return working.sort_values("Date").reset_index(drop=True)


def _read_market_lake_frame(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    db_path = resolve_market_lake_db_path()
    if db_path is None:
        return pd.DataFrame()

    cache_key = (str(db_path), symbol.upper(), start_date, end_date)
    cached = _FRAME_CACHE.get(cache_key)
    if cached is not None:
        return cached.copy()

    query = """
        SELECT
            date AS "Date",
            open AS "Open",
            high AS "High",
            low AS "Low",
            close AS "Close",
            adj_close AS "Adj Close",
            volume AS "Volume"
        FROM daily_prices
        WHERE UPPER(symbol) = UPPER(?)
          AND date >= ?
          AND date <= ?
          AND close IS NOT NULL
        ORDER BY date ASC
    """

    try:
        with sqlite3.connect(db_path) as connection:
            table_row = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_prices'"
            ).fetchone()
            if table_row is None:
                _warn_market_lake_diagnostic("market_lake_schema_missing", db_path, "missing table daily_prices")
                return pd.DataFrame()
            frame = pd.read_sql_query(query, connection, params=[symbol, start_date, end_date])
    except sqlite3.DatabaseError as exc:
        _warn_market_lake_diagnostic("market_lake_read_failed", db_path, str(exc).strip()[:240])
        return pd.DataFrame()

    normalized = _normalize_price_frame(frame)
    _FRAME_CACHE[cache_key] = normalized.copy()
    return normalized


def _read_market_lake_window(symbol: str, curr_date: str, lookback_years: int = 5) -> pd.DataFrame:
    current_dt = pd.Timestamp(curr_date)
    start_date = (current_dt - pd.DateOffset(years=lookback_years)).strftime("%Y-%m-%d")
    return _read_market_lake_frame(symbol, start_date, current_dt.strftime("%Y-%m-%d"))


def _normalize_yfinance_frame(frame: pd.DataFrame) -> pd.DataFrame:
    if frame is None or frame.empty:
        return pd.DataFrame()

    working = frame.reset_index()
    if "Date" not in working.columns and "Datetime" in working.columns:
        working = working.rename(columns={"Datetime": "Date"})
    if "Adj Close" not in working.columns:
        working["Adj Close"] = working.get("Close")
    return _normalize_price_frame(working)


def _merge_price_frames(base_frame: pd.DataFrame, tail_frame: pd.DataFrame) -> pd.DataFrame:
    if base_frame.empty:
        return tail_frame.copy()
    if tail_frame.empty:
        return base_frame.copy()
    merged = pd.concat([base_frame, tail_frame], ignore_index=True)
    return _normalize_price_frame(merged)


def _is_recent_enough(frame: pd.DataFrame, target_date: str, max_gap_days: int = 5) -> bool:
    if frame.empty:
        return False

    latest_date = pd.to_datetime(frame["Date"], errors="coerce").max()
    if pd.isna(latest_date):
        return False

    target_dt = pd.Timestamp(target_date)
    return latest_date >= target_dt - pd.Timedelta(days=max_gap_days)


def _fetch_yfinance_tail(symbol: str, start_date: str, end_date: str, yf_retry_func) -> pd.DataFrame:
    end_dt = pd.Timestamp(end_date) + pd.Timedelta(days=1)
    frame = yf_retry_func(
        lambda: yf.download(
            symbol,
            start=start_date,
            end=end_dt.strftime("%Y-%m-%d"),
            multi_level_index=False,
            progress=False,
            auto_adjust=False,
        )
    )
    return _normalize_yfinance_frame(frame)


def _format_pct_change(frame: pd.DataFrame, periods: int) -> str:
    if len(frame) <= periods:
        return "N/A"
    latest = pd.to_numeric(frame.iloc[-1]["Close"], errors="coerce")
    previous = pd.to_numeric(frame.iloc[-1 - periods]["Close"], errors="coerce")
    if pd.isna(latest) or pd.isna(previous) or previous == 0:
        return "N/A"
    return f"{((latest / previous) - 1) * 100:.2f}%"


def _compact_price_frame_for_tool(frame: pd.DataFrame, max_rows: int) -> pd.DataFrame:
    if frame.empty:
        return frame

    working = frame.tail(max_rows).copy()
    working["Date"] = pd.to_datetime(working["Date"], errors="coerce").dt.strftime("%Y-%m-%d")
    for column in ["Open", "High", "Low", "Close", "Adj Close"]:
        working[column] = pd.to_numeric(working[column], errors="coerce").round(4)
    working["Volume"] = pd.to_numeric(working["Volume"], errors="coerce").fillna(0).round(0).astype("int64")
    return working


def _render_stock_csv(symbol: str, start_date: str, end_date: str, frame: pd.DataFrame) -> str:
    max_rows = _market_data_tool_max_rows()
    output_frame = _compact_price_frame_for_tool(frame, max_rows)
    csv_string = output_frame.to_csv(index=False)
    latest = frame.iloc[-1] if not frame.empty else {}
    latest_date = pd.to_datetime(latest.get("Date"), errors="coerce") if not frame.empty else pd.NaT
    latest_date_text = latest_date.strftime("%Y-%m-%d") if not pd.isna(latest_date) else "N/A"
    latest_close = pd.to_numeric(latest.get("Close"), errors="coerce") if not frame.empty else None
    latest_close_text = "N/A" if pd.isna(latest_close) else f"{float(latest_close):.4f}"
    header = f"# Stock data for {symbol.upper()} from {start_date} to {end_date}\n"
    header += f"# Total records available: {len(frame)}\n"
    header += f"# Records returned: {len(output_frame)} latest rows (compact LLM context cap={max_rows})\n"
    header += f"# Latest close: {latest_close_text} on {latest_date_text}\n"
    header += f"# Close change: 1d={_format_pct_change(frame, 1)}, 5d={_format_pct_change(frame, 5)}, 20d={_format_pct_change(frame, 20)}\n"
    header += f"# Source: local market_lake.db\n\n"
    return header + csv_string


def _normalize_indicator_lookback_days(look_back_days) -> int:
    try:
        numeric = int(look_back_days)
    except (TypeError, ValueError):
        numeric = 30
    return max(1, min(numeric, _indicator_tool_max_lookback_days()))


def install_market_lake_fallback() -> bool:
    global _PATCH_INSTALLED
    if _PATCH_INSTALLED:
        return True

    try:
        import tradingagents.dataflows.interface as interface
        import tradingagents.dataflows.stockstats_utils as stockstats_utils
        import tradingagents.dataflows.y_finance as y_finance
    except Exception:
        return False

    original_get_stock_data = interface.VENDOR_METHODS["get_stock_data"]["yfinance"]
    original_get_indicators = interface.VENDOR_METHODS["get_indicators"]["yfinance"]
    original_load_ohlcv = stockstats_utils.load_ohlcv

    def patched_get_stock_data(symbol: str, start_date: str, end_date: str):
        local_frame = _read_market_lake_frame(symbol, start_date, end_date)
        if local_frame.empty:
            return original_get_stock_data(symbol, start_date, end_date)

        if _is_recent_enough(local_frame, end_date):
            return _render_stock_csv(symbol, start_date, end_date, local_frame)

        latest_date = pd.to_datetime(local_frame["Date"], errors="coerce").max()
        tail_start = max(pd.Timestamp(start_date), latest_date - pd.Timedelta(days=7))

        try:
            tail_frame = _fetch_yfinance_tail(
                symbol,
                tail_start.strftime("%Y-%m-%d"),
                end_date,
                stockstats_utils.yf_retry,
            )
            merged = _merge_price_frames(local_frame, tail_frame)
            if _is_recent_enough(merged, end_date):
                return _render_stock_csv(symbol, start_date, end_date, merged)
        except Exception:
            pass

        return original_get_stock_data(symbol, start_date, end_date)

    def patched_load_ohlcv(symbol: str, curr_date: str) -> pd.DataFrame:
        local_frame = _read_market_lake_window(symbol, curr_date)
        if local_frame.empty:
            return original_load_ohlcv(symbol, curr_date)

        if _is_recent_enough(local_frame, curr_date):
            return stockstats_utils._clean_dataframe(local_frame)

        latest_date = pd.to_datetime(local_frame["Date"], errors="coerce").max()
        tail_start = max(pd.Timestamp(curr_date) - pd.DateOffset(months=2), latest_date - pd.Timedelta(days=7))

        try:
            tail_frame = _fetch_yfinance_tail(
                symbol,
                tail_start.strftime("%Y-%m-%d"),
                curr_date,
                stockstats_utils.yf_retry,
            )
            merged = _merge_price_frames(local_frame, tail_frame)
            if _is_recent_enough(merged, curr_date):
                return stockstats_utils._clean_dataframe(merged)
        except Exception:
            pass

        return original_load_ohlcv(symbol, curr_date)

    def patched_get_indicators(symbol: str, indicator: str, curr_date: str, look_back_days: int = 30):
        return original_get_indicators(
            symbol,
            indicator,
            curr_date,
            _normalize_indicator_lookback_days(look_back_days),
        )

    interface.VENDOR_METHODS["get_stock_data"]["yfinance"] = patched_get_stock_data
    interface.VENDOR_METHODS["get_indicators"]["yfinance"] = patched_get_indicators
    stockstats_utils.load_ohlcv = patched_load_ohlcv
    y_finance.load_ohlcv = patched_load_ohlcv
    for method_name in (
        "get_news",
        "get_global_news",
        "get_fundamentals",
        "get_balance_sheet",
        "get_cashflow",
        "get_income_statement",
        "get_insider_transactions",
    ):
        original_impl = interface.VENDOR_METHODS.get(method_name, {}).get("yfinance")
        if original_impl:
            interface.VENDOR_METHODS[method_name]["yfinance"] = _wrap_cached_vendor_method(method_name, original_impl)
    _PATCH_INSTALLED = True
    return True
