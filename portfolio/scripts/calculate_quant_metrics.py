#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import resolve_account_id, resolve_portfolio_root  # noqa: E402
from portfolio_state_paths import load_preferred_portfolio_state, read_json_or_none  # noqa: E402
PORTFOLIO_ROOT = resolve_portfolio_root()
ASSET_MASTER_PATH = PORTFOLIO_ROOT / "config" / "asset_master.json"
WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
OUTPUT_PATH = PORTFOLIO_ROOT / "data" / "quant_metrics_engine.json"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_LOOKBACK_DAYS = 60
ANNUALIZATION_DAYS = 252
POSITION_PROXY_RULES = [
    {
        "symbol": "025162",
        "category_equals": ["大宗商品/QDII"],
        "name_patterns": ["大宗商品"],
        "proxy_note": "unlisted_active_position_proxy_cn_commodity_fund",
    },
    {
        "symbol": "QQQ",
        "category_equals": ["美股科技/QDII"],
        "name_patterns": ["纳斯达克科技市值加权"],
        "proxy_note": "unlisted_active_position_proxy_us_tech",
    },
    {
        "symbol": "^N225",
        "category_equals": ["日本股市/QDII"],
        "name_patterns": ["日经225"],
        "proxy_note": "unlisted_active_position_proxy_japan",
    },
]


def ensure_runtime() -> None:
    if os.environ.get("QUANT_METRICS_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import numpy  # noqa: F401
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["QUANT_METRICS_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calculate portfolio quant metrics, risk matrix, and Brinson attribution."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--asset-master", default="")
    parser.add_argument("--portfolio-state", default="")
    parser.add_argument("--latest", default="")
    parser.add_argument("--watchlist", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def round_or_none(value: Any, digits: int = 6) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if not math.isfinite(numeric):
        return None
    return round(numeric, digits)


def normalize_name(value: str) -> str:
    text = str(value or "")
    replacements = {
        "（": "(",
        "）": ")",
        " ": "",
        "\u3000": "",
        "(QDII)": "",
        "（QDII）": "",
        "ETF发起式联接": "",
        "ETF发起联接": "",
        "ETF联接": "",
        "ETF发起": "",
        "联接": "",
        "发起式": "",
        "发起": "",
        "人民币": "",
        "混合型": "混合",
        "持有期": "持有",
        "QDII-LOF": "QDII",
        "QDII-FOF-LOF": "QDII",
        "-": "",
        "_": "",
        "/": "",
        ".": "",
        "(": "",
        ")": "",
        "[": "",
        "]": "",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


def matches_rule(rule: dict[str, Any], category: str, name: str) -> bool:
    category_equals = list(rule.get("category_equals") or [])
    name_patterns = list(rule.get("name_patterns") or [])

    category_match = bool(category and category in category_equals)
    name_match = False
    for pattern in name_patterns:
        try:
            if pattern and pd.notna(name) and re.search(str(pattern), name):
                name_match = True
                break
        except Exception:
            continue

    if category_equals or name_patterns:
        return category_match or name_match
    return False


def resolve_bucket_key(asset_master: dict[str, Any], position: dict[str, Any]) -> str:
    category = str(position.get("category") or position.get("latest_category") or "").strip()
    name = str(position.get("name") or "").strip()

    for rule in asset_master.get("bucket_mapping_rules", []):
        if matches_rule(rule, category, name):
            return str(rule.get("bucket_key"))

    return str(asset_master.get("fallback_bucket_key") or "tactical")


def build_watchlist_lookup(watchlist_payload: dict[str, Any]) -> tuple[dict[str, str], list[tuple[str, str]]]:
    by_name: dict[str, str] = {}
    ordered: list[tuple[str, str]] = []

    for item in watchlist_payload.get("watchlist", []):
        if not item.get("enabled", True):
            continue
        code = str(item.get("code") or "").strip()
        name = str(item.get("name") or "").strip()
        if not code or not name:
            continue
        normalized = normalize_name(name)
        by_name[normalized] = code
        ordered.append((normalized, code))

    return by_name, ordered


def resolve_position_symbol(position: dict[str, Any], watchlist_lookup: dict[str, str], watchlist_pairs: list[tuple[str, str]]) -> str | None:
    candidates = [
        position.get("code"),
        position.get("fund_code"),
        position.get("name"),
    ]

    for candidate in candidates:
        normalized = normalize_name(str(candidate or ""))
        if normalized and normalized in watchlist_lookup:
            return watchlist_lookup[normalized]

    normalized_name = normalize_name(str(position.get("name") or ""))
    if not normalized_name:
        return None

    for watchlist_name, code in watchlist_pairs:
        if normalized_name in watchlist_name or watchlist_name in normalized_name:
            return code

    for rule in POSITION_PROXY_RULES:
        if matches_rule(rule, str(position.get("category") or ""), str(position.get("name") or "")):
            return str(rule["symbol"])

    return None


def infer_holding_profit(position: dict[str, Any]) -> float:
    for key in ("holding_profit", "holding_pnl"):
        value = position.get(key)
        try:
            numeric = float(value)
        except Exception:
            continue
        if math.isfinite(numeric):
            return numeric
    return 0.0


def estimate_cost(amount: float, holding_profit: float) -> float | None:
    estimated = amount - holding_profit
    if math.isfinite(estimated) and estimated > 0:
        return estimated
    return None


def load_price_series(connection: sqlite3.Connection, symbol: str) -> pd.Series:
    query = """
        SELECT date, adj_close
        FROM daily_prices
        WHERE symbol = ?
          AND adj_close IS NOT NULL
        ORDER BY date ASC
    """
    df = pd.read_sql_query(query, connection, params=[symbol])
    if df.empty:
        raise ValueError(f"missing adj_close history for symbol={symbol}")

    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    df = (
        df.dropna(subset=["date", "adj_close"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .set_index("date")
    )
    if df.empty:
        raise ValueError(f"adj_close history empty after cleaning for symbol={symbol}")

    return df["adj_close"].rename(symbol)


def build_returns_frame(series_map: dict[str, pd.Series], lookback_days: int) -> pd.DataFrame:
    combined = pd.concat(series_map.values(), axis=1, sort=True).sort_index().ffill().dropna(how="any")
    minimum_rows = lookback_days + 1
    if len(combined) < minimum_rows:
        raise ValueError(f"insufficient aligned history: need >= {minimum_rows}, got {len(combined)}")
    prices = combined.tail(minimum_rows)
    returns = prices.pct_change().dropna(how="any")
    if len(returns) < lookback_days:
        raise ValueError(f"insufficient aligned return rows: need {lookback_days}, got {len(returns)}")
    return returns.tail(lookback_days)


def compute_benchmark_bucket_weights(asset_master: dict[str, Any]) -> dict[str, float]:
    weights: dict[str, float] = {
        bucket_key: 0.0 for bucket_key in asset_master.get("bucket_order", [])
    }

    sleeves = asset_master.get("performance_benchmark", {}).get("sleeves", {})
    for sleeve in sleeves.values():
        for bucket_key, weight in (sleeve.get("bucket_weights_pct") or {}).items():
            weights[bucket_key] = float(weights.get(bucket_key, 0.0)) + float(weight or 0.0)

    return weights


def annual_cash_return(asset_master: dict[str, Any], lookback_days: int) -> float:
    annual_cash_yield_pct = float(
        asset_master.get("portfolio_backtest", {}).get("annual_cash_yield_pct", 2.0)
    )
    daily_rate = annual_cash_yield_pct / 100.0 / ANNUALIZATION_DAYS
    return (1.0 + daily_rate) ** lookback_days - 1.0


def to_nested_matrix(df: pd.DataFrame, digits: int = 8) -> dict[str, dict[str, float | None]]:
    result: dict[str, dict[str, float | None]] = {}
    for row_key in df.index:
        result[row_key] = {
            column: round_or_none(df.loc[row_key, column], digits)
            for column in df.columns
        }
    return result


def summarize_highest_correlation(corr_df: pd.DataFrame) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    columns = list(corr_df.columns)
    for i, left in enumerate(columns):
        for right in columns[i + 1 :]:
            value = corr_df.loc[left, right]
            if not math.isfinite(float(value)):
                continue
            candidate = {
                "left_symbol": left,
                "right_symbol": right,
                "correlation": round_or_none(value, 6),
            }
            if best is None or float(value) > float(best["correlation"]):
                best = candidate
    return best


def update_manifest(output_path: Path) -> None:
    if not MANIFEST_PATH.exists():
        return

    manifest = read_json(MANIFEST_PATH)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["quant_metrics_engine_script"] = str(PORTFOLIO_ROOT / "scripts" / "calculate_quant_metrics.py")
    canonical["latest_quant_metrics_engine"] = str(output_path)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    global MANIFEST_PATH
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    MANIFEST_PATH = portfolio_root / "state-manifest.json"
    manifest = read_json_or_none(MANIFEST_PATH) or {}
    args.asset_master = args.asset_master or str(portfolio_root / "config" / "asset_master.json")
    args.watchlist = args.watchlist or str(portfolio_root / "fund-watchlist.json")
    args.db = args.db or str(portfolio_root / "data" / "market_lake.db")
    args.output = args.output or str(portfolio_root / "data" / "quant_metrics_engine.json")
    asset_master = read_json(Path(args.asset_master))
    portfolio_state, portfolio_state_path, portfolio_state_source_kind, _ = load_preferred_portfolio_state(
        portfolio_root=portfolio_root,
        manifest=manifest,
        explicit_portfolio_state=args.portfolio_state,
        explicit_latest_compat=args.latest,
    )
    watchlist = read_json(Path(args.watchlist))
    watchlist_lookup, watchlist_pairs = build_watchlist_lookup(watchlist)

    active_positions = [
        position
        for position in (portfolio_state.get("positions") or [])
        if position.get("status") == "active" and float(position.get("amount") or 0) > 0
    ]
    if not active_positions:
        raise ValueError("portfolio_state snapshot has no active positions")

    bucket_order = list(asset_master.get("bucket_order") or [])
    bucket_labels = {
        key: asset_master.get("buckets", {}).get(key, {}).get("label", key) for key in bucket_order
    }

    positions_enriched: list[dict[str, Any]] = []
    missing_symbols: list[dict[str, Any]] = []
    total_market_value = 0.0

    for position in active_positions:
        amount = float(position.get("amount") or 0)
        holding_profit = infer_holding_profit(position)
        estimated_cost = estimate_cost(amount, holding_profit)
        symbol = resolve_position_symbol(position, watchlist_lookup, watchlist_pairs)
        bucket_key = resolve_bucket_key(asset_master, position)
        if not symbol:
            missing_symbols.append({"name": position.get("name"), "category": position.get("category")})
            continue

        return_pct = None
        if estimated_cost is not None and estimated_cost > 0:
            return_pct = holding_profit / estimated_cost

        positions_enriched.append(
            {
                "symbol": symbol,
                "name": position.get("name"),
                "category": position.get("category"),
                "bucket_key": bucket_key,
                "bucket_label": bucket_labels.get(bucket_key, bucket_key),
                "amount_cny": amount,
                "holding_profit_cny": holding_profit,
                "estimated_cost_cny": estimated_cost,
                "return_pct_decimal": return_pct,
            }
        )
        total_market_value += amount

    if missing_symbols:
        raise ValueError(f"missing watchlist mapping for active positions: {missing_symbols}")
    if total_market_value <= 0:
        raise ValueError("total active market value is non-positive")

    raw_active_symbols = [position["symbol"] for position in positions_enriched]

    representative_map = asset_master.get("portfolio_backtest", {}).get("bucket_representatives", {})
    benchmark_bucket_weights_pct = compute_benchmark_bucket_weights(asset_master)
    benchmark_symbol_map = {
        bucket_key: (representative_map.get(bucket_key) or {}).get("symbol") for bucket_key in bucket_order
    }

    related_symbols = set(raw_active_symbols)
    for bucket_key, symbol in benchmark_symbol_map.items():
        if symbol and symbol != "CASH_CNY":
            related_symbols.add(symbol)

    series_map: dict[str, pd.Series] = {}
    history_errors: list[dict[str, Any]] = []
    with sqlite3.connect(args.db) as connection:
        for symbol in sorted(related_symbols):
            try:
                series_map[symbol] = load_price_series(connection, symbol)
            except Exception as exc:
                history_errors.append({"symbol": symbol, "message": str(exc)})

    excluded_positions: list[dict[str, Any]] = []
    filtered_positions: list[dict[str, Any]] = []
    total_market_value = 0.0
    for position in positions_enriched:
        if position["symbol"] not in series_map:
            excluded_positions.append(
                {
                    "symbol": position["symbol"],
                    "name": position["name"],
                    "bucket_key": position["bucket_key"],
                    "reason": "missing_market_history",
                }
            )
            continue
        filtered_positions.append(position)
        total_market_value += position["amount_cny"]

    if not filtered_positions:
        raise ValueError("no active positions with usable market_lake history")

    for position in filtered_positions:
        position["weight_decimal"] = position["amount_cny"] / total_market_value
        position["weight_pct"] = position["weight_decimal"] * 100.0

    positions_enriched = filtered_positions
    symbol_to_position = {position["symbol"]: position for position in positions_enriched}
    active_symbols = [position["symbol"] for position in positions_enriched]

    position_returns = build_returns_frame(
        {symbol: series_map[symbol] for symbol in active_symbols},
        lookback_days=args.lookback_days,
    )
    corr_df = position_returns.corr()
    cov_annualized_df = position_returns.cov() * ANNUALIZATION_DAYS

    weights_series = pd.Series(
        {position["symbol"]: position["weight_decimal"] for position in positions_enriched},
        index=position_returns.columns,
        dtype=float,
    )
    cov_matrix = cov_annualized_df.loc[weights_series.index, weights_series.index]
    portfolio_variance = float(weights_series.to_numpy().T @ cov_matrix.to_numpy() @ weights_series.to_numpy())
    portfolio_vol = math.sqrt(max(portfolio_variance, 0.0))

    marginal_vector = (cov_matrix.to_numpy() @ weights_series.to_numpy()) / portfolio_vol if portfolio_vol > 0 else np.zeros(len(weights_series))
    component_vector = weights_series.to_numpy() * marginal_vector

    position_risk_rows: list[dict[str, Any]] = []
    bucket_risk_rows: dict[str, dict[str, Any]] = {
        bucket_key: {
            "bucket_key": bucket_key,
            "bucket_label": bucket_labels.get(bucket_key, bucket_key),
            "weight_pct": 0.0,
            "component_risk_contribution_pct": 0.0,
            "marginal_risk_contribution_pct": None,
            "risk_share_pct": 0.0,
            "position_count": 0,
        }
        for bucket_key in bucket_order
    }

    for index, symbol in enumerate(weights_series.index):
        position = symbol_to_position[symbol]
        mrc = float(marginal_vector[index]) if portfolio_vol > 0 else 0.0
        crc = float(component_vector[index]) if portfolio_vol > 0 else 0.0
        position_risk_rows.append(
            {
                "symbol": symbol,
                "name": position["name"],
                "bucket_key": position["bucket_key"],
                "bucket_label": position["bucket_label"],
                "weight_pct": round_or_none(position["weight_pct"], 4),
                "marginal_risk_contribution_pct": round_or_none(mrc * 100.0, 6),
                "component_risk_contribution_pct": round_or_none(crc * 100.0, 6),
                "risk_share_pct": round_or_none((crc / portfolio_vol) * 100.0 if portfolio_vol > 0 else 0.0, 4),
            }
        )

        bucket_row = bucket_risk_rows[position["bucket_key"]]
        bucket_row["weight_pct"] += position["weight_pct"]
        bucket_row["component_risk_contribution_pct"] += crc * 100.0
        bucket_row["risk_share_pct"] += (crc / portfolio_vol) * 100.0 if portfolio_vol > 0 else 0.0
        bucket_row["position_count"] += 1

    for bucket_key, bucket_row in bucket_risk_rows.items():
        weight_decimal = bucket_row["weight_pct"] / 100.0
        component_decimal = bucket_row["component_risk_contribution_pct"] / 100.0
        bucket_row["weight_pct"] = round_or_none(bucket_row["weight_pct"], 4)
        bucket_row["component_risk_contribution_pct"] = round_or_none(
            bucket_row["component_risk_contribution_pct"],
            6,
        )
        bucket_row["risk_share_pct"] = round_or_none(bucket_row["risk_share_pct"], 4)
        if weight_decimal > 0 and portfolio_vol > 0:
            bucket_row["marginal_risk_contribution_pct"] = round_or_none(
                (component_decimal / weight_decimal) * 100.0,
                6,
            )
        else:
            bucket_row["marginal_risk_contribution_pct"] = None

    bucket_rows: list[dict[str, Any]] = []
    for bucket_key in bucket_order:
        members = [position for position in positions_enriched if position["bucket_key"] == bucket_key]
        bucket_amount = sum(position["amount_cny"] for position in members)
        bucket_profit = sum(position["holding_profit_cny"] for position in members)
        bucket_cost = sum(
            position["estimated_cost_cny"] for position in members if position["estimated_cost_cny"] is not None
        )
        bucket_return = bucket_profit / bucket_cost if bucket_cost and bucket_cost > 0 else None
        bucket_weight = bucket_amount / total_market_value if total_market_value > 0 else 0.0

        bucket_rows.append(
            {
                "bucket_key": bucket_key,
                "bucket_label": bucket_labels.get(bucket_key, bucket_key),
                "portfolio_weight_pct": round_or_none(bucket_weight * 100.0, 4),
                "portfolio_weight_decimal": round_or_none(bucket_weight, 8),
                "portfolio_market_value_cny": round_or_none(bucket_amount, 2),
                "portfolio_holding_profit_cny": round_or_none(bucket_profit, 2),
                "portfolio_return_pct": round_or_none(
                    bucket_return * 100.0 if bucket_return is not None else None,
                    4,
                ),
                "portfolio_return_decimal": round_or_none(bucket_return, 8) if bucket_return is not None else None,
                "positions": [
                    {
                        "symbol": position["symbol"],
                        "name": position["name"],
                        "amount_cny": round_or_none(position["amount_cny"], 2),
                        "weight_pct": round_or_none(position["weight_pct"], 4),
                        "holding_profit_cny": round_or_none(position["holding_profit_cny"], 2),
                        "return_pct": round_or_none(
                            (position["return_pct_decimal"] * 100.0)
                            if position["return_pct_decimal"] is not None
                            else None,
                            4,
                        ),
                    }
                    for position in members
                ],
            }
        )

    benchmark_rows: list[dict[str, Any]] = []
    benchmark_total_return = 0.0
    for bucket_row in bucket_rows:
        bucket_key = bucket_row["bucket_key"]
        benchmark_weight = float(benchmark_bucket_weights_pct.get(bucket_key, 0.0)) / 100.0
        benchmark_symbol = benchmark_symbol_map.get(bucket_key)
        benchmark_return = None
        benchmark_note = None

        if benchmark_symbol == "CASH_CNY":
            benchmark_return = annual_cash_return(asset_master, args.lookback_days)
            benchmark_note = "synthetic_cash_yield"
        elif benchmark_symbol:
            series = series_map.get(benchmark_symbol)
            if series is None:
                benchmark_note = "missing_market_history"
            else:
                if len(series) < args.lookback_days + 1:
                    raise ValueError(f"benchmark symbol {benchmark_symbol} lacks enough history")
                window_series = series.tail(args.lookback_days + 1)
                benchmark_return = float(window_series.iloc[-1] / window_series.iloc[0] - 1.0)
                benchmark_note = "market_lake_adj_close_60d"

        portfolio_return = bucket_row["portfolio_return_decimal"] if bucket_row["portfolio_return_decimal"] is not None else 0.0
        benchmark_return = benchmark_return if benchmark_return is not None else 0.0

        allocation = (bucket_row["portfolio_weight_decimal"] - benchmark_weight) * (
            benchmark_return - 0.0
        )
        benchmark_rows.append(
            {
                "bucket_key": bucket_key,
                "bucket_label": bucket_row["bucket_label"],
                "benchmark_symbol": benchmark_symbol,
                "benchmark_return_decimal": round_or_none(benchmark_return, 8),
                "benchmark_return_pct": round_or_none(benchmark_return * 100.0, 4),
                "benchmark_weight_decimal": round_or_none(benchmark_weight, 8),
                "benchmark_weight_pct": round_or_none(benchmark_weight * 100.0, 4),
                "benchmark_return_source": benchmark_note,
                "portfolio_return_decimal": bucket_row["portfolio_return_decimal"],
                "portfolio_return_pct": bucket_row["portfolio_return_pct"],
                "portfolio_weight_decimal": bucket_row["portfolio_weight_decimal"],
                "portfolio_weight_pct": bucket_row["portfolio_weight_pct"],
            }
        )
        benchmark_total_return += benchmark_weight * benchmark_return

    benchmark_lookup = {row["bucket_key"]: row for row in benchmark_rows}
    brinson_rows: list[dict[str, Any]] = []
    total_allocation = 0.0
    total_selection = 0.0
    total_interaction = 0.0

    for bucket_row in bucket_rows:
        benchmark_row = benchmark_lookup[bucket_row["bucket_key"]]
        wp = float(bucket_row["portfolio_weight_decimal"] or 0.0)
        wb = float(benchmark_row["benchmark_weight_decimal"] or 0.0)
        rp = float(bucket_row["portfolio_return_decimal"] or 0.0)
        rb = float(benchmark_row["benchmark_return_decimal"] or 0.0)

        allocation = (wp - wb) * (rb - benchmark_total_return)
        selection = wb * (rp - rb)
        interaction = (wp - wb) * (rp - rb)
        active = allocation + selection + interaction

        total_allocation += allocation
        total_selection += selection
        total_interaction += interaction

        brinson_rows.append(
            {
                "bucket_key": bucket_row["bucket_key"],
                "bucket_label": bucket_row["bucket_label"],
                "benchmark_symbol": benchmark_row["benchmark_symbol"],
                "portfolio_weight_pct": bucket_row["portfolio_weight_pct"],
                "benchmark_weight_pct": benchmark_row["benchmark_weight_pct"],
                "weight_gap_pct": round_or_none((wp - wb) * 100.0, 4),
                "portfolio_return_pct": bucket_row["portfolio_return_pct"],
                "benchmark_return_pct": benchmark_row["benchmark_return_pct"],
                "allocation_effect_pct": round_or_none(allocation * 100.0, 6),
                "selection_effect_pct": round_or_none(selection * 100.0, 6),
                "interaction_effect_pct": round_or_none(interaction * 100.0, 6),
                "active_contribution_pct": round_or_none(active * 100.0, 6),
            }
        )

    output_payload = {
        "account_id": account_id,
        "generated_at": format_now(),
        "lookback_days": args.lookback_days,
        "sources": {
            "asset_master": str(Path(args.asset_master)),
            "portfolio_snapshot": str(portfolio_state_path),
            "portfolio_snapshot_source_kind": portfolio_state_source_kind,
            "watchlist": str(Path(args.watchlist)),
            "market_lake_db": str(Path(args.db)),
        },
        "portfolio_snapshot": {
            "snapshot_date": portfolio_state.get("snapshot_date"),
            "total_market_value_cny": round_or_none(total_market_value, 2),
            "active_position_count": len(positions_enriched),
            "active_symbols": active_symbols,
            "excluded_positions_due_to_missing_history": excluded_positions,
        },
        "matrices": {
            "correlation_matrix": {
                "symbols": list(position_returns.columns),
                "highest_pair": summarize_highest_correlation(corr_df),
                "matrix": to_nested_matrix(corr_df, digits=6),
            },
            "annualized_covariance_matrix": {
                "symbols": list(position_returns.columns),
                "matrix": to_nested_matrix(cov_annualized_df, digits=8),
            },
        },
        "risk_model": {
            "portfolio_annualized_volatility_pct": round_or_none(portfolio_vol * 100.0, 6),
            "return_observations": int(len(position_returns)),
            "position_risk_contributions": position_risk_rows,
            "bucket_marginal_risk_contribution": [
                bucket_risk_rows[bucket_key] for bucket_key in bucket_order
            ],
        },
        "errors": history_errors,
        "brinson_attribution": {
            "portfolio_return_source": "portfolio_state holding_pnl / estimated_cost (cross-sectional snapshot; falls back to latest.json compatibility view only if needed)",
            "benchmark_return_source": f"market_lake adj_close trailing {args.lookback_days}d",
            "benchmark_total_return_pct": round_or_none(benchmark_total_return * 100.0, 6),
            "total_allocation_effect_pct": round_or_none(total_allocation * 100.0, 6),
            "total_selection_effect_pct": round_or_none(total_selection * 100.0, 6),
            "total_interaction_effect_pct": round_or_none(total_interaction * 100.0, 6),
            "total_active_effect_pct": round_or_none(
                (total_allocation + total_selection + total_interaction) * 100.0,
                6,
            ),
            "bucket_effects": brinson_rows,
        },
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_manifest(output_path)

    print(
        json.dumps(
            {
                "account_id": account_id,
                "portfolio_root": str(portfolio_root),
                "output": str(output_path),
                "active_position_count": len(positions_enriched),
                "return_observations": int(len(position_returns)),
                "portfolio_annualized_volatility_pct": output_payload["risk_model"][
                    "portfolio_annualized_volatility_pct"
                ],
                "brinson_bucket_count": len(brinson_rows),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
