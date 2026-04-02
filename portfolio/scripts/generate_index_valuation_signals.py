#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
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
OUTPUT_DIR = PORTFOLIO_ROOT / "signals"
OUTPUT_PATH = OUTPUT_DIR / "index_valuation_matrix.json"
QDII_PROXY_PATH = PORTFOLIO_ROOT / "data" / "qdii_valuation_proxy.json"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

TRADING_DAYS_5Y = 1250
TRADING_DAYS_10Y = 2500


def ensure_runtime() -> None:
    if os.environ.get("AKSHARE_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent

    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import akshare  # noqa: F401
            import pandas  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["AKSHARE_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import akshare as ak  # noqa: E402
import pandas as pd  # noqa: E402


INDEX_PROXY_MAPPING: dict[str, dict[str, Any]] = {
    "a_share_core_hs300": {
        "name": "沪深300",
        "asset_region": "CN",
        "proxy_type": "index",
        "mapped_labels": [
            "沪深300",
            "易方达沪深300ETF联接C",
            "A股核心仓"
        ],
        "price_symbol": "sh000300",
        "valuation_proxy_note": None,
        "pe_source": {
            "provider": "stock_index_pe_lg",
            "symbol": "沪深300",
            "field": "滚动市盈率"
        },
        "pb_source": {
            "provider": "stock_index_pb_lg",
            "symbol": "沪深300",
            "field": "市净率"
        }
    },
    "a_share_defensive_dividend_proxy": {
        "name": "上证红利（红利低波估值代理）",
        "asset_region": "CN",
        "proxy_type": "proxy_index",
        "mapped_labels": [
            "红利低波",
            "华夏中证红利低波动ETF发起式联接A",
            "A股防守仓"
        ],
        "price_symbol": "sh000015",
        "valuation_proxy_note": "当前使用上证红利作为红利低波路线的稳定估值代理，后续若拿到更贴近的红利低波指数历史估值源，可再切换。",
        "pe_source": {
            "provider": "stock_index_pe_lg",
            "symbol": "上证红利",
            "field": "滚动市盈率"
        },
        "pb_source": {
            "provider": "stock_index_pb_lg",
            "symbol": "上证红利",
            "field": "市净率"
        }
    }
}

PENDING_INDEX_PROXY_MAPPING: dict[str, dict[str, Any]] = {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Layer 2 index valuation signal matrix for A-share core proxies."
    )
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--window-5y", type=int, default=TRADING_DAYS_5Y)
    parser.add_argument("--window-10y", type=int, default=TRADING_DAYS_10Y)
    return parser.parse_args()


def rebind_runtime_paths(portfolio_root: Path) -> None:
    global PORTFOLIO_ROOT
    global OUTPUT_DIR
    global OUTPUT_PATH
    global QDII_PROXY_PATH
    global MANIFEST_PATH

    PORTFOLIO_ROOT = portfolio_root
    OUTPUT_DIR = PORTFOLIO_ROOT / "signals"
    OUTPUT_PATH = OUTPUT_DIR / "index_valuation_matrix.json"
    QDII_PROXY_PATH = PORTFOLIO_ROOT / "data" / "qdii_valuation_proxy.json"
    MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"


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


def round_or_none(value: Any, digits: int = 2) -> float | None:
    numeric = safe_float(value)
    if numeric is None:
        return None
    return round(numeric, digits)


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def classify_percentile_regime(percentile: float | None) -> str:
    if percentile is None:
        return "unknown"
    if percentile < 10:
        return "extreme_undervalued"
    if percentile < 30:
        return "undervalued"
    if percentile <= 70:
        return "fair_valued"
    return "overvalued"


def empirical_percentile(series: pd.Series, window: int, *, allow_full_fallback: bool) -> tuple[float | None, str]:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    if clean.empty:
        return None, "no_data"

    if len(clean) >= window:
        sample = clean.tail(window)
        basis = f"trailing_{window}"
    elif allow_full_fallback:
        sample = clean
        basis = "full_history_fallback"
    else:
        return None, "insufficient_history"

    current = float(sample.iloc[-1])
    percentile = float((sample <= current).mean() * 100)
    return round(percentile, 2), basis


def build_composite_percentile(*values: float | None) -> float | None:
    usable = [value for value in values if value is not None]
    if not usable:
        return None
    return round(sum(usable) / len(usable), 2)


def load_series_from_source(source: dict[str, str]) -> pd.DataFrame:
    provider_name = source["provider"]
    symbol = source["symbol"]
    field = source["field"]

    provider = getattr(ak, provider_name)
    df = provider(symbol=symbol)
    working = df.copy()
    working["日期"] = pd.to_datetime(working["日期"], errors="coerce")
    working[field] = pd.to_numeric(working[field], errors="coerce")
    working = working.dropna(subset=["日期", field]).sort_values("日期")
    return working[["日期", field]]


def build_signal_record(
    proxy_key: str,
    config: dict[str, Any],
    window_5y: int,
    window_10y: int
) -> dict[str, Any]:
    pe_df = load_series_from_source(config["pe_source"])
    pb_df = load_series_from_source(config["pb_source"])

    pe_series = pe_df[config["pe_source"]["field"]]
    pb_series = pb_df[config["pb_source"]["field"]]

    current_pe = round_or_none(pe_series.iloc[-1], 2)
    current_pb = round_or_none(pb_series.iloc[-1], 2)

    pe_pct_5y, pe_basis_5y = empirical_percentile(pe_series, window_5y, allow_full_fallback=True)
    pb_pct_5y, pb_basis_5y = empirical_percentile(pb_series, window_5y, allow_full_fallback=True)
    pe_pct_10y, pe_basis_10y = empirical_percentile(pe_series, window_10y, allow_full_fallback=False)
    pb_pct_10y, pb_basis_10y = empirical_percentile(pb_series, window_10y, allow_full_fallback=False)

    composite_pct_5y = build_composite_percentile(pe_pct_5y, pb_pct_5y)
    composite_pct_10y = build_composite_percentile(pe_pct_10y, pb_pct_10y)

    signal_date = max(pe_df["日期"].iloc[-1], pb_df["日期"].iloc[-1]).strftime("%Y-%m-%d")

    return {
        "proxy_key": proxy_key,
        "name": config["name"],
        "asset_region": config["asset_region"],
        "proxy_type": config["proxy_type"],
        "signal_date": signal_date,
        "mapped_labels": config["mapped_labels"],
        "price_symbol": config["price_symbol"],
        "valuation_proxy_note": config.get("valuation_proxy_note"),
        "metrics": {
            "current_pe_ttm": current_pe,
            "current_pb": current_pb,
            "pe_percentile_5y": pe_pct_5y,
            "pb_percentile_5y": pb_pct_5y,
            "composite_percentile_5y": composite_pct_5y,
            "pe_percentile_10y": pe_pct_10y,
            "pb_percentile_10y": pb_pct_10y,
            "composite_percentile_10y": composite_pct_10y
        },
        "derived_signals": {
            "pe_regime_5y": classify_percentile_regime(pe_pct_5y),
            "pb_regime_5y": classify_percentile_regime(pb_pct_5y),
            "valuation_regime_primary": classify_percentile_regime(composite_pct_5y),
            "valuation_regime_10y": classify_percentile_regime(composite_pct_10y)
            if composite_pct_10y is not None
            else "unknown"
        },
        "data_quality": {
            "history_points_pe": int(len(pe_df)),
            "history_points_pb": int(len(pb_df)),
            "pe_5y_basis": pe_basis_5y,
            "pb_5y_basis": pb_basis_5y,
            "pe_10y_basis": pe_basis_10y,
            "pb_10y_basis": pb_basis_10y
        },
        "valuation_sources": {
            "pe_source": config["pe_source"],
            "pb_source": config["pb_source"]
        }
    }


def update_manifest(output_path: Path) -> None:
    if not MANIFEST_PATH.exists():
        return

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["index_valuation_signals_script"] = str(Path(__file__).resolve())
    canonical["latest_index_valuation_matrix"] = str(output_path)
    MANIFEST_PATH.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def load_qdii_proxy_payload() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not QDII_PROXY_PATH.exists():
        return {}, [
            {
                "proxy_key": "qdii_proxy_payload",
                "name": "QDII valuation proxy bundle",
                "error": f"missing_proxy_payload: {QDII_PROXY_PATH}"
            }
        ]

    try:
        payload = read_json(QDII_PROXY_PATH)
    except Exception as exc:  # pragma: no cover
        return {}, [
            {
                "proxy_key": "qdii_proxy_payload",
                "name": "QDII valuation proxy bundle",
                "error": repr(exc)
            }
        ]

    signals = payload.get("signals", {})
    if not isinstance(signals, dict):
        return {}, [
            {
                "proxy_key": "qdii_proxy_payload",
                "name": "QDII valuation proxy bundle",
                "error": "invalid_proxy_payload: signals is not a dict"
            }
        ]

    return payload, []


def main() -> None:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    rebind_runtime_paths(portfolio_root)
    output_path = Path(args.output).expanduser() if args.output else OUTPUT_PATH
    output_path.parent.mkdir(parents=True, exist_ok=True)

    signals: dict[str, Any] = {}
    errors: list[dict[str, Any]] = []

    for proxy_key, config in INDEX_PROXY_MAPPING.items():
        try:
            signals[proxy_key] = build_signal_record(
                proxy_key=proxy_key,
                config=config,
                window_5y=args.window_5y,
                window_10y=args.window_10y
            )
        except Exception as exc:  # pragma: no cover
            errors.append(
                {
                    "proxy_key": proxy_key,
                    "name": config.get("name"),
                    "error": repr(exc)
                }
            )

    qdii_proxy_payload, qdii_proxy_errors = load_qdii_proxy_payload()
    qdii_proxy_mapping = qdii_proxy_payload.get("proxy_mapping", {})
    qdii_proxy_signals = qdii_proxy_payload.get("signals", {})

    if isinstance(qdii_proxy_signals, dict):
        signals.update(qdii_proxy_signals)
    errors.extend(qdii_proxy_errors)

    active_proxy_mapping: dict[str, Any] = {
        **INDEX_PROXY_MAPPING,
        **(qdii_proxy_mapping if isinstance(qdii_proxy_mapping, dict) else {})
    }

    payload = {
        "version": 1,
        "generated_at": format_now(),
        "layer_role": "layer_2_valuation_engine",
        "source": {
            "primary": [
                "AkShare stock_index_pe_lg",
                "AkShare stock_index_pb_lg",
                "Yahoo Finance via yfinance"
            ],
            "fusion_note": "A股核心/防守代理使用 AkShare PE/PB 历史分位；海外 QDII 未覆盖资产已融合 yfinance 价格分位代理（qdii_valuation_proxy.json）。"
        },
        "parameters": {
            "window_5y": args.window_5y,
            "window_10y": args.window_10y,
            "regime_thresholds_percentile": {
                "extreme_undervalued_lt": 10,
                "undervalued_range": [10, 30],
                "fair_valued_range": [30, 70],
                "overvalued_gt": 70
            }
        },
        "active_proxy_mapping": active_proxy_mapping,
        "pending_proxy_mapping": PENDING_INDEX_PROXY_MAPPING,
        "signals": signals,
        "errors": errors
    }

    output_path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    update_manifest(output_path)
    print(
        json.dumps(
            {
                "outputPath": str(output_path),
                "signalCount": len(signals),
                "errorCount": len(errors)
            },
            ensure_ascii=False,
            indent=2
        )
    )


if __name__ == "__main__":
    main()
