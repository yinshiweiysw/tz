#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, TypeVar

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = DEFAULT_PORTFOLIO_ROOT
DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_BASE_DELAY = 1.0
DEFAULT_FULL_HISTORY_START_DATE = "19901219"
DEFAULT_INCREMENTAL_BUFFER_DAYS = 10

T = TypeVar("T")


def ensure_runtime() -> None:
    if os.environ.get("FETCH_MACRO_ERP_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import akshare  # noqa: F401
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["FETCH_MACRO_ERP_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import akshare as ak  # noqa: E402
import pandas as pd  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch historical HS300 PE and CN 10Y rate, calculate ERP, and upsert into market_lake.db."
    )
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--start-date", default="")
    parser.add_argument("--full-refresh", action="store_true")
    parser.add_argument("--incremental-buffer-days", type=int, default=DEFAULT_INCREMENTAL_BUFFER_DAYS)
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    parser.add_argument("--retry-base-delay", type=float, default=DEFAULT_RETRY_BASE_DELAY)
    return parser.parse_args()


def rebind_runtime_paths(portfolio_root: Path) -> None:
    global PORTFOLIO_ROOT
    global DB_PATH

    PORTFOLIO_ROOT = portfolio_root
    DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def safe_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.replace(",", "").replace("%", "").strip()
        if normalized in {"", "--", "-", "None", "nan"}:
            return None
        value = normalized
    try:
        numeric = float(value)
    except Exception:
        return None
    if not math.isfinite(numeric):
        return None
    return numeric


def round_or_none(value: Any, digits: int = 4) -> float | None:
    numeric = safe_float(value)
    if numeric is None:
        return None
    return round(numeric, digits)


def retry_call(
    label: str,
    func: Callable[[], T],
    *,
    max_retries: int,
    base_delay: float,
) -> T:
    attempts = max(1, int(max_retries))
    errors: list[str] = []

    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:
            errors.append(f"attempt_{attempt}: {exc!r}")
            if attempt >= attempts:
                break
            time.sleep(float(base_delay) * (2 ** (attempt - 1)))

    raise RuntimeError(f"{label} failed after {attempts} attempts; {'; '.join(errors)}")


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS macro_indicators (
          date TEXT NOT NULL PRIMARY KEY,
          pe_ttm REAL NOT NULL,
          cn_10y_rate REAL NOT NULL,
          ey_pct REAL NOT NULL,
          erp_pct REAL NOT NULL,
          pe_source TEXT NOT NULL,
          rate_source TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_macro_indicators_date
          ON macro_indicators(date);
        """
    )


def max_existing_date(connection: sqlite3.Connection) -> str | None:
    ensure_schema(connection)
    row = connection.execute("SELECT MAX(date) FROM macro_indicators").fetchone()
    if not row or not row[0]:
        return None
    return str(row[0])


def resolve_start_date(
    connection: sqlite3.Connection,
    *,
    user_start_date: str,
    full_refresh: bool,
    incremental_buffer_days: int,
) -> str:
    explicit = str(user_start_date or "").strip()
    if explicit:
        return explicit.replace("-", "")

    if full_refresh:
        return DEFAULT_FULL_HISTORY_START_DATE

    last_date = max_existing_date(connection)
    if not last_date:
        return DEFAULT_FULL_HISTORY_START_DATE

    anchor = date.fromisoformat(last_date) - timedelta(days=max(int(incremental_buffer_days), 0))
    return anchor.strftime("%Y%m%d")


def choose_first_column(columns: list[str], candidates: list[str], label: str) -> str:
    for candidate in candidates:
        if candidate in columns:
            return candidate
    raise ValueError(f"missing expected {label} column, got columns={columns}")


def normalize_date_column(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, errors="coerce").dt.strftime("%Y-%m-%d")


def fetch_hs300_pe_history(*, max_retries: int, base_delay: float) -> tuple[pd.DataFrame, str]:
    if hasattr(ak, "stock_a_indicator_lg"):
        try:
            raw_df = retry_call(
                "stock_a_indicator_lg(000300)",
                lambda: ak.stock_a_indicator_lg(symbol="000300"),
                max_retries=max_retries,
                base_delay=base_delay,
            )
            date_col = choose_first_column(list(raw_df.columns), ["trade_date", "日期", "date"], "trade date")
            pe_col = choose_first_column(
                list(raw_df.columns),
                ["pe_ttm", "滚动市盈率", "市盈率TTM", "市盈率(PE,TTM)"],
                "PE TTM",
            )
            source = "akshare.stock_a_indicator_lg"
            working = raw_df[[date_col, pe_col]].copy()
        except Exception:
            raw_df = retry_call(
                "stock_index_pe_lg(沪深300)",
                lambda: ak.stock_index_pe_lg(symbol="沪深300"),
                max_retries=max_retries,
                base_delay=base_delay,
            )
            date_col = choose_first_column(list(raw_df.columns), ["日期", "trade_date", "date"], "trade date")
            pe_col = choose_first_column(list(raw_df.columns), ["滚动市盈率", "pe_ttm"], "PE TTM")
            source = "akshare.stock_index_pe_lg"
            working = raw_df[[date_col, pe_col]].copy()
    else:
        raw_df = retry_call(
            "stock_index_pe_lg(沪深300)",
            lambda: ak.stock_index_pe_lg(symbol="沪深300"),
            max_retries=max_retries,
            base_delay=base_delay,
        )
        date_col = choose_first_column(list(raw_df.columns), ["日期", "trade_date", "date"], "trade date")
        pe_col = choose_first_column(list(raw_df.columns), ["滚动市盈率", "pe_ttm"], "PE TTM")
        source = "akshare.stock_index_pe_lg"
        working = raw_df[[date_col, pe_col]].copy()

    working.columns = ["date", "pe_ttm"]
    working["date"] = normalize_date_column(working["date"])
    working["pe_ttm"] = pd.to_numeric(working["pe_ttm"], errors="coerce")
    working = (
        working.dropna(subset=["date", "pe_ttm"])
        .query("pe_ttm > 0")
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .reset_index(drop=True)
    )
    if working.empty:
        raise ValueError("HS300 PE history is empty after cleaning")

    return working, source


def fetch_cn_10y_rate_history(
    *,
    start_date: str,
    max_retries: int,
    base_delay: float,
) -> tuple[pd.DataFrame, str]:
    raw_df = retry_call(
        f"bond_zh_us_rate(start_date={start_date})",
        lambda: ak.bond_zh_us_rate(start_date=start_date),
        max_retries=max_retries,
        base_delay=base_delay,
    )
    date_col = choose_first_column(list(raw_df.columns), ["日期", "trade_date", "date"], "trade date")
    rate_col = choose_first_column(
        list(raw_df.columns),
        ["中国国债收益率10年", "中国国债收益率10年(%)", "中国国债收益率10Y"],
        "CN 10Y rate",
    )

    working = raw_df[[date_col, rate_col]].copy()
    working.columns = ["date", "cn_10y_rate"]
    working["date"] = normalize_date_column(working["date"])
    working["cn_10y_rate"] = pd.to_numeric(working["cn_10y_rate"], errors="coerce")
    working = (
        working.dropna(subset=["date", "cn_10y_rate"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .reset_index(drop=True)
    )
    if working.empty:
        raise ValueError("CN 10Y rate history is empty after cleaning")

    return working, "akshare.bond_zh_us_rate"


def build_erp_frame(
    pe_df: pd.DataFrame,
    rate_df: pd.DataFrame,
    *,
    pe_source: str,
    rate_source: str,
    start_date_filter: str,
) -> pd.DataFrame:
    merged = pe_df.merge(rate_df, on="date", how="inner")
    if not merged.empty and start_date_filter:
        start_date_iso = pd.to_datetime(start_date_filter, errors="coerce").strftime("%Y-%m-%d")
        merged = merged.loc[merged["date"] >= start_date_iso].copy()

    merged["ey_pct"] = (1.0 / merged["pe_ttm"]) * 100.0
    merged["erp_pct"] = merged["ey_pct"] - merged["cn_10y_rate"]
    merged["pe_source"] = pe_source
    merged["rate_source"] = rate_source
    merged["updated_at"] = format_now()
    merged = merged.replace([math.inf, -math.inf], pd.NA)
    merged = (
        merged.dropna(subset=["date", "pe_ttm", "cn_10y_rate", "ey_pct", "erp_pct"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .reset_index(drop=True)
    )
    if merged.empty:
        raise ValueError("ERP frame is empty after merge and calculation")
    return merged


def upsert_macro_indicators(connection: sqlite3.Connection, frame: pd.DataFrame) -> int:
    ensure_schema(connection)
    rows = [
        (
            row["date"],
            float(row["pe_ttm"]),
            float(row["cn_10y_rate"]),
            float(row["ey_pct"]),
            float(row["erp_pct"]),
            str(row["pe_source"]),
            str(row["rate_source"]),
            str(row["updated_at"]),
        )
        for _, row in frame.iterrows()
    ]
    connection.executemany(
        """
        INSERT INTO macro_indicators (
          date, pe_ttm, cn_10y_rate, ey_pct, erp_pct, pe_source, rate_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          pe_ttm = excluded.pe_ttm,
          cn_10y_rate = excluded.cn_10y_rate,
          ey_pct = excluded.ey_pct,
          erp_pct = excluded.erp_pct,
          pe_source = excluded.pe_source,
          rate_source = excluded.rate_source,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    connection.commit()
    return len(rows)


def print_recent_rows(connection: sqlite3.Connection, limit: int = 5) -> None:
    query = """
        SELECT date, pe_ttm, cn_10y_rate, ey_pct, erp_pct
        FROM macro_indicators
        ORDER BY date DESC
        LIMIT ?
    """
    rows = connection.execute(query, [int(limit)]).fetchall()
    print("=== Recent ERP Rows ===")
    if not rows:
        print("(empty)")
        return

    print("date        pe_ttm   cn_10y_rate  ey_pct   erp_pct")
    for row in rows:
        print(
            f"{row[0]}  "
            f"{row[1]:>7.2f}  "
            f"{row[2]:>11.4f}  "
            f"{row[3]:>7.4f}  "
            f"{row[4]:>7.4f}"
        )


def main() -> None:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    rebind_runtime_paths(portfolio_root)
    db_path = (Path(args.db).expanduser().resolve() if args.db else DB_PATH.resolve())
    db_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(db_path) as connection:
        ensure_schema(connection)
        start_date = resolve_start_date(
            connection,
            user_start_date=args.start_date,
            full_refresh=bool(args.full_refresh),
            incremental_buffer_days=args.incremental_buffer_days,
        )

        pe_df, pe_source = fetch_hs300_pe_history(
            max_retries=args.max_retries,
            base_delay=args.retry_base_delay,
        )
        rate_df, rate_source = fetch_cn_10y_rate_history(
            start_date=start_date,
            max_retries=args.max_retries,
            base_delay=args.retry_base_delay,
        )
        erp_frame = build_erp_frame(
            pe_df,
            rate_df,
            pe_source=pe_source,
            rate_source=rate_source,
            start_date_filter=start_date,
        )
        affected = upsert_macro_indicators(connection, erp_frame)

        print("=== Macro ERP Sync Complete ===")
        print(f"db_path: {db_path}")
        print(f"fetch_start_date: {start_date}")
        print(f"pe_source: {pe_source}")
        print(f"rate_source: {rate_source}")
        print(f"upsert_rows: {affected}")
        print(f"date_range: {erp_frame['date'].iloc[0]} -> {erp_frame['date'].iloc[-1]}")
        print_recent_rows(connection, limit=5)


if __name__ == "__main__":
    main()
