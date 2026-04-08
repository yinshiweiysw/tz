#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_account_id, resolve_portfolio_root  # noqa: E402
from fund_name_normalizer import normalize_fund_name  # noqa: E402
from portfolio_state_paths import load_preferred_portfolio_state, read_json_or_none  # noqa: E402

PORTFOLIO_ROOT = resolve_portfolio_root()
WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
OUTPUT_DIR = PORTFOLIO_ROOT / "data"
OUTPUT_PATH = OUTPUT_DIR / "correlation_matrix.json"
MARKET_LAKE_DB_PATH = OUTPUT_DIR / "market_lake.db"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_LOOKBACK_DAYS = 60
MIN_PAIR_OBSERVATIONS = 20


def ensure_runtime() -> None:
    if os.environ.get("CORRELATION_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["CORRELATION_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate 60-day fund return correlation matrix with AkShare NAV history."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--watchlist", default="")
    parser.add_argument("--portfolio-state", default="")
    parser.add_argument("--latest", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--output", default="")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


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


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


normalize_name = normalize_fund_name


def load_target_pool(
    *,
    watchlist_path: Path,
    portfolio_state_payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    watchlist_payload = read_json(watchlist_path)

    portfolio_positions = portfolio_state_payload.get("positions", [])
    portfolio_index = {
        normalize_name(item.get("name", "")): item for item in portfolio_positions if item.get("name")
    }

    targets: list[dict[str, Any]] = []
    for item in watchlist_payload.get("watchlist", []):
        if not item.get("enabled", True):
            continue

        normalized = normalize_name(item.get("name", ""))
        portfolio_match = portfolio_index.get(normalized)
        targets.append(
            {
                "code": str(item.get("code", "")).strip(),
                "name": item.get("name"),
                "watchlist_amount_cny": safe_float(item.get("approxCurrentAmountCny")),
                "watchlist_note": item.get("note"),
                "portfolio_match_name": portfolio_match.get("name") if portfolio_match else None,
                "portfolio_category": portfolio_match.get("category") if portfolio_match else None,
            }
        )

    metadata = {
        "watchlist_as_of": watchlist_payload.get("as_of"),
        "watchlist_basis": watchlist_payload.get("basis"),
        "portfolio_snapshot_date": portfolio_state_payload.get("snapshot_date"),
        "latest_snapshot_date": portfolio_state_payload.get("snapshot_date"),
    }
    return targets, metadata


def open_market_lake_connection(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"market lake not found: {db_path}")
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def load_history_series_from_db(
    connection: sqlite3.Connection,
    symbol: str,
    lookback_days: int,
) -> pd.Series:
    rows = connection.execute(
        """
        SELECT date, close
        FROM daily_prices
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        (symbol, lookback_days),
    ).fetchall()

    if not rows:
        raise ValueError("market_lake 查询为空")

    working = pd.DataFrame(rows, columns=["date", "close"])
    working["date"] = pd.to_datetime(working["date"], errors="coerce")
    working["close"] = pd.to_numeric(working["close"], errors="coerce")
    working = (
        working.dropna(subset=["date", "close"])
        .sort_values("date")
        .drop_duplicates(subset=["date"], keep="last")
        .set_index("date")
    )

    if working.empty:
        raise ValueError("净值历史在清洗后为空")

    series = working["close"]
    if series.empty:
        raise ValueError("lookback 窗口内无可用净值")

    return series


def build_pair_statistics(returns_df: pd.DataFrame, targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stats: list[dict[str, Any]] = []
    names = {item["code"]: item["name"] for item in targets}
    categories = {item["code"]: item.get("portfolio_category") for item in targets}
    codes = list(returns_df.columns)

    for left_index, left_code in enumerate(codes):
        for right_code in codes[left_index + 1 :]:
            pair = returns_df[[left_code, right_code]].dropna()
            if len(pair) < MIN_PAIR_OBSERVATIONS:
                continue

            correlation = pair[left_code].corr(pair[right_code])
            stats.append(
                {
                    "left_code": left_code,
                    "left_name": names.get(left_code),
                    "left_category": categories.get(left_code),
                    "right_code": right_code,
                    "right_name": names.get(right_code),
                    "right_category": categories.get(right_code),
                    "correlation": round_or_none(correlation, 4),
                    "overlapping_return_points": int(len(pair)),
                }
            )

    return sorted(
        stats,
        key=lambda item: abs(float(item.get("correlation") or 0)),
        reverse=True,
    )


def generate_correlation_matrix(
    args: argparse.Namespace,
    *,
    watchlist_path: Path,
    portfolio_state_payload: dict[str, Any],
    portfolio_state_path: Path,
    portfolio_state_source_kind: str,
    db_path: Path,
) -> dict[str, Any]:
    targets, metadata = load_target_pool(
        watchlist_path=watchlist_path,
        portfolio_state_payload=portfolio_state_payload,
    )
    payload: dict[str, Any] = {
        "version": 1,
        "generated_at": format_now(),
        "layer_role": "layer_2_dynamic_correlation_engine",
        "source": "Local SQLite market_lake daily_prices",
        "parameters": {
            "lookback_trading_days": args.lookback_days,
            "indicator": "累计净值走势",
            "return_method": "daily_pct_change",
            "min_pair_observations": MIN_PAIR_OBSERVATIONS,
        },
        "source_pool": metadata,
        "funds": [],
        "matrix": {},
        "pair_statistics": [],
        "errors": [],
    }
    payload["source_pool"]["portfolio_snapshot_path"] = str(portfolio_state_path)
    payload["source_pool"]["portfolio_snapshot_source_kind"] = portfolio_state_source_kind

    nav_series_map: dict[str, pd.Series] = {}

    with open_market_lake_connection(db_path) as connection:
        for target in targets:
            code = target["code"]
            name = target["name"]
            payload["funds"].append(
                {
                    "code": code,
                    "name": name,
                    "portfolio_category": target.get("portfolio_category"),
                    "latest_category": target.get("portfolio_category"),
                    "watchlist_amount_cny": round_or_none(target.get("watchlist_amount_cny"), 2),
                }
            )

            try:
                nav_series_map[code] = load_history_series_from_db(connection, code, args.lookback_days)
            except Exception as exc:
                payload["errors"].append(
                    {
                        "code": code,
                        "name": name,
                        "message": str(exc),
                    }
                )

    if not nav_series_map:
        return payload

    nav_df = pd.concat(nav_series_map, axis=1, sort=True).sort_index()
    returns_df = nav_df.pct_change().dropna(how="all")
    correlation_df = returns_df.corr()

    payload["matrix"] = {
        column: {
            inner_column: round_or_none(correlation_df.loc[column, inner_column], 4)
            for inner_column in correlation_df.columns
        }
        for column in correlation_df.columns
    }
    payload["pair_statistics"] = build_pair_statistics(returns_df, targets)
    payload["data_quality"] = {
        "aligned_nav_rows": int(len(nav_df)),
        "aligned_return_rows": int(len(returns_df)),
        "funds_with_history": int(len(nav_series_map)),
    }
    return payload


def main() -> int:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    manifest = read_json_or_none(portfolio_root / "state-manifest.json") or {}
    canonical = manifest.get("canonical_entrypoints", {}) if isinstance(manifest, dict) else {}
    watchlist_path = (
        Path(args.watchlist)
        if args.watchlist
        else Path(canonical.get("fund_watchlist") or portfolio_root / "fund-watchlist.json")
    )
    portfolio_state_payload, portfolio_state_path, portfolio_state_source_kind, _ = load_preferred_portfolio_state(
        portfolio_root=portfolio_root,
        manifest=manifest,
        explicit_portfolio_state=args.portfolio_state,
        explicit_latest_compat=args.latest,
    )
    db_path = (
        Path(args.db)
        if args.db
        else Path(
            canonical.get("market_lake_db")
            or (
                portfolio_root / "data" / "market_lake.db"
                if (portfolio_root / "data" / "market_lake.db").exists()
                else DEFAULT_PORTFOLIO_ROOT / "data" / "market_lake.db"
            )
        )
    )
    output_path = Path(args.output) if args.output else portfolio_root / "data" / "correlation_matrix.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = generate_correlation_matrix(
        args,
        watchlist_path=watchlist_path,
        portfolio_state_payload=portfolio_state_payload,
        portfolio_state_path=portfolio_state_path,
        portfolio_state_source_kind=portfolio_state_source_kind,
        db_path=db_path,
    )
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "accountId": account_id,
                "portfolioRoot": str(portfolio_root),
                "outputPath": str(output_path),
                "fundCount": len(payload["funds"]),
                "matrixSize": len(payload["matrix"]),
                "pairCount": len(payload["pair_statistics"]),
                "errorCount": len(payload["errors"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
