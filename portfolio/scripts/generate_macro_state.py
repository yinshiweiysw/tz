#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, TypeVar

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import resolve_account_id, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = resolve_portfolio_root()
OUTPUT_DIR = PORTFOLIO_ROOT / "data"
OUTPUT_PATH = OUTPUT_DIR / "macro_state.json"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_BASE_DELAY = 1.0


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


T = TypeVar("T")


INDEX_CONFIG: dict[str, dict[str, Any]] = {
    "000300": {
        "name": "沪深300",
        "role": "erp_anchor",
        "legulegu_symbol": "沪深300",
        "csindex_symbol": "000300",
        # Assumption: use the standard market-cap weighted PE from Legulegu when available.
        "preferred_pe_sources": [
            {
                "provider": "AkShare stock_index_pe_lg",
                "kind": "legulegu_pe",
                "field": "滚动市盈率",
            },
            {
                "provider": "AkShare stock_zh_index_value_csindex",
                "kind": "csindex_value",
                "field": "市盈率1",
            },
        ],
        # Assumption: use the official CSI dividend yield column 股息率1 as the default carry anchor.
        "preferred_dividend_sources": [
            {
                "provider": "AkShare stock_zh_index_value_csindex",
                "kind": "csindex_value",
                "field": "股息率1",
            }
        ],
    },
    "000922": {
        "name": "中证红利",
        "role": "dividend_spread_anchor",
        "csindex_symbol": "000922",
        "preferred_pe_sources": [
            {
                "provider": "AkShare stock_zh_index_value_csindex",
                "kind": "csindex_value",
                "field": "市盈率1",
            }
        ],
        "preferred_dividend_sources": [
            {
                "provider": "AkShare stock_zh_index_value_csindex",
                "kind": "csindex_value",
                "field": "股息率1",
            }
        ],
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch macro anchor data and generate local macro_state.json for ERP and dividend-spread routing."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    parser.add_argument("--retry-base-delay", type=float, default=DEFAULT_RETRY_BASE_DELAY)
    parser.add_argument(
        "--disable-previous-fallback",
        action="store_true",
        help="Disable fallback to the previous local macro_state.json when external APIs fail.",
    )
    return parser.parse_args()


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def current_local_date() -> date:
    return datetime.now().astimezone().date()


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


def to_rate_decimal(percent_value: float | None) -> float | None:
    if percent_value is None:
        return None
    return percent_value / 100.0


def as_date_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, pd.Timestamp):
        return value.date().isoformat()
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        return stripped[:10]
    return None


def freshness_days(as_of_date: str | None) -> int | None:
    if not as_of_date:
        return None
    try:
        value = date.fromisoformat(as_of_date)
    except ValueError:
        return None
    return (current_local_date() - value).days


def load_previous_macro_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = read_json(path)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def clone_previous_item(previous_item: dict[str, Any], error_message: str, generated_at: str) -> dict[str, Any]:
    payload = copy.deepcopy(previous_item)
    payload["fallback_used"] = True
    payload["fallback_source"] = {
        "type": "previous_macro_state",
        "generated_at": generated_at,
        "reason": error_message,
    }
    return payload


def retry_call(
    label: str,
    func: Callable[[], T],
    *,
    max_retries: int,
    base_delay: float,
) -> T:
    attempts = max(1, max_retries)
    errors: list[str] = []

    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:
            errors.append(f"attempt_{attempt}: {exc!r}")
            if attempt >= attempts:
                break
            time.sleep(base_delay * (2 ** (attempt - 1)))

    raise RuntimeError(f"{label} failed after {attempts} attempts; {'; '.join(errors)}")


def latest_valid_row(frame: pd.DataFrame, value_field: str, date_field: str) -> tuple[str, float]:
    working = frame.copy()
    working[date_field] = pd.to_datetime(working[date_field], errors="coerce")
    working[value_field] = pd.to_numeric(working[value_field], errors="coerce")
    working = working.dropna(subset=[date_field, value_field]).sort_values(date_field)
    if working.empty:
        raise ValueError(f"no valid rows for field={value_field}")
    row = working.iloc[-1]
    return row[date_field].date().isoformat(), float(row[value_field])


def fetch_10y_cgb_yield(
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_delay: float = DEFAULT_RETRY_BASE_DELAY,
) -> dict[str, Any]:
    errors: list[str] = []

    try:
        def load_primary() -> pd.DataFrame:
            start_date = (current_local_date() - timedelta(days=370)).strftime("%Y%m%d")
            return ak.bond_zh_us_rate(start_date=start_date)

        primary_df = retry_call(
            "bond_zh_us_rate",
            load_primary,
            max_retries=max_retries,
            base_delay=base_delay,
        )
        as_of_date, yield_pct = latest_valid_row(primary_df, "中国国债收益率10年", "日期")
        return {
            "series_key": "cn_10y_cgb",
            "name": "中国10年期国债收益率",
            "as_of_date": as_of_date,
            "yield_pct": round(yield_pct, 4),
            "yield_decimal": round_or_none(to_rate_decimal(yield_pct), 8),
            "provider": "AkShare bond_zh_us_rate",
            "source_field": "中国国债收益率10年",
            "freshness_days": freshness_days(as_of_date),
            "fallback_used": False,
        }
    except Exception as exc:
        errors.append(str(exc))

    def load_secondary() -> pd.DataFrame:
        return ak.bond_gb_zh_sina(symbol="中国10年期国债")

    secondary_df = retry_call(
        "bond_gb_zh_sina",
        load_secondary,
        max_retries=max_retries,
        base_delay=base_delay,
    )
    as_of_date, yield_pct = latest_valid_row(secondary_df, "close", "date")
    payload = {
        "series_key": "cn_10y_cgb",
        "name": "中国10年期国债收益率",
        "as_of_date": as_of_date,
        "yield_pct": round(yield_pct, 4),
        "yield_decimal": round_or_none(to_rate_decimal(yield_pct), 8),
        "provider": "AkShare bond_gb_zh_sina",
        "source_field": "close",
        "freshness_days": freshness_days(as_of_date),
        "fallback_used": False,
    }
    if errors:
        payload["provider_fallback_note"] = errors[-1]
    return payload


def fetch_csindex_value_frame(
    csindex_symbol: str,
    *,
    max_retries: int,
    base_delay: float,
) -> pd.DataFrame:
    return retry_call(
        f"stock_zh_index_value_csindex:{csindex_symbol}",
        lambda: ak.stock_zh_index_value_csindex(symbol=csindex_symbol),
        max_retries=max_retries,
        base_delay=base_delay,
    )


def fetch_legulegu_pe_frame(
    legulegu_symbol: str,
    *,
    max_retries: int,
    base_delay: float,
) -> pd.DataFrame:
    return retry_call(
        f"stock_index_pe_lg:{legulegu_symbol}",
        lambda: ak.stock_index_pe_lg(symbol=legulegu_symbol),
        max_retries=max_retries,
        base_delay=base_delay,
    )


def extract_metric_from_source(
    ticker: str,
    metric_kind: str,
    source_config: dict[str, Any],
    *,
    max_retries: int,
    base_delay: float,
) -> dict[str, Any]:
    index_config = INDEX_CONFIG[ticker]
    kind = source_config["kind"]
    field = source_config["field"]

    if kind == "csindex_value":
        frame = fetch_csindex_value_frame(
            index_config["csindex_symbol"],
            max_retries=max_retries,
            base_delay=base_delay,
        )
        as_of_date, value = latest_valid_row(frame, field, "日期")
        return {
            "value": round(value, 4),
            "as_of_date": as_of_date,
            "provider": source_config["provider"],
            "field": field,
            "freshness_days": freshness_days(as_of_date),
        }

    if kind == "legulegu_pe":
        frame = fetch_legulegu_pe_frame(
            index_config["legulegu_symbol"],
            max_retries=max_retries,
            base_delay=base_delay,
        )
        as_of_date, value = latest_valid_row(frame, field, "日期")
        return {
            "value": round(value, 4),
            "as_of_date": as_of_date,
            "provider": source_config["provider"],
            "field": field,
            "freshness_days": freshness_days(as_of_date),
        }

    raise ValueError(f"unsupported source kind for {ticker}/{metric_kind}: {kind}")


def fetch_index_valuation(
    ticker: str,
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_delay: float = DEFAULT_RETRY_BASE_DELAY,
) -> dict[str, Any]:
    if ticker not in INDEX_CONFIG:
        raise KeyError(f"unsupported ticker: {ticker}")

    config = INDEX_CONFIG[ticker]
    errors: list[dict[str, Any]] = []
    pe_metric: dict[str, Any] | None = None
    dividend_metric: dict[str, Any] | None = None

    for source in config["preferred_pe_sources"]:
        try:
            pe_metric = extract_metric_from_source(
                ticker,
                "pe_ttm",
                source,
                max_retries=max_retries,
                base_delay=base_delay,
            )
            break
        except Exception as exc:
            errors.append(
                {
                    "metric": "pe_ttm",
                    "provider": source["provider"],
                    "error": str(exc),
                }
            )

    for source in config["preferred_dividend_sources"]:
        try:
            dividend_metric = extract_metric_from_source(
                ticker,
                "dividend_yield_pct",
                source,
                max_retries=max_retries,
                base_delay=base_delay,
            )
            break
        except Exception as exc:
            errors.append(
                {
                    "metric": "dividend_yield_pct",
                    "provider": source["provider"],
                    "error": str(exc),
                }
            )

    if pe_metric is None or dividend_metric is None:
        raise RuntimeError(json.dumps(errors, ensure_ascii=False))

    return {
        "ticker": ticker,
        "name": config["name"],
        "role": config["role"],
        "pe_ttm": pe_metric["value"],
        "pe_as_of_date": pe_metric["as_of_date"],
        "pe_provider": pe_metric["provider"],
        "pe_field": pe_metric["field"],
        "pe_freshness_days": pe_metric["freshness_days"],
        "dividend_yield_pct": dividend_metric["value"],
        "dividend_yield_decimal": round_or_none(to_rate_decimal(dividend_metric["value"]), 8),
        "dividend_as_of_date": dividend_metric["as_of_date"],
        "dividend_provider": dividend_metric["provider"],
        "dividend_field": dividend_metric["field"],
        "dividend_freshness_days": dividend_metric["freshness_days"],
        "fallback_used": False,
        "warnings": errors,
    }


def calculate_erp_and_spread(
    ten_year_cgb: dict[str, Any],
    hs300_valuation: dict[str, Any],
    dividend_valuation: dict[str, Any],
) -> dict[str, Any]:
    cgb_yield_decimal = safe_float(ten_year_cgb.get("yield_decimal"))
    hs300_pe = safe_float(hs300_valuation.get("pe_ttm"))
    dividend_yield_decimal = safe_float(dividend_valuation.get("dividend_yield_decimal"))

    if cgb_yield_decimal is None:
        raise ValueError("missing 10Y CGB decimal yield")
    if hs300_pe is None or hs300_pe <= 0:
        raise ValueError("invalid HS300 PE")
    if dividend_yield_decimal is None:
        raise ValueError("missing dividend yield decimal")

    earnings_yield_decimal = 1.0 / hs300_pe
    erp_decimal = earnings_yield_decimal - cgb_yield_decimal
    dividend_spread_decimal = dividend_yield_decimal - cgb_yield_decimal

    return {
        "hs300_erp": {
            "formula": "(1 / hs300_pe_ttm) - cn_10y_cgb_yield_decimal",
            "inputs": {
                "hs300_pe_ttm": round(hs300_pe, 4),
                "earnings_yield_decimal": round_or_none(earnings_yield_decimal, 8),
                "cn_10y_cgb_yield_decimal": round_or_none(cgb_yield_decimal, 8),
            },
            "value_decimal": round_or_none(erp_decimal, 8),
            "value_pct": round_or_none(erp_decimal * 100.0, 4),
            "value_bp": round_or_none(erp_decimal * 10000.0, 2),
            "valuation_as_of_date": hs300_valuation.get("pe_as_of_date"),
            "yield_as_of_date": ten_year_cgb.get("as_of_date"),
        },
        "csi_dividend_spread": {
            "formula": "csi_dividend_yield_decimal - cn_10y_cgb_yield_decimal",
            "inputs": {
                "csi_dividend_yield_decimal": round_or_none(dividend_yield_decimal, 8),
                "cn_10y_cgb_yield_decimal": round_or_none(cgb_yield_decimal, 8),
            },
            "value_decimal": round_or_none(dividend_spread_decimal, 8),
            "value_pct": round_or_none(dividend_spread_decimal * 100.0, 4),
            "value_bp": round_or_none(dividend_spread_decimal * 10000.0, 2),
            "valuation_as_of_date": dividend_valuation.get("dividend_as_of_date"),
            "yield_as_of_date": ten_year_cgb.get("as_of_date"),
        },
    }


def save_macro_state(payload: dict[str, Any], output_path: Path = OUTPUT_PATH) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def update_manifest(*, manifest_path: Path, output_path: Path) -> None:
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["macro_state_script"] = str(SCRIPT_DIR / "generate_macro_state.py")
    canonical["latest_macro_state"] = str(output_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fallback_or_raise(
    *,
    key: str,
    fetcher: Callable[[], dict[str, Any]],
    previous_item: dict[str, Any] | None,
    allow_previous_fallback: bool,
    errors: list[dict[str, Any]],
    generated_at: str,
) -> dict[str, Any] | None:
    try:
        return fetcher()
    except Exception as exc:
        error_message = str(exc)
        if allow_previous_fallback and previous_item:
            errors.append(
                {
                    "component": key,
                    "severity": "warning",
                    "error": error_message,
                    "fallback_to_previous_state": True,
                }
            )
            return clone_previous_item(previous_item, error_message, generated_at)

        errors.append(
            {
                "component": key,
                "severity": "error",
                "error": error_message,
                "fallback_to_previous_state": False,
            }
        )
        return None


def derive_status(*, errors: list[dict[str, Any]], used_previous_fallback: bool, factors_ready: bool) -> str:
    if factors_ready and not errors:
        return "ok"
    if factors_ready and used_previous_fallback:
        return "partial_fallback"
    if factors_ready:
        return "degraded"
    if used_previous_fallback:
        return "fallback_only"
    return "error"


def main() -> int:
    global MANIFEST_PATH
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    MANIFEST_PATH = portfolio_root / "state-manifest.json"
    output_path = Path(args.output) if args.output else portfolio_root / "data" / "macro_state.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    generated_at = format_now()
    previous_state = load_previous_macro_state(output_path)
    previous_generated_at = previous_state.get("generated_at") if previous_state else None
    allow_previous_fallback = not args.disable_previous_fallback
    errors: list[dict[str, Any]] = []

    ten_year_cgb = fallback_or_raise(
        key="ten_year_cgb",
        fetcher=lambda: fetch_10y_cgb_yield(
            max_retries=args.max_retries,
            base_delay=args.retry_base_delay,
        ),
        previous_item=(previous_state or {}).get("ten_year_cgb"),
        allow_previous_fallback=allow_previous_fallback,
        errors=errors,
        generated_at=previous_generated_at or generated_at,
    )

    hs300_valuation = fallback_or_raise(
        key="index_000300",
        fetcher=lambda: fetch_index_valuation(
            "000300",
            max_retries=args.max_retries,
            base_delay=args.retry_base_delay,
        ),
        previous_item=((previous_state or {}).get("indices") or {}).get("000300"),
        allow_previous_fallback=allow_previous_fallback,
        errors=errors,
        generated_at=previous_generated_at or generated_at,
    )

    dividend_valuation = fallback_or_raise(
        key="index_000922",
        fetcher=lambda: fetch_index_valuation(
            "000922",
            max_retries=args.max_retries,
            base_delay=args.retry_base_delay,
        ),
        previous_item=((previous_state or {}).get("indices") or {}).get("000922"),
        allow_previous_fallback=allow_previous_fallback,
        errors=errors,
        generated_at=previous_generated_at or generated_at,
    )

    used_previous_fallback = any(item.get("fallback_to_previous_state") for item in errors)

    factors: dict[str, Any] = {}
    if ten_year_cgb and hs300_valuation and dividend_valuation:
        try:
            factors = calculate_erp_and_spread(ten_year_cgb, hs300_valuation, dividend_valuation)
        except Exception as exc:
            if allow_previous_fallback and previous_state and previous_state.get("factors"):
                factors = copy.deepcopy(previous_state["factors"])
                factors["fallback_used"] = True
                factors["fallback_source"] = {
                    "type": "previous_macro_state",
                    "generated_at": previous_generated_at,
                    "reason": str(exc),
                }
                used_previous_fallback = True
                errors.append(
                    {
                        "component": "factor_calculation",
                        "severity": "warning",
                        "error": str(exc),
                        "fallback_to_previous_state": True,
                    }
                )
            else:
                errors.append(
                    {
                        "component": "factor_calculation",
                        "severity": "error",
                        "error": str(exc),
                        "fallback_to_previous_state": False,
                    }
                )

    stale_fields = [
        key
        for key, item in {
            "ten_year_cgb": ten_year_cgb,
            "index_000300_pe": hs300_valuation,
            "index_000922_dividend": dividend_valuation,
        }.items()
        if isinstance(item, dict) and item.get("fallback_used")
    ]

    payload = {
        "version": 1,
        "generated_at": generated_at,
        "layer_role": "macro_anchor_state",
        "status": derive_status(
            errors=errors,
            used_previous_fallback=used_previous_fallback,
            factors_ready=bool(factors),
        ),
        "source": {
            "primary": [
                "AkShare bond_zh_us_rate",
                "AkShare bond_gb_zh_sina",
                "AkShare stock_index_pe_lg",
                "AkShare stock_zh_index_value_csindex",
            ],
            "selection_note": "10Y 国债优先取 bond_zh_us_rate；沪深300 PE 优先取 stock_index_pe_lg 的滚动市盈率；股息率优先取中证指数官方估值表 stock_zh_index_value_csindex 的股息率1。",
        },
        "retry_policy": {
            "max_retries": args.max_retries,
            "base_delay_seconds": args.retry_base_delay,
            "strategy": "exponential_backoff",
        },
        "ten_year_cgb": ten_year_cgb,
        "indices": {
            "000300": hs300_valuation,
            "000922": dividend_valuation,
        },
        "factors": factors,
        "data_quality": {
            "used_previous_state_fallback": used_previous_fallback,
            "previous_state_path": str(output_path) if previous_state else None,
            "stale_fields": stale_fields,
            "errors": errors,
        },
    }

    save_macro_state(payload, output_path)
    update_manifest(manifest_path=MANIFEST_PATH, output_path=output_path)
    print(
        json.dumps(
            {
                "accountId": account_id,
                "portfolioRoot": str(portfolio_root),
                "outputPath": str(output_path),
                "status": payload["status"],
                "errorCount": len(errors),
                "usedPreviousFallback": used_previous_fallback,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
