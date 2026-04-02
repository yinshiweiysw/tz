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

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = DEFAULT_PORTFOLIO_ROOT
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_SYMBOL = "KWEB"
DEFAULT_LOOKBACK_DAYS = 1250
DEFAULT_WARMUP_DAYS = 120
DEFAULT_SMA_WINDOW = 20
DEFAULT_RSI_WINDOW = 14
DEFAULT_ADX_WINDOW = 14
DEFAULT_MACD_FAST = 12
DEFAULT_MACD_SLOW = 26
DEFAULT_MACD_SIGNAL = 9
ADX_TREND_THRESHOLD = 25
RSI_LEFT_SIDE_THRESHOLD = 30


def ensure_runtime() -> None:
    if os.environ.get("BACKTEST_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent

    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            import ta  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["BACKTEST_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd  # noqa: E402
from ta.momentum import RSIIndicator  # noqa: E402
from ta.trend import ADXIndicator, MACD  # noqa: E402
from ta.volatility import AverageTrueRange  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local-only historical backtest against market_lake.db."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--warmup-days", type=int, default=DEFAULT_WARMUP_DAYS)
    parser.add_argument("--sma-window", type=int, default=DEFAULT_SMA_WINDOW)
    parser.add_argument("--rsi-window", type=int, default=DEFAULT_RSI_WINDOW)
    parser.add_argument("--adx-window", type=int, default=DEFAULT_ADX_WINDOW)
    parser.add_argument("--macd-fast", type=int, default=DEFAULT_MACD_FAST)
    parser.add_argument("--macd-slow", type=int, default=DEFAULT_MACD_SLOW)
    parser.add_argument("--macd-signal", type=int, default=DEFAULT_MACD_SIGNAL)
    parser.add_argument("--output", default="")
    return parser.parse_args()


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


def resolve_runtime_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    portfolio_root = resolve_portfolio_root(
        user=args.user or None,
        portfolio_root=args.portfolio_root or None,
    )
    manifest_path = portfolio_root / "state-manifest.json"
    canonical = {}
    if manifest_path.exists():
        try:
            canonical = json.loads(manifest_path.read_text(encoding="utf-8")).get(
                "canonical_entrypoints", {}
            )
        except Exception:
            canonical = {}

    db_path = (
        Path(args.db).expanduser()
        if args.db
        else Path(str(canonical.get("market_lake_db", portfolio_root / "data" / "market_lake.db"))).expanduser()
    )
    output_path = (
        Path(args.output).expanduser()
        if args.output
        else portfolio_root / "data" / "backtest_results.json"
    )
    return db_path, output_path


def load_price_history(symbol: str, rows_needed: int, db_path: Path) -> pd.DataFrame:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    query = """
        SELECT date, open, high, low, close, adj_close
        FROM daily_prices
        WHERE symbol = ?
          AND close IS NOT NULL
          AND high IS NOT NULL
          AND low IS NOT NULL
        ORDER BY date DESC
        LIMIT ?
    """

    with sqlite3.connect(db_path) as connection:
        history = pd.read_sql_query(query, connection, params=[symbol, rows_needed])

    if history.empty:
        raise ValueError(f"No local price history found for symbol={symbol}")

    history["date"] = pd.to_datetime(history["date"], errors="coerce")
    for column in ["open", "high", "low", "close", "adj_close"]:
        history[column] = pd.to_numeric(history[column], errors="coerce")
    history["adj_close"] = history["adj_close"].fillna(history["close"])
    history = (
        history.dropna(subset=["date", "open", "high", "low", "close"])
        .sort_values("date")
        .drop_duplicates(subset=["date"], keep="last")
        .set_index("date")
    )

    return history


def prepare_indicator_frame(
    price_df: pd.DataFrame,
    sma_window: int,
    rsi_window: int,
    adx_window: int,
    macd_fast: int,
    macd_slow: int,
    macd_signal: int,
) -> pd.DataFrame:
    working = price_df.copy()
    for column in ["open", "high", "low", "close", "adj_close"]:
        working[column] = working[column].astype(float)

    working["SMA_20"] = working["close"].rolling(window=sma_window, min_periods=sma_window).mean()
    working["RSI_14"] = RSIIndicator(
        close=working["close"],
        window=rsi_window,
        fillna=False,
    ).rsi()
    atr_indicator = AverageTrueRange(
        high=working["high"],
        low=working["low"],
        close=working["close"],
        window=adx_window,
        fillna=False,
    )

    adx_indicator = ADXIndicator(
        high=working["high"],
        low=working["low"],
        close=working["close"],
        window=adx_window,
        fillna=False,
    )
    macd_indicator = MACD(
        close=working["close"],
        window_fast=macd_fast,
        window_slow=macd_slow,
        window_sign=macd_signal,
        fillna=False,
    )

    working["ATR_14"] = atr_indicator.average_true_range()
    working["PLUS_DI_14"] = adx_indicator.adx_pos()
    working["MINUS_DI_14"] = adx_indicator.adx_neg()
    working["ADX_14"] = adx_indicator.adx()
    working["MACD_LINE"] = macd_indicator.macd()
    working["MACD_SIGNAL"] = macd_indicator.macd_signal()
    working["MACD_HIST"] = macd_indicator.macd_diff()
    working["PREV_MACD_HIST"] = working["MACD_HIST"].shift(1)
    working["HIST_INCREASING"] = working["MACD_HIST"] > working["PREV_MACD_HIST"]
    return working


def build_stateful_signals(frame: pd.DataFrame) -> pd.DataFrame:
    working = frame.copy()

    trend_long = (working["close"] > working["SMA_20"]) & (working["ADX_14"] > ADX_TREND_THRESHOLD)
    left_side_long = (working["RSI_14"] < RSI_LEFT_SIDE_THRESHOLD) & (
        (working["MACD_HIST"] >= 0)
        | ((working["MACD_HIST"] < 0) & (working["HIST_INCREASING"] == True))
    )
    falling_knife_exit = (
        (working["close"] < working["SMA_20"])
        & (working["MACD_HIST"] < 0)
        & (working["HIST_INCREASING"] == False)
    )
    choppy_filter = (working["ADX_14"] < ADX_TREND_THRESHOLD) & (~left_side_long.fillna(False))

    position_signal: list[int] = []
    signal_reason: list[str] = []
    previous_position = 0

    for index in working.index:
        if bool(falling_knife_exit.loc[index]):
            current_position = 0
            reason = "exit_falling_knife"
        elif bool(trend_long.loc[index]):
            current_position = 1
            reason = "long_trend_confirmation"
        elif bool(left_side_long.loc[index]):
            current_position = 1
            reason = "long_bottom_divergence"
        elif bool(choppy_filter.loc[index]):
            current_position = previous_position
            reason = "hold_choppy_filter"
        else:
            current_position = previous_position
            reason = "hold_previous_state"

        position_signal.append(current_position)
        signal_reason.append(reason)
        previous_position = current_position

    working["trend_long"] = trend_long.fillna(False)
    working["left_side_long"] = left_side_long.fillna(False)
    working["falling_knife_exit"] = falling_knife_exit.fillna(False)
    working["choppy_filter"] = choppy_filter.fillna(False)
    working["signal"] = pd.Series(position_signal, index=working.index, dtype=float)
    working["signal_reason"] = signal_reason
    return working


def compute_max_drawdown(equity_curve: pd.Series) -> float | None:
    clean = equity_curve.dropna()
    if clean.empty:
        return None
    rolling_peak = clean.cummax()
    drawdown = clean / rolling_peak - 1.0
    return round_or_none(drawdown.min() * 100, 2)


def summarize_strategy(frame: pd.DataFrame, column_prefix: str) -> dict[str, Any]:
    daily_return_col = f"{column_prefix}_daily_return"
    equity_col = f"{column_prefix}_equity"

    equity_curve = frame[equity_col].dropna()
    if equity_curve.empty:
        raise ValueError(f"No equity curve built for prefix={column_prefix}")

    cumulative_return_pct = round_or_none((equity_curve.iloc[-1] - 1.0) * 100, 2)
    max_drawdown_pct = compute_max_drawdown(equity_curve)

    return {
      "cumulative_return_pct": cumulative_return_pct,
      "max_drawdown_pct": max_drawdown_pct,
      "ending_equity": round_or_none(equity_curve.iloc[-1], 4),
      "daily_return_mean_pct": round_or_none(frame[daily_return_col].mean() * 100, 4),
      "daily_return_vol_pct": round_or_none(frame[daily_return_col].std() * 100, 4),
    }


def build_backtest_frame(frame: pd.DataFrame) -> pd.DataFrame:
    working = frame.copy()
    working["daily_return"] = working["close"].pct_change()
    working["position"] = working["signal"].shift(1).fillna(0.0)
    # T 日收盘信号在 T+1 日收盘执行，真正承担 T+1 -> T+2 收益的是前一日已建立的仓位。
    working["strategy_exposure"] = working["position"].shift(1).fillna(0.0)
    working["buy_hold_daily_return"] = working["daily_return"].fillna(0.0)
    working["strategy_daily_return"] = (
        working["strategy_exposure"] * working["daily_return"].fillna(0.0)
    )
    working["buy_hold_equity"] = (1.0 + working["buy_hold_daily_return"]).cumprod()
    working["strategy_equity"] = (1.0 + working["strategy_daily_return"]).cumprod()
    return working


def run_backtest(args: argparse.Namespace) -> dict[str, Any]:
    db_path, output_path = resolve_runtime_paths(args)
    rows_to_load = args.lookback_days + args.warmup_days
    raw_history = load_price_history(args.symbol, rows_to_load, db_path)
    if len(raw_history) < args.lookback_days:
        raise ValueError(
            f"Insufficient history for {args.symbol}: need >= {args.lookback_days}, got {len(raw_history)}"
        )

    indicator_frame = prepare_indicator_frame(
        price_df=raw_history,
        sma_window=args.sma_window,
        rsi_window=args.rsi_window,
        adx_window=args.adx_window,
        macd_fast=args.macd_fast,
        macd_slow=args.macd_slow,
        macd_signal=args.macd_signal,
    )
    signal_frame = build_stateful_signals(indicator_frame)
    backtest_frame = build_backtest_frame(signal_frame)
    evaluation_frame = backtest_frame.tail(args.lookback_days).copy()

    buy_hold_summary = summarize_strategy(evaluation_frame, "buy_hold")
    strategy_summary = summarize_strategy(evaluation_frame, "strategy")

    trade_entries = int((evaluation_frame["position"].diff().fillna(evaluation_frame["position"]) > 0).sum())
    trade_exits = int((evaluation_frame["position"].diff().fillna(0) < 0).sum())
    exposure_pct = round_or_none(evaluation_frame["strategy_exposure"].mean() * 100, 2)

    latest_row = evaluation_frame.iloc[-1]
    result = {
        "generated_at": format_now(),
        "source": {
            "type": "Local SQLite market_lake daily_prices",
            "db_path": str(db_path),
            "symbol": args.symbol,
        },
        "config": {
            "lookback_days": args.lookback_days,
            "warmup_days": args.warmup_days,
            "sma_window": args.sma_window,
            "rsi_window": args.rsi_window,
            "adx_window": args.adx_window,
            "macd_fast": args.macd_fast,
            "macd_slow": args.macd_slow,
            "macd_signal": args.macd_signal,
            "adx_threshold": ADX_TREND_THRESHOLD,
            "rsi_left_side_threshold": RSI_LEFT_SIDE_THRESHOLD,
            "signal_execution_rule": "signal_t_close__position_t1_close__pnl_from_t2_daily_return",
        },
        "period": {
            "loaded_rows": int(len(raw_history)),
            "evaluation_rows": int(len(evaluation_frame)),
            "start_date": evaluation_frame.index[0].strftime("%Y-%m-%d"),
            "end_date": evaluation_frame.index[-1].strftime("%Y-%m-%d"),
        },
        "buy_and_hold": buy_hold_summary,
        "strategy_v20": {
            **strategy_summary,
            "exposure_pct": exposure_pct,
            "trade_entries": trade_entries,
            "trade_exits": trade_exits,
            "final_signal": int(latest_row["signal"]),
            "final_position": int(latest_row["position"]),
            "final_strategy_exposure": int(latest_row["strategy_exposure"]),
            "final_signal_reason": latest_row["signal_reason"],
        },
        "improvement": {
            "cumulative_return_delta_pct": round_or_none(
                (strategy_summary["cumulative_return_pct"] or 0)
                - (buy_hold_summary["cumulative_return_pct"] or 0),
                2,
            ),
            "max_drawdown_delta_pct": round_or_none(
                (strategy_summary["max_drawdown_pct"] or 0)
                - (buy_hold_summary["max_drawdown_pct"] or 0),
                2,
            ),
        },
        "latest_snapshot": {
            "date": evaluation_frame.index[-1].strftime("%Y-%m-%d"),
            "open": round_or_none(latest_row["open"], 4),
            "high": round_or_none(latest_row["high"], 4),
            "low": round_or_none(latest_row["low"], 4),
            "close": round_or_none(latest_row["close"], 4),
            "adj_close": round_or_none(latest_row["adj_close"], 4),
            "sma_20": round_or_none(latest_row["SMA_20"], 4),
            "rsi_14": round_or_none(latest_row["RSI_14"], 2),
            "atr_14": round_or_none(latest_row["ATR_14"], 4),
            "adx_14": round_or_none(latest_row["ADX_14"], 2),
            "macd_hist": round_or_none(latest_row["MACD_HIST"], 4),
            "hist_increasing": bool(latest_row["HIST_INCREASING"]) if pd.notna(latest_row["HIST_INCREASING"]) else None,
            "signal": int(latest_row["signal"]),
            "position": int(latest_row["position"]),
            "strategy_exposure": int(latest_row["strategy_exposure"]),
            "signal_reason": latest_row["signal_reason"],
        },
    }
    result["output_path"] = str(output_path)
    return result


def main() -> None:
    args = parse_args()
    result = run_backtest(args)
    output_path = Path(result["output_path"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("=== Buy & Hold vs V2.0 策略 ===")
    print(f"Symbol: {result['source']['symbol']}")
    print(
        f"Window: {result['period']['start_date']} -> {result['period']['end_date']} "
        f"({result['period']['evaluation_rows']} trading days)"
    )
    print(
        "Buy & Hold | "
        f"Cumulative Return: {result['buy_and_hold']['cumulative_return_pct']}% | "
        f"Max Drawdown: {result['buy_and_hold']['max_drawdown_pct']}%"
    )
    print(
        "V2.0 Strategy | "
        f"Cumulative Return: {result['strategy_v20']['cumulative_return_pct']}% | "
        f"Max Drawdown: {result['strategy_v20']['max_drawdown_pct']}% | "
        f"Exposure: {result['strategy_v20']['exposure_pct']}% | "
        f"Entries: {result['strategy_v20']['trade_entries']}"
    )
    print(
        "Delta | "
        f"Return: {result['improvement']['cumulative_return_delta_pct']}pct | "
        f"Max Drawdown: {result['improvement']['max_drawdown_delta_pct']}pct"
    )
    print(f"Saved JSON: {output_path}")


if __name__ == "__main__":
    main()
