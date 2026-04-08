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
from fund_name_normalizer import normalize_fund_name  # noqa: E402
from portfolio_state_paths import load_preferred_portfolio_state, read_json_or_none  # noqa: E402
PORTFOLIO_ROOT = resolve_portfolio_root()
WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
INDEX_VALUATION_MATRIX_PATH = PORTFOLIO_ROOT / "signals" / "index_valuation_matrix.json"
OUTPUT_DIR = PORTFOLIO_ROOT / "signals"
OUTPUT_PATH = OUTPUT_DIR / "signals_matrix.json"
DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_SHORT_WINDOW = 20
DEFAULT_LONG_WINDOW = 60
DEFAULT_RSI_WINDOW = 14
DEFAULT_ADX_WINDOW = 14
DEFAULT_MACD_FAST = 12
DEFAULT_MACD_SLOW = 26
DEFAULT_MACD_SIGNAL = 9
DEFAULT_DRAWDOWN_WINDOW = 60
TREND_TOLERANCE = 0.002
ADX_TREND_THRESHOLD = 25


def ensure_runtime() -> None:
    if os.environ.get("AKSHARE_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent

    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            import ta  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["AKSHARE_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd  # noqa: E402
from ta.momentum import RSIIndicator  # noqa: E402
from ta.trend import ADXIndicator, MACD  # noqa: E402
from ta.volatility import AverageTrueRange  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Layer 2 fund signal matrix from historical NAV data."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--short-window", type=int, default=DEFAULT_SHORT_WINDOW)
    parser.add_argument("--long-window", type=int, default=DEFAULT_LONG_WINDOW)
    parser.add_argument("--rsi-window", type=int, default=DEFAULT_RSI_WINDOW)
    parser.add_argument("--adx-window", type=int, default=DEFAULT_ADX_WINDOW)
    parser.add_argument("--macd-fast", type=int, default=DEFAULT_MACD_FAST)
    parser.add_argument("--macd-slow", type=int, default=DEFAULT_MACD_SLOW)
    parser.add_argument("--macd-signal", type=int, default=DEFAULT_MACD_SIGNAL)
    parser.add_argument("--drawdown-window", type=int, default=DEFAULT_DRAWDOWN_WINDOW)
    parser.add_argument("--portfolio-state", default="")
    parser.add_argument("--latest", default="")
    parser.add_argument("--db", default="")
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


def load_target_pool(portfolio_state_payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    watchlist_payload = read_json(WATCHLIST_PATH)

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
                "portfolio_amount_cny": safe_float(portfolio_match.get("amount")) if portfolio_match else None,
                "portfolio_daily_pnl_cny": safe_float(portfolio_match.get("daily_pnl")) if portfolio_match else None,
                "portfolio_category": portfolio_match.get("category") if portfolio_match else None,
            }
        )

    metadata = {
        "watchlist_as_of": watchlist_payload.get("as_of"),
        "watchlist_basis": watchlist_payload.get("basis"),
        "portfolio_snapshot_date": portfolio_state_payload.get("snapshot_date"),
        "portfolio_summary": portfolio_state_payload.get("summary", {}),
        "latest_snapshot_date": portfolio_state_payload.get("snapshot_date"),
        "latest_summary": portfolio_state_payload.get("summary", {}),
    }
    return targets, metadata


def compare_series(lhs: float | None, rhs: float | None, tolerance: float = TREND_TOLERANCE) -> int | None:
    if lhs is None or rhs is None or rhs == 0:
        return None
    threshold = abs(rhs) * tolerance
    delta = lhs - rhs
    if delta > threshold:
        return 1
    if delta < -threshold:
        return -1
    return 0


def classify_trend(current_price: float | None, sma_20: float | None, sma_60: float | None) -> tuple[str, float | None]:
    relations = [
        compare_series(current_price, sma_20),
        compare_series(current_price, sma_60),
        compare_series(sma_20, sma_60),
    ]
    usable = [value for value in relations if value is not None]
    if not usable:
        return "neutral", None

    score = sum(usable) / len(usable)
    if score >= 0.75:
        return "bullish", round(score, 4)
    if score >= 0.25:
        return "weak_bullish", round(score, 4)
    if score > -0.25:
        return "neutral", round(score, 4)
    if score > -0.75:
        return "weak_bearish", round(score, 4)
    return "bearish", round(score, 4)


def classify_bias_regime(bias_20: float | None) -> str:
    if bias_20 is None:
        return "unknown"
    if bias_20 >= 10:
        return "overextended_up"
    if bias_20 >= 3:
        return "strong_above_mean"
    if bias_20 <= -10:
        return "capitulation_zone"
    if bias_20 <= -3:
        return "below_mean"
    return "near_mean"


def classify_rsi_regime(rsi_14: float | None) -> str:
    if rsi_14 is None:
        return "unknown"
    if rsi_14 >= 70:
        return "overbought"
    if rsi_14 <= 30:
        return "oversold"
    if rsi_14 >= 55:
        return "strong"
    if rsi_14 <= 45:
        return "weak"
    return "neutral"


def build_valuation_lookup() -> dict[str, Any]:
    if not INDEX_VALUATION_MATRIX_PATH.exists():
        return {}

    try:
        payload = read_json(INDEX_VALUATION_MATRIX_PATH)
    except Exception:
        return {}

    by_name: dict[str, Any] = {}
    for signal in payload.get("signals", {}).values():
        candidates = [
            signal.get("proxy_key"),
            signal.get("name"),
            *(signal.get("mapped_labels", []) or []),
        ]
        for candidate in candidates:
            normalized = normalize_name(str(candidate or ""))
            if normalized:
                by_name[normalized] = signal

    return by_name


def find_valuation_signal(target: dict[str, Any], valuation_lookup: dict[str, Any]) -> dict[str, Any] | None:
    candidates = [
        target.get("code"),
        target.get("name"),
        target.get("portfolio_match_name"),
        target.get("portfolio_category"),
    ]

    for candidate in candidates:
        normalized = normalize_name(str(candidate or ""))
        if normalized and normalized in valuation_lookup:
            return valuation_lookup[normalized]

    return None


def compute_recent_max_drawdown(nav_series: pd.Series, window: int) -> tuple[float | None, float | None]:
    clean = nav_series.dropna()
    if clean.empty:
        return None, None

    full_history_drawdown = clean / clean.cummax() - 1.0
    recent_drawdown = full_history_drawdown.tail(window)
    current_drawdown = recent_drawdown.iloc[-1] if not recent_drawdown.empty else None
    max_drawdown = recent_drawdown.min() if not recent_drawdown.empty else None
    return (
        round_or_none(max_drawdown * 100 if max_drawdown is not None else None, 2),
        round_or_none(current_drawdown * 100 if current_drawdown is not None else None, 2),
    )


def prepare_history_frame(
    df: pd.DataFrame,
    short_window: int,
    long_window: int,
    rsi_window: int,
    adx_window: int,
    macd_fast: int,
    macd_slow: int,
    macd_signal: int,
) -> pd.DataFrame:
    working = df.copy()
    working["净值日期"] = pd.to_datetime(working["净值日期"], errors="coerce")
    numeric_columns = ["开盘价", "最高价", "最低价", "收盘价", "复权收盘价", "成交量"]
    for column in numeric_columns:
        if column in working.columns:
            working[column] = pd.to_numeric(working[column], errors="coerce")

    working["单位净值"] = working["复权收盘价"].where(
        working["复权收盘价"].notna(),
        working["收盘价"],
    )
    working["日增长率"] = working["单位净值"].pct_change() * 100.0
    working = (
        working.dropna(subset=["净值日期", "单位净值", "最高价", "最低价", "收盘价"])
        .sort_values("净值日期")
        .set_index("净值日期")
    )

    working["SMA_20"] = working["单位净值"].rolling(window=short_window, min_periods=short_window).mean()
    working["SMA_60"] = working["单位净值"].rolling(window=long_window, min_periods=long_window).mean()
    working["RSI_14"] = RSIIndicator(
        close=working["单位净值"],
        window=rsi_window,
        fillna=False,
    ).rsi()
    atr_indicator = AverageTrueRange(
        high=working["最高价"],
        low=working["最低价"],
        close=working["收盘价"],
        window=adx_window,
        fillna=False,
    )
    adx_indicator = ADXIndicator(
        high=working["最高价"],
        low=working["最低价"],
        close=working["收盘价"],
        window=adx_window,
        fillna=False,
    )
    macd_indicator = MACD(
        close=working["单位净值"],
        window_slow=macd_slow,
        window_fast=macd_fast,
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
    return working


def load_history_from_db(connection: sqlite3.Connection, code: str) -> pd.DataFrame:
    query = """
        SELECT date, open, high, low, close, adj_close, volume
        FROM daily_prices
        WHERE symbol = ?
          AND close IS NOT NULL
          AND high IS NOT NULL
          AND low IS NOT NULL
        ORDER BY date ASC
    """
    raw_df = pd.read_sql_query(query, connection, params=[code])
    if raw_df.empty:
        raise ValueError("SQLite 返回空历史")

    history_df = raw_df.rename(
        columns={
            "date": "净值日期",
            "open": "开盘价",
            "high": "最高价",
            "low": "最低价",
            "close": "收盘价",
            "adj_close": "复权收盘价",
            "volume": "成交量",
        }
    )
    return history_df


def filter_trend_status(raw_trend_status: str, adx_14: float | None) -> str:
    if adx_14 is None:
        return raw_trend_status
    if adx_14 < ADX_TREND_THRESHOLD:
        return "choppy_sideways"
    return raw_trend_status


def classify_left_side_regime(
    rsi_14: float | None,
    valuation_percentile_5y: float | None,
    macd_hist: float | None,
    hist_increasing: bool | None,
) -> str:
    trigger_left_side = (
        (rsi_14 is not None and rsi_14 < 30)
        or (valuation_percentile_5y is not None and valuation_percentile_5y < 15)
    )
    if not trigger_left_side or macd_hist is None or hist_increasing is None:
        return "neutral"
    if macd_hist < 0 and hist_increasing is False:
        return "falling_knife"
    if macd_hist >= 0 or (macd_hist < 0 and hist_increasing is True):
        return "bottom_divergence"
    return "neutral"


def build_signal_record(
    target: dict[str, Any],
    history_df: pd.DataFrame,
    short_window: int,
    long_window: int,
    drawdown_window: int,
    valuation_signal: dict[str, Any] | None,
) -> dict[str, Any]:
    latest_row = history_df.iloc[-1]
    current_nav = safe_float(latest_row.get("单位净值"))
    sma_20 = safe_float(latest_row.get("SMA_20"))
    sma_60 = safe_float(latest_row.get("SMA_60"))
    rsi_14 = safe_float(latest_row.get("RSI_14"))
    atr_14 = safe_float(latest_row.get("ATR_14"))
    plus_di_14 = safe_float(latest_row.get("PLUS_DI_14"))
    minus_di_14 = safe_float(latest_row.get("MINUS_DI_14"))
    adx_14 = safe_float(latest_row.get("ADX_14"))
    macd_line = safe_float(latest_row.get("MACD_LINE"))
    macd_signal = safe_float(latest_row.get("MACD_SIGNAL"))
    macd_hist = safe_float(latest_row.get("MACD_HIST"))
    previous_macd_hist = (
        safe_float(history_df["MACD_HIST"].iloc[-2]) if len(history_df) >= 2 else None
    )
    hist_increasing = None
    if macd_hist is not None and previous_macd_hist is not None:
        hist_increasing = macd_hist > previous_macd_hist

    valuation_percentile_5y = safe_float(
        valuation_signal.get("metrics", {}).get("composite_percentile_5y")
    ) if valuation_signal else None
    valuation_regime_primary = (
        valuation_signal.get("derived_signals", {}).get("valuation_regime_primary")
        if valuation_signal
        else None
    )

    bias_20 = None
    if current_nav is not None and sma_20 not in {None, 0}:
        bias_20 = ((current_nav - sma_20) / sma_20) * 100

    raw_trend_status, trend_score = classify_trend(current_nav, sma_20, sma_60)
    trend_status = filter_trend_status(raw_trend_status, adx_14)
    left_side_regime = classify_left_side_regime(
        rsi_14=rsi_14,
        valuation_percentile_5y=valuation_percentile_5y,
        macd_hist=macd_hist,
        hist_increasing=hist_increasing,
    )
    max_drawdown_pct, current_drawdown_pct = compute_recent_max_drawdown(
        history_df["单位净值"], drawdown_window
    )

    recent_returns = history_df["单位净值"].pct_change().dropna()
    trailing_volatility = None
    if len(recent_returns) >= short_window:
        trailing_volatility = recent_returns.tail(short_window).std() * math.sqrt(252) * 100

    return {
        "code": target["code"],
        "name": target["name"],
        "signal_date": history_df.index[-1].strftime("%Y-%m-%d"),
        "history_points": int(len(history_df)),
        "portfolio_context": {
            "watchlist_amount_cny": round_or_none(target.get("watchlist_amount_cny"), 2),
            "portfolio_position_amount_cny": round_or_none(target.get("portfolio_amount_cny"), 2),
            "latest_position_amount_cny": round_or_none(target.get("portfolio_amount_cny"), 2),
            "portfolio_daily_pnl_cny": round_or_none(target.get("portfolio_daily_pnl_cny"), 2),
            "latest_daily_pnl_cny": round_or_none(target.get("portfolio_daily_pnl_cny"), 2),
            "portfolio_category": target.get("portfolio_category"),
            "latest_category": target.get("portfolio_category"),
            "watchlist_note": target.get("watchlist_note"),
            "portfolio_name_match": target.get("portfolio_match_name"),
            "latest_name_match": target.get("portfolio_match_name"),
        },
        "valuation_context": {
            "proxy_key": valuation_signal.get("proxy_key") if valuation_signal else None,
            "proxy_name": valuation_signal.get("name") if valuation_signal else None,
            "composite_percentile_5y": round_or_none(valuation_percentile_5y, 2),
            "valuation_regime_primary": valuation_regime_primary,
        },
        "indicators": {
            "current_nav": round_or_none(current_nav, 4),
            f"sma_{short_window}": round_or_none(sma_20, 4),
            f"sma_{long_window}": round_or_none(sma_60, 4),
            f"bias_{short_window}_percent": round_or_none(bias_20, 2),
            "rsi_14": round_or_none(rsi_14, 2),
            "atr_14": round_or_none(atr_14, 4),
            "plus_di_14": round_or_none(plus_di_14, 2),
            "minus_di_14": round_or_none(minus_di_14, 2),
            "adx_14": round_or_none(adx_14, 2),
            "macd_line": round_or_none(macd_line, 6),
            "macd_signal": round_or_none(macd_signal, 6),
            "macd_hist": round_or_none(macd_hist, 6),
            f"max_drawdown_{drawdown_window}d_percent": round_or_none(max_drawdown_pct, 2),
            f"current_drawdown_{drawdown_window}d_percent": round_or_none(current_drawdown_pct, 2),
            f"annualized_volatility_{short_window}d_percent": round_or_none(trailing_volatility, 2),
        },
        "derived_signals": {
            "trend_status": trend_status,
            "raw_trend_status": raw_trend_status,
            "trend_score": trend_score,
            "bias_regime": classify_bias_regime(bias_20),
            "rsi_regime": classify_rsi_regime(rsi_14),
            "left_side_regime": left_side_regime,
            "hist_increasing": hist_increasing,
        },
        "data_quality": {
            f"enough_history_for_sma_{short_window}": len(history_df) >= short_window,
            f"enough_history_for_sma_{long_window}": len(history_df) >= long_window,
            "enough_history_for_rsi_14": len(history_df) >= DEFAULT_RSI_WINDOW,
            "enough_history_for_adx_14": len(history_df) >= (DEFAULT_ADX_WINDOW * 2),
            "enough_history_for_macd": len(history_df) >= (DEFAULT_MACD_SLOW + DEFAULT_MACD_SIGNAL),
            "drawdown_window_used": min(len(history_df), drawdown_window),
        },
    }


def generate_fund_signals_matrix(args: argparse.Namespace) -> dict[str, Any]:
    manifest = read_json_or_none(PORTFOLIO_ROOT / "state-manifest.json") or {}
    portfolio_state_payload, portfolio_state_path, portfolio_state_source_kind, _ = load_preferred_portfolio_state(
        portfolio_root=PORTFOLIO_ROOT,
        manifest=manifest,
        explicit_portfolio_state=args.portfolio_state,
        explicit_latest_compat=args.latest,
    )
    targets, metadata = load_target_pool(portfolio_state_payload)
    valuation_lookup = build_valuation_lookup()
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    payload: dict[str, Any] = {
        "version": 1,
        "account_id": account_id,
        "generated_at": format_now(),
        "layer_role": "layer_2_fund_signal_engine",
        "source": "Local SQLite market_lake daily_prices (OHLC unified)",
        "parameters": {
            "short_window": args.short_window,
            "long_window": args.long_window,
            "rsi_window": args.rsi_window,
            "adx_window": args.adx_window,
            "adx_trend_threshold": ADX_TREND_THRESHOLD,
            "macd_fast": args.macd_fast,
            "macd_slow": args.macd_slow,
            "macd_signal": args.macd_signal,
            "drawdown_window": args.drawdown_window,
            "db": str(Path(args.db)),
        },
        "source_pool": {
            **metadata,
            "portfolio_snapshot_path": str(portfolio_state_path),
            "portfolio_snapshot_source_kind": portfolio_state_source_kind,
            "market_lake_db": str(Path(args.db)),
        },
        "signals": {},
        "errors": [],
    }

    with sqlite3.connect(args.db) as connection:
        for target in targets:
            code = target["code"]
            name = target["name"]
            try:
                raw_df = load_history_from_db(connection, code)
                history_df = prepare_history_frame(
                    raw_df,
                    short_window=args.short_window,
                    long_window=args.long_window,
                    rsi_window=args.rsi_window,
                    adx_window=args.adx_window,
                    macd_fast=args.macd_fast,
                    macd_slow=args.macd_slow,
                    macd_signal=args.macd_signal,
                )
                if history_df.empty:
                    raise ValueError("净值历史在清洗后为空")

                valuation_signal = find_valuation_signal(target, valuation_lookup)
                payload["signals"][code] = build_signal_record(
                    target=target,
                    history_df=history_df,
                    short_window=args.short_window,
                    long_window=args.long_window,
                    drawdown_window=args.drawdown_window,
                    valuation_signal=valuation_signal,
                )
            except Exception as exc:
                payload["errors"].append(
                    {
                        "code": code,
                        "name": name,
                        "message": str(exc),
                    }
                )

    payload["_meta"] = {
        "schema_version": "1.0",
        "generated_at": format_now(),
        "source_script": "generate_fund_signals_matrix.py",
    }

    return payload


def main() -> int:
    global PORTFOLIO_ROOT, WATCHLIST_PATH, INDEX_VALUATION_MATRIX_PATH, OUTPUT_DIR, OUTPUT_PATH
    args = parse_args()
    PORTFOLIO_ROOT = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
    INDEX_VALUATION_MATRIX_PATH = PORTFOLIO_ROOT / "signals" / "index_valuation_matrix.json"
    OUTPUT_DIR = PORTFOLIO_ROOT / "signals"
    OUTPUT_PATH = OUTPUT_DIR / "signals_matrix.json"
    args.db = args.db or str(PORTFOLIO_ROOT / "data" / "market_lake.db")
    args.output = args.output or str(OUTPUT_PATH)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = generate_fund_signals_matrix(args)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "account_id": resolve_account_id(user=args.user, portfolio_root=args.portfolio_root),
                "portfolio_root": str(PORTFOLIO_ROOT),
                "output": str(output_path),
                "signal_count": len(payload["signals"]),
                "error_count": len(payload["errors"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
