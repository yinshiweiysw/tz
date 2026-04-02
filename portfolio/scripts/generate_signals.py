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
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_account_id, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = resolve_portfolio_root()
DEFAULT_ASSET_MASTER_PATH = PORTFOLIO_ROOT / "config" / "asset_master.json"
ACCOUNT_CONTEXT_PATH = PORTFOLIO_ROOT / "account_context.json"
MACRO_STATE_PATH = PORTFOLIO_ROOT / "data" / "macro_state.json"
DB_PATH = PORTFOLIO_ROOT / "data" / "market_lake.db"
OUTPUT_PATH = PORTFOLIO_ROOT / "signals" / "regime_router_signals.json"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

DEFAULT_SHORT_SIGNAL_WINDOW = 20
DEFAULT_ATR_WINDOW = 14

DEFAULT_POLICY = {
    "macro_momentum_full_fraction": 1.0,
    "macro_momentum_watch_fraction": 0.5,
    "target_volatility_probe_fraction": 0.25,
    "target_volatility_idle_fraction": 0.1,
    "erp_accumulate_threshold_pct": 5.5,
    "erp_danger_threshold_pct": 3.5,
    "erp_accumulate_fraction": 1.0,
    "erp_right_side_fraction": 0.35,
    "erp_neutral_fraction": 0.75,
    "dividend_safe_spread_pct": 2.0,
    "dividend_crowded_spread_pct": 1.0,
    "dividend_base_fraction": 1.0,
    "dividend_mid_fraction": 0.75,
    "dividend_trimmed_fraction": 0.5,
}

BUCKET_A_CORE = "A_CORE"
BUCKET_GLB_MOM = "GLB_MOM"
BUCKET_INCOME = "INCOME"
BUCKET_HEDGE = "HEDGE"
BUCKET_TACTICAL = "TACTICAL"
BUCKET_CASH = "CASH"


def ensure_runtime() -> None:
    if os.environ.get("SIGNAL_ROUTER_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import pandas  # noqa: F401
            import ta  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["SIGNAL_ROUTER_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import pandas as pd  # noqa: E402
from ta.volatility import AverageTrueRange  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate regime-aware signal routing output from asset_master and macro_state."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--asset-master", default="")
    parser.add_argument("--account-context", default="")
    parser.add_argument("--macro-state", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--output", default="")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_json_or_none(path: Path) -> dict[str, Any] | None:
    try:
        return read_json(path)
    except Exception:
        return None


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


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


def clamp(value: Any, lower: float = 0.0, upper: float = 1.0) -> float:
    numeric = safe_float(value)
    if numeric is None:
        return lower
    return max(lower, min(upper, numeric))


def round_money(value: Any) -> float:
    numeric = safe_float(value) or 0.0
    return round(numeric, 2)


def update_manifest(*, manifest_path: Path, output_path: Path) -> None:
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["signal_router_script"] = str(SCRIPT_DIR / "generate_signals.py")
    canonical["latest_regime_router_signals"] = str(output_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class SignalRouter:
    def __init__(
        self,
        asset_master_path: Path,
        account_context_path: Path,
        macro_state_path: Path,
        db_path: Path,
        *,
        policy_overrides: dict[str, Any] | None = None,
    ) -> None:
        self.asset_master_path = asset_master_path
        self.account_context_path = account_context_path
        self.macro_state_path = macro_state_path
        self.db_path = db_path
        self.asset_master = read_json(asset_master_path)
        self.account_context = read_json(account_context_path)
        self.macro_state = read_json(macro_state_path)
        self.policy = {**DEFAULT_POLICY, **(policy_overrides or {})}
        self.short_signal_window = DEFAULT_SHORT_SIGNAL_WINDOW
        self.atr_window = DEFAULT_ATR_WINDOW

        assets = self.asset_master.get("assets")
        if not isinstance(assets, list) or not assets:
            raise ValueError(f"asset master missing assets[]: {asset_master_path}")
        self.assets = assets
        self.global_constraints = self._load_global_constraints()
        self.bucket_configs = self._load_bucket_configs()
        configured_order = self.asset_master.get("bucket_order") or list(self.bucket_configs)
        self.bucket_order = [bucket_key for bucket_key in configured_order if bucket_key in self.bucket_configs]
        self.assets_by_bucket = self._group_assets_by_bucket()
        self.total_portfolio_value = self._resolve_total_portfolio_value()
        self.dynamic_risk_budget: dict[str, Any] = {}

    def route_all(self) -> dict[str, Any]:
        payload = {
            "version": 3,
            "generated_at": format_now(),
            "layer_role": "regime_signal_router",
            "source": {
                "asset_master": str(self.asset_master_path),
                "account_context": str(self.account_context_path),
                "macro_state": str(self.macro_state_path),
                "market_lake_db": str(self.db_path),
            },
            "risk_budget": self.dynamic_risk_budget,
            "signals": {},
            "errors": [],
        }

        raw_signals: list[dict[str, Any]] = []
        with sqlite3.connect(self.db_path) as connection:
            for asset in self.assets:
                if asset.get("signal_enabled") is False:
                    continue
                symbol = str(asset.get("symbol") or "").strip()
                market_data_symbol = str(
                    asset.get("signal_proxy_symbol")
                    or asset.get("ticker")
                    or symbol
                ).strip()
                try:
                    prices = self._load_price_history(connection, market_data_symbol)
                    signal = self.route_asset(asset, prices)
                    signal["market_data_symbol"] = market_data_symbol
                    signal["execution_symbol"] = str(asset.get("ticker") or symbol).strip()
                    signal["execution_price_snapshot"] = self._resolve_execution_price_snapshot(
                        connection,
                        asset=asset,
                        proxy_prices=prices,
                    )
                    raw_signals.append(signal)
                except Exception as exc:
                    payload["errors"].append(
                        {
                            "symbol": symbol,
                            "name": asset.get("name"),
                            "market_data_symbol": market_data_symbol,
                            "message": str(exc),
                }
                    )

        self.dynamic_risk_budget = self.get_dynamic_risk_budget(raw_signals)
        payload["risk_budget"] = self.dynamic_risk_budget

        for signal in self._apply_execution_projection(self._apply_bucket_budget(raw_signals)):
            payload["signals"][signal["symbol"]] = signal

        return payload

    def route_asset(self, asset: dict[str, Any], prices: pd.DataFrame) -> dict[str, Any]:
        regime = (asset.get("strategy_regime") or {}).get("type")

        if regime == "macro_momentum":
            result = self._evaluate_macro_momentum(asset, prices)
        elif regime == "target_volatility":
            result = self._evaluate_target_volatility(asset, prices)
        elif regime == "erp_mean_reversion":
            result = self._evaluate_erp_mean_reversion(asset, prices)
        elif regime == "dividend_carry":
            result = self._evaluate_dividend_carry(asset, prices)
        else:
            raise ValueError(f"unsupported regime type: {regime}")

        return {
            "symbol": asset.get("symbol"),
            "name": asset.get("name"),
            "bucket": asset.get("bucket"),
            "execution_type": asset.get("execution_type") or "OTC",
            "ticker": asset.get("ticker"),
            "settlement_rule": asset.get("settlement_rule"),
            "lot_size": int(asset.get("lot_size") or 100),
            "slippage_buffer": round_or_none(asset.get("slippage_buffer"), 4),
            "portfolio_role": asset.get("portfolio_role"),
            "hedge_sleeve_type": asset.get("hedge_sleeve_type"),
            "bucket_target_bias": round_or_none(asset.get("bucket_target_bias"), 4),
            "portfolio_weight_cap": round_or_none(asset.get("portfolio_weight_cap"), 4),
            "regime_type": regime,
            **result,
        }

    def _evaluate_macro_momentum(self, asset: dict[str, Any], prices: pd.DataFrame) -> dict[str, Any]:
        regime = asset["strategy_regime"]
        long_ma_window = int(regime["trend_filter"]["moving_average"])
        atr_threshold = safe_float(regime["risk_control"].get("max_atr_threshold"))
        snapshot = self._build_technical_snapshot(prices, long_ma_window=long_ma_window)

        reasons: list[str] = []
        current_price = snapshot["current_price"]
        long_ma = snapshot["long_ma"]
        atr_pct = snapshot["atr_pct"]

        if current_price is None or long_ma is None:
            return self._build_signal(
                action="Hold",
                requested_bucket_fraction=0.0,
                reasons=["insufficient history for macro_momentum long moving average"],
                technical_snapshot=snapshot,
            )

        if current_price < long_ma:
            reasons.append("price below long moving average, exit to defense")
            return self._build_signal(
                action="Sell",
                requested_bucket_fraction=0.0,
                reasons=reasons,
                technical_snapshot=snapshot,
            )

        if atr_threshold is not None and atr_pct is not None and atr_pct > atr_threshold:
            reasons.append("trend is positive but ATR is above risk budget, keep reduced weight")
            return self._build_signal(
                action="Hold",
                requested_bucket_fraction=self.policy["macro_momentum_watch_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
            )

        if snapshot["short_breakout"]:
            reasons.append("price above long moving average and short breakout confirmed")
            return self._build_signal(
                action="Buy",
                requested_bucket_fraction=self.policy["macro_momentum_full_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
            )

        reasons.append("price above long moving average and volatility is normal")
        return self._build_signal(
            action="Hold",
            requested_bucket_fraction=self.policy["macro_momentum_full_fraction"],
            reasons=reasons,
            technical_snapshot=snapshot,
        )

    def _evaluate_target_volatility(self, asset: dict[str, Any], prices: pd.DataFrame) -> dict[str, Any]:
        regime = asset["strategy_regime"]
        long_ma_window = int(regime["trend_filter"]["moving_average"])
        atr_threshold = safe_float(regime["risk_control"].get("max_atr_threshold"))
        kill_switch_enabled = bool(regime["risk_control"].get("kill_switch_enabled"))
        snapshot = self._build_technical_snapshot(prices, long_ma_window=long_ma_window)

        reasons: list[str] = []
        atr_pct = snapshot["atr_pct"]

        if atr_pct is None:
            return self._build_signal(
                action="Hold",
                requested_bucket_fraction=0.0,
                reasons=["insufficient ATR history for target_volatility routing"],
                technical_snapshot=snapshot,
            )

        if kill_switch_enabled and atr_threshold is not None and atr_pct > atr_threshold:
            reasons.append("ATR above max threshold, trigger kill switch and force de-risk")
            return self._build_signal(
                action="Kill_Switch",
                requested_bucket_fraction=0.0,
                reasons=reasons,
                technical_snapshot=snapshot,
            )

        if (
            atr_threshold is not None
            and atr_pct <= atr_threshold * 0.6
            and snapshot["short_breakout"]
        ):
            reasons.append("ATR back to low regime and short moving average breakout allows pilot entry")
            return self._build_signal(
                action="Buy",
                requested_bucket_fraction=self.policy["target_volatility_probe_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
            )

        reasons.append("volatility normalized but no clean breakout, keep only minimal participation")
        return self._build_signal(
            action="Hold",
            requested_bucket_fraction=self.policy["target_volatility_idle_fraction"],
            reasons=reasons,
            technical_snapshot=snapshot,
        )

    def _evaluate_erp_mean_reversion(self, asset: dict[str, Any], prices: pd.DataFrame) -> dict[str, Any]:
        regime = asset["strategy_regime"]
        long_ma_window = int(regime["trend_filter"]["moving_average"])
        snapshot = self._build_technical_snapshot(prices, long_ma_window=long_ma_window)
        erp_pct = self._get_factor_pct("hs300_erp")
        reasons: list[str] = []

        if erp_pct is None:
            raise ValueError("macro_state missing hs300_erp.value_pct")

        if erp_pct >= self.policy["erp_accumulate_threshold_pct"]:
            reasons.append("ERP above high-threshold, accumulate from the left side regardless of weak tape")
            return self._build_signal(
                action="Accumulate",
                requested_bucket_fraction=self.policy["erp_accumulate_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
                macro_context={"hs300_erp_pct": erp_pct},
            )

        short_ma = snapshot["short_ma"]
        current_price = snapshot["current_price"]
        if erp_pct <= self.policy["erp_danger_threshold_pct"]:
            reasons.append("ERP below danger threshold, switch to pure right-side discipline")
            if current_price is not None and short_ma is not None and current_price < short_ma:
                reasons.append("price below short moving average, exit immediately")
                return self._build_signal(
                    action="Sell",
                    requested_bucket_fraction=0.0,
                    reasons=reasons,
                    technical_snapshot=snapshot,
                    macro_context={"hs300_erp_pct": erp_pct},
                )

            reasons.append("price still above short moving average, allow only reduced right-side exposure")
            return self._build_signal(
                action="Hold",
                requested_bucket_fraction=self.policy["erp_right_side_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
                macro_context={"hs300_erp_pct": erp_pct},
            )

        if snapshot["short_breakout"]:
            reasons.append("ERP back to neutral zone and short-term breakout confirms re-entry")
            return self._build_signal(
                action="Buy",
                requested_bucket_fraction=self.policy["erp_neutral_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
                macro_context={"hs300_erp_pct": erp_pct},
            )

        reasons.append("ERP in neutral zone, keep strategic core weight and wait")
        return self._build_signal(
            action="Hold",
            requested_bucket_fraction=self.policy["erp_neutral_fraction"],
            reasons=reasons,
            technical_snapshot=snapshot,
            macro_context={"hs300_erp_pct": erp_pct},
        )

    def _evaluate_dividend_carry(self, asset: dict[str, Any], prices: pd.DataFrame) -> dict[str, Any]:
        regime = asset["strategy_regime"]
        long_ma_window = int(regime["trend_filter"]["moving_average"])
        snapshot = self._build_technical_snapshot(prices, long_ma_window=long_ma_window)
        spread_pct = self._get_factor_pct("csi_dividend_spread")
        reasons: list[str] = []

        if spread_pct is None:
            raise ValueError("macro_state missing csi_dividend_spread.value_pct")

        if spread_pct >= self.policy["dividend_safe_spread_pct"]:
            reasons.append("dividend spread above safety floor, maintain carry base position")
            return self._build_signal(
                action="Hold",
                requested_bucket_fraction=self.policy["dividend_base_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
                macro_context={"csi_dividend_spread_pct": spread_pct},
            )

        if spread_pct <= self.policy["dividend_crowded_spread_pct"]:
            reasons.append("dividend spread compressed too far, crowding risk is elevated")
            reasons.append("trim position instead of chasing yield-crowded exposure")
            return self._build_signal(
                action="Sell",
                requested_bucket_fraction=self.policy["dividend_trimmed_fraction"],
                reasons=reasons,
                technical_snapshot=snapshot,
                macro_context={"csi_dividend_spread_pct": spread_pct},
            )

        reasons.append("spread in middle zone, keep smaller defensive carry allocation")
        return self._build_signal(
            action="Hold",
            requested_bucket_fraction=self.policy["dividend_mid_fraction"],
            reasons=reasons,
            technical_snapshot=snapshot,
            macro_context={"csi_dividend_spread_pct": spread_pct},
        )

    def _load_global_constraints(self) -> dict[str, float]:
        constraints = self.asset_master.get("global_constraints") or {}
        absolute_equity_cap = safe_float(constraints.get("absolute_equity_cap"))
        max_drawdown_limit = safe_float(constraints.get("max_drawdown_limit"))
        if absolute_equity_cap is None or absolute_equity_cap <= 0 or absolute_equity_cap > 1:
            raise ValueError("asset master missing valid global_constraints.absolute_equity_cap")
        if max_drawdown_limit is None or max_drawdown_limit <= 0 or max_drawdown_limit > 1:
            raise ValueError("asset master missing valid global_constraints.max_drawdown_limit")
        return {
            "absolute_equity_cap": absolute_equity_cap,
            "max_drawdown_limit": max_drawdown_limit,
        }

    def _load_bucket_configs(self) -> dict[str, dict[str, Any]]:
        buckets = self.asset_master.get("buckets")
        if not isinstance(buckets, dict) or not buckets:
            raise ValueError(f"asset master missing buckets: {self.asset_master_path}")

        configs: dict[str, dict[str, Any]] = {}
        for bucket_key, bucket in buckets.items():
            bucket = bucket or {}
            target_pct = safe_float(bucket.get("target"))
            if target_pct is None:
                target_pct = safe_float(bucket.get("target_pct"))
            min_pct = clamp(bucket.get("min") if bucket.get("min") is not None else bucket.get("min_pct"), 0.0, 1.0)
            max_pct = safe_float(bucket.get("max"))
            if max_pct is None:
                max_pct = safe_float(bucket.get("max_pct"))
            if target_pct is None and max_pct is not None:
                target_pct = max(min_pct, min(max_pct, (min_pct + max_pct) / 2.0))
            if target_pct is None or target_pct < 0 or target_pct > 1:
                raise ValueError(f"bucket {bucket_key} missing valid target/target_pct")
            if max_pct is None or max_pct < 0 or max_pct > 1:
                raise ValueError(f"bucket {bucket_key} missing valid max/max_pct")
            if target_pct > max_pct:
                raise ValueError(f"bucket {bucket_key} target exceeds max")

            configs[bucket_key] = {
                "label": bucket.get("label") or bucket_key,
                "short_label": bucket.get("short_label") or bucket.get("label") or bucket_key,
                "driver": bucket.get("driver") or bucket.get("risk_role"),
                "risk_role": bucket.get("risk_role") or bucket.get("driver"),
                "target_pct": target_pct,
                "min_pct": min_pct,
                "max_pct": max_pct,
                "priority_rank": int(bucket.get("priority_rank") or 999),
                "is_equity_like": bool(bucket.get("is_equity_like", bucket_key != BUCKET_CASH)),
            }
        return configs

    def _group_assets_by_bucket(self) -> dict[str, list[dict[str, Any]]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for asset in self.assets:
            bucket_key = str(asset.get("bucket") or "").strip()
            if bucket_key not in self.bucket_configs:
                raise ValueError(f"asset {asset.get('symbol')} references unknown bucket {bucket_key}")
            grouped.setdefault(bucket_key, []).append(asset)
        return grouped

    def get_dynamic_risk_budget(self, raw_signals: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        erp_pct = self._get_factor_pct("hs300_erp")
        absolute_equity_cap = self.global_constraints["absolute_equity_cap"]
        requested_cash_reserve_pct = max(0.0, 1.0 - absolute_equity_cap)
        regime_state = "balanced"
        notes: list[str] = []
        bucket_signal_state = self._build_bucket_signal_state(raw_signals or [])

        if erp_pct is None:
            regime_state = "erp_missing_neutral"
            notes.append("hs300_erp missing, fall back to neutral cash reserve derived from absolute equity cap")
        elif erp_pct > self.policy["erp_accumulate_threshold_pct"]:
            regime_state = "high_erp_offense"
            requested_cash_reserve_pct = 0.25
            notes.append("ERP above 5.5%, lower cash floor to 25% and lift only A_CORE / INCOME sleeves")
        elif erp_pct < self.policy["erp_danger_threshold_pct"]:
            regime_state = "low_erp_defense"
            requested_cash_reserve_pct = 0.40
            notes.append("ERP below 3.5%, raise cash floor to 40% and scale down only A_CORE / INCOME sleeves")
        else:
            notes.append("ERP in neutral zone, keep baseline cash reserve aligned with absolute equity cap for A-share sleeves")

        requested_equity_budget_pct = max(0.0, 1.0 - requested_cash_reserve_pct)
        effective_equity_budget_pct = min(requested_equity_budget_pct, absolute_equity_cap)
        scaling_factor = 1.0
        if absolute_equity_cap > 0:
            scaling_factor = min(effective_equity_budget_pct / absolute_equity_cap, 1.0)
        a_share_scaling_factor = scaling_factor if regime_state == "low_erp_defense" else 1.0

        bucket_budgets: dict[str, dict[str, Any]] = {}
        total_effective_target_pct = 0.0
        for bucket_key in self.bucket_order:
            config = self.bucket_configs[bucket_key]
            effective_target_pct = config["target_pct"]
            if bucket_key == BUCKET_GLB_MOM:
                trend_state = bucket_signal_state.get(bucket_key) or {}
                if trend_state.get("trend_gate_passed"):
                    effective_target_pct = config["max_pct"]
                    notes.append("GLB_MOM trend filter is positive, allow momentum sleeve to use its own max cap")
                else:
                    effective_target_pct = 0.0
                    notes.append("GLB_MOM trend filter is negative, route the sleeve back to cash instead of following ERP")
            elif regime_state == "high_erp_offense" and bucket_key in {BUCKET_A_CORE, BUCKET_INCOME}:
                effective_target_pct = config["max_pct"]
            elif regime_state == "low_erp_defense" and bucket_key in {BUCKET_A_CORE, BUCKET_INCOME}:
                effective_target_pct = min(config["target_pct"] * a_share_scaling_factor, config["max_pct"])
            elif bucket_key == BUCKET_CASH:
                effective_target_pct = requested_cash_reserve_pct
            else:
                effective_target_pct = min(config["target_pct"], config["max_pct"])

            bucket_budgets[bucket_key] = {
                "label": config["label"],
                "risk_role": config["risk_role"],
                "base_target_pct": config["target_pct"],
                "max_pct": config["max_pct"],
                "effective_target_pct": effective_target_pct,
                "priority_rank": config["priority_rank"],
                "is_equity_like": config["is_equity_like"],
                "trend_gate_passed": (bucket_signal_state.get(bucket_key) or {}).get("trend_gate_passed"),
            }
            if config["is_equity_like"]:
                total_effective_target_pct += effective_target_pct

        if total_effective_target_pct > effective_equity_budget_pct and total_effective_target_pct > 0:
            compression_ratio = effective_equity_budget_pct / total_effective_target_pct
            for bucket_key, bucket_budget in bucket_budgets.items():
                if bucket_budget["is_equity_like"]:
                    bucket_budget["effective_target_pct"] *= compression_ratio
            total_effective_target_pct = effective_equity_budget_pct
            notes.append("bucket targets exceeded effective equity cap and were compressed proportionally")

        effective_cash_reserve_pct = max(0.0, 1.0 - total_effective_target_pct)
        rounded_bucket_budgets = {
            bucket_key: {
                **bucket_budget,
                "base_target_pct": round_or_none(bucket_budget["base_target_pct"], 4),
                "max_pct": round_or_none(bucket_budget["max_pct"], 4),
                "effective_target_pct": round_or_none(bucket_budget["effective_target_pct"], 4),
            }
            for bucket_key, bucket_budget in bucket_budgets.items()
        }

        return {
            "hs300_erp_pct": round_or_none(erp_pct, 4),
            "regime_state": regime_state,
            "max_drawdown_limit": round_or_none(self.global_constraints["max_drawdown_limit"], 4),
            "absolute_equity_cap_pct": round_or_none(absolute_equity_cap, 4),
            "requested_cash_reserve_pct": round_or_none(requested_cash_reserve_pct, 4),
            "cash_reserve_pct": round_or_none(effective_cash_reserve_pct, 4),
            "requested_equity_budget_pct": round_or_none(requested_equity_budget_pct, 4),
            "effective_equity_budget_pct": round_or_none(effective_equity_budget_pct, 4),
            "equity_scaling_factor": round_or_none(scaling_factor, 4),
            "a_share_scaling_factor": round_or_none(a_share_scaling_factor, 4),
            "effective_bucket_target_sum_pct": round_or_none(total_effective_target_pct, 4),
            "bucket_signal_state": bucket_signal_state,
            "bucket_budgets": rounded_bucket_budgets,
            "notes": notes,
        }

    def _build_bucket_signal_state(self, raw_signals: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for signal in raw_signals:
            grouped.setdefault(str(signal.get("bucket") or ""), []).append(signal)

        state: dict[str, dict[str, Any]] = {}
        for bucket_key, signals in grouped.items():
            trend_gate_passed = False
            signal_dates: list[str] = []
            for signal in signals:
                technical_snapshot = signal.get("technical_snapshot") or {}
                current_price = safe_float(technical_snapshot.get("current_price"))
                long_ma = safe_float(technical_snapshot.get("long_ma"))
                signal_date = str(technical_snapshot.get("signal_date") or "").strip()
                if signal_date:
                    signal_dates.append(signal_date)
                if signal.get("regime_type") == "macro_momentum" and None not in {current_price, long_ma}:
                    trend_gate_passed = current_price >= long_ma

            state[bucket_key] = {
                "trend_gate_passed": trend_gate_passed,
                "signal_count": len(signals),
                "latest_signal_date": max(signal_dates) if signal_dates else None,
            }

        if BUCKET_GLB_MOM not in state:
            state[BUCKET_GLB_MOM] = {
                "trend_gate_passed": False,
                "signal_count": 0,
                "latest_signal_date": None,
            }
        return state

    def _apply_bucket_budget(self, raw_signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for signal in raw_signals:
            grouped.setdefault(str(signal.get("bucket") or ""), []).append(signal)

        group_meta: dict[str, dict[str, Any]] = {}
        for bucket_key, signals in grouped.items():
            bucket_budget = (self.dynamic_risk_budget.get("bucket_budgets") or {}).get(bucket_key) or {}
            total_requested_demand = sum(
                clamp(signal.get("requested_bucket_fraction"), 0.0, 1.0)
                * max(safe_float(signal.get("bucket_target_bias")) or 1.0, 0.0)
                for signal in signals
            )
            core_sleeve_active = any(
                str(signal.get("hedge_sleeve_type") or "") == "core_gold"
                and clamp(signal.get("requested_bucket_fraction"), 0.0, 1.0) > 0
                for signal in signals
            )
            group_meta[bucket_key] = {
                "effective_target_pct": safe_float(bucket_budget.get("effective_target_pct")) or 0.0,
                "max_pct": safe_float(bucket_budget.get("max_pct")) or 0.0,
                "priority_rank": int(bucket_budget.get("priority_rank") or 999),
                "normalizer": max(total_requested_demand, 1.0),
                "total_requested_demand": total_requested_demand,
                "core_sleeve_active": core_sleeve_active,
            }

        allocated: list[dict[str, Any]] = []
        for signal in raw_signals:
            bucket_key = str(signal.get("bucket") or "")
            meta = group_meta.get(bucket_key) or {
                "effective_target_pct": 0.0,
                "max_pct": 0.0,
                "priority_rank": 999,
                "normalizer": 1.0,
                "total_requested_fraction": 0.0,
            }
            requested_bucket_fraction = clamp(signal.get("requested_bucket_fraction"), 0.0, 1.0)
            bucket_target_bias = max(safe_float(signal.get("bucket_target_bias")) or 1.0, 0.0)
            hedge_sleeve_type = str(signal.get("hedge_sleeve_type") or "")
            requested_bucket_demand = requested_bucket_fraction * bucket_target_bias

            if hedge_sleeve_type == "commodity_satellite" and not bool(meta.get("core_sleeve_active")):
                requested_bucket_demand = 0.0

            raw_weight_target = meta["effective_target_pct"] * requested_bucket_demand / meta["normalizer"]
            portfolio_weight_cap = safe_float(signal.get("portfolio_weight_cap"))
            weight_target = raw_weight_target

            reasons = list(signal.get("reasons") or [])
            if hedge_sleeve_type == "commodity_satellite" and not bool(meta.get("core_sleeve_active")):
                reasons.append("commodity satellite is disabled until the core gold sleeve is active")
            if meta["normalizer"] > 1.0 and requested_bucket_demand > 0:
                reasons.append("bucket demand or sleeve bias exceeded 100% and was normalized back to the bucket cap")
            if portfolio_weight_cap is not None and portfolio_weight_cap >= 0 and weight_target > portfolio_weight_cap:
                weight_target = portfolio_weight_cap
                reasons.append("asset-specific portfolio cap clipped the final target weight")

            allocated.append(
                {
                    **signal,
                    "Weight_Target": round(weight_target, 4),
                    "requested_bucket_fraction": round(requested_bucket_fraction, 4),
                    "bucket_priority_rank": meta["priority_rank"],
                    "allocation_context": {
                        "bucket_weight_normalizer": round_or_none(meta["normalizer"], 4),
                        "bucket_requested_demand_total": round_or_none(meta["total_requested_demand"], 4),
                        "requested_bucket_demand": round_or_none(requested_bucket_demand, 4),
                        "bucket_target_bias": round_or_none(bucket_target_bias, 4),
                        "portfolio_weight_cap": round_or_none(portfolio_weight_cap, 4),
                        "raw_weight_target": round_or_none(raw_weight_target, 4),
                        "core_sleeve_active": bool(meta.get("core_sleeve_active")),
                        "effective_bucket_target_pct": round_or_none(meta["effective_target_pct"], 4),
                        "effective_bucket_max_pct": round_or_none(meta["max_pct"], 4),
                        "cash_reserve_pct": round_or_none(self.dynamic_risk_budget.get("cash_reserve_pct"), 4),
                        "effective_equity_budget_pct": round_or_none(
                            self.dynamic_risk_budget.get("effective_equity_budget_pct"),
                            4,
                        ),
                        "regime_state": self.dynamic_risk_budget.get("regime_state"),
                    },
                    "macro_context": {
                        **(signal.get("macro_context") or {}),
                        "risk_budget_regime": self.dynamic_risk_budget.get("regime_state"),
                        "cash_reserve_pct": round_or_none(self.dynamic_risk_budget.get("cash_reserve_pct"), 4),
                    },
                    "reasons": reasons,
                }
            )

        return allocated

    def _apply_execution_projection(self, signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
        projected: list[dict[str, Any]] = []
        for signal in signals:
            execution_type = str(signal.get("execution_type") or "OTC").upper()
            technical_snapshot = signal.get("technical_snapshot") or {}
            execution_price_snapshot = signal.get("execution_price_snapshot") or {}
            signal_last_price = safe_float(technical_snapshot.get("current_price"))
            last_price = (
                safe_float(execution_price_snapshot.get("last_price"))
                if execution_type == "EXCHANGE"
                else signal_last_price
            )
            target_value_cny = round_money(self.total_portfolio_value * (safe_float(signal.get("Weight_Target")) or 0.0))

            execution_context: dict[str, Any] = {
                "target_value_cny": target_value_cny,
                "last_price": round_or_none(last_price, 4),
                "signal_symbol": signal.get("market_data_symbol"),
                "signal_last_price": round_or_none(signal_last_price, 4),
                "execution_symbol": signal.get("execution_symbol"),
                "price_source": execution_price_snapshot.get("source") or "signal_proxy",
                "price_date": execution_price_snapshot.get("price_date") or technical_snapshot.get("signal_date"),
                "slippage_buffer": round_or_none(signal.get("slippage_buffer"), 4),
            }
            if execution_type == "EXCHANGE":
                lot_size = max(int(signal.get("lot_size") or 100), 1)
                ticker = str(signal.get("execution_symbol") or signal.get("ticker") or signal.get("symbol") or "").strip()
                if not ticker:
                    raise ValueError(f"exchange asset missing ticker for symbol={signal.get('symbol')}")
                if last_price is None or last_price <= 0:
                    raise ValueError(f"exchange asset missing valid last price for symbol={signal.get('symbol')}")

                raw_shares = int(math.floor(target_value_cny / last_price))
                target_shares = raw_shares // lot_size * lot_size
                execution_context.update(
                    {
                        "ticker": ticker,
                        "lot_size": lot_size,
                        "target_shares": int(target_shares),
                        "target_notional_cny": round_money(target_shares * last_price),
                    }
                )
            else:
                execution_context.update(
                    {
                        "target_amount_cny": target_value_cny,
                    }
                )

            projected.append(
                {
                    **signal,
                    "execution_type": execution_type,
                    "execution_context": execution_context,
                }
            )
        return projected

    def _resolve_execution_price_snapshot(
        self,
        connection: sqlite3.Connection,
        *,
        asset: dict[str, Any],
        proxy_prices: pd.DataFrame,
    ) -> dict[str, Any]:
        execution_type = str(asset.get("execution_type") or "OTC").upper()
        execution_symbol = str(asset.get("ticker") or asset.get("symbol") or "").strip()
        if not execution_symbol:
            raise ValueError(f"asset missing execution symbol: {asset.get('name')}")

        if execution_type != "EXCHANGE":
            latest = proxy_prices.iloc[-1]
            return {
                "symbol": execution_symbol,
                "last_price": round_or_none(latest.get("price"), 4),
                "price_date": proxy_prices.index[-1].strftime("%Y-%m-%d"),
                "source": "signal_proxy_history",
            }

        try:
            execution_prices = self._load_price_history(connection, execution_symbol)
            latest = execution_prices.iloc[-1]
            return {
                "symbol": execution_symbol,
                "last_price": round_or_none(latest.get("price"), 4),
                "price_date": execution_prices.index[-1].strftime("%Y-%m-%d"),
                "source": "market_lake",
            }
        except Exception:
            return self._fetch_go_stock_exchange_quote(execution_symbol)

    def _fetch_go_stock_exchange_quote(self, symbol: str) -> dict[str, Any]:
        quote_symbol = str(symbol or "").strip().upper()
        if not quote_symbol:
            raise ValueError("execution symbol missing for go-stock quote")

        if quote_symbol.startswith(("SH", "SZ")) and quote_symbol[2:].isdigit():
            normalized = quote_symbol.lower()
        elif quote_symbol.endswith(".SH"):
            normalized = f"sh{quote_symbol.split('.')[0]}"
        elif quote_symbol.endswith(".SZ") or quote_symbol.endswith(".BJ"):
            normalized = f"sz{quote_symbol.split('.')[0]}"
        elif quote_symbol.isdigit():
            normalized = f"sh{quote_symbol}" if quote_symbol[0] in {"5", "6"} else f"sz{quote_symbol}"
        else:
            raise ValueError(f"unsupported go-stock execution symbol: {quote_symbol}")

        query = urlencode({"q": normalized})
        request = Request(
            url=f"http://qt.gtimg.cn/?{query}",
            headers={
                "Referer": "https://gu.qq.com/",
                "User-Agent": "Mozilla/5.0",
            },
        )
        with urlopen(request, timeout=10) as response:
            payload = response.read().decode("gb18030", errors="ignore").strip()

        if "=" not in payload:
            raise ValueError(f"go-stock quote payload malformed for execution symbol={quote_symbol}")

        quote_blob = payload.split("=", 1)[1].strip().strip('"').strip(";")
        fields = quote_blob.split("~")
        if len(fields) < 31:
            raise ValueError(f"go-stock quote payload incomplete for execution symbol={quote_symbol}")

        last_price = safe_float(fields[3])
        if last_price is None or last_price <= 0:
            raise ValueError(f"go-stock quote missing valid last price for execution symbol={quote_symbol}")

        quote_time = fields[30] if len(fields) > 30 else ""
        price_date = quote_time[:8] if len(quote_time) >= 8 else format_now()

        return {
            "symbol": fields[2] or quote_symbol,
            "last_price": round_or_none(last_price, 4),
            "price_date": price_date,
            "source": "go_stock_stock_quote",
            "name": fields[1] if len(fields) > 1 else None,
        }

    def _resolve_total_portfolio_value(self) -> float:
        reported_min = safe_float(
            self.account_context.get("reported_total_assets_range_cny", {}).get("min")
        )
        if reported_min is None or reported_min <= 0:
            raise ValueError("account_context missing valid reported_total_assets_range_cny.min")
        return round_money(reported_min)

    def _load_price_history(self, connection: sqlite3.Connection, symbol: str) -> pd.DataFrame:
        query = """
            SELECT date, open, high, low, close, adj_close, volume
            FROM daily_prices
            WHERE symbol = ?
              AND close IS NOT NULL
              AND high IS NOT NULL
              AND low IS NOT NULL
            ORDER BY date ASC
        """
        frame = pd.read_sql_query(query, connection, params=[symbol])
        if frame.empty:
            raise ValueError(f"missing price history for symbol={symbol}")

        working = frame.copy()
        working["date"] = pd.to_datetime(working["date"], errors="coerce")
        for column in ["open", "high", "low", "close", "adj_close", "volume"]:
            working[column] = pd.to_numeric(working[column], errors="coerce")
        working = (
            working.dropna(subset=["date", "high", "low", "close"])
            .drop_duplicates(subset=["date"], keep="last")
            .sort_values("date")
            .set_index("date")
        )
        if working.empty:
            raise ValueError(f"price history empty after cleaning for symbol={symbol}")

        working["price"] = working["adj_close"].where(working["adj_close"].notna(), working["close"])
        return working

    def _build_technical_snapshot(self, prices: pd.DataFrame, *, long_ma_window: int) -> dict[str, Any]:
        working = prices.copy()
        working["short_ma"] = working["price"].rolling(
            window=self.short_signal_window,
            min_periods=self.short_signal_window,
        ).mean()
        working["long_ma"] = working["price"].rolling(
            window=long_ma_window,
            min_periods=long_ma_window,
        ).mean()
        working["atr_14"] = AverageTrueRange(
            high=working["high"],
            low=working["low"],
            close=working["close"],
            window=self.atr_window,
            fillna=False,
        ).average_true_range()

        latest = working.iloc[-1]
        previous = working.iloc[-2] if len(working) >= 2 else None

        current_price = safe_float(latest.get("price"))
        short_ma = safe_float(latest.get("short_ma"))
        long_ma = safe_float(latest.get("long_ma"))
        atr_value = safe_float(latest.get("atr_14"))
        atr_pct = None
        if current_price not in {None, 0} and atr_value is not None:
            atr_pct = atr_value / current_price

        short_breakout = False
        if previous is not None:
            prev_price = safe_float(previous.get("price"))
            prev_short_ma = safe_float(previous.get("short_ma"))
            if None not in {prev_price, prev_short_ma, current_price, short_ma}:
                short_breakout = bool(prev_price <= prev_short_ma and current_price > short_ma)

        return {
            "signal_date": working.index[-1].strftime("%Y-%m-%d"),
            "history_points": int(len(working)),
            "current_price": round_or_none(current_price, 4),
            f"sma_{self.short_signal_window}": round_or_none(short_ma, 4),
            f"sma_{long_ma_window}": round_or_none(long_ma, 4),
            "short_ma": round_or_none(short_ma, 4),
            "long_ma": round_or_none(long_ma, 4),
            "atr_14": round_or_none(atr_value, 4),
            "atr_pct": round_or_none(atr_pct, 4),
            "short_breakout": short_breakout,
        }

    def _get_factor_pct(self, key: str) -> float | None:
        factor = (self.macro_state.get("factors") or {}).get(key) or {}
        value_pct = safe_float(factor.get("value_pct"))
        if value_pct is not None:
            return value_pct

        value_decimal = safe_float(factor.get("value_decimal"))
        if value_decimal is not None:
            return value_decimal * 100.0
        return None

    def _build_signal(
        self,
        *,
        action: str,
        requested_bucket_fraction: float,
        reasons: list[str],
        technical_snapshot: dict[str, Any],
        macro_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "Action": action,
            "Weight_Target": 0.0,
            "requested_bucket_fraction": round(clamp(requested_bucket_fraction), 4),
            "reasons": reasons,
            "technical_snapshot": technical_snapshot,
            "macro_context": macro_context or {},
        }


def main() -> int:
    global MANIFEST_PATH
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    MANIFEST_PATH = portfolio_root / "state-manifest.json"
    manifest = read_json_or_none(MANIFEST_PATH) or {}
    canonical = manifest.get("canonical_entrypoints", {}) if isinstance(manifest, dict) else {}
    asset_master_path = (
        Path(args.asset_master)
        if args.asset_master
        else Path(canonical.get("asset_master") or portfolio_root / "config" / "asset_master.json")
    )
    account_context_path = (
        Path(args.account_context)
        if args.account_context
        else Path(canonical.get("account_context") or portfolio_root / "account_context.json")
    )
    macro_state_path = (
        Path(args.macro_state)
        if args.macro_state
        else Path(
            canonical.get("latest_macro_state")
            or (
                portfolio_root / "data" / "macro_state.json"
                if (portfolio_root / "data" / "macro_state.json").exists()
                else DEFAULT_PORTFOLIO_ROOT / "data" / "macro_state.json"
            )
        )
    )
    db_path = (
        Path(args.db)
        if args.db
        else Path(
            canonical.get("market_lake_db")
            or (
                portfolio_root / "data" / "market_lake.db"
                if (portfolio_root / "data" / "market_lake.db").exists()
                else DEFAULT_PORTFOLIO_ROOT / "data" / "market_lake.db"
            )
        )
    )
    output_path = Path(args.output) if args.output else portfolio_root / "signals" / "regime_router_signals.json"
    router = SignalRouter(
        asset_master_path=asset_master_path,
        account_context_path=account_context_path,
        macro_state_path=macro_state_path,
        db_path=db_path,
    )
    payload = router.route_all()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_manifest(manifest_path=MANIFEST_PATH, output_path=output_path)

    print(
        json.dumps(
            {
                "account_id": account_id,
                "portfolio_root": str(portfolio_root),
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
