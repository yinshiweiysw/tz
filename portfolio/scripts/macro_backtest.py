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

from account_root import resolve_account_id, resolve_portfolio_root  # noqa: E402


PORTFOLIO_ROOT = resolve_portfolio_root()
DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
DEFAULT_REPORT_PATH = PORTFOLIO_ROOT / "reports" / "backtest_10yr_result.png"
DEFAULT_SUMMARY_PATH = PORTFOLIO_ROOT / "data" / "macro_backtest_results.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_CN_SYMBOL = "007339"
DEFAULT_US_SYMBOL = "513100"
DEFAULT_BENCHMARK_SYMBOL = DEFAULT_CN_SYMBOL
DEFAULT_LOOKBACK_YEARS = 10
DEFAULT_CASH_YIELD_PCT = 2.0
DEFAULT_HIGH_ERP_THRESHOLD_PCT = 5.5
DEFAULT_LOW_ERP_THRESHOLD_PCT = 3.5
DEFAULT_PROXY_WINDOW_DAYS = 756
DEFAULT_PROXY_MIN_HISTORY_DAYS = 252

HIGH_ERP_WEIGHTS = {"cash": 0.10, "cn": 0.60, "us": 0.30}
LOW_ERP_WEIGHTS = {"cash": 0.40, "cn": 0.30, "us": 0.30}
NEUTRAL_WEIGHTS = {"cash": 0.20, "cn": 0.50, "us": 0.30}


def ensure_runtime() -> None:
    if os.environ.get("MACRO_BACKTEST_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["MACRO_BACKTEST_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a vectorized macro cash-gating backtest on local market_lake.db data."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--cn-symbol", default=DEFAULT_CN_SYMBOL)
    parser.add_argument("--us-symbol", default=DEFAULT_US_SYMBOL)
    parser.add_argument("--benchmark-symbol", default=DEFAULT_BENCHMARK_SYMBOL)
    parser.add_argument("--years", type=int, default=DEFAULT_LOOKBACK_YEARS)
    parser.add_argument("--cash-yield-pct", type=float, default=DEFAULT_CASH_YIELD_PCT)
    parser.add_argument("--high-erp-threshold-pct", type=float, default=DEFAULT_HIGH_ERP_THRESHOLD_PCT)
    parser.add_argument("--low-erp-threshold-pct", type=float, default=DEFAULT_LOW_ERP_THRESHOLD_PCT)
    parser.add_argument("--proxy-window-days", type=int, default=DEFAULT_PROXY_WINDOW_DAYS)
    parser.add_argument("--proxy-min-history-days", type=int, default=DEFAULT_PROXY_MIN_HISTORY_DAYS)
    parser.add_argument("--report-path", default="")
    parser.add_argument("--summary-output", default="")
    parser.add_argument(
        "--force-proxy-factor",
        action="store_true",
        help="Ignore any historical ERP table and use the rolling price-percentile proxy instead.",
    )
    parser.add_argument(
        "--skip-plot",
        action="store_true",
        help="Skip matplotlib rendering. Useful when the runtime lacks matplotlib.",
    )
    return parser.parse_args()


def read_sql_series(connection: sqlite3.Connection, symbol: str) -> pd.DataFrame:
    query = """
        SELECT date, close, adj_close, name, provider, asset_type
        FROM daily_prices
        WHERE symbol = ?
          AND close IS NOT NULL
        ORDER BY date ASC
    """
    frame = pd.read_sql_query(query, connection, params=[symbol])
    if frame.empty:
        raise ValueError(f"symbol={symbol} has no history in daily_prices")

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    frame["adj_close"] = pd.to_numeric(frame["adj_close"], errors="coerce")
    frame["adj_close"] = frame["adj_close"].fillna(frame["close"])
    frame = (
        frame.dropna(subset=["date", "adj_close"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .set_index("date")
    )
    if frame.empty:
        raise ValueError(f"symbol={symbol} is empty after cleaning")
    return frame


def table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    query = "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1"
    row = connection.execute(query, [table_name]).fetchone()
    return row is not None


def table_columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table_name})")}


def load_historical_erp_series(connection: sqlite3.Connection) -> tuple[pd.Series | None, str, str | None]:
    candidates = [
        ("macro_factors_daily", "date", ["hs300_erp_pct", "erp_pct", "hs300_erp", "hs300_erp_decimal"]),
        ("macro_factor_history", "date", ["hs300_erp_pct", "erp_pct", "hs300_erp", "hs300_erp_decimal"]),
        ("erp_history", "date", ["hs300_erp_pct", "erp_pct", "hs300_erp", "hs300_erp_decimal"]),
    ]

    for table_name, date_column, value_candidates in candidates:
        if not table_exists(connection, table_name):
            continue
        columns = table_columns(connection, table_name)
        if date_column not in columns:
            continue
        value_column = next((item for item in value_candidates if item in columns), None)
        if value_column is None:
            continue

        query = f"""
            SELECT {date_column} AS date, {value_column} AS erp_value
            FROM {table_name}
            WHERE {value_column} IS NOT NULL
            ORDER BY {date_column} ASC
        """
        frame = pd.read_sql_query(query, connection)
        if frame.empty:
            continue

        frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
        frame["erp_value"] = pd.to_numeric(frame["erp_value"], errors="coerce")
        frame = frame.dropna(subset=["date", "erp_value"]).drop_duplicates(subset=["date"], keep="last")
        if frame.empty:
            continue

        series = frame.set_index("date")["erp_value"].sort_index()
        if value_column.endswith("_decimal"):
            series = series * 100.0
        return series.rename("erp_pct"), f"{table_name}.{value_column}", None

    return None, "fallback_proxy", "market_lake.db 缺少历史 ERP 表，自动降级为价格代理因子。"


def build_proxy_erp_series(
    cn_price: pd.Series,
    *,
    window_days: int,
    min_history_days: int,
) -> pd.Series:
    rolling_low = cn_price.rolling(window=window_days, min_periods=min_history_days).min()
    rolling_high = cn_price.rolling(window=window_days, min_periods=min_history_days).max()
    span = rolling_high - rolling_low
    raw_percentile = (cn_price - rolling_low) / span
    clipped_percentile = raw_percentile.clip(lower=0.0, upper=1.0)
    proxy_erp_pct = (7.0 - 4.0 * clipped_percentile).where(span > 0, 5.0)
    return proxy_erp_pct.rename("erp_pct")


def build_weight_frame(
    factor_signal_pct: pd.Series,
    *,
    high_threshold_pct: float,
    low_threshold_pct: float,
) -> pd.DataFrame:
    index = factor_signal_pct.index
    high_regime = factor_signal_pct > high_threshold_pct
    low_regime = factor_signal_pct < low_threshold_pct

    cash_weight = pd.Series(NEUTRAL_WEIGHTS["cash"], index=index)
    cn_weight = pd.Series(NEUTRAL_WEIGHTS["cn"], index=index)
    us_weight = pd.Series(NEUTRAL_WEIGHTS["us"], index=index)

    cash_weight = cash_weight.where(~high_regime, HIGH_ERP_WEIGHTS["cash"])
    cn_weight = cn_weight.where(~high_regime, HIGH_ERP_WEIGHTS["cn"])
    us_weight = us_weight.where(~high_regime, HIGH_ERP_WEIGHTS["us"])

    cash_weight = cash_weight.where(~low_regime, LOW_ERP_WEIGHTS["cash"])
    cn_weight = cn_weight.where(~low_regime, LOW_ERP_WEIGHTS["cn"])
    us_weight = us_weight.where(~low_regime, LOW_ERP_WEIGHTS["us"])

    regime = pd.Series("neutral", index=index)
    regime = regime.where(~high_regime, "high_erp")
    regime = regime.where(~low_regime, "low_erp")

    weights = pd.DataFrame(
        {
            "cash_weight": cash_weight,
            "cn_weight": cn_weight,
            "us_weight": us_weight,
            "regime": regime,
        },
        index=index,
    )
    return weights


def compute_cagr(nav_series: pd.Series) -> float | None:
    clean = nav_series.dropna()
    if len(clean) < 2:
        return None
    days = (clean.index[-1] - clean.index[0]).days
    if days <= 0:
        return None
    years = days / 365.25
    return (clean.iloc[-1] / clean.iloc[0]) ** (1.0 / years) - 1.0


def compute_max_drawdown(nav_series: pd.Series) -> float | None:
    clean = nav_series.dropna()
    if clean.empty:
        return None
    rolling_peak = clean.cummax()
    drawdown = clean / rolling_peak - 1.0
    return float(drawdown.min())


def compute_sharpe_ratio(daily_return: pd.Series, daily_risk_free: float) -> float | None:
    clean = daily_return.dropna()
    if clean.empty:
        return None
    excess = clean - daily_risk_free
    volatility = float(excess.std())
    if not math.isfinite(volatility) or math.isclose(volatility, 0.0, abs_tol=1e-12):
        return None
    return float((excess.mean() / volatility) * math.sqrt(252.0))


def round_or_none(value: Any, digits: int = 4) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if not math.isfinite(numeric):
        return None
    return round(numeric, digits)


def format_pct(value: float | None) -> str:
    if value is None:
        return "--"
    return f"{value * 100.0:.2f}%"


def format_ratio(value: float | None) -> str:
    if value is None:
        return "--"
    return f"{value:.2f}"


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def render_plot(backtest_frame: pd.DataFrame, report_path: Path, title: str) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as exc:
        raise RuntimeError(
            "matplotlib is required for plotting. Install it into the active runtime or rerun with --skip-plot."
        ) from exc

    report_path.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(
        backtest_frame.index,
        backtest_frame["strategy_nav"],
        label="Macro ERP Strategy",
        linewidth=2.2,
        color="#0f766e",
    )
    ax.plot(
        backtest_frame.index,
        backtest_frame["benchmark_nav"],
        label="Benchmark: CN Full Allocation",
        linewidth=1.8,
        color="#b45309",
        alpha=0.9,
    )
    ax.set_title(title)
    ax.set_ylabel("Cumulative NAV")
    ax.grid(alpha=0.25, linestyle="--")
    ax.legend()
    fig.tight_layout()
    fig.savefig(report_path, dpi=160, bbox_inches="tight")
    plt.close(fig)


def summarize_result(
    backtest_frame: pd.DataFrame,
    *,
    daily_cash_yield: float,
    factor_source: str,
    factor_note: str | None,
    requested_years: int,
    high_erp_threshold_pct: float,
    low_erp_threshold_pct: float,
    cn_symbol: str,
    us_symbol: str,
    benchmark_symbol: str,
) -> dict[str, Any]:
    strategy_nav = backtest_frame["strategy_nav"]
    benchmark_nav = backtest_frame["benchmark_nav"]
    strategy_daily_return = backtest_frame["strategy_return"]
    benchmark_daily_return = backtest_frame["benchmark_return"]

    actual_years = (strategy_nav.index[-1] - strategy_nav.index[0]).days / 365.25 if len(strategy_nav) >= 2 else 0.0
    regime_counts = backtest_frame["regime"].value_counts(dropna=False).to_dict()

    return {
        "generated_at": format_now(),
        "source": {
            "db": str(DB_PATH),
            "cn_symbol": cn_symbol,
            "us_symbol": us_symbol,
            "benchmark_symbol": benchmark_symbol,
            "factor_source": factor_source,
            "factor_note": factor_note,
        },
        "config": {
            "requested_lookback_years": requested_years,
            "cash_yield_pct": round_or_none(daily_cash_yield * 252.0 * 100.0, 4),
            "high_erp_threshold_pct": round_or_none(high_erp_threshold_pct, 4),
            "low_erp_threshold_pct": round_or_none(low_erp_threshold_pct, 4),
            "high_erp_weights": HIGH_ERP_WEIGHTS,
            "neutral_weights": NEUTRAL_WEIGHTS,
            "low_erp_weights": LOW_ERP_WEIGHTS,
            "signal_execution_rule": "factor_t_close_shift_1__weights_t__capture_return_t",
        },
        "period": {
            "start_date": strategy_nav.index[0].strftime("%Y-%m-%d"),
            "end_date": strategy_nav.index[-1].strftime("%Y-%m-%d"),
            "trading_days": int(len(backtest_frame)),
            "actual_years": round_or_none(actual_years, 4),
        },
        "strategy": {
            "total_return_pct": round_or_none((strategy_nav.iloc[-1] / strategy_nav.iloc[0] - 1.0) * 100.0, 4),
            "cagr_pct": round_or_none((compute_cagr(strategy_nav) or 0.0) * 100.0, 4),
            "max_drawdown_pct": round_or_none((compute_max_drawdown(strategy_nav) or 0.0) * 100.0, 4),
            "sharpe_ratio": round_or_none(compute_sharpe_ratio(strategy_daily_return, daily_cash_yield), 4),
            "ending_nav": round_or_none(strategy_nav.iloc[-1], 6),
            "average_cash_weight_pct": round_or_none(backtest_frame["cash_weight"].mean() * 100.0, 4),
        },
        "benchmark": {
            "total_return_pct": round_or_none((benchmark_nav.iloc[-1] / benchmark_nav.iloc[0] - 1.0) * 100.0, 4),
            "cagr_pct": round_or_none((compute_cagr(benchmark_nav) or 0.0) * 100.0, 4),
            "max_drawdown_pct": round_or_none((compute_max_drawdown(benchmark_nav) or 0.0) * 100.0, 4),
            "sharpe_ratio": round_or_none(compute_sharpe_ratio(benchmark_daily_return, daily_cash_yield), 4),
            "ending_nav": round_or_none(benchmark_nav.iloc[-1], 6),
        },
        "regime_day_count": {str(key): int(value) for key, value in regime_counts.items()},
    }


def run_backtest(args: argparse.Namespace) -> tuple[dict[str, Any], pd.DataFrame]:
    db_path = Path(args.db).expanduser().resolve() if args.db else DB_PATH
    with sqlite3.connect(db_path) as connection:
        cn_frame = read_sql_series(connection, args.cn_symbol)
        us_frame = read_sql_series(connection, args.us_symbol)
        benchmark_frame = read_sql_series(connection, args.benchmark_symbol)

        if args.force_proxy_factor:
            erp_series = None
            factor_source = "forced_proxy"
            factor_note = "用户指定 --force-proxy-factor，使用价格代理 ERP。"
        else:
            erp_series, factor_source, factor_note = load_historical_erp_series(connection)

    cn_close = cn_frame["adj_close"].rename("cn_close")
    us_close = us_frame["adj_close"].rename("us_close")
    benchmark_close = benchmark_frame["adj_close"].rename("benchmark_close")

    factor_series = (
        erp_series
        if erp_series is not None
        else build_proxy_erp_series(
            cn_close,
            window_days=max(int(args.proxy_window_days), 2),
            min_history_days=max(int(args.proxy_min_history_days), 2),
        )
    )

    merged = (
        pd.concat([cn_close, us_close, benchmark_close, factor_series.rename("erp_pct")], axis=1, sort=True)
        .sort_index()
        .ffill()
        .dropna(subset=["cn_close", "us_close", "benchmark_close"])
    )
    if merged.empty:
        raise ValueError("aligned price frame is empty after merge/forward-fill")

    end_date = merged.index.max()
    requested_start = end_date - pd.DateOffset(years=max(int(args.years), 1))
    evaluation = merged.loc[merged.index >= requested_start].copy()
    if evaluation.empty:
        raise ValueError("evaluation frame is empty for the requested lookback window")

    cn_return = evaluation["cn_close"].pct_change().fillna(0.0)
    us_return = evaluation["us_close"].pct_change().fillna(0.0)
    benchmark_return = evaluation["benchmark_close"].pct_change().fillna(0.0)
    daily_cash_yield = float(args.cash_yield_pct) / 100.0 / 252.0

    factor_signal = evaluation["erp_pct"].shift(1)
    weights = build_weight_frame(
        factor_signal,
        high_threshold_pct=float(args.high_erp_threshold_pct),
        low_threshold_pct=float(args.low_erp_threshold_pct),
    )

    strategy_return = (
        weights["cn_weight"] * cn_return
        + weights["us_weight"] * us_return
        + weights["cash_weight"] * daily_cash_yield
    )
    strategy_nav = (1.0 + strategy_return).cumprod()
    benchmark_nav = (1.0 + benchmark_return).cumprod()

    backtest_frame = pd.concat(
        [
            evaluation[["cn_close", "us_close", "benchmark_close", "erp_pct"]],
            factor_signal.rename("erp_signal_pct"),
            weights,
            cn_return.rename("cn_return"),
            us_return.rename("us_return"),
            benchmark_return.rename("benchmark_return"),
            strategy_return.rename("strategy_return"),
            strategy_nav.rename("strategy_nav"),
            benchmark_nav.rename("benchmark_nav"),
        ],
        axis=1,
    )

    summary = summarize_result(
        backtest_frame,
        daily_cash_yield=daily_cash_yield,
        factor_source=factor_source,
        factor_note=factor_note,
        requested_years=int(args.years),
        high_erp_threshold_pct=float(args.high_erp_threshold_pct),
        low_erp_threshold_pct=float(args.low_erp_threshold_pct),
        cn_symbol=args.cn_symbol,
        us_symbol=args.us_symbol,
        benchmark_symbol=args.benchmark_symbol,
    )
    summary["period"]["requested_start_date"] = requested_start.strftime("%Y-%m-%d")
    summary["period"]["used_max_available_history"] = backtest_frame.index[0] > requested_start
    return summary, backtest_frame


def print_summary(summary: dict[str, Any], report_path: Path, skip_plot: bool) -> None:
    strategy = summary["strategy"]
    benchmark = summary["benchmark"]
    period = summary["period"]
    source = summary["source"]

    print("=== Macro ERP Dynamic Cash Backtest ===")
    print(
        f"Period: {period['start_date']} -> {period['end_date']} | "
        f"Trading Days: {period['trading_days']} | "
        f"Actual Years: {period['actual_years']}"
    )
    print(
        f"Symbols: CN={source['cn_symbol']} | US={source['us_symbol']} | "
        f"Benchmark={source['benchmark_symbol']}"
    )
    print(f"Factor Source: {source['factor_source']}")
    if source.get("factor_note"):
        print(f"Factor Note: {source['factor_note']}")
    print("")
    print(
        f"Strategy   | CAGR {strategy['cagr_pct']}% | "
        f"MaxDD {strategy['max_drawdown_pct']}% | "
        f"Sharpe {strategy['sharpe_ratio']} | "
        f"Total Return {strategy['total_return_pct']}%"
    )
    print(
        f"Benchmark  | CAGR {benchmark['cagr_pct']}% | "
        f"MaxDD {benchmark['max_drawdown_pct']}% | "
        f"Sharpe {benchmark['sharpe_ratio']} | "
        f"Total Return {benchmark['total_return_pct']}%"
    )
    if skip_plot:
        print("Plot: skipped by --skip-plot")
    else:
        print(f"Plot: {report_path}")


def main() -> None:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)

    db_path = Path(args.db).expanduser().resolve() if args.db else (portfolio_root / "data" / "market_lake.db")
    report_path = (
        Path(args.report_path).expanduser().resolve()
        if args.report_path
        else (portfolio_root / "reports" / "backtest_10yr_result.png")
    )
    summary_output = (
        Path(args.summary_output).expanduser().resolve()
        if args.summary_output
        else (portfolio_root / "data" / "macro_backtest_results.json")
    )

    args.db = str(db_path)
    summary, backtest_frame = run_backtest(args)
    summary["account_id"] = account_id
    summary["source"]["db"] = str(db_path)

    if not args.skip_plot:
        title = (
            f"Macro Cash-Gating Backtest | CN={args.cn_symbol} | US={args.us_symbol} | "
            f"Factor={summary['source']['factor_source']}"
        )
        render_plot(backtest_frame, report_path, title)

    summary_output.parent.mkdir(parents=True, exist_ok=True)
    summary_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print_summary(summary, report_path, args.skip_plot)


if __name__ == "__main__":
    main()
