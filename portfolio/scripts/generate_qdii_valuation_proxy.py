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

TRADING_DAYS_5Y = 1250
DOWNLOAD_PERIOD = "10y"
MIN_HISTORY_POINTS = 252


def ensure_runtime() -> None:
    if os.environ.get("AKSHARE_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent

    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["AKSHARE_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd  # noqa: E402


QDII_PROXY_MAPPING: dict[str, dict[str, Any]] = {
    "hk_hstech": {
        "name": "恒生互联网/科技（QDII价格分位代理）",
        "asset_region": "HK",
        "proxy_type": "price_percentile_proxy",
        "mapped_labels": [
            "恒生互联网/科技",
            "华夏恒生互联网科技业ETF联接(QDII)C",
            "易方达港股通互联网ETF联接C",
            "广发恒生科技ETF联接(QDII)A",
            "广发恒生科技ETF联接(QDII)C",
            "港股互联网/QDII",
            "港股科技/QDII",
        ],
        "proxy_candidates": ["^HSTECH", "KWEB"],
        "valuation_proxy_note": "优先使用恒生科技指数；若 Yahoo 无可用历史，则降级采用 KWEB 作为港股互联网/科技拥挤度代理。",
    },
    "us_ndx": {
        "name": "纳斯达克100（QDII价格分位代理）",
        "asset_region": "US",
        "proxy_type": "price_percentile_proxy",
        "mapped_labels": [
            "纳斯达克100",
            "摩根纳斯达克100指数(QDII)人民币A",
            "摩根纳斯达克100指数(QDII)A",
            "嘉实纳斯达克100ETF发起联接(QDII)A人民币",
            "嘉实纳斯达克100ETF联接(QDII)A",
            "美股科技/QDII",
        ],
        "proxy_candidates": ["QQQ"],
        "valuation_proxy_note": "使用 QQQ 作为纳指100价格分位代理，适用于海外成长风格的拥挤度/估值降级判断。",
    },
    "us_spx": {
        "name": "标普500（QDII价格分位代理）",
        "asset_region": "US",
        "proxy_type": "price_percentile_proxy",
        "mapped_labels": [
            "标普500",
            "博时标普500ETF联接C",
            "摩根标普500指数(QDII)人民币A",
            "摩根标普500指数(QDII)A",
            "美股指数/QDII",
        ],
        "proxy_candidates": ["SPY"],
        "valuation_proxy_note": "使用 SPY 作为标普500价格分位代理，反映美股核心宽基当前所处的历史价位区间。",
    },
    "global_overseas_tech": {
        "name": "全球科技（QDII价格分位代理）",
        "asset_region": "GLOBAL",
        "proxy_type": "price_percentile_proxy",
        "mapped_labels": [
            "华宝海外科技股票(QDII-LOF)C",
            "华宝海外科技股票(QDII-FOF-LOF)C",
            "海外科技/QDII",
        ],
        "proxy_candidates": ["VGT", "XLK"],
        "valuation_proxy_note": "使用美国科技 ETF 作为全球科技暴露的降级代理，更偏向捕捉成长拥挤度而非严格基本面估值。",
    },
    "global_commodity": {
        "name": "大宗商品（QDII价格分位代理）",
        "asset_region": "GLOBAL",
        "proxy_type": "price_percentile_proxy",
        "mapped_labels": [
            "国泰大宗商品(QDII-LOF)D",
            "国泰大宗商品配置(QDII-LOF-FOF)D",
            "大宗商品/QDII",
        ],
        "proxy_candidates": ["DBC", "GSG"],
        "valuation_proxy_note": "商品类资产不存在稳定 PE/PB 估值，价格分位仅用于识别拥挤度与周期位置。",
    },
    "jp_nikkei225": {
        "name": "日经225（QDII价格分位代理）",
        "asset_region": "JP",
        "proxy_type": "price_percentile_proxy",
        "mapped_labels": [
            "华安三菱日联日经225ETF联接(QDII)A",
            "日本股市/QDII",
            "日经225",
        ],
        "proxy_candidates": ["^N225", "EWJ"],
        "valuation_proxy_note": "优先使用日经225指数本体；若指数源异常，则降级采用 EWJ 作为替代。",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Yahoo Finance based price-percentile valuation proxies for overseas QDII assets."
    )
    parser.add_argument("--portfolio-root", default="", help="Override portfolio root")
    parser.add_argument("--db", default="", help="Override market_lake.db path")
    parser.add_argument("--output", default="", help="Override output json path")
    parser.add_argument("--window-5y", type=int, default=TRADING_DAYS_5Y)
    parser.add_argument("--period", default=DOWNLOAD_PERIOD)
    return parser.parse_args()


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def round_or_none(value: Any, digits: int = 2) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if not math.isfinite(numeric):
        return None
    return round(numeric, digits)


def classify_percentile_regime(percentile: float | None) -> str:
    if percentile is None:
        return "unknown"
    if percentile < 15:
        return "extreme_undervalued"
    if percentile < 30:
        return "undervalued"
    if percentile <= 70:
        return "fair_valued"
    if percentile <= 85:
        return "overvalued"
    return "bubble_overvalued"


def open_market_lake_connection(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"market lake not found: {db_path}")
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def load_price_series_from_db(connection: sqlite3.Connection, candidate_tickers: list[str]) -> tuple[pd.Series, str, str]:
    last_error: str | None = None

    for ticker in candidate_tickers:
        try:
            total_rows = connection.execute(
                "SELECT COUNT(*) FROM daily_prices WHERE symbol = ?",
                (ticker,),
            ).fetchone()[0]
            if total_rows <= 0:
                last_error = f"{ticker}: no rows in market_lake"
                continue

            rows = connection.execute(
                """
                SELECT date, close
                FROM daily_prices
                WHERE symbol = ?
                ORDER BY date ASC
                """,
                (ticker,),
            ).fetchall()
            if not rows:
                last_error = f"{ticker}: empty query result"
                continue

            frame = pd.DataFrame(rows, columns=["date", "close"])
            frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
            frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
            frame = frame.dropna(subset=["date", "close"]).sort_values("date")
            if frame.empty:
                last_error = f"{ticker}: query result empty after cleaning"
                continue

            series = frame.set_index("date")["close"]
            if len(series) < MIN_HISTORY_POINTS:
                last_error = f"{ticker}: insufficient usable history ({len(series)} points)"
                continue

            return series, ticker, "close"
        except Exception as exc:  # pragma: no cover
            last_error = f"{ticker}: {exc!r}"

    raise RuntimeError(last_error or "all ticker candidates failed")


def compute_price_percentile_window(series: pd.Series, window_5y: int) -> dict[str, Any]:
    clean = series.dropna().sort_index()
    if clean.empty:
        raise ValueError("price history is empty after cleaning")

    if len(clean) >= window_5y:
        sample = clean.tail(window_5y)
        basis = f"trailing_{window_5y}"
    else:
        sample = clean
        basis = "full_history_fallback"

    current_price = float(sample.iloc[-1])
    low_5y = float(sample.min())
    high_5y = float(sample.max())

    if math.isclose(high_5y, low_5y):
        percentile_5y = 50.0
    else:
        percentile_5y = ((current_price - low_5y) / (high_5y - low_5y)) * 100

    return {
        "current_price": round_or_none(current_price, 2),
        "low_5y": round_or_none(low_5y, 2),
        "high_5y": round_or_none(high_5y, 2),
        "percentile_5y": round_or_none(percentile_5y, 2),
        "history_points_total": int(len(clean)),
        "history_points_5y_window": int(len(sample)),
        "history_basis": basis,
        "signal_date": sample.index[-1].strftime("%Y-%m-%d"),
    }


def build_signal_record(
    connection: sqlite3.Connection,
    proxy_key: str,
    config: dict[str, Any],
    period: str,
    window_5y: int,
) -> dict[str, Any]:
    series, used_ticker, price_column = load_price_series_from_db(connection, config["proxy_candidates"])
    metrics = compute_price_percentile_window(series, window_5y)
    percentile_5y = metrics["percentile_5y"]

    return {
        "proxy_key": proxy_key,
        "name": config["name"],
        "asset_region": config["asset_region"],
        "proxy_type": config["proxy_type"],
        "signal_date": metrics["signal_date"],
        "mapped_labels": config["mapped_labels"],
        "proxy_ticker": used_ticker,
        "valuation_proxy_note": config["valuation_proxy_note"],
        "metrics": {
            "current_price": metrics["current_price"],
            "price_low_5y": metrics["low_5y"],
            "price_high_5y": metrics["high_5y"],
            "price_percentile_5y": percentile_5y,
            "composite_percentile_5y": percentile_5y,
        },
        "derived_signals": {
            "valuation_regime_primary": classify_percentile_regime(percentile_5y),
        },
        "data_quality": {
            "history_points_total": metrics["history_points_total"],
            "history_points_5y_window": metrics["history_points_5y_window"],
            "history_basis": metrics["history_basis"],
            "price_field": price_column,
        },
        "valuation_sources": {
            "provider": "Local SQLite market_lake",
            "ticker": used_ticker,
            "ticker_candidates": config["proxy_candidates"],
            "download_period": period,
            "field": price_column,
            "method": "5y_min_max_price_percentile",
        },
    }


def update_manifest(portfolio_root: Path, output_path: Path) -> None:
    manifest_path = portfolio_root / "state-manifest.json"
    if not manifest_path.exists():
        return

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["qdii_valuation_proxy_script"] = str(Path(__file__).resolve())
    canonical["latest_qdii_valuation_proxy"] = str(output_path)
    manifest_path.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    default_output_dir = portfolio_root / "data"
    output_path = Path(args.output).expanduser() if args.output else default_output_dir / "qdii_valuation_proxy.json"
    db_path = Path(args.db).expanduser() if args.db else default_output_dir / "market_lake.db"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    signals: dict[str, Any] = {}
    errors: list[dict[str, Any]] = []

    with open_market_lake_connection(db_path) as connection:
        for proxy_key, config in QDII_PROXY_MAPPING.items():
            try:
                signals[proxy_key] = build_signal_record(
                    connection=connection,
                    proxy_key=proxy_key,
                    config=config,
                    period=args.period,
                    window_5y=args.window_5y,
                )
            except Exception as exc:  # pragma: no cover
                errors.append(
                    {
                        "proxy_key": proxy_key,
                        "name": config.get("name"),
                        "error": repr(exc),
                    }
                )

    payload = {
        "version": 1,
        "generated_at": format_now(),
        "layer_role": "layer_2_qdii_valuation_proxy_engine",
        "source": {
            "primary": ["Local SQLite market_lake daily_prices"],
            "proxy_method": "5y_min_max_price_percentile",
            "note": "海外资产使用价格分位作为估值降级代理；数据直接来自本地 SQLite market_lake，更适合识别拥挤度与赔率区间，而非替代严格基本面估值。",
        },
        "parameters": {
            "download_period": args.period,
            "window_5y": args.window_5y,
            "regime_thresholds_percentile": {
                "extreme_undervalued_lt": 15,
                "undervalued_range": [15, 30],
                "fair_valued_range": [30, 70],
                "overvalued_range": [70, 85],
                "bubble_overvalued_gt": 85,
            },
        },
        "proxy_mapping": QDII_PROXY_MAPPING,
        "signals": signals,
        "errors": errors,
    }

    output_path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    update_manifest(portfolio_root, output_path)
    print(
        json.dumps(
            {
                "outputPath": str(output_path),
                "signalCount": len(signals),
                "errorCount": len(errors),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
