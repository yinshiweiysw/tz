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

LOOKBACK_DAYS = 252
CHANGE_WINDOW_DAYS = 60
DOWNLOAD_PERIOD = "2y"
MIN_SERIES_POINTS = 180

YIELD_STEEPENING_PREV_NEGATIVE_PCT = -0.25
YIELD_STEEPENING_DELTA_PCT = 0.25
CREDIT_CRISIS_PERCENTILE = 10.0
VIX_CRISIS_LEVEL = 25.0
GROWTH_RECESSION_PERCENTILE = 20.0
FX_SQUEEZE_CHANGE_60D_PCT = 2.0
USD_HEADWIND_DXY_PERCENTILE = 80.0
USD_HEADWIND_DXY_CHANGE_60D_PCT = 1.0


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


SERIES_CONFIG: dict[str, dict[str, Any]] = {
    "tnx": {
        "label": "10Y Treasury Yield",
        "candidates": ["^TNX"],
        "field_preference": ["Adj Close", "Close"],
        "scale": 0.1,
        "min_points": MIN_SERIES_POINTS,
    },
    "irx": {
        "label": "3M Treasury Yield",
        "candidates": ["^IRX"],
        "field_preference": ["Adj Close", "Close"],
        "scale": 0.1,
        "min_points": MIN_SERIES_POINTS,
    },
    "vix": {
        "label": "VIX",
        "candidates": ["^VIX"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "hyg": {
        "label": "High Yield Bond ETF",
        "candidates": ["HYG"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "ief": {
        "label": "7-10Y Treasury ETF",
        "candidates": ["IEF"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "copper": {
        "label": "Copper Futures",
        "candidates": ["HG=F"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "gold": {
        "label": "Gold Futures",
        "candidates": ["GC=F"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "oil": {
        "label": "Crude Oil Futures",
        "candidates": ["CL=F"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "dxy": {
        "label": "US Dollar Index",
        "candidates": ["DX-Y.NYB"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
    },
    "usdcnh": {
        "label": "Offshore RMB Proxy",
        "candidates": ["USDCNH=X", "CNH=X", "USDCNY=X"],
        "field_preference": ["Adj Close", "Close"],
        "min_points": MIN_SERIES_POINTS,
        "proxy_note": "Yahoo 的 USDCNH/CNH 历史序列存在明显缺口；若离岸口径不可用，则自动降级为 USDCNY=X 作为跨境美元流动性代理。",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate institutional macro radar from Yahoo Finance series."
    )
    parser.add_argument("--portfolio-root", default="", help="Override portfolio root")
    parser.add_argument("--db", default="", help="Override market_lake.db path")
    parser.add_argument("--output", default="", help="Override output json path")
    parser.add_argument("--lookback-days", type=int, default=LOOKBACK_DAYS)
    parser.add_argument("--change-window", type=int, default=CHANGE_WINDOW_DAYS)
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


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_series_from_db(
    connection: sqlite3.Connection,
    config_key: str,
    config: dict[str, Any],
    lookback_days: int,
) -> dict[str, Any]:
    last_error: str | None = None

    for ticker in config["candidates"]:
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
                ORDER BY date DESC
                LIMIT ?
                """,
                (ticker, lookback_days),
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
            scale = float(config.get("scale", 1.0))
            if scale != 1.0:
                series = series * scale

            if len(series) < int(config.get("min_points", MIN_SERIES_POINTS)):
                last_error = f"{ticker}: insufficient history ({len(series)} points)"
                continue

            return {
                "key": config_key,
                "label": config["label"],
                "ticker_requested": config["candidates"][0],
                "ticker_used": ticker,
                "field": "close",
                "series": series,
                "history_points_total": int(total_rows),
                "history_points_window": int(len(series)),
                "proxy_note": config.get("proxy_note"),
                "used_fallback": ticker != config["candidates"][0],
            }
        except Exception as exc:  # pragma: no cover
            last_error = f"{ticker}: {exc!r}"

    raise RuntimeError(last_error or f"{config_key}: all ticker candidates failed")


def open_market_lake_connection(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"market lake not found: {db_path}")
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def align_series(left: pd.Series, right: pd.Series, lookback_days: int) -> pd.DataFrame:
    pair = pd.concat([left.rename("left"), right.rename("right")], axis=1).dropna()
    if len(pair) < lookback_days:
        pair = pair.copy()
    sample = pair.tail(lookback_days)
    if sample.empty:
        raise ValueError("aligned sample is empty")
    return sample


def empirical_percentile(series: pd.Series) -> float:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    current = float(clean.iloc[-1])
    return float((clean <= current).mean() * 100)


def pct_change_from_window(series: pd.Series, change_window: int) -> float:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    if len(clean) <= change_window:
        raise ValueError("insufficient points for change window")
    current = float(clean.iloc[-1])
    previous = float(clean.iloc[-(change_window + 1)])
    if math.isclose(previous, 0.0):
        raise ValueError("previous value is zero")
    return ((current / previous) - 1.0) * 100.0


def to_bps(percentage_points: float) -> float:
    return percentage_points * 100.0


def build_yield_curve_dimension(
    tnx_series: pd.Series,
    irx_series: pd.Series,
    change_window: int,
    tnx_meta: dict[str, Any],
    irx_meta: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    alerts: list[dict[str, Any]] = []
    pair = align_series(tnx_series, irx_series, LOOKBACK_DAYS)
    spread = pair["left"] - pair["right"]

    current_spread = float(spread.iloc[-1])
    previous_spread = float(spread.iloc[-(change_window + 1)])
    spread_change = current_spread - previous_spread

    steepening_warning = (
        previous_spread <= YIELD_STEEPENING_PREV_NEGATIVE_PCT and spread_change >= YIELD_STEEPENING_DELTA_PCT
    ) or (
        previous_spread <= -0.1 and current_spread >= 0 and spread_change >= 0.15
    )

    if steepening_warning:
        state = "steepening_warning"
        headline = "收益率曲线由深度倒挂快速修复，降息预期正在抢跑。"
        alerts.append(
            {
                "severity": "warning",
                "dimension": "yield_curve",
                "message": "⚠️ 极度警惕：收益率曲线陡峭化（降息预期抢跑），历史衰退高危期。"
            }
        )
    elif current_spread < 0:
        state = "inverted"
        headline = "10Y-3M 仍处倒挂区间，流动性定价尚未走出后周期压力。"
    else:
        state = "late_cycle_normalization"
        headline = "曲线已回到正利差，但暂未出现典型衰退式急剧陡峭化。"

    brief = (
        f"流动性 / 收益率曲线：10Y-3M 当前 {round_or_none(to_bps(current_spread), 2)}bp，"
        f"较 60 个交易日前变动 {round_or_none(to_bps(spread_change), 2):+}bp。"
        f"{headline}"
    )

    return (
        {
            "state": state,
            "brief": brief,
            "signal_date": spread.index[-1].strftime("%Y-%m-%d"),
            "current_spread_pct": round_or_none(current_spread, 4),
            "current_spread_bps": round_or_none(to_bps(current_spread), 2),
            "spread_60d_ago_pct": round_or_none(previous_spread, 4),
            "spread_change_60d_bps": round_or_none(to_bps(spread_change), 2),
            "tnx_current_pct": round_or_none(pair["left"].iloc[-1], 3),
            "irx_current_pct": round_or_none(pair["right"].iloc[-1], 3),
            "tnx_ticker": tnx_meta["ticker_used"],
            "irx_ticker": irx_meta["ticker_used"],
        },
        alerts,
    )


def build_credit_dimension(
    hyg_series: pd.Series,
    ief_series: pd.Series,
    vix_series: pd.Series,
    hyg_meta: dict[str, Any],
    ief_meta: dict[str, Any],
    vix_meta: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    alerts: list[dict[str, Any]] = []
    pair = align_series(hyg_series, ief_series, LOOKBACK_DAYS)
    ratio = (pair["left"] / pair["right"]).dropna().tail(LOOKBACK_DAYS)
    vix_sample = vix_series.dropna().tail(LOOKBACK_DAYS)

    ratio_percentile = empirical_percentile(ratio)
    vix_current = float(vix_sample.iloc[-1])

    if ratio_percentile <= CREDIT_CRISIS_PERCENTILE and vix_current > VIX_CRISIS_LEVEL:
        state = "systemic_credit_tightening"
        headline = "垃圾债/国债比值已跌入一年低位，且 VIX 升破高波区间，信用 beta 与权益波动同步恶化。"
        alerts.append(
            {
                "severity": "critical",
                "dimension": "credit_radar",
                "message": "🚨 系统性信用紧缩：垃圾债遭遇抛售，流动性危机爆发！严禁做多高波动资产！"
            }
        )
    elif ratio_percentile <= 25 or vix_current > VIX_CRISIS_LEVEL:
        state = "fragile_risk_appetite"
        headline = "波动率抬升已较为明显，但信用 beta 尚未确认进入崩塌式收缩。"
    else:
        state = "stable_credit"
        headline = "信用资产与中期国债相对表现稳定，暂未看到系统性信用踩踏。"

    brief = (
        f"信用 / 风险偏好：HYG/IEF 位于近 1 年 {round_or_none(ratio_percentile, 2)}% 分位，"
        f"VIX 当前 {round_or_none(vix_current, 2)}。{headline}"
    )

    return (
        {
            "state": state,
            "brief": brief,
            "signal_date": ratio.index[-1].strftime("%Y-%m-%d"),
            "hyg_ief_ratio_current": round_or_none(ratio.iloc[-1], 4),
            "hyg_ief_ratio_percentile_1y": round_or_none(ratio_percentile, 2),
            "vix_current": round_or_none(vix_current, 2),
            "vix_percentile_1y": round_or_none(empirical_percentile(vix_sample), 2),
            "hyg_ticker": hyg_meta["ticker_used"],
            "ief_ticker": ief_meta["ticker_used"],
            "vix_ticker": vix_meta["ticker_used"],
        },
        alerts,
    )


def build_growth_dimension(
    copper_series: pd.Series,
    gold_series: pd.Series,
    oil_series: pd.Series,
    copper_meta: dict[str, Any],
    gold_meta: dict[str, Any],
    oil_meta: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    alerts: list[dict[str, Any]] = []
    pair = align_series(copper_series, gold_series, LOOKBACK_DAYS)
    copper_gold = (pair["left"] / pair["right"]).dropna().tail(LOOKBACK_DAYS)
    oil_sample = oil_series.dropna().tail(LOOKBACK_DAYS)

    copper_gold_percentile = empirical_percentile(copper_gold)
    oil_percentile = empirical_percentile(oil_sample)

    if copper_gold_percentile < GROWTH_RECESSION_PERCENTILE:
        state = "recession_fear"
        headline = "铜金比已压至一年低分位，增长定价偏向衰退交易。"
    elif copper_gold_percentile > 80:
        state = "reflation_reacceleration"
        headline = "铜金比回到高分位，市场更接近再通胀 / 再加速交易。"
    else:
        state = "balanced_growth"
        headline = "增长与避险资产相对定价处于中性区，暂未形成单边宏观叙事。"

    if oil_percentile > 80 and copper_gold_percentile < 35:
        headline = f"{headline} 同时油价分位偏高，需额外提防供给扰动带来的类滞胀噪音。"

    brief = (
        f"增长 / 宏观基本面：铜金比位于近 1 年 {round_or_none(copper_gold_percentile, 2)}% 分位，"
        f"原油位于 {round_or_none(oil_percentile, 2)}% 分位。{headline}"
    )

    return (
        {
            "state": state,
            "brief": brief,
            "signal_date": copper_gold.index[-1].strftime("%Y-%m-%d"),
            "copper_gold_ratio_current": round_or_none(copper_gold.iloc[-1], 6),
            "copper_gold_ratio_percentile_1y": round_or_none(copper_gold_percentile, 2),
            "oil_current": round_or_none(oil_sample.iloc[-1], 2),
            "oil_percentile_1y": round_or_none(oil_percentile, 2),
            "copper_ticker": copper_meta["ticker_used"],
            "gold_ticker": gold_meta["ticker_used"],
            "oil_ticker": oil_meta["ticker_used"],
        },
        alerts,
    )


def build_capital_dimension(
    dxy_series: pd.Series,
    usdcnh_series: pd.Series,
    change_window: int,
    dxy_meta: dict[str, Any],
    usdcnh_meta: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    alerts: list[dict[str, Any]] = []
    dxy_sample = dxy_series.dropna().tail(LOOKBACK_DAYS)
    fx_sample = usdcnh_series.dropna().tail(LOOKBACK_DAYS)

    fx_change_60d = pct_change_from_window(fx_sample, change_window)
    dxy_change_60d = pct_change_from_window(dxy_sample, change_window)
    dxy_percentile = empirical_percentile(dxy_sample)

    if fx_change_60d >= FX_SQUEEZE_CHANGE_60D_PCT:
        state = "offshore_liquidity_squeeze"
        headline = "人民币对美元出现较明显贬值，跨境美元流动性对风险资产构成约束。"
    elif dxy_percentile >= USD_HEADWIND_DXY_PERCENTILE and dxy_change_60d >= USD_HEADWIND_DXY_CHANGE_60D_PCT:
        state = "usd_headwind"
        headline = "美元指数维持高位且继续走强，外部流动性环境偏紧，但人民币尚未出现失序贬值。"
    else:
        state = "stable_cross_border_liquidity"
        headline = "汇率与美元条件整体可控，暂未看到离岸流动性被动抽紧。"

    if state == "offshore_liquidity_squeeze":
        alerts.append(
            {
                "severity": "warning",
                "dimension": "capital_flow",
                "message": "⚠️ Offshore_Liquidity_Squeeze：离岸人民币显著走弱，外资与高波资产承压，需提高美元流动性敏感资产的仓位门槛。"
            }
        )

    fallback_note = None
    if usdcnh_meta["used_fallback"]:
        fallback_note = usdcnh_meta.get("proxy_note")

    brief = (
        f"资金 / 外资流动：{usdcnh_meta['ticker_used']} 较 60 个交易日前变动 {round_or_none(fx_change_60d, 2):+}% ，"
        f"DXY 位于近 1 年 {round_or_none(dxy_percentile, 2)}% 分位，60 日变动 {round_or_none(dxy_change_60d, 2):+}%。"
        f"{headline}"
    )
    if fallback_note:
        brief = f"{brief}（汇率口径已降级使用在岸代理）"

    return (
        {
            "state": state,
            "brief": brief,
            "signal_date": min(dxy_sample.index[-1], fx_sample.index[-1]).strftime("%Y-%m-%d"),
            "fx_pair_requested": usdcnh_meta["ticker_requested"],
            "fx_pair_used": usdcnh_meta["ticker_used"],
            "fx_current": round_or_none(fx_sample.iloc[-1], 4),
            "fx_change_60d_pct": round_or_none(fx_change_60d, 2),
            "dxy_current": round_or_none(dxy_sample.iloc[-1], 2),
            "dxy_percentile_1y": round_or_none(dxy_percentile, 2),
            "dxy_change_60d_pct": round_or_none(dxy_change_60d, 2),
            "fx_proxy_note": fallback_note,
        },
        alerts,
    )


def build_overall_assessment(
    yield_curve: dict[str, Any],
    credit: dict[str, Any],
    growth: dict[str, Any],
    capital: dict[str, Any],
    alerts: list[dict[str, Any]],
) -> dict[str, Any]:
    critical_count = len([item for item in alerts if item.get("severity") == "critical"])
    warning_count = len([item for item in alerts if item.get("severity") == "warning"])

    if critical_count > 0:
        state = "defensive_max"
        summary = "宏观气候进入高压防守区，信用与流动性约束优先级高于任何进攻型配置。"
    elif credit["state"] == "fragile_risk_appetite" or capital["state"] == "usd_headwind":
        state = "defensive_bias"
        summary = "宏观环境偏防守，波动与美元约束仍在，适合保持高波资产的仓位纪律。"
    elif growth["state"] == "reflation_reacceleration" and yield_curve["state"] == "late_cycle_normalization":
        state = "balanced_to_constructive"
        summary = "流动性与增长信号尚可，宏观环境可维持中性偏建设性观察。"
    else:
        state = "neutral_balanced"
        summary = "宏观线索暂未共振成单一风险情景，组合仍以结构优化与择时纪律为主。"

    if warning_count > 0 and critical_count == 0 and state == "neutral_balanced":
        state = "cautious_neutral"
        summary = "宏观并未全面失控，但已有局部警报抬头，宜保持谨慎中性仓位。"

    return {
        "state": state,
        "summary": summary,
        "critical_alert_count": critical_count,
        "warning_alert_count": warning_count,
    }


def update_manifest(portfolio_root: Path, output_path: Path) -> None:
    manifest_path = portfolio_root / "state-manifest.json"
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["macro_radar_script"] = str(Path(__file__).resolve())
    canonical["latest_macro_radar"] = str(output_path)
    manifest_path.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    default_output_dir = portfolio_root / "data"
    output_path = Path(args.output).expanduser() if args.output else default_output_dir / "macro_radar.json"
    db_path = Path(args.db).expanduser() if args.db else default_output_dir / "market_lake.db"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    series_payload: dict[str, Any] = {}
    errors: list[dict[str, Any]] = []

    with open_market_lake_connection(db_path) as connection:
        for key, config in SERIES_CONFIG.items():
            try:
                series_payload[key] = load_series_from_db(
                    connection=connection,
                    config_key=key,
                    config=config,
                    lookback_days=args.lookback_days,
                )
            except Exception as exc:  # pragma: no cover
                errors.append(
                    {
                        "series_key": key,
                        "label": config.get("label"),
                        "error": repr(exc),
                    }
                )

    if errors:
        payload = {
            "version": 1,
            "generated_at": format_now(),
            "layer_role": "institutional_macro_radar",
            "errors": errors,
            "source": {
                "primary": ["Local SQLite market_lake daily_prices"]
            }
        }
        output_path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        update_manifest(portfolio_root, output_path)
        print(
            json.dumps(
                {
                    "outputPath": str(output_path),
                    "errorCount": len(errors),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    yield_curve, yield_alerts = build_yield_curve_dimension(
        series_payload["tnx"]["series"],
        series_payload["irx"]["series"],
        args.change_window,
        series_payload["tnx"],
        series_payload["irx"],
    )
    credit, credit_alerts = build_credit_dimension(
        series_payload["hyg"]["series"],
        series_payload["ief"]["series"],
        series_payload["vix"]["series"],
        series_payload["hyg"],
        series_payload["ief"],
        series_payload["vix"],
    )
    growth, growth_alerts = build_growth_dimension(
        series_payload["copper"]["series"],
        series_payload["gold"]["series"],
        series_payload["oil"]["series"],
        series_payload["copper"],
        series_payload["gold"],
        series_payload["oil"],
    )
    capital, capital_alerts = build_capital_dimension(
        series_payload["dxy"]["series"],
        series_payload["usdcnh"]["series"],
        args.change_window,
        series_payload["dxy"],
        series_payload["usdcnh"],
    )

    alerts = [*yield_alerts, *credit_alerts, *growth_alerts, *capital_alerts]
    overall_assessment = build_overall_assessment(yield_curve, credit, growth, capital, alerts)

    series_sources = {
        key: {
            "label": value["label"],
            "ticker_requested": value["ticker_requested"],
            "ticker_used": value["ticker_used"],
            "field": value["field"],
            "history_points_total": value["history_points_total"],
            "history_points_window": value["history_points_window"],
            "used_fallback": value["used_fallback"],
            "proxy_note": value.get("proxy_note"),
        }
        for key, value in series_payload.items()
    }

    payload = {
        "version": 1,
        "generated_at": format_now(),
        "layer_role": "institutional_macro_radar",
        "source": {
            "primary": ["Local SQLite market_lake daily_prices"],
            "note": "宏观雷达聚焦流动性、信用、增长与资金四个维度，直接读取本地数据湖中的最近 252 个交易日数据进行状态识别。",
        },
        "parameters": {
            "lookback_days": args.lookback_days,
            "change_window_days": args.change_window,
            "download_period": args.period,
            "yield_curve_steepening_rule": {
                "previous_spread_lte_pct": YIELD_STEEPENING_PREV_NEGATIVE_PCT,
                "spread_change_gte_pct": YIELD_STEEPENING_DELTA_PCT,
            },
            "credit_crisis_rule": {
                "hyg_ief_percentile_lte": CREDIT_CRISIS_PERCENTILE,
                "vix_gt": VIX_CRISIS_LEVEL,
            },
            "growth_recession_rule": {
                "copper_gold_percentile_lt": GROWTH_RECESSION_PERCENTILE,
            },
            "offshore_liquidity_rule": {
                "fx_change_60d_pct_gte": FX_SQUEEZE_CHANGE_60D_PCT,
            },
        },
        "series_sources": series_sources,
        "overall_assessment": overall_assessment,
        "alerts": alerts,
        "dimensions": {
            "yield_curve": yield_curve,
            "credit_radar": credit,
            "growth_radar": growth,
            "capital_flow": capital,
        },
        "errors": [],
    }

    output_path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    update_manifest(portfolio_root, output_path)
    print(
        json.dumps(
            {
                "outputPath": str(output_path),
                "alertCount": len(alerts),
                "overallState": overall_assessment["state"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
