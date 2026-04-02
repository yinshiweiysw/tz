#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = DEFAULT_PORTFOLIO_ROOT
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_INITIAL_CAPITAL = 1_000_000.0
DEFAULT_LOOKBACK_DAYS = 1250
DEFAULT_WARMUP_DAYS = 120
DEFAULT_RSI_WINDOW = 14
DEFAULT_ADX_WINDOW = 14
DEFAULT_SMA_WINDOW = 20
DEFAULT_MACD_FAST = 12
DEFAULT_MACD_SLOW = 26
DEFAULT_MACD_SIGNAL = 9
DEFAULT_ANNUAL_CASH_YIELD_PCT = 2.0
DEFAULT_VALUATION_WINDOW_DAYS = 1250
DEFAULT_VALUATION_MIN_HISTORY_DAYS = 252
ADX_TREND_THRESHOLD = 25
RSI_BOTTOM_THRESHOLD = 30
MIN_TRADE_CNY = 1.0
CASH_BUCKET_KEY = "cash"


def ensure_runtime() -> None:
    if os.environ.get("PORTFOLIO_BACKTEST_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            import ta  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["PORTFOLIO_BACKTEST_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd  # noqa: E402
from ta.momentum import RSIIndicator  # noqa: E402
from ta.trend import ADXIndicator, MACD  # noqa: E402
from ta.volatility import AverageTrueRange  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a portfolio-level walk-forward backtest using local market_lake data."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--asset-master", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--initial-capital", type=float, default=DEFAULT_INITIAL_CAPITAL)
    parser.add_argument("--lookback-days", type=int, default=None)
    parser.add_argument("--warmup-days", type=int, default=None)
    parser.add_argument("--equity-output", default="")
    parser.add_argument("--summary-output", default="")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_runtime_paths(args: argparse.Namespace) -> dict[str, Path]:
    portfolio_root = resolve_portfolio_root(
        user=args.user or None,
        portfolio_root=args.portfolio_root or None,
    )
    manifest_path = portfolio_root / "state-manifest.json"
    canonical = {}
    if manifest_path.exists():
        try:
            canonical = read_json(manifest_path).get("canonical_entrypoints", {})
        except Exception:
            canonical = {}

    return {
        "portfolio_root": portfolio_root,
        "manifest_path": manifest_path,
        "asset_master_path": (
            Path(args.asset_master).expanduser()
            if args.asset_master
            else Path(str(canonical.get("asset_master", portfolio_root / "config" / "asset_master.json"))).expanduser()
        ),
        "db_path": (
            Path(args.db).expanduser()
            if args.db
            else Path(str(canonical.get("market_lake_db", portfolio_root / "data" / "market_lake.db"))).expanduser()
        ),
        "equity_output_path": (
            Path(args.equity_output).expanduser()
            if args.equity_output
            else portfolio_root / "data" / "portfolio_backtest_equity.json"
        ),
        "summary_output_path": (
            Path(args.summary_output).expanduser()
            if args.summary_output
            else portfolio_root / "data" / "portfolio_backtest_results.json"
        ),
    }


def round_or_none(value: Any, digits: int = 2) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if not math.isfinite(numeric):
        return None
    return round(numeric, digits)


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def bucket_target_pct(bucket_cfg: dict[str, Any], initial_capital: float) -> float:
    target_pct = bucket_cfg.get("target")
    if target_pct is None:
        target_pct = bucket_cfg.get("target_pct")
    if target_pct is not None:
        return float(target_pct)

    target_amount = bucket_cfg.get("target_amount_cny")
    if target_amount is None or initial_capital <= 0:
        raise ValueError(f"Bucket missing target_pct/target_amount_cny: {bucket_cfg}")

    return (float(target_amount) / float(initial_capital)) * 100.0


def aggregate_benchmark_bucket_weights(asset_master: dict[str, Any]) -> dict[str, float]:
    result: dict[str, float] = defaultdict(float)
    sleeves = asset_master.get("performance_benchmark", {}).get("sleeves", {})

    for sleeve in sleeves.values():
        for bucket_key, weight in (sleeve.get("bucket_weights_pct") or {}).items():
            result[bucket_key] += float(weight)

    return dict(result)


def load_backtest_specs(asset_master: dict[str, Any], initial_capital: float) -> dict[str, dict[str, Any]]:
    backtest_cfg = asset_master.get("portfolio_backtest", {})
    representatives = backtest_cfg.get("bucket_representatives", {})
    buckets = asset_master.get("buckets", {})
    specs: dict[str, dict[str, Any]] = {}

    for bucket_key in asset_master.get("bucket_order", []):
        bucket_cfg = buckets.get(bucket_key)
        rep_cfg = representatives.get(bucket_key)
        if not bucket_cfg or not rep_cfg:
            raise ValueError(f"Missing backtest representative for bucket={bucket_key}")

        specs[bucket_key] = {
            "bucket_key": bucket_key,
            "label": bucket_cfg.get("label", bucket_key),
            "target_pct": bucket_target_pct(bucket_cfg, initial_capital),
            "min_pct": float(bucket_cfg.get("min", bucket_cfg.get("min_pct", 0))),
            "max_pct": float(bucket_cfg.get("max", bucket_cfg.get("max_pct", 100))),
            "symbol": rep_cfg.get("symbol"),
            "display_name": rep_cfg.get("display_name", rep_cfg.get("symbol", bucket_key)),
            "synthetic_cash": bool(rep_cfg.get("synthetic_cash", False)),
            "proxy_note": rep_cfg.get("proxy_note") or rep_cfg.get("note"),
        }

    return specs


def load_price_frame(connection: sqlite3.Connection, symbol: str) -> pd.DataFrame:
    query = """
        SELECT date, open, high, low, close, adj_close
        FROM daily_prices
        WHERE symbol = ?
          AND close IS NOT NULL
          AND high IS NOT NULL
          AND low IS NOT NULL
        ORDER BY date ASC
    """
    df = pd.read_sql_query(query, connection, params=[symbol])
    if df.empty:
        raise ValueError(f"No local price history found for symbol={symbol}")

    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    for column in ["open", "high", "low", "close", "adj_close"]:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df["adj_close"] = df["adj_close"].fillna(df["close"])
    df = (
        df.dropna(subset=["date", "open", "high", "low", "close"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .set_index("date")
    )
    if df.empty:
        raise ValueError(f"Local price history for symbol={symbol} is empty after cleaning")

    return df[["open", "high", "low", "close", "adj_close"]]


def build_aligned_price_frame(
    connection: sqlite3.Connection,
    specs: dict[str, dict[str, Any]],
    lookback_days: int,
    warmup_days: int,
    valuation_window_days: int,
) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    raw_frames: dict[str, pd.DataFrame] = {}
    price_series = []

    for spec in specs.values():
        if spec["synthetic_cash"]:
            continue
        frame = load_price_frame(connection, spec["symbol"])
        raw_frames[spec["bucket_key"]] = frame
        price_series.append(frame["close"].rename(spec["symbol"]))

    combined = pd.concat(price_series, axis=1, sort=True).sort_index().ffill().dropna(how="any")
    minimum_required_rows = lookback_days + warmup_days
    preferred_rows = lookback_days + warmup_days + valuation_window_days
    if len(combined) < minimum_required_rows:
        raise ValueError(
            f"Insufficient aligned history: need >= {minimum_required_rows} rows, got {len(combined)}"
        )

    combined = combined.tail(min(preferred_rows, len(combined))).copy()
    aligned_frames: dict[str, pd.DataFrame] = {}
    for bucket_key, spec in specs.items():
        if spec["synthetic_cash"]:
            continue
        aligned_frame = raw_frames[bucket_key].reindex(combined.index).ffill()
        if aligned_frame[["high", "low", "close"]].isna().any().any():
            raise ValueError(f"Aligned OHLC contains null values for bucket={bucket_key}")
        aligned_frames[bucket_key] = aligned_frame

    combined["CASH_CNY"] = 1.0
    return combined, aligned_frames


def compute_indicator_frame(
    market_frame: pd.DataFrame,
    valuation_window_days: int,
    valuation_min_history_days: int,
) -> pd.DataFrame:
    working = market_frame.copy()
    working["close"] = working["close"].astype(float)
    working["high"] = working["high"].astype(float)
    working["low"] = working["low"].astype(float)

    working["SMA_20"] = working["close"].rolling(window=DEFAULT_SMA_WINDOW, min_periods=DEFAULT_SMA_WINDOW).mean()
    working["RSI_14"] = RSIIndicator(
        close=working["close"],
        window=DEFAULT_RSI_WINDOW,
        fillna=False,
    ).rsi()
    atr_indicator = AverageTrueRange(
        high=working["high"],
        low=working["low"],
        close=working["close"],
        window=DEFAULT_ADX_WINDOW,
        fillna=False,
    )

    adx_indicator = ADXIndicator(
        high=working["high"],
        low=working["low"],
        close=working["close"],
        window=DEFAULT_ADX_WINDOW,
        fillna=False,
    )
    macd_indicator = MACD(
        close=working["close"],
        window_fast=DEFAULT_MACD_FAST,
        window_slow=DEFAULT_MACD_SLOW,
        window_sign=DEFAULT_MACD_SIGNAL,
        fillna=False,
    )

    working["ATR_14"] = atr_indicator.average_true_range()
    working["ADX_14"] = adx_indicator.adx()
    working["MACD_HIST"] = macd_indicator.macd_diff()
    working["PREV_MACD_HIST"] = working["MACD_HIST"].shift(1)
    working["HIST_INCREASING"] = working["MACD_HIST"] > working["PREV_MACD_HIST"]
    rolling_min = working["close"].rolling(
        window=valuation_window_days,
        min_periods=valuation_min_history_days,
    ).min()
    rolling_max = working["close"].rolling(
        window=valuation_window_days,
        min_periods=valuation_min_history_days,
    ).max()
    valuation_range = rolling_max - rolling_min
    working["VALUATION_PCT_5Y"] = ((working["close"] - rolling_min) / valuation_range) * 100.0
    working.loc[valuation_range == 0, "VALUATION_PCT_5Y"] = 50.0
    working["VALUATION_PCT_5Y"] = working["VALUATION_PCT_5Y"].clip(lower=0, upper=100)
    return working


def build_signal_snapshot(indicator_row: pd.Series) -> dict[str, Any]:
    close = float(indicator_row["close"]) if pd.notna(indicator_row["close"]) else None
    sma_20 = float(indicator_row["SMA_20"]) if pd.notna(indicator_row["SMA_20"]) else None
    rsi_14 = float(indicator_row["RSI_14"]) if pd.notna(indicator_row["RSI_14"]) else None
    adx_14 = float(indicator_row["ADX_14"]) if pd.notna(indicator_row["ADX_14"]) else None
    macd_hist = float(indicator_row["MACD_HIST"]) if pd.notna(indicator_row["MACD_HIST"]) else None
    valuation_percentile_5y = (
        float(indicator_row["VALUATION_PCT_5Y"])
        if pd.notna(indicator_row["VALUATION_PCT_5Y"])
        else None
    )
    hist_increasing = (
        bool(indicator_row["HIST_INCREASING"]) if pd.notna(indicator_row["HIST_INCREASING"]) else None
    )
    above_sma = bool(close is not None and sma_20 is not None and close > sma_20)

    bullish = bool(
        above_sma
        and adx_14 is not None
        and adx_14 > ADX_TREND_THRESHOLD
    )
    bottom_divergence = bool(
        rsi_14 is not None
        and rsi_14 < RSI_BOTTOM_THRESHOLD
        and macd_hist is not None
        and (
            macd_hist >= 0
            or (macd_hist < 0 and hist_increasing is True)
        )
    )
    falling_knife = bool(
        close is not None
        and sma_20 is not None
        and close < sma_20
        and macd_hist is not None
        and macd_hist < 0
        and hist_increasing is False
    )

    if falling_knife:
        regime = "falling_knife"
    elif bullish:
        regime = "bullish"
    elif bottom_divergence:
        regime = "bottom_divergence"
    else:
        regime = "neutral"

    return {
        "close": close,
        "sma_20": sma_20,
        "rsi_14": rsi_14,
        "adx_14": adx_14,
        "macd_hist": macd_hist,
        "valuation_percentile_5y": valuation_percentile_5y,
        "hist_increasing": hist_increasing,
        "above_sma": above_sma,
        "bullish": bullish,
        "bottom_divergence": bottom_divergence,
        "falling_knife": falling_knife,
        "regime": regime,
    }


def derive_exposure_scale(
    signal: dict[str, Any],
    scale_config: dict[str, float],
) -> tuple[float, str]:
    bullish_scale = float(scale_config.get("bullish_trend", 1.0))
    choppy_scale = float(scale_config.get("choppy_above_sma", 0.5))
    left_scale = float(scale_config.get("left_undervalued", 0.3))

    if signal["falling_knife"]:
        return 0.0, "falling_knife_exit"

    if signal["bullish"]:
        return bullish_scale, "bullish_trend_full"

    if signal["above_sma"] and signal["adx_14"] is not None and signal["adx_14"] < ADX_TREND_THRESHOLD:
        return choppy_scale, "choppy_above_sma_half"

    if (
        not signal["above_sma"]
        and signal["valuation_percentile_5y"] is not None
        and signal["valuation_percentile_5y"] < 30
        and not signal["falling_knife"]
    ):
        return left_scale, "left_undervalued_base"

    return 0.0, "risk_off_zero"


def compute_bucket_values(
    date: pd.Timestamp,
    prices: pd.DataFrame,
    units: dict[str, float],
    cash_balance: float,
    specs: dict[str, dict[str, Any]],
) -> dict[str, float]:
    values: dict[str, float] = {CASH_BUCKET_KEY: cash_balance}
    for bucket_key, spec in specs.items():
        if spec["synthetic_cash"]:
            continue
        price = float(prices.loc[date, spec["symbol"]])
        values[bucket_key] = units.get(bucket_key, 0.0) * price
    return values


def compute_weights(values: dict[str, float], total_nav: float) -> dict[str, float]:
    if total_nav <= 0:
        return {key: 0.0 for key in values}
    return {key: (value / total_nav) * 100.0 for key, value in values.items()}


def apply_daily_cash_yield(cash_balance: float, daily_cash_yield: float) -> float:
    if cash_balance <= 0:
        return cash_balance
    return cash_balance * (1.0 + daily_cash_yield)


def execute_orders_for_date(
    date: pd.Timestamp,
    prices: pd.DataFrame,
    pending_orders: dict[pd.Timestamp, list[dict[str, Any]]],
    units: dict[str, float],
    cash_balance: float,
    specs: dict[str, dict[str, Any]],
) -> tuple[float, list[dict[str, Any]]]:
    orders = pending_orders.pop(date, [])
    executed: list[dict[str, Any]] = []
    if not orders:
        return cash_balance, executed

    ordered = sorted(orders, key=lambda item: 0 if item["side"] == "sell" else 1)
    for order in ordered:
        bucket_key = order["bucket_key"]
        spec = specs[bucket_key]
        if spec["synthetic_cash"]:
            continue

        price = float(prices.loc[date, spec["symbol"]])
        if price <= 0:
            continue

        if order["side"] == "sell":
            current_units = units.get(bucket_key, 0.0)
            current_value = current_units * price
            desired_value = current_value if order.get("sell_all") else min(order["amount_cny"], current_value)
            if desired_value <= MIN_TRADE_CNY:
                continue
            units_to_sell = min(current_units, desired_value / price)
            sale_value = units_to_sell * price
            units[bucket_key] = max(0.0, current_units - units_to_sell)
            cash_balance += sale_value
            executed.append(
                {
                    "bucket_key": bucket_key,
                    "side": "sell",
                    "executed_value_cny": round_or_none(sale_value, 2),
                    "reason": order["reason"],
                }
            )
            continue

        desired_buy = float(order["amount_cny"])
        affordable = min(desired_buy, cash_balance)
        if affordable <= MIN_TRADE_CNY:
            continue
        units[bucket_key] = units.get(bucket_key, 0.0) + (affordable / price)
        cash_balance -= affordable
        executed.append(
            {
                "bucket_key": bucket_key,
                "side": "buy",
                "executed_value_cny": round_or_none(affordable, 2),
                "reason": order["reason"],
            }
        )

    return cash_balance, executed


def schedule_next_day_orders(
    current_date: pd.Timestamp,
    next_date: pd.Timestamp | None,
    values: dict[str, float],
    weights: dict[str, float],
    total_nav: float,
    cash_balance: float,
    signals: dict[str, dict[str, Any]],
    specs: dict[str, dict[str, Any]],
    scale_config: dict[str, float],
    pending_orders: dict[pd.Timestamp, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    if next_date is None:
        return []

    orders: list[dict[str, Any]] = []
    exposure_plan: dict[str, dict[str, Any]] = {}

    for bucket_key, spec in specs.items():
        if spec["synthetic_cash"]:
            continue

        value = values.get(bucket_key, 0.0)
        weight = weights.get(bucket_key, 0.0)
        signal = signals[bucket_key]
        exposure_scale, scale_reason = derive_exposure_scale(signal, scale_config)
        exposure_plan[bucket_key] = {
            "scale": exposure_scale,
            "reason": scale_reason,
            "raw_target_value_cny": total_nav * (spec["max_pct"] / 100.0) * exposure_scale,
        }

        if value <= MIN_TRADE_CNY:
            if signal["falling_knife"]:
                continue
        if signal["falling_knife"] and value > MIN_TRADE_CNY:
            orders.append(
                {
                    "bucket_key": bucket_key,
                    "side": "sell",
                    "amount_cny": value,
                    "sell_all": True,
                    "reason": "signal_stop_falling_knife",
                    "decision_date": current_date.strftime("%Y-%m-%d"),
                }
            )
            continue

        if weight > spec["max_pct"]:
            target_value = total_nav * (spec["target_pct"] / 100.0)
            trim_amount = max(0.0, value - target_value)
            if trim_amount > MIN_TRADE_CNY:
                orders.append(
                    {
                        "bucket_key": bucket_key,
                        "side": "sell",
                        "amount_cny": trim_amount,
                        "sell_all": False,
                        "reason": "bucket_max_pct_trim",
                        "decision_date": current_date.strftime("%Y-%m-%d"),
                    }
                )

    blocked_buy_buckets = {item["bucket_key"] for item in orders if item["side"] == "sell"}
    reserved_cash = 0.0
    total_raw_target = sum(item["raw_target_value_cny"] for item in exposure_plan.values())
    target_scale_down = min(1.0, total_nav / total_raw_target) if total_raw_target > 0 else 1.0

    for bucket_key, spec in specs.items():
        if spec["synthetic_cash"] or bucket_key in blocked_buy_buckets:
            continue

        value = values.get(bucket_key, 0.0)
        plan = exposure_plan[bucket_key]
        desired_target_value = plan["raw_target_value_cny"] * target_scale_down
        if desired_target_value <= value + MIN_TRADE_CNY:
            continue
        gap_amount = max(0.0, desired_target_value - value)
        affordable = max(0.0, cash_balance - reserved_cash)
        buy_amount = min(gap_amount, affordable)
        if buy_amount <= MIN_TRADE_CNY:
            continue

        orders.append(
            {
                "bucket_key": bucket_key,
                "side": "buy",
                "amount_cny": buy_amount,
                "reason": f"tiered_scale_refill:{plan['reason']}",
                "decision_date": current_date.strftime("%Y-%m-%d"),
            }
        )
        reserved_cash += buy_amount

    if orders:
        pending_orders[next_date].extend(orders)
    return orders


def compute_cagr(nav_series: pd.Series) -> float | None:
    clean = nav_series.dropna()
    if len(clean) < 2 or clean.iloc[0] <= 0:
        return None

    days = (clean.index[-1] - clean.index[0]).days
    if days <= 0:
        return None

    years = days / 365.25
    return round_or_none(((clean.iloc[-1] / clean.iloc[0]) ** (1 / years) - 1) * 100, 2)


def compute_max_drawdown(nav_series: pd.Series) -> float | None:
    clean = nav_series.dropna()
    if clean.empty:
        return None
    rolling_peak = clean.cummax()
    drawdown = clean / rolling_peak - 1.0
    return round_or_none(drawdown.min() * 100, 2)


def summarize_portfolio(nav_series: pd.Series, cash_weight_series: pd.Series) -> dict[str, Any]:
    clean_nav = nav_series.dropna()
    return {
        "total_return_pct": round_or_none((clean_nav.iloc[-1] / clean_nav.iloc[0] - 1.0) * 100, 2),
        "cagr_pct": compute_cagr(clean_nav),
        "max_drawdown_pct": compute_max_drawdown(clean_nav),
        "avg_cash_position_pct": round_or_none(cash_weight_series.mean(), 2),
        "ending_nav_cny": round_or_none(clean_nav.iloc[-1], 2),
    }


def update_manifest(manifest_path: Path, summary_output: Path, equity_output: Path) -> None:
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path)
    canonical = manifest.get("canonical_entrypoints")
    if not isinstance(canonical, dict):
        return

    canonical["portfolio_backtest_script"] = str(Path(__file__).resolve())
    canonical["latest_portfolio_backtest_results"] = str(summary_output)
    canonical["latest_portfolio_backtest_equity"] = str(equity_output)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_backtest(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    runtime_paths = resolve_runtime_paths(args)
    asset_master = read_json(runtime_paths["asset_master_path"])
    initial_capital = float(args.initial_capital)
    backtest_cfg = asset_master.get("portfolio_backtest", {})
    lookback_days = int(
        args.lookback_days
        if args.lookback_days is not None
        else backtest_cfg.get("lookback_days", DEFAULT_LOOKBACK_DAYS)
    )
    warmup_days = int(
        args.warmup_days
        if args.warmup_days is not None
        else backtest_cfg.get("warmup_days", DEFAULT_WARMUP_DAYS)
    )
    annual_cash_yield_pct = float(backtest_cfg.get("annual_cash_yield_pct", DEFAULT_ANNUAL_CASH_YIELD_PCT))
    daily_cash_yield = annual_cash_yield_pct / 100.0 / 252.0
    valuation_window_days = int(
        backtest_cfg.get("valuation_percentile_window_days", DEFAULT_VALUATION_WINDOW_DAYS)
    )
    valuation_min_history_days = int(
        backtest_cfg.get("valuation_percentile_min_history_days", DEFAULT_VALUATION_MIN_HISTORY_DAYS)
    )
    scale_config = backtest_cfg.get("tiered_exposure_scale", {})
    bucket_specs = load_backtest_specs(asset_master, initial_capital)
    benchmark_bucket_weights = aggregate_benchmark_bucket_weights(asset_master)

    with sqlite3.connect(runtime_paths["db_path"]) as connection:
        aligned_prices, aligned_market_frames = build_aligned_price_frame(
            connection,
            bucket_specs,
            lookback_days,
            warmup_days,
            valuation_window_days,
        )

    indicator_frames = {
        bucket_key: compute_indicator_frame(
            aligned_market_frames[bucket_key],
            valuation_window_days=valuation_window_days,
            valuation_min_history_days=valuation_min_history_days,
        )
        for bucket_key, spec in bucket_specs.items()
        if not spec["synthetic_cash"]
    }

    evaluation_dates = list(aligned_prices.index[-lookback_days:])
    strategy_units = {
        bucket_key: 0.0
        for bucket_key, spec in bucket_specs.items()
        if not spec["synthetic_cash"]
    }
    strategy_cash = initial_capital
    pending_orders: dict[pd.Timestamp, list[dict[str, Any]]] = defaultdict(list)

    first_date = evaluation_dates[0]
    benchmark_units = {
        bucket_key: 0.0
        for bucket_key, spec in bucket_specs.items()
        if not spec["synthetic_cash"]
    }
    benchmark_cash = initial_capital * (benchmark_bucket_weights.get(CASH_BUCKET_KEY, 0.0) / 100.0)
    for bucket_key, spec in bucket_specs.items():
        if spec["synthetic_cash"]:
            continue
        allocation = initial_capital * (benchmark_bucket_weights.get(bucket_key, 0.0) / 100.0)
        if allocation <= 0:
            continue
        price = float(aligned_prices.loc[first_date, spec["symbol"]])
        benchmark_units[bucket_key] = allocation / price

    records: list[dict[str, Any]] = []
    trade_entry_count = 0
    trade_exit_count = 0

    for index, current_date in enumerate(evaluation_dates):
        next_date = evaluation_dates[index + 1] if index + 1 < len(evaluation_dates) else None
        if index > 0:
            strategy_cash = apply_daily_cash_yield(strategy_cash, daily_cash_yield)
            benchmark_cash = apply_daily_cash_yield(benchmark_cash, daily_cash_yield)

        strategy_cash, executed_orders = execute_orders_for_date(
            date=current_date,
            prices=aligned_prices,
            pending_orders=pending_orders,
            units=strategy_units,
            cash_balance=strategy_cash,
            specs=bucket_specs,
        )
        trade_entry_count += sum(1 for item in executed_orders if item["side"] == "buy")
        trade_exit_count += sum(1 for item in executed_orders if item["side"] == "sell")

        strategy_values = compute_bucket_values(
            date=current_date,
            prices=aligned_prices,
            units=strategy_units,
            cash_balance=strategy_cash,
            specs=bucket_specs,
        )
        strategy_nav = sum(strategy_values.values())
        strategy_weights = compute_weights(strategy_values, strategy_nav)

        benchmark_values = compute_bucket_values(
            date=current_date,
            prices=aligned_prices,
            units=benchmark_units,
            cash_balance=benchmark_cash,
            specs=bucket_specs,
        )
        benchmark_nav = sum(benchmark_values.values())
        benchmark_weights = compute_weights(benchmark_values, benchmark_nav)

        signals = {
            bucket_key: build_signal_snapshot(indicator_frames[bucket_key].loc[current_date])
            for bucket_key in indicator_frames
        }

        scheduled_orders = schedule_next_day_orders(
            current_date=current_date,
            next_date=next_date,
            values=strategy_values,
            weights=strategy_weights,
            total_nav=strategy_nav,
            cash_balance=strategy_cash,
            signals=signals,
            specs=bucket_specs,
            scale_config=scale_config,
            pending_orders=pending_orders,
        )

        records.append(
            {
                "date": current_date.strftime("%Y-%m-%d"),
                "strategy_nav_cny": round_or_none(strategy_nav, 2),
                "benchmark_nav_cny": round_or_none(benchmark_nav, 2),
                "strategy_cash_position_pct": round_or_none(strategy_weights.get(CASH_BUCKET_KEY, 0.0), 2),
                "benchmark_cash_position_pct": round_or_none(benchmark_weights.get(CASH_BUCKET_KEY, 0.0), 2),
                "executed_orders": executed_orders,
                "scheduled_orders": scheduled_orders,
                "strategy_bucket_weights_pct": {
                    bucket_key: round_or_none(strategy_weights.get(bucket_key, 0.0), 2)
                    for bucket_key in bucket_specs
                },
                "benchmark_bucket_weights_pct": {
                    bucket_key: round_or_none(benchmark_weights.get(bucket_key, 0.0), 2)
                    for bucket_key in bucket_specs
                },
            }
        )

    equity_df = pd.DataFrame(records)
    equity_df["date"] = pd.to_datetime(equity_df["date"])
    equity_df = equity_df.set_index("date")

    strategy_summary = summarize_portfolio(
        equity_df["strategy_nav_cny"],
        equity_df["strategy_cash_position_pct"],
    )
    benchmark_summary = summarize_portfolio(
        equity_df["benchmark_nav_cny"],
        equity_df["benchmark_cash_position_pct"],
    )

    summary = {
        "generated_at": format_now(),
        "source": {
            "asset_master": str(runtime_paths["asset_master_path"]),
            "market_lake_db": str(runtime_paths["db_path"]),
        },
        "config": {
            "initial_capital_cny": initial_capital,
            "lookback_days": lookback_days,
            "warmup_days": warmup_days,
            "execution_model": backtest_cfg.get("execution_model", "signal_on_close_execute_next_day_close"),
            "annual_cash_yield_pct": annual_cash_yield_pct,
            "adx_threshold": ADX_TREND_THRESHOLD,
            "rsi_bottom_threshold": RSI_BOTTOM_THRESHOLD,
            "valuation_percentile_window_days": valuation_window_days,
            "tiered_exposure_scale": scale_config,
            "note": "Data Lake V2 provides native OHLC series. Orders are still matched at next-trading-day close as a conservative close-to-close proxy.",
        },
        "representatives": bucket_specs,
        "period": {
            "start_date": equity_df.index[0].strftime("%Y-%m-%d"),
            "end_date": equity_df.index[-1].strftime("%Y-%m-%d"),
            "evaluation_days": int(len(equity_df)),
        },
        "benchmark_static": benchmark_summary,
        "dynamic_portfolio_v30_phase3": {
            **strategy_summary,
            "trade_entries": trade_entry_count,
            "trade_exits": trade_exit_count,
        },
        "delta": {
            "total_return_pct": round_or_none(
                (strategy_summary["total_return_pct"] or 0) - (benchmark_summary["total_return_pct"] or 0),
                2,
            ),
            "cagr_pct": round_or_none(
                (strategy_summary["cagr_pct"] or 0) - (benchmark_summary["cagr_pct"] or 0),
                2,
            ),
            "max_drawdown_pct": round_or_none(
                (strategy_summary["max_drawdown_pct"] or 0) - (benchmark_summary["max_drawdown_pct"] or 0),
                2,
            ),
            "avg_cash_position_pct": round_or_none(
                (strategy_summary["avg_cash_position_pct"] or 0)
                - (benchmark_summary["avg_cash_position_pct"] or 0),
                2,
            ),
        },
    }

    equity_payload = {
        "generated_at": summary["generated_at"],
        "summary": summary,
        "equity_curve": [
            {
                "date": record["date"],
                "strategy_nav_cny": record["strategy_nav_cny"],
                "benchmark_nav_cny": record["benchmark_nav_cny"],
                "strategy_cash_position_pct": record["strategy_cash_position_pct"],
                "benchmark_cash_position_pct": record["benchmark_cash_position_pct"],
            }
            for record in records
        ],
    }

    summary["runtime_paths"] = {
        "portfolio_root": str(runtime_paths["portfolio_root"]),
        "manifest_path": str(runtime_paths["manifest_path"]),
        "summary_output": str(runtime_paths["summary_output_path"]),
        "equity_output": str(runtime_paths["equity_output_path"]),
    }

    return summary, equity_payload


def main() -> None:
    args = parse_args()
    summary, equity_payload = run_backtest(args)

    runtime_paths = resolve_runtime_paths(args)
    summary_output = runtime_paths["summary_output_path"]
    equity_output = runtime_paths["equity_output_path"]
    summary_output.parent.mkdir(parents=True, exist_ok=True)
    equity_output.parent.mkdir(parents=True, exist_ok=True)

    summary_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    equity_output.write_text(json.dumps(equity_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_manifest(runtime_paths["manifest_path"], summary_output, equity_output)

    benchmark = summary["benchmark_static"]
    dynamic = summary["dynamic_portfolio_v30_phase3"]

    print("=== 组合级基准 vs V3.0-Phase3 动态组合 ===")
    print(
        f"Window: {summary['period']['start_date']} -> {summary['period']['end_date']} "
        f"({summary['period']['evaluation_days']} trading days)"
    )
    print(
        "Benchmark | "
        f"Total Return: {benchmark['total_return_pct']}% | "
        f"CAGR: {benchmark['cagr_pct']}% | "
        f"Max Drawdown: {benchmark['max_drawdown_pct']}% | "
        f"Avg Cash Position: {benchmark['avg_cash_position_pct']}%"
    )
    print(
        "V3.0-Phase3 Dynamic | "
        f"Total Return: {dynamic['total_return_pct']}% | "
        f"CAGR: {dynamic['cagr_pct']}% | "
        f"Max Drawdown: {dynamic['max_drawdown_pct']}% | "
        f"Avg Cash Position: {dynamic['avg_cash_position_pct']}% | "
        f"Entries: {dynamic['trade_entries']} | "
        f"Exits: {dynamic['trade_exits']}"
    )
    print(
        "Delta | "
        f"Return: {summary['delta']['total_return_pct']}pct | "
        f"CAGR: {summary['delta']['cagr_pct']}pct | "
        f"Max Drawdown: {summary['delta']['max_drawdown_pct']}pct | "
        f"Avg Cash Position: {summary['delta']['avg_cash_position_pct']}pct"
    )
    print(f"Saved Summary: {summary_output}")
    print(f"Saved Equity: {equity_output}")


if __name__ == "__main__":
    main()
