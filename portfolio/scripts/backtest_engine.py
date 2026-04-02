#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = DEFAULT_PORTFOLIO_ROOT
DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
OUTPUT_SUMMARY_PATH = PORTFOLIO_ROOT / "data" / "backtest_engine_results.json"
OUTPUT_EQUITY_PATH = PORTFOLIO_ROOT / "data" / "backtest_engine_equity.csv"
OUTPUT_PLOT_PATH = PORTFOLIO_ROOT / "reports" / "backtest_engine_nav_vs_hs300.png"
PROXY_CONFIG_PATH = PORTFOLIO_ROOT / "config" / "backtest_proxy_mapping.json"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

TRADING_DAYS = 250
DEFAULT_START_DATE = "2018-01-01"
DEFAULT_INITIAL_CAPITAL = 1.0
DEFAULT_OFFENSE_CASH_PCT = 0.10
DEFAULT_NEUTRAL_CASH_PCT = 0.25
DEFAULT_DEFENSE_CASH_PCT = 0.40
DEFAULT_HIGH_ERP_THRESHOLD = 5.5
DEFAULT_LOW_ERP_THRESHOLD = 3.5
DEFAULT_TREND_FILTER_WINDOW = 120
DEFAULT_CN_CORE_TARGET = 0.20
DEFAULT_CN_CORE_MAX = 0.25
DEFAULT_DIVIDEND_TARGET = 0.10
DEFAULT_DIVIDEND_MAX = 0.15
DEFAULT_GLB_MOM_MAX = 0.15
DEFAULT_GOLD_BASE_WEIGHT = 0.10
DEFAULT_GOLD_CRISIS_WEIGHT = 0.20

DEFAULT_SYMBOL_CANDIDATES = {
    "hs300": ["510300", "159919", "007339"],
    "nasdaq100": ["513100", "QQQ"],
    "gold": ["518880", "GLD", "IAU", "GC=F"],
    "dividend": ["515180", "512890", "021482"],
}


def ensure_runtime() -> None:
    if os.environ.get("BACKTEST_ENGINE_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["BACKTEST_ENGINE_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


@dataclass(frozen=True)
class AssetSpec:
    key: str
    symbol: str
    label: str
    live_symbol: str | None = None
    reference_targets: tuple[str, ...] = ()
    candidate_symbols: tuple[str, ...] = ()
    proxy_note: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Vectorized backtest engine for Route A macro cash-gate allocation."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--start-date", default=DEFAULT_START_DATE)
    parser.add_argument("--end-date", default="")
    parser.add_argument("--initial-capital", type=float, default=DEFAULT_INITIAL_CAPITAL)
    parser.add_argument("--summary-output", default="")
    parser.add_argument("--equity-output", default="")
    parser.add_argument("--plot-output", default="")
    parser.add_argument("--proxy-config", default="")
    parser.add_argument("--hs300-symbol", default="")
    parser.add_argument("--nasdaq-symbol", default="")
    parser.add_argument("--gold-symbol", default="")
    parser.add_argument("--dividend-symbol", default="")
    parser.add_argument("--high-erp-threshold", type=float, default=DEFAULT_HIGH_ERP_THRESHOLD)
    parser.add_argument("--low-erp-threshold", type=float, default=DEFAULT_LOW_ERP_THRESHOLD)
    parser.add_argument("--offense-cash-pct", type=float, default=DEFAULT_OFFENSE_CASH_PCT)
    parser.add_argument("--neutral-cash-pct", type=float, default=DEFAULT_NEUTRAL_CASH_PCT)
    parser.add_argument("--defense-cash-pct", type=float, default=DEFAULT_DEFENSE_CASH_PCT)
    return parser.parse_args()


def rebind_runtime_paths(portfolio_root: Path) -> None:
    global PORTFOLIO_ROOT
    global DB_PATH
    global OUTPUT_SUMMARY_PATH
    global OUTPUT_EQUITY_PATH
    global OUTPUT_PLOT_PATH
    global PROXY_CONFIG_PATH
    global MANIFEST_PATH

    PORTFOLIO_ROOT = portfolio_root
    DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
    OUTPUT_SUMMARY_PATH = PORTFOLIO_ROOT / "data" / "backtest_engine_results.json"
    OUTPUT_EQUITY_PATH = PORTFOLIO_ROOT / "data" / "backtest_engine_equity.csv"
    OUTPUT_PLOT_PATH = PORTFOLIO_ROOT / "reports" / "backtest_engine_nav_vs_hs300.png"
    PROXY_CONFIG_PATH = PORTFOLIO_ROOT / "config" / "backtest_proxy_mapping.json"
    MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_runtime_paths(args: argparse.Namespace) -> dict[str, Path]:
    portfolio_root = resolve_portfolio_root(
        user=args.user or None,
        portfolio_root=args.portfolio_root or None,
    )
    rebind_runtime_paths(portfolio_root)

    return {
        "portfolio_root": portfolio_root,
        "db_path": Path(args.db).expanduser().resolve() if args.db else DB_PATH.resolve(),
        "proxy_config_path": (
            Path(args.proxy_config).expanduser().resolve() if args.proxy_config else PROXY_CONFIG_PATH.resolve()
        ),
        "summary_output": (
            Path(args.summary_output).expanduser().resolve() if args.summary_output else OUTPUT_SUMMARY_PATH.resolve()
        ),
        "equity_output": (
            Path(args.equity_output).expanduser().resolve() if args.equity_output else OUTPUT_EQUITY_PATH.resolve()
        ),
        "plot_output": (
            Path(args.plot_output).expanduser().resolve() if args.plot_output else OUTPUT_PLOT_PATH.resolve()
        ),
        "manifest_path": MANIFEST_PATH.resolve(),
    }


def normalize_symbol_list(values: Any) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    if not isinstance(values, list):
        return normalized
    for item in values:
        symbol = str(item or "").strip()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        normalized.append(symbol)
    return normalized


def load_proxy_mapping(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = read_json(path)
    mapping = payload.get("asset_proxy_mapping", {})
    return mapping if isinstance(mapping, dict) else {}


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


def round_money(value: Any) -> float:
    numeric = safe_float(value) or 0.0
    return round(numeric, 4)


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def update_manifest(manifest_path: Path, summary_output: Path, equity_output: Path, plot_output: Path) -> None:
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["backtest_engine_script"] = str(Path(__file__).resolve())
    canonical["latest_backtest_engine_results"] = str(summary_output)
    canonical["latest_backtest_engine_equity"] = str(equity_output)
    canonical["latest_backtest_engine_plot"] = str(plot_output)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_price_history(connection: sqlite3.Connection, symbol: str) -> pd.DataFrame:
    query = """
        SELECT date, close, adj_close
        FROM daily_prices
        WHERE symbol = ?
          AND close IS NOT NULL
        ORDER BY date ASC
    """
    frame = pd.read_sql_query(query, connection, params=[symbol])
    if frame.empty:
        raise ValueError(f"missing price history for symbol={symbol}")

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    frame["adj_close"] = pd.to_numeric(frame["adj_close"], errors="coerce")
    frame["price"] = frame["adj_close"].where(frame["adj_close"].notna(), frame["close"])
    frame = (
        frame.dropna(subset=["date", "price"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .set_index("date")
    )
    if frame.empty:
        raise ValueError(f"price history empty after cleaning for symbol={symbol}")
    return frame[["price"]]


def resolve_asset_spec(
    connection: sqlite3.Connection,
    *,
    key: str,
    explicit_symbol: str,
    proxy_mapping: dict[str, dict[str, Any]],
    requested_start: str,
) -> AssetSpec:
    proxy_config = proxy_mapping.get(key, {})
    configured_candidates = normalize_symbol_list(proxy_config.get("local_candidates"))
    candidates = (
        [explicit_symbol]
        if explicit_symbol
        else (configured_candidates or DEFAULT_SYMBOL_CANDIDATES[key])
    )
    live_symbol = str(proxy_config.get("live_symbol") or "").strip() or None
    reference_targets = tuple(normalize_symbol_list(proxy_config.get("reference_targets")))
    proxy_note = str(proxy_config.get("selection_note") or "").strip() or None
    requested_start_ts = pd.Timestamp(requested_start)
    viable_candidates: list[tuple[int, pd.Timestamp, AssetSpec]] = []

    for index, candidate in enumerate(candidates):
        symbol = str(candidate or "").strip()
        if not symbol:
            continue
        try:
            frame = load_price_history(connection, symbol)
        except Exception:
            continue
        if frame.empty:
            continue
        label = {
            "hs300": "HS300",
            "nasdaq100": "Nasdaq100",
            "gold": "Gold",
            "dividend": "Dividend_Index",
        }[key]
        viable_candidates.append(
            (
                index if frame.index.min() <= requested_start_ts else len(candidates) + index,
                frame.index.min(),
                AssetSpec(
                    key=key,
                    symbol=symbol,
                    label=label,
                    live_symbol=live_symbol,
                    reference_targets=reference_targets,
                    candidate_symbols=tuple(candidates),
                    proxy_note=proxy_note,
                ),
            )
        )

    if viable_candidates:
        viable_candidates.sort(key=lambda item: (item[0], item[1]))
        return viable_candidates[0][2]

    raise ValueError(f"unable to resolve local proxy symbol for asset={key}; tried {candidates}")


def load_asset_returns(
    connection: sqlite3.Connection,
    specs: list[AssetSpec],
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, dict[str, Any]]]:
    return_series_list: list[pd.Series] = []
    price_series_list: list[pd.Series] = []
    metadata: dict[str, dict[str, Any]] = {}

    for spec in specs:
        history = load_price_history(connection, spec.symbol)
        returns = history["price"].pct_change().rename(spec.key)
        prices = history["price"].rename(f"price_{spec.key}")
        return_series_list.append(returns)
        price_series_list.append(prices)
        metadata[spec.key] = {
            "symbol": spec.symbol,
            "label": spec.label,
            "live_symbol": spec.live_symbol,
            "reference_targets": list(spec.reference_targets),
            "candidate_symbols": list(spec.candidate_symbols),
            "proxy_note": spec.proxy_note,
            "first_date": history.index.min().strftime("%Y-%m-%d"),
            "last_date": history.index.max().strftime("%Y-%m-%d"),
            "rows": int(len(history)),
        }

    returns_frame = pd.concat(return_series_list, axis=1, sort=True).sort_index()
    price_frame = pd.concat(price_series_list, axis=1, sort=True).sort_index()
    return returns_frame, price_frame, metadata


def load_macro_frame(connection: sqlite3.Connection) -> pd.DataFrame:
    query = """
        SELECT date, erp_pct, cn_10y_rate
        FROM macro_indicators
        WHERE erp_pct IS NOT NULL
        ORDER BY date ASC
    """
    frame = pd.read_sql_query(query, connection)
    if frame.empty:
        raise ValueError("macro_indicators table is empty")

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["erp_pct"] = pd.to_numeric(frame["erp_pct"], errors="coerce")
    frame["cn_10y_rate"] = pd.to_numeric(frame["cn_10y_rate"], errors="coerce")
    frame = (
        frame.dropna(subset=["date", "erp_pct"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .set_index("date")
    )
    if frame.empty:
        raise ValueError("macro frame empty after cleaning")
    return frame


def align_data(
    *,
    returns_frame: pd.DataFrame,
    price_frame: pd.DataFrame,
    macro_frame: pd.DataFrame,
    start_date: str,
    end_date: str | None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    requested_start = pd.Timestamp(start_date)
    requested_end = pd.Timestamp(end_date) if end_date else None

    merged = returns_frame.join(price_frame, how="outer").join(macro_frame, how="outer").sort_index()
    if requested_end is not None:
        merged = merged.loc[merged.index <= requested_end]

    merged[["erp_pct", "cn_10y_rate"]] = merged[["erp_pct", "cn_10y_rate"]].ffill()

    return_cols = [column for column in returns_frame.columns]
    first_valid_by_col = {
        column: merged[column].dropna().index.min()
        for column in return_cols
    }
    macro_first_valid = merged["erp_pct"].dropna().index.min()

    effective_start = max(
        [requested_start, macro_first_valid, *[value for value in first_valid_by_col.values() if value is not None]]
    )
    aligned = merged.loc[merged.index >= effective_start].copy()
    aligned = aligned.dropna(subset=return_cols + ["erp_pct"])
    if aligned.empty:
        raise ValueError("aligned backtest frame is empty after applying effective start")

    aligned[return_cols] = aligned[return_cols].fillna(0.0)
    aligned["cn_10y_rate"] = aligned["cn_10y_rate"].ffill().fillna(2.0)
    aligned = aligned.loc[aligned.index >= requested_start]

    return aligned, {
        "requested_start": requested_start.strftime("%Y-%m-%d"),
        "requested_end": requested_end.strftime("%Y-%m-%d") if requested_end is not None else None,
        "effective_start": effective_start.strftime("%Y-%m-%d"),
        "effective_end": aligned.index.max().strftime("%Y-%m-%d"),
        "effective_rows": int(len(aligned)),
        "start_was_truncated": effective_start > requested_start,
    }


def build_weight_matrix(
    frame: pd.DataFrame,
    *,
    high_erp_threshold: float,
    low_erp_threshold: float,
    offense_cash_pct: float,
    neutral_cash_pct: float,
    defense_cash_pct: float,
) -> pd.DataFrame:
    erp = frame["erp_pct"]
    high_regime = erp > high_erp_threshold
    low_regime = erp < low_erp_threshold
    target_cash_floor = pd.Series(
        np.select(
            [high_regime, low_regime],
            [offense_cash_pct, defense_cash_pct],
            default=neutral_cash_pct,
        ),
        index=frame.index,
        dtype=float,
    )

    hs300_ma120 = frame["price_hs300"].rolling(
        window=DEFAULT_TREND_FILTER_WINDOW,
        min_periods=DEFAULT_TREND_FILTER_WINDOW,
    ).mean()
    nasdaq_ma120 = frame["price_nasdaq100"].rolling(
        window=DEFAULT_TREND_FILTER_WINDOW,
        min_periods=DEFAULT_TREND_FILTER_WINDOW,
    ).mean()
    hs300_trend_on = (frame["price_hs300"] >= hs300_ma120).fillna(False)
    nasdaq_trend_on = (frame["price_nasdaq100"] >= nasdaq_ma120).fillna(False)
    dual_risk_off = (~hs300_trend_on) & (~nasdaq_trend_on)

    low_erp_a_share_scale = 1.0
    if 1.0 - neutral_cash_pct > 0:
        low_erp_a_share_scale = min((1.0 - defense_cash_pct) / (1.0 - neutral_cash_pct), 1.0)

    weights = pd.DataFrame(index=frame.index)
    weights["hs300"] = np.select(
        [high_regime, low_regime],
        [DEFAULT_CN_CORE_MAX, DEFAULT_CN_CORE_TARGET * low_erp_a_share_scale],
        default=DEFAULT_CN_CORE_TARGET,
    )
    weights["dividend"] = np.select(
        [high_regime, low_regime],
        [DEFAULT_DIVIDEND_MAX, DEFAULT_DIVIDEND_TARGET * low_erp_a_share_scale],
        default=DEFAULT_DIVIDEND_TARGET,
    )
    weights["nasdaq100"] = np.where(nasdaq_trend_on, DEFAULT_GLB_MOM_MAX, 0.0)
    weights["gold"] = np.where(dual_risk_off, DEFAULT_GOLD_CRISIS_WEIGHT, DEFAULT_GOLD_BASE_WEIGHT)
    weights["requested_cash_floor"] = target_cash_floor
    weights["cash"] = (1.0 - weights[["hs300", "nasdaq100", "gold", "dividend"]].sum(axis=1)).clip(0.0, 1.0)
    weights["hs300_trend_filter_passed"] = hs300_trend_on.astype(bool)
    weights["nasdaq_trend_filter_passed"] = nasdaq_trend_on.astype(bool)
    weights["gold_crisis_hedge_active"] = dual_risk_off.astype(bool)
    weights["cash_floor_buffer"] = weights["cash"] - weights["requested_cash_floor"]

    weights = weights.astype(float)
    weights["hs300_trend_filter_passed"] = hs300_trend_on.astype(bool)
    weights["nasdaq_trend_filter_passed"] = nasdaq_trend_on.astype(bool)
    weights["gold_crisis_hedge_active"] = dual_risk_off.astype(bool)
    weights["weight_sum"] = weights[["hs300", "nasdaq100", "gold", "dividend", "cash"]].sum(axis=1)
    return weights


def compute_drawdown(nav: pd.Series) -> pd.Series:
    peak = nav.cummax()
    return nav / peak - 1.0


def compute_performance_metrics(
    nav: pd.Series,
    daily_returns: pd.Series,
    cash_rf_daily: pd.Series,
    *,
    initial_capital: float,
) -> dict[str, float | None]:
    clean_nav = nav.dropna()
    clean_returns = daily_returns.dropna()
    clean_rf = cash_rf_daily.reindex(clean_returns.index).fillna(0.0)
    if clean_nav.empty or clean_returns.empty:
        raise ValueError("insufficient series for performance metrics")

    total_years = len(clean_returns) / TRADING_DAYS
    ending_multiple = (
        clean_nav.iloc[-1] / initial_capital
        if initial_capital and not math.isclose(initial_capital, 0.0, abs_tol=1e-12)
        else np.nan
    )
    cagr = ending_multiple ** (1.0 / total_years) - 1.0 if total_years > 0 else np.nan
    drawdown = compute_drawdown(clean_nav)
    max_drawdown = drawdown.min()

    excess_returns = clean_returns - clean_rf
    return_std = clean_returns.std(ddof=0)
    sharpe = (
        (excess_returns.mean() / return_std) * math.sqrt(TRADING_DAYS)
        if return_std and not math.isclose(return_std, 0.0, abs_tol=1e-12)
        else np.nan
    )
    calmar = cagr / abs(max_drawdown) if max_drawdown < 0 else np.nan

    return {
        "cagr": round_or_none(cagr, 6),
        "max_drawdown": round_or_none(max_drawdown, 6),
        "sharpe_ratio": round_or_none(sharpe, 6),
        "calmar_ratio": round_or_none(calmar, 6),
    }


def compute_window_drawdown(nav: pd.Series) -> float | None:
    clean_nav = nav.dropna()
    if clean_nav.empty:
        return None
    rebased = clean_nav / clean_nav.iloc[0]
    return round_or_none(compute_drawdown(rebased).min(), 6)


def build_stress_window_summary(
    frame: pd.DataFrame,
    *,
    start_date: str,
    end_date: str,
    limit: float = 0.10,
) -> dict[str, Any] | None:
    window = frame.loc[(frame.index >= pd.Timestamp(start_date)) & (frame.index <= pd.Timestamp(end_date))].copy()
    if window.empty:
        return None

    strategy_window_mdd = compute_window_drawdown(window["strategy_nav"])
    benchmark_window_mdd = compute_window_drawdown(window["benchmark_nav"])
    strategy_point_mdd = round_or_none(window["strategy_drawdown"].min(), 6)
    benchmark_point_mdd = round_or_none(window["benchmark_drawdown"].min(), 6)

    return {
        "start_date": window.index.min().strftime("%Y-%m-%d"),
        "end_date": window.index.max().strftime("%Y-%m-%d"),
        "rows": int(len(window)),
        "strategy_window_max_drawdown": strategy_window_mdd,
        "benchmark_window_max_drawdown": benchmark_window_mdd,
        "strategy_worst_point_drawdown": strategy_point_mdd,
        "benchmark_worst_point_drawdown": benchmark_point_mdd,
        "strategy_breached_limit": (
            strategy_window_mdd is not None and abs(float(strategy_window_mdd)) > limit
        ),
        "benchmark_breached_limit": (
            benchmark_window_mdd is not None and abs(float(benchmark_window_mdd)) > limit
        ),
    }


def plot_results(
    frame: pd.DataFrame,
    *,
    plot_output: Path,
) -> tuple[bool, str | None]:
    try:
        import matplotlib.pyplot as plt
    except Exception as exc:
        return False, f"matplotlib unavailable: {exc}"

    plot_output.parent.mkdir(parents=True, exist_ok=True)

    plt.style.use("seaborn-v0_8-whitegrid")
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(frame.index, frame["strategy_nav"], label="Strategy NAV", linewidth=2.2, color="#0f766e")
    ax.plot(frame.index, frame["benchmark_nav"], label="Benchmark HS300", linewidth=1.8, color="#b45309")
    ax.set_title("Route A Macro Cash-Gate Backtest")
    ax.set_xlabel("Date")
    ax.set_ylabel("NAV")
    ax.legend(loc="best")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(plot_output, dpi=160)
    plt.close(fig)
    return True, None


def build_backtest_frame(
    aligned: pd.DataFrame,
    weights: pd.DataFrame,
    *,
    initial_capital: float,
    defense_cash_pct: float,
) -> pd.DataFrame:
    working = aligned.copy()
    return_cols = ["hs300", "nasdaq100", "gold", "dividend"]
    weight_cols = ["hs300", "nasdaq100", "gold", "dividend", "cash"]
    diagnostic_cols = [column for column in weights.columns if column not in set(weight_cols + ["weight_sum"])]
    renamed_weights = weights[weight_cols].rename(columns={column: f"w_{column}" for column in weight_cols})
    working = working.join(renamed_weights, how="inner")
    if diagnostic_cols:
        working = working.join(weights[diagnostic_cols], how="inner")

    # Apply yesterday's close-based signal to today's return stream to avoid lookahead bias.
    shifted_weights = working[[f"w_{column}" for column in weight_cols]].shift(1)
    shifted_weights.iloc[0] = working.iloc[0][[f"w_{column}" for column in weight_cols]]

    rf_daily = (working["cn_10y_rate"].shift(1).fillna(working["cn_10y_rate"]) / 100.0) / TRADING_DAYS
    risky_leg_return = (
        shifted_weights["w_hs300"] * working["hs300"]
        + shifted_weights["w_nasdaq100"] * working["nasdaq100"]
        + shifted_weights["w_gold"] * working["gold"]
        + shifted_weights["w_dividend"] * working["dividend"]
    )
    strategy_return = risky_leg_return + shifted_weights["w_cash"] * rf_daily
    benchmark_return = working["hs300"]

    working["target_cash_pct"] = working["w_cash"]
    working["cash_rf_daily"] = rf_daily
    working["strategy_return"] = strategy_return
    working["benchmark_return"] = benchmark_return
    working["strategy_nav"] = initial_capital * (1.0 + working["strategy_return"]).cumprod()
    working["benchmark_nav"] = initial_capital * (1.0 + working["benchmark_return"]).cumprod()
    working["strategy_drawdown"] = compute_drawdown(working["strategy_nav"])
    working["benchmark_drawdown"] = compute_drawdown(working["benchmark_nav"])
    working["high_cash_defense_mode"] = working["target_cash_pct"] >= defense_cash_pct - 1e-9
    return working


def run_backtest(args: argparse.Namespace) -> tuple[pd.DataFrame, dict[str, Any]]:
    runtime_paths = resolve_runtime_paths(args)
    proxy_mapping = load_proxy_mapping(runtime_paths["proxy_config_path"])
    with sqlite3.connect(runtime_paths["db_path"]) as connection:
        specs = [
            resolve_asset_spec(
                connection,
                key="hs300",
                explicit_symbol=args.hs300_symbol,
                proxy_mapping=proxy_mapping,
                requested_start=args.start_date,
            ),
            resolve_asset_spec(
                connection,
                key="nasdaq100",
                explicit_symbol=args.nasdaq_symbol,
                proxy_mapping=proxy_mapping,
                requested_start=args.start_date,
            ),
            resolve_asset_spec(
                connection,
                key="gold",
                explicit_symbol=args.gold_symbol,
                proxy_mapping=proxy_mapping,
                requested_start=args.start_date,
            ),
            resolve_asset_spec(
                connection,
                key="dividend",
                explicit_symbol=args.dividend_symbol,
                proxy_mapping=proxy_mapping,
                requested_start=args.start_date,
            ),
        ]
        returns_frame, price_frame, asset_meta = load_asset_returns(connection, specs)
        macro_frame = load_macro_frame(connection)

    aligned, alignment_meta = align_data(
        returns_frame=returns_frame,
        price_frame=price_frame,
        macro_frame=macro_frame,
        start_date=args.start_date,
        end_date=args.end_date or None,
    )
    weights = build_weight_matrix(
        aligned,
        high_erp_threshold=args.high_erp_threshold,
        low_erp_threshold=args.low_erp_threshold,
        offense_cash_pct=args.offense_cash_pct,
        neutral_cash_pct=args.neutral_cash_pct,
        defense_cash_pct=args.defense_cash_pct,
    )
    frame = build_backtest_frame(
        aligned=aligned,
        weights=weights,
        initial_capital=args.initial_capital,
        defense_cash_pct=args.defense_cash_pct,
    )

    strategy_metrics = compute_performance_metrics(
        nav=frame["strategy_nav"],
        daily_returns=frame["strategy_return"],
        cash_rf_daily=frame["cash_rf_daily"],
        initial_capital=args.initial_capital,
    )
    benchmark_metrics = compute_performance_metrics(
        nav=frame["benchmark_nav"],
        daily_returns=frame["benchmark_return"],
        cash_rf_daily=frame["cash_rf_daily"],
        initial_capital=args.initial_capital,
    )

    high_cash_days = int(frame["high_cash_defense_mode"].sum())
    nasdaq_trend_off_days = int((~frame["nasdaq_trend_filter_passed"].fillna(False)).sum())
    gold_crisis_hedge_days = int(frame["gold_crisis_hedge_active"].fillna(False).sum())
    stress_windows = {
        "2018": build_stress_window_summary(frame, start_date="2018-01-01", end_date="2018-12-31"),
        "2022": build_stress_window_summary(frame, start_date="2022-01-01", end_date="2022-12-31"),
    }
    summary = {
        "generated_at": format_now(),
        "db_path": str(runtime_paths["db_path"]),
        "proxy_config_path": str(runtime_paths["proxy_config_path"]),
        "requested_window": {
            "start_date": args.start_date,
            "end_date": args.end_date or frame.index.max().strftime("%Y-%m-%d"),
        },
        "alignment": alignment_meta,
        "resolved_symbols": asset_meta,
        "parameters": {
            "initial_capital": round_or_none(args.initial_capital, 4),
            "high_erp_threshold_pct": round_or_none(args.high_erp_threshold, 4),
            "low_erp_threshold_pct": round_or_none(args.low_erp_threshold, 4),
            "offense_cash_pct": round_or_none(args.offense_cash_pct, 4),
            "neutral_cash_pct": round_or_none(args.neutral_cash_pct, 4),
            "defense_cash_pct": round_or_none(args.defense_cash_pct, 4),
            "trend_filter_window_days": DEFAULT_TREND_FILTER_WINDOW,
            "strategic_weights": {
                "cn_core_target": round_or_none(DEFAULT_CN_CORE_TARGET, 4),
                "cn_core_max": round_or_none(DEFAULT_CN_CORE_MAX, 4),
                "dividend_target": round_or_none(DEFAULT_DIVIDEND_TARGET, 4),
                "dividend_max": round_or_none(DEFAULT_DIVIDEND_MAX, 4),
                "glb_mom_max": round_or_none(DEFAULT_GLB_MOM_MAX, 4),
                "gold_base_weight": round_or_none(DEFAULT_GOLD_BASE_WEIGHT, 4),
                "gold_crisis_weight": round_or_none(DEFAULT_GOLD_CRISIS_WEIGHT, 4),
            },
        },
        "strategy_metrics": strategy_metrics,
        "benchmark_metrics": benchmark_metrics,
        "risk_monitor": {
            "high_cash_defense_days": high_cash_days,
            "nasdaq_trend_filter_off_days": nasdaq_trend_off_days,
            "gold_crisis_hedge_days": gold_crisis_hedge_days,
            "max_drawdown_limit": 0.10,
            "strategy_breached_max_drawdown_limit": (
                safe_float(strategy_metrics["max_drawdown"]) is not None
                and abs(float(strategy_metrics["max_drawdown"])) > 0.10
            ),
        },
        "stress_windows": stress_windows,
        "ending_nav": {
            "strategy": round_or_none(frame["strategy_nav"].iloc[-1], 6),
            "benchmark": round_or_none(frame["benchmark_nav"].iloc[-1], 6),
        },
        "runtime_paths": {
            "portfolio_root": str(runtime_paths["portfolio_root"]),
            "manifest_path": str(runtime_paths["manifest_path"]),
        },
    }
    return frame, summary


def main() -> None:
    args = parse_args()
    frame, summary = run_backtest(args)
    runtime_paths = resolve_runtime_paths(args)

    summary_output = runtime_paths["summary_output"]
    equity_output = runtime_paths["equity_output"]
    plot_output = runtime_paths["plot_output"]

    summary_output.parent.mkdir(parents=True, exist_ok=True)
    equity_output.parent.mkdir(parents=True, exist_ok=True)

    frame_to_save = frame.reset_index().rename(columns={"index": "date"})
    frame_to_save["date"] = frame_to_save["date"].dt.strftime("%Y-%m-%d")
    frame_to_save.to_csv(equity_output, index=False)
    plot_generated, plot_warning = plot_results(frame, plot_output=plot_output)
    summary["artifacts"] = {
        "summary_output": str(summary_output),
        "equity_output": str(equity_output),
        "plot_output": str(plot_output),
        "plot_generated": plot_generated,
        "plot_warning": plot_warning,
    }
    summary_output.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    update_manifest(runtime_paths["manifest_path"], summary_output, equity_output, plot_output)

    alignment = summary["alignment"]
    print(
        f"[backtest_engine] requested window: {summary['requested_window']['start_date']} -> "
        f"{summary['requested_window']['end_date']}"
    )
    print(
        f"[backtest_engine] effective window: {alignment['effective_start']} -> "
        f"{alignment['effective_end']} ({alignment['effective_rows']} rows)"
    )
    if alignment["start_was_truncated"]:
        print(
            "[backtest_engine] warning: effective start was truncated by local proxy availability; "
            "ingest older HS300/Dividend proxies to reach the full 2018 window."
        )

    strategy_metrics = summary["strategy_metrics"]
    print(f"[backtest_engine] strategy CAGR: {strategy_metrics['cagr']}")
    print(f"[backtest_engine] strategy max drawdown: {strategy_metrics['max_drawdown']}")
    print(f"[backtest_engine] strategy sharpe: {strategy_metrics['sharpe_ratio']}")
    print(f"[backtest_engine] strategy calmar: {strategy_metrics['calmar_ratio']}")
    print(
        f"[backtest_engine] high cash defense mode days: "
        f"{summary['risk_monitor']['high_cash_defense_days']}"
    )
    print(
        f"[backtest_engine] nasdaq trend filter off days: "
        f"{summary['risk_monitor']['nasdaq_trend_filter_off_days']}"
    )
    print(
        f"[backtest_engine] gold crisis hedge days: "
        f"{summary['risk_monitor']['gold_crisis_hedge_days']}"
    )
    for label, metrics in (summary.get("stress_windows") or {}).items():
        if not metrics:
            print(f"[backtest_engine] stress {label}: unavailable")
            continue
        print(
            f"[backtest_engine] stress {label}: "
            f"strategy_window_mdd={metrics['strategy_window_max_drawdown']} "
            f"breached={metrics['strategy_breached_limit']} "
            f"benchmark_window_mdd={metrics['benchmark_window_max_drawdown']}"
        )
    print(f"[backtest_engine] summary: {summary_output}")
    print(f"[backtest_engine] equity: {equity_output}")
    if plot_generated:
        print(f"[backtest_engine] plot: {plot_output}")
    else:
        print(f"[backtest_engine] plot skipped: {plot_warning}")


if __name__ == "__main__":
    main()
