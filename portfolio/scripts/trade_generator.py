#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import resolve_account_id, resolve_portfolio_root  # noqa: E402
from portfolio_state_paths import load_preferred_portfolio_state  # noqa: E402


PORTFOLIO_ROOT = resolve_portfolio_root()
ACCOUNT_CONTEXT_PATH = PORTFOLIO_ROOT / "account_context.json"
WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
ASSET_MASTER_PATH = PORTFOLIO_ROOT / "config" / "asset_master.json"
MACRO_STATE_PATH = PORTFOLIO_ROOT / "data" / "macro_state.json"
REGIME_SIGNALS_PATH = PORTFOLIO_ROOT / "signals" / "regime_router_signals.json"
OUTPUT_JSON_PATH = PORTFOLIO_ROOT / "data" / "trade_plan_v4.json"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"

MAX_DAILY_ACCUMULATE = 5000.0
MAX_DAILY_BUY = 20000.0
MAX_DAILY_SELL = -20000.0
DEFAULT_SLIPPAGE_BUFFER = 0.002
MIN_EXCHANGE_TRADE_NOTIONAL = 500.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate executable RMB trade deltas from regime_router_signals.json."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--date", default="")
    parser.add_argument("--portfolio-state", default="")
    parser.add_argument("--latest", default="")
    parser.add_argument("--account-context", default="")
    parser.add_argument("--watchlist", default="")
    parser.add_argument("--asset-master", default="")
    parser.add_argument("--macro-state", default="")
    parser.add_argument("--signals", default="")
    parser.add_argument("--output-json", default="")
    parser.add_argument("--report-path", default="")
    parser.add_argument("--min-trade-amount", type=float, default=1000.0)
    parser.add_argument("--kill-switch-floor-weight", type=float, default=0.0)
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def current_cn_date() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


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


def round_money(value: Any) -> float:
    numeric = safe_float(value) or 0.0
    return round(numeric, 2)


def format_money(value: Any) -> str:
    return f"{round_money(value):,.2f}"


def format_ratio_pct(value: Any) -> str:
    numeric = safe_float(value)
    if numeric is None:
        return "--"
    return f"{numeric * 100.0:.2f}%"


def format_price(value: Any, digits: int = 4) -> str:
    numeric = safe_float(value)
    if numeric is None:
        return "--"
    return f"{numeric:,.{digits}f}"


def floor_lot_quantity(notional_cny: Any, price: Any, lot_size: Any) -> int:
    budget = safe_float(notional_cny) or 0.0
    last_price = safe_float(price) or 0.0
    lot = max(int(safe_float(lot_size) or 0), 1)
    if budget <= 0 or last_price <= 0:
        return 0
    raw_quantity = math.floor(budget / last_price)
    return raw_quantity // lot * lot


def round_or_none(value: Any, digits: int = 4) -> float | None:
    numeric = safe_float(value)
    if numeric is None:
        return None
    return round(numeric, digits)


def normalize_fund_name(value: str) -> str:
    text = str(value or "")
    replacements = {
        "（": "(",
        "）": ")",
        " ": "",
        "\u3000": "",
        "(QDII)": "",
        "（QDII）": "",
        "QDII-FOF-LOF": "QDII",
        "QDII-LOF": "QDII",
        "ETF发起式联接": "",
        "ETF发起联接": "",
        "ETF联接": "",
        "ETF发起": "",
        "联接": "",
        "发起式": "",
        "发起": "",
        "人民币": "",
        "混合型": "混合",
        "持有期": "持有",
        "-": "",
        "_": "",
        "/": "",
        ".": "",
        "(": "",
        ")": "",
        "[": "",
        "]": "",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


class TradePlanner:
    def __init__(
        self,
        *,
        account_id: str,
        portfolio_root: Path,
        portfolio_state_path: Path,
        portfolio_state_source_kind: str,
        account_context_path: Path,
        watchlist_path: Path,
        asset_master_path: Path,
        macro_state_path: Path,
        signals_path: Path,
        min_trade_amount: float = 1000.0,
        kill_switch_floor_weight: float = 0.0,
    ) -> None:
        self.account_id = account_id
        self.portfolio_root = portfolio_root
        self.portfolio_state_path = portfolio_state_path
        self.portfolio_state_source_kind = portfolio_state_source_kind
        self.account_context_path = account_context_path
        self.watchlist_path = watchlist_path
        self.asset_master_path = asset_master_path
        self.macro_state_path = macro_state_path
        self.signals_path = signals_path
        self.min_trade_amount = float(min_trade_amount)
        self.kill_switch_floor_weight = float(kill_switch_floor_weight)

        self.portfolio_state = read_json(portfolio_state_path)
        self.account_context = read_json(account_context_path)
        self.watchlist = read_json(watchlist_path)
        self.asset_master = read_json(asset_master_path)
        self.macro_state = read_json(macro_state_path)
        self.signals_payload = read_json(signals_path)
        self.risk_budget = self.signals_payload.get("risk_budget") or {}
        self.asset_config_by_key = self._build_asset_config_lookup()

        self.watchlist_by_name = self._build_watchlist_lookup()
        self.current_positions = self._build_current_positions()
        self.current_positions_total_cny = round_money(
            sum(safe_float(position.get("current_position_cny")) or 0.0 for position in self.current_positions.values())
        )
        self.total_portfolio_value = self._resolve_total_portfolio_value()
        self.cash_estimate, self.cash_estimate_source = self._resolve_cash_estimate()
        self.pending_buy_confirm = round_money(
            self.portfolio_state.get("summary", {}).get("pending_buy_confirm")
        )
        self.pending_sell_to_arrive = round_money(
            self.portfolio_state.get("summary", {}).get("pending_sell_to_arrive")
        )
        self.liquid_cash_estimate = round_money(max(self.cash_estimate - self.pending_buy_confirm, 0.0))
        raw_cash_reserve_pct = safe_float(self.risk_budget.get("cash_reserve_pct")) or 0.0
        self.required_cash_reserve_pct = max(0.0, min(1.0, raw_cash_reserve_pct))
        self.required_cash_reserve_cny = round_money(
            self.total_portfolio_value * self.required_cash_reserve_pct
        )
        self.initial_available_cash_cny = round_money(
            max(self.liquid_cash_estimate - self.required_cash_reserve_cny, 0.0)
        )
        self.cash_sweeper = self._load_cash_sweeper_config()

    def plan(self, *, plan_date: str) -> dict[str, Any]:
        decisions: list[dict[str, Any]] = []

        for symbol, signal in (self.signals_payload.get("signals") or {}).items():
            decision = self._build_trade_decision(symbol, signal)
            decisions.append(decision)

        decisions, cash_tracker = self._apply_dynamic_cash_tracker(decisions)

        actionable_trades: list[dict[str, Any]] = []
        suppressed_trades: list[dict[str, Any]] = []
        for decision in decisions:
            if decision["execution_action"] == "Hold":
                suppressed_trades.append(decision)
            else:
                actionable_trades.append(decision)

        buy_total = round_money(
            sum(item["planned_trade_amount_cny"] for item in actionable_trades if item["execution_action"] == "Buy")
        )
        sell_total = round_money(
            sum(item["planned_trade_amount_cny"] for item in actionable_trades if item["execution_action"] == "Sell")
        )

        macro_snapshot = self._build_macro_snapshot()
        payload = {
            "version": 3,
            "account_id": self.account_id,
            "plan_date": plan_date,
            "generated_at": format_now(),
            "layer_role": "trade_planner_v6_dual_track",
            "source": {
                "portfolio_snapshot": str(self.portfolio_state_path),
                "portfolio_snapshot_source_kind": self.portfolio_state_source_kind,
                "account_context": str(self.account_context_path),
                "watchlist": str(self.watchlist_path),
                "asset_master": str(self.asset_master_path),
                "macro_state": str(self.macro_state_path),
                "regime_router_signals": str(self.signals_path),
            },
            "parameters": {
                "min_trade_amount_cny": self.min_trade_amount,
                "min_exchange_trade_notional_cny": MIN_EXCHANGE_TRADE_NOTIONAL,
                "kill_switch_floor_weight": self.kill_switch_floor_weight,
                "max_daily_accumulate_cny": MAX_DAILY_ACCUMULATE,
                "max_daily_buy_cny": MAX_DAILY_BUY,
                "max_daily_sell_cny": MAX_DAILY_SELL,
                "cash_sweeper_threshold_cny": (
                    round_money(self.cash_sweeper.get("activation_threshold_cny"))
                    if self.cash_sweeper
                    else None
                ),
                "total_portfolio_value_method": "account_context.reported_total_assets_range_cny.min -> portfolio_state.summary.total_fund_assets",
            },
            "risk_budget": self.risk_budget,
            "macro_snapshot": macro_snapshot,
            "portfolio_context": {
                "total_portfolio_value_cny": self.total_portfolio_value,
                "current_active_positions_value_cny": self.current_positions_total_cny,
                "cash_estimate_cny": self.cash_estimate,
                "cash_estimate_source": self.cash_estimate_source,
                "pending_buy_confirm_cny": self.pending_buy_confirm,
                "pending_sell_to_arrive_cny": self.pending_sell_to_arrive,
                "liquid_cash_estimate_cny": self.liquid_cash_estimate,
                "initial_available_cash_cny": self.initial_available_cash_cny,
                "required_cash_reserve_pct": round(self.required_cash_reserve_pct, 4),
                "required_cash_reserve_cny": self.required_cash_reserve_cny,
            },
            "cash_guardrail": {
                "required_cash_reserve_pct": round(self.required_cash_reserve_pct, 4),
                "required_cash_reserve_cny": self.required_cash_reserve_cny,
                "starting_cash_estimate_cny": self.cash_estimate,
                "starting_cash_estimate_source": self.cash_estimate_source,
                "pending_buy_confirm_cny": self.pending_buy_confirm,
                "starting_liquid_cash_cny": self.liquid_cash_estimate,
                "starting_available_cash_cny": self.initial_available_cash_cny,
                "ending_available_cash_cny": round_money(cash_tracker.get("ending_available_cash_cny")),
                "sell_released_cny": round_money(cash_tracker.get("sell_released_cny")),
                "buy_committed_cny": round_money(cash_tracker.get("buy_committed_cny")),
                "sweeper_committed_cny": round_money(cash_tracker.get("sweeper_committed_cny")),
                "sweeper_triggered": bool(cash_tracker.get("sweeper_triggered")),
                "execution_order": cash_tracker.get("execution_order", []),
            },
            "summary": {
                "actionable_trade_count": len(actionable_trades),
                "suppressed_trade_count": len(suppressed_trades),
                "gross_buy_cny": buy_total,
                "gross_sell_cny": sell_total,
                "net_cash_impact_cny": round_money(sell_total - buy_total),
            },
            "trades": actionable_trades,
            "suppressed": suppressed_trades,
            "upstream_signal_errors": self.signals_payload.get("errors", []),
        }
        return payload

    def render_markdown(self, payload: dict[str, Any]) -> str:
        snapshot = payload["macro_snapshot"]
        summary = payload["summary"]
        actionable_trades = list(payload["trades"])
        buy_trades = [
            trade
            for trade in actionable_trades
            if trade["execution_action"] == "Buy" and not trade.get("is_cash_sweeper")
        ]
        sell_trades = [trade for trade in actionable_trades if trade["execution_action"] == "Sell"]
        primary_legs = buy_trades if buy_trades else actionable_trades
        first_leg = primary_legs[0] if primary_legs else None
        second_leg = primary_legs[1] if len(primary_legs) > 1 else None

        conclusion_lines: list[str]
        if not actionable_trades:
            conclusion_lines = [
                "- 当前暂无满足摩擦成本和风险约束的执行单，继续等待更明确的信号与更大的调仓缺口。"
            ]
        else:
            if buy_trades and sell_trades:
                regime_line = "当前计划以“先减后买”的内部再平衡为主，先回收风险，再补强高赔率主线。"
            elif sell_trades:
                regime_line = "当前计划以风险回收和主动减仓为主，优先削峰与降低同质化暴露。"
            else:
                regime_line = "当前计划以补仓和结构修复为主，优先把资金补到赔率更高、信号更友好的桶。"

            conclusion_lines = [
                f"- {regime_line}",
                (
                    f"- 本期可执行 {summary['actionable_trade_count']} 笔：计划买入 "
                    f"{format_money(summary['gross_buy_cny'])} 元，计划卖出 "
                    f"{format_money(summary['gross_sell_cny'])} 元，净现金变化 "
                    f"{format_money(summary['net_cash_impact_cny'])} 元。"
                ),
            ]
            if first_leg:
                verb = "买入" if first_leg["execution_action"] == "Buy" else "卖出"
                conclusion_lines.append(
                    f"- 若只执行一笔，优先处理：{self._compat_bucket_label(first_leg['bucket'])} / {verb} {first_leg['name']} / {format_money(first_leg['planned_trade_amount_cny'])} 元。"
                )

        lines = [
            f"# {payload['plan_date']} Next Trade Plan",
            "",
            "## 宏观温度计快照",
            "",
            f"- {snapshot['one_liner']}",
            "",
            "## 组合执行口径",
            "",
            f"- 总资产执行口径：{format_money(payload['portfolio_context']['total_portfolio_value_cny'])} 元",
            f"- 当前 active 持仓：{format_money(payload['portfolio_context']['current_active_positions_value_cny'])} 元",
            f"- 当前推算现金：{format_money(payload['portfolio_context']['cash_estimate_cny'])} 元",
            f"- 待确认买入占用现金：{format_money(payload['portfolio_context']['pending_buy_confirm_cny'])} 元",
            f"- 动态现金防线：{format_ratio_pct(payload['portfolio_context']['required_cash_reserve_pct'])} / {format_money(payload['portfolio_context']['required_cash_reserve_cny'])} 元",
            f"- 扣除防线后的起始可用现金：{format_money(payload['portfolio_context']['initial_available_cash_cny'])} 元",
            f"- 动态记账后的剩余可用现金：{format_money(payload['cash_guardrail']['ending_available_cash_cny'])} 元",
            f"- 摩擦成本阈值：{format_money(payload['parameters']['min_trade_amount_cny'])} 元",
            (
                f"- 尾款归集阈值：{format_money(payload['parameters']['cash_sweeper_threshold_cny'])} 元"
                f"（{self.cash_sweeper['symbol']} {self.cash_sweeper['name']}）"
                if self.cash_sweeper
                else "- 尾款归集阈值：未配置"
            ),
            "",
            "## 当前结论",
            "",
            *conclusion_lines,
            "",
            "## 第一笔计划",
            "",
            *(
                [
                    f"- 仓位桶：{self._compat_bucket_label(first_leg['bucket'])}",
                    f"- 标的：{first_leg['name']}",
                    f"- 金额：{format_money(first_leg['planned_trade_amount_cny'])} 元",
                    (
                        "- 资金来源：优先使用本期减仓回笼资金；若回笼不足，则动用现金防线以上余额。"
                        if first_leg["execution_action"] == "Buy" and summary["gross_sell_cny"] > 0
                        else (
                            "- 资金来源：使用现金仓 / 机动资金执行。"
                            if first_leg["execution_action"] == "Buy"
                            else "- 资金来源：本单为减仓回笼动作，不涉及外部资金。"
                        )
                    ),
                    "- 状态：可执行",
                    f"- 理由：{first_leg['decision_note']}",
                ]
                if first_leg
                else ["- 当前无可执行首笔计划。"]
            ),
            "",
            "## 第二笔排队",
            "",
            *(
                [
                    f"- 仓位桶：{self._compat_bucket_label(second_leg['bucket'])}",
                    f"- 标的：{second_leg['name']}",
                    f"- 金额：{format_money(second_leg['planned_trade_amount_cny'])} 元",
                    (
                        "- 资金来源：优先使用本期减仓回笼资金；若回笼不足，则动用现金防线以上余额。"
                        if second_leg["execution_action"] == "Buy" and summary["gross_sell_cny"] > 0
                        else (
                            "- 资金来源：使用现金仓 / 机动资金执行。"
                            if second_leg["execution_action"] == "Buy"
                            else "- 资金来源：本单为减仓回笼动作，不涉及外部资金。"
                        )
                    ),
                    "- 状态：排队",
                    f"- 理由：{second_leg['decision_note']}",
                ]
                if second_leg
                else ["- 当前暂无第二笔排队计划。"]
            ),
            "",
            "## ✂️ 智能减仓与再平衡预案",
            "",
        ]

        if sell_trades:
            for trade in sell_trades[:3]:
                route_label = (
                    "信号转弱 / 主动回收风险"
                    if trade.get("signal_action") == "Sell"
                    else "超配回落 / 常规再平衡"
                )
                lines.extend(
                    [
                        f"### {trade['name']}",
                        f"- 目标桶：{self._compat_bucket_label(trade['bucket'])}",
                        f"- 减仓标的：{trade['name']}",
                        f"- 建议减仓金额：{format_money(trade['planned_trade_amount_cny'])} 元",
                        f"- 系统定性：{route_label}",
                        f"- 系统指令：{trade['decision_note']}",
                        "",
                    ]
                )
        else:
            lines.append("- 当前无主动减仓指令。")
            lines.append("")

        lines.extend(
            [
                "## 🔄 调仓资金路由建议 (Self-Financing Route)",
                "",
            ]
        )

        if summary["gross_sell_cny"] > 0 and buy_trades:
            first_buy_bucket = self._compat_bucket_label(buy_trades[0]["bucket"])
            lines.append(
                f"- 本期存在 {format_money(summary['gross_sell_cny'])} 元的减仓回笼资金预期。建议将本次 {first_buy_bucket} 的买入资金优先从减仓款中划拨，实现组合内部再平衡，无需动用场外增量现金。"
            )
            remaining_cash = round_money(summary["gross_sell_cny"] - summary["gross_buy_cny"])
            if remaining_cash > 0:
                lines.append(
                    f"- 减仓回笼资金充裕。完成买入替换后，剩余的 {format_money(remaining_cash)} 元请划归至【现金/机动仓】暂存，提升账户整体防御力。"
                )
            elif remaining_cash < 0:
                lines.append(
                    f"- 减仓回笼资金不足。完成内部划拨后，仍需额外动用 {format_money(abs(remaining_cash))} 元现金防线以上余额。"
                )
        elif buy_trades:
            lines.append("- 当前无减仓回笼资金，默认使用现金仓 / 机动资金执行买入。")
        else:
            lines.append("- 当前无新增买入腿，现金继续维持在系统防线之上。")

        lines.extend(
            [
                "",
                "## 明确的买卖指令",
                "",
            ]
        )

        if actionable_trades:
            for trade in actionable_trades:
                lines.append(self._render_trade_line(trade))
                lines.append(f"  归因：{trade['decision_note']}")
        else:
            lines.append("- 今日无满足摩擦成本和风险约束的新增执行单。")

        lines.extend(
            [
                "",
                "## 被静默或忽略的信号",
                "",
            ]
        )

        if payload["suppressed"]:
            for trade in payload["suppressed"]:
                lines.append(self._render_suppressed_line(trade))
        else:
            lines.append("- 无。")

        if payload["upstream_signal_errors"]:
            lines.extend(
                [
                    "",
                    "## 上游缺口",
                    "",
                ]
            )
            for item in payload["upstream_signal_errors"]:
                lines.append(f"- {item.get('symbol')}: {item.get('message')}")

        lines.extend(
            [
                "",
                "## 汇总",
                "",
                f"- 可执行交易数：{summary['actionable_trade_count']}",
                f"- 计划买入总额：{format_money(summary['gross_buy_cny'])} 元",
                f"- 计划卖出总额：{format_money(summary['gross_sell_cny'])} 元",
                f"- 计划净现金变化：{format_money(summary['net_cash_impact_cny'])} 元",
            ]
        )
        return "\n".join(lines) + "\n"

    def _bucket_label(self, bucket_key: str | None) -> str:
        if not bucket_key:
            return "未分类仓位"
        return str((self.asset_master.get("buckets") or {}).get(bucket_key, {}).get("label") or bucket_key)

    def _compat_bucket_label(self, bucket_key: str | None) -> str:
        mapping = {
            "A_CORE": "核心仓",
            "GLB_MOM": "全球动量仓",
            "INCOME": "防守仓",
            "HEDGE": "对冲仓",
            "TACTICAL": "战术仓",
            "CASH": "现金/机动仓",
        }
        if not bucket_key:
            return "未分类仓位"
        return mapping.get(bucket_key, self._bucket_label(bucket_key))

    def _render_trade_line(self, trade: dict[str, Any]) -> str:
        verb = "买入" if trade["execution_action"] == "Buy" else "卖出"
        execution_type = str(trade.get("execution_type") or "OTC").upper()
        if trade.get("is_cash_sweeper"):
            return (
                f"- [归集][基金] {trade['symbol']} - {format_money(trade['planned_trade_amount_cny'])} 元"
                f"（{trade['name']}）"
            )
        if execution_type == "EXCHANGE":
            raw_gap = abs(int(trade.get("raw_share_delta") or 0))
            return (
                f"- [{verb}][证券] {trade.get('ticker') or trade['symbol']} - {int(trade.get('quantity') or 0)} 股"
                f"（{trade.get('order_type') or 'Limit'} {format_price(trade.get('price_hint'))}，"
                f"预计成交额 {format_money(trade.get('expected_notional_cny'))} 元，"
                f"预估滑点成本 {format_money(trade.get('estimated_slippage_cost_cny'))} 元，"
                f"执行 {int(trade.get('quantity') or 0)}/{raw_gap} 股缺口；{trade['name']}）"
            )
        return (
            f"- [{verb}][基金] {trade['symbol']} - {format_money(trade['planned_trade_amount_cny'])} 元"
            f"（{trade['name']}）"
        )

    def _render_suppressed_line(self, trade: dict[str, Any]) -> str:
        execution_type = str(trade.get("execution_type") or "OTC").upper()
        if trade.get("is_cash_sweeper"):
            return f"- [忽略][归集基金] {trade['symbol']} - 理由：{trade['decision_note']}"
        if execution_type == "EXCHANGE":
            label = trade.get("ticker") or trade.get("symbol")
            return f"- [忽略][证券] {label} - 理由：{trade['decision_note']}"
        return f"- [忽略][基金] {trade['symbol']} - 理由：{trade['decision_note']}"

    def _apply_dynamic_cash_tracker(
        self,
        decisions: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        current_available_cash = self.initial_available_cash_cny
        tracked: list[dict[str, Any]] = []
        sell_released_cny = 0.0
        buy_committed_cny = 0.0
        sweeper_committed_cny = 0.0
        execution_order: list[dict[str, Any]] = []

        sorted_decisions = sorted(decisions, key=self._decision_execution_sort_key)
        for sequence, decision in enumerate(sorted_decisions, start=1):
            action = str(decision.get("execution_action") or "Hold")
            cash_before = current_available_cash
            updated = {**decision}

            if action == "Buy":
                actual_cost = self._estimate_cash_movement(updated)
                if current_available_cash + 1e-9 < actual_cost:
                    updated = self._cap_buy_decision_to_budget(updated, current_available_cash)
                    actual_cost = self._estimate_cash_movement(updated)
                current_available_cash = round_money(max(current_available_cash - actual_cost, 0.0))
                if updated.get("execution_action") == "Buy":
                    buy_committed_cny += actual_cost
            elif action == "Sell":
                cash_released = self._estimate_cash_movement(updated)
                current_available_cash = round_money(current_available_cash + cash_released)
                sell_released_cny += cash_released

            updated = self._annotate_cash_tracking(
                updated,
                sequence=sequence,
                cash_before=cash_before,
                cash_after=current_available_cash,
            )
            tracked.append(updated)
            execution_order.append(
                {
                    "sequence": sequence,
                    "symbol": updated.get("ticker") or updated.get("symbol"),
                    "action": updated.get("execution_action"),
                    "cash_before_cny": round_money(cash_before),
                    "cash_after_cny": round_money(current_available_cash),
                }
            )

        sweeper = self._build_cash_sweeper_decision(current_available_cash)
        if sweeper is not None:
            cash_before = current_available_cash
            sweeper_cost = self._estimate_cash_movement(sweeper)
            current_available_cash = round_money(max(current_available_cash - sweeper_cost, 0.0))
            buy_committed_cny += sweeper_cost
            sweeper_committed_cny += sweeper_cost
            sweeper = self._annotate_cash_tracking(
                sweeper,
                sequence=len(tracked) + 1,
                cash_before=cash_before,
                cash_after=current_available_cash,
            )
            tracked.append(sweeper)
            execution_order.append(
                {
                    "sequence": int(sweeper.get("execution_sequence") or len(tracked)),
                    "symbol": sweeper.get("symbol"),
                    "action": sweeper.get("execution_action"),
                    "cash_before_cny": round_money(cash_before),
                    "cash_after_cny": round_money(current_available_cash),
                }
            )

        return tracked, {
            "starting_available_cash_cny": self.initial_available_cash_cny,
            "ending_available_cash_cny": current_available_cash,
            "sell_released_cny": round_money(sell_released_cny),
            "buy_committed_cny": round_money(buy_committed_cny),
            "sweeper_committed_cny": round_money(sweeper_committed_cny),
            "sweeper_triggered": sweeper is not None,
            "execution_order": execution_order,
        }

    def _decision_execution_sort_key(self, decision: dict[str, Any]) -> tuple[int, int, int, str]:
        action = str(decision.get("execution_action") or "Hold")
        if action == "Sell":
            action_rank = 0
        elif action == "Buy":
            action_rank = 1
        else:
            action_rank = 2
        buy_style_rank = 0 if decision.get("signal_action") == "Accumulate" else 1
        return (
            action_rank,
            int(decision.get("trade_priority_rank") or 999),
            buy_style_rank,
            str(decision.get("ticker") or decision.get("symbol") or ""),
        )

    def _estimate_cash_movement(self, decision: dict[str, Any]) -> float:
        if str(decision.get("execution_action") or "Hold") == "Hold":
            return 0.0
        execution_type = str(decision.get("execution_type") or "OTC").upper()
        if execution_type == "EXCHANGE":
            return round_money(decision.get("expected_notional_cny"))
        return round_money(decision.get("planned_trade_amount_cny"))

    def _annotate_cash_tracking(
        self,
        decision: dict[str, Any],
        *,
        sequence: int,
        cash_before: float,
        cash_after: float,
    ) -> dict[str, Any]:
        updated = {**decision}
        action = str(updated.get("execution_action") or "Hold")
        movement = self._estimate_cash_movement(updated)
        tracker_note = None

        if action == "Buy" and movement > 0:
            tracker_note = (
                f"本笔执行前可用现金 {format_money(cash_before)} 元，实际占用 {format_money(movement)} 元；"
                f"执行后剩余 {format_money(cash_after)} 元，尾款自动滚入后续资产。"
            )
        elif action == "Sell" and movement > 0:
            tracker_note = (
                f"本笔预计回笼 {format_money(movement)} 元，可用现金由 {format_money(cash_before)} 元"
                f"升至 {format_money(cash_after)} 元。"
            )
        elif updated.get("suppressed_by_cash_guardrail"):
            tracker_note = (
                f"轮到该资产时可用现金仅 {format_money(cash_before)} 元，本笔未成交，"
                f"额度继续留给后续资产。"
            )

        updated["execution_sequence"] = int(sequence)
        updated["cash_available_before_trade_cny"] = round_money(cash_before)
        updated["cash_available_after_trade_cny"] = round_money(cash_after)
        updated["cash_delta_cny"] = round_money(cash_after - cash_before)
        if action == "Buy":
            updated["cash_guardrail_remaining_after_trade_cny"] = round_money(cash_after)
        if tracker_note:
            updated["decision_note"] = f"{updated['decision_note']} {tracker_note}"
        return updated

    def _suppress_for_cash_guardrail(self, decision: dict[str, Any], note: str) -> dict[str, Any]:
        return {
            **decision,
            "execution_action": "Hold",
            "final_delta_cny": 0.0,
            "planned_trade_amount_cny": 0.0,
            "quantity": 0,
            "final_share_delta": 0,
            "exchange_order": None,
            "suppressed_by_cash_guardrail": True,
            "cash_guardrail_capped": False,
            "cash_guardrail_remaining_after_trade_cny": 0.0,
            "decision_note": note,
        }

    def _cap_buy_decision_to_budget(self, decision: dict[str, Any], remaining_buy_budget: float) -> dict[str, Any]:
        execution_type = str(decision.get("execution_type") or "OTC").upper()
        executable_amount = round_money(max(remaining_buy_budget, 0.0))
        if execution_type == "EXCHANGE":
            last_price = safe_float(decision.get("last_price"))
            lot_size = int(decision.get("lot_size") or 100)
            slippage_buffer = safe_float(decision.get("slippage_buffer"))
            if slippage_buffer is None:
                slippage_buffer = DEFAULT_SLIPPAGE_BUFFER
            limit_price = safe_float(decision.get("price_hint"))
            if limit_price is None and last_price is not None and last_price > 0:
                limit_price = self._build_price_hint(last_price, "Buy", slippage_buffer)
            executable_quantity = floor_lot_quantity(executable_amount, limit_price, lot_size)
            executable_amount = round_money(executable_quantity * (limit_price or 0.0))
            if executable_quantity < lot_size or executable_amount < MIN_EXCHANGE_TRADE_NOTIONAL:
                note = (
                    f"{decision['decision_note']} 动态现金防线要求保留 {format_money(self.required_cash_reserve_cny)} 元；"
                    f"本笔轮到执行时，可用于场内新增委托的资金仅 {format_money(executable_amount)} 元，"
                    f"不足以满足场内最小交易价值 {format_money(MIN_EXCHANGE_TRADE_NOTIONAL)} 元，静默处理。"
                )
                return self._suppress_for_cash_guardrail(decision, note)

            updated = {**decision}
            price_hint = limit_price or (last_price or 0.0)
            estimated_slippage_cost = round_money(executable_quantity * abs((price_hint or 0.0) - (last_price or 0.0)))
            updated["quantity"] = executable_quantity
            updated["final_share_delta"] = executable_quantity
            updated["final_delta_cny"] = executable_amount
            updated["planned_trade_amount_cny"] = executable_amount
            updated["expected_notional_cny"] = executable_amount
            updated["price_hint"] = round_or_none(price_hint, 4)
            updated["order_type"] = "Limit"
            updated["estimated_slippage_cost_cny"] = estimated_slippage_cost
            updated["cash_guardrail_capped"] = True
            updated["cash_guardrail_remaining_after_trade_cny"] = round_money(
                max(remaining_buy_budget - executable_amount, 0.0)
            )
            updated["decision_note"] = (
                f"{decision['decision_note']} 动态现金防线要求保留 {format_money(self.required_cash_reserve_cny)} 元；"
                f"本笔轮到执行时，场内可新增资金仅剩 {format_money(executable_amount)} 元，折算为 {executable_quantity} 股执行。"
            )
            updated["exchange_order"] = {
                "symbol": updated.get("ticker") or updated.get("symbol"),
                "action": updated.get("execution_action"),
                "order_type": "Limit",
                "quantity": executable_quantity,
                "price_hint": round_or_none(price_hint, 4),
            }
            return updated

        if executable_amount < self.min_trade_amount:
            note = (
                f"{decision['decision_note']} 动态现金防线要求保留 {format_money(self.required_cash_reserve_cny)} 元；"
                f"本笔轮到执行时，可新增资金仅 {format_money(executable_amount)} 元，"
                f"低于最小交易门槛 {format_money(self.min_trade_amount)} 元，静默处理。"
            )
            return self._suppress_for_cash_guardrail(decision, note)

        updated = {**decision}
        updated["final_delta_cny"] = executable_amount
        updated["planned_trade_amount_cny"] = executable_amount
        updated["cash_guardrail_capped"] = True
        updated["decision_note"] = (
            f"{decision['decision_note']} 动态现金防线要求保留 {format_money(self.required_cash_reserve_cny)} 元；"
            f"本笔轮到执行时，可新增资金仅剩 {format_money(executable_amount)} 元，故按 {format_money(executable_amount)} 元执行。"
        )
        updated["cash_guardrail_remaining_after_trade_cny"] = round_money(
            max(remaining_buy_budget - executable_amount, 0.0)
        )
        return updated

    def _load_cash_sweeper_config(self) -> dict[str, Any] | None:
        config = self.asset_master.get("cash_sweeper") or {}
        if not config or not bool(config.get("enabled")):
            return None
        symbol = str(config.get("symbol") or "").strip()
        name = str(config.get("name") or "").strip()
        if not symbol or not name:
            return None
        return {
            "enabled": True,
            "symbol": symbol,
            "name": name,
            "execution_type": "OTC",
            "activation_threshold_cny": round_money(config.get("activation_threshold_cny")),
            "min_trade_amount_cny": round_money(
                config.get("min_trade_amount_cny") or self.min_trade_amount
            ),
            "priority_rank": int(config.get("priority_rank") or 999),
            "note": str(config.get("note") or "").strip(),
        }

    def _build_cash_sweeper_decision(self, available_cash: float) -> dict[str, Any] | None:
        if not self.cash_sweeper:
            return None

        activation_threshold = round_money(self.cash_sweeper.get("activation_threshold_cny"))
        min_trade_amount = round_money(self.cash_sweeper.get("min_trade_amount_cny") or self.min_trade_amount)
        sweep_amount = round_money(max(available_cash, 0.0))
        if sweep_amount < max(activation_threshold, min_trade_amount):
            return None

        symbol = str(self.cash_sweeper["symbol"])
        name = str(self.cash_sweeper["name"])
        position = self.current_positions.get(
            symbol,
            {
                "symbol": symbol,
                "name": name,
                "current_position_cny": 0.0,
                "shares": 0,
                "cost_price": None,
                "category": "cash_sweeper",
            },
        )
        current_position = round_money(position.get("current_position_cny"))
        target_value = round_money(current_position + sweep_amount)
        sweep_note = self.cash_sweeper.get("note") or "闲置现金自动归集到底仓资产。"
        decision_note = (
            f"{sweep_note} 所有核心资产完成分配后，仍剩 {format_money(sweep_amount)} 元可用现金，"
            f"高于归集阈值 {format_money(activation_threshold)} 元，自动买入该 OTC 归集资产。"
        )
        synthetic_signal = {
            "bucket": "CASH_SWEEP",
            "execution_type": "OTC",
            "Action": "Sweep",
            "Weight_Target": 0.0,
            "bucket_priority_rank": int(self.cash_sweeper.get("priority_rank") or 999),
            "reasons": [sweep_note],
            "is_cash_sweeper": True,
            "execution_context": {
                "target_amount_cny": target_value,
                "target_value_cny": target_value,
            },
        }
        return self._build_decision_record(
            symbol=symbol,
            name=name,
            signal=synthetic_signal,
            execution_action="Buy",
            effective_weight_target=0.0,
            current_position=current_position,
            target_value=target_value,
            raw_delta=sweep_amount,
            final_delta=sweep_amount,
            planned_trade_amount=sweep_amount,
            decision_note=decision_note,
            velocity_capped=False,
            suppressed_by_friction=False,
            ledger_position_cny=safe_float(position.get("current_position_cny")),
        )

    def _build_asset_config_lookup(self) -> dict[str, dict[str, Any]]:
        lookup: dict[str, dict[str, Any]] = {}
        for asset in self.asset_master.get("assets", []):
            symbol = str(asset.get("symbol") or "").strip()
            ticker = str(asset.get("ticker") or "").strip()
            if symbol:
                lookup[symbol] = asset
            if ticker:
                lookup[ticker] = asset
        return lookup

    def _resolve_asset_config(self, symbol: str, signal: dict[str, Any]) -> dict[str, Any] | None:
        candidate_keys = [
            str(signal.get("ticker") or "").strip(),
            str((signal.get("execution_context") or {}).get("ticker") or "").strip(),
            str(symbol or "").strip(),
        ]
        for key in candidate_keys:
            if key and key in self.asset_config_by_key:
                return self.asset_config_by_key[key]
        return None

    def _build_watchlist_lookup(self) -> dict[str, dict[str, Any]]:
        lookup: dict[str, dict[str, Any]] = {}
        for item in self.watchlist.get("watchlist", []):
            code = str(item.get("code") or "").strip()
            name = str(item.get("name") or "").strip()
            if not code or not name:
                continue
            lookup[normalize_fund_name(name)] = {
                "code": code,
                "name": name,
            }
        return lookup

    def _resolve_position_symbol(self, position: dict[str, Any]) -> tuple[str | None, str | None]:
        explicit_symbol = str(
            position.get("ticker") or position.get("symbol") or position.get("code") or ""
        ).strip()
        if explicit_symbol:
            return explicit_symbol, position.get("name") or explicit_symbol

        normalized = normalize_fund_name(position.get("name", ""))
        watchlist_match = self.watchlist_by_name.get(normalized)
        if not watchlist_match:
            return None, None
        return watchlist_match["code"], watchlist_match["name"]

    def _build_current_positions(self) -> dict[str, dict[str, Any]]:
        positions_by_symbol: dict[str, dict[str, Any]] = {}
        for position in self.portfolio_state.get("positions", []):
            if position.get("status") != "active":
                continue
            symbol, canonical_name = self._resolve_position_symbol(position)
            if not symbol:
                continue

            amount = safe_float(position.get("amount"))
            shares = int(round(safe_float(position.get("shares")) or 0))
            cost_price = round_or_none(position.get("cost_price"), 4)
            sellable_raw = position.get("sellable_shares")
            sellable_shares = (
                int(round(safe_float(sellable_raw) or 0))
                if sellable_raw is not None
                else None
            )
            current_position_cny = round_money(amount) if amount is not None else None
            if current_position_cny is None and shares > 0 and (cost_price or 0.0) > 0:
                current_position_cny = round_money(shares * float(cost_price))
            positions_by_symbol[symbol] = {
                "symbol": symbol,
                "ticker": str(position.get("ticker") or symbol).strip() or symbol,
                "name": position.get("name") or canonical_name or symbol,
                "execution_type": str(position.get("execution_type") or "OTC").upper(),
                "current_position_cny": current_position_cny,
                "shares": shares,
                "sellable_shares": sellable_shares,
                "cost_price": cost_price,
                "category": position.get("category"),
            }
        return positions_by_symbol

    def _resolve_total_portfolio_value(self) -> float:
        reported_min = safe_float(
            self.account_context.get("reported_total_assets_range_cny", {}).get("min")
        )
        if reported_min is not None and reported_min > 0:
            return round_money(reported_min)

        portfolio_total = safe_float(self.portfolio_state.get("summary", {}).get("total_fund_assets"))
        if portfolio_total is not None and portfolio_total > 0:
            return round_money(portfolio_total)

        raise ValueError("unable to resolve total portfolio value from account context or portfolio_state summary")

    def _resolve_cash_estimate(self) -> tuple[float, str]:
        portfolio_summary_cash = safe_float(self.portfolio_state.get("summary", {}).get("available_cash_cny"))
        if portfolio_summary_cash is not None and portfolio_summary_cash >= 0:
            return round_money(portfolio_summary_cash), "portfolio_state.summary.available_cash_cny"

        portfolio_cash_ledger = safe_float(self.portfolio_state.get("cash_ledger", {}).get("available_cash_cny"))
        if portfolio_cash_ledger is not None and portfolio_cash_ledger >= 0:
            return round_money(portfolio_cash_ledger), "portfolio_state.cash_ledger.available_cash_cny"

        fallback_cash = safe_float(self.account_context.get("reported_cash_estimate_cny")) or 0.0
        return round_money(max(fallback_cash, 0.0)), "account_context.reported_cash_estimate_cny"

    def _build_trade_decision(self, symbol: str, signal: dict[str, Any]) -> dict[str, Any]:
        position = self._resolve_signal_position(symbol, signal)
        name = signal.get("name") or position.get("name") or symbol
        asset_config = self._resolve_asset_config(symbol, signal) or {}
        enriched_signal = {
            **signal,
            "settlement_rule": signal.get("settlement_rule") or asset_config.get("settlement_rule"),
        }
        execution_type = str(signal.get("execution_type") or "OTC").upper()
        if execution_type == "EXCHANGE":
            return self.process_exchange_trade(symbol, name, enriched_signal, position)
        return self.process_otc_trade(symbol, name, enriched_signal, position)

    def _resolve_signal_position(self, symbol: str, signal: dict[str, Any]) -> dict[str, Any]:
        execution_type = str(signal.get("execution_type") or "OTC").upper()
        execution_context = signal.get("execution_context") or {}
        ticker = str(signal.get("ticker") or execution_context.get("ticker") or "").strip()

        candidate_keys: list[str] = []
        if execution_type == "EXCHANGE" and ticker:
            candidate_keys.append(ticker)
        candidate_keys.append(symbol)

        for key in candidate_keys:
            if key and key in self.current_positions:
                return {**self.current_positions[key], "lookup_key": key}

        return {
            "symbol": symbol,
            "name": signal.get("name") or symbol,
            "current_position_cny": None,
            "shares": 0,
            "sellable_shares": None,
            "cost_price": None,
            "category": None,
            "lookup_key": None,
        }

    def _build_price_hint(self, last_price: float, execution_action: str, slippage_buffer: float) -> float:
        if execution_action == "Buy":
            return round(last_price * (1.0 + slippage_buffer), 4)
        if execution_action == "Sell":
            return round(last_price * (1.0 - slippage_buffer), 4)
        return round(last_price, 4)

    def _resolve_sellable_shares(
        self,
        *,
        position: dict[str, Any],
        current_shares: int,
        settlement_rule: str,
    ) -> int:
        explicit = position.get("sellable_shares")
        if explicit is not None:
            return max(0, min(int(round(safe_float(explicit) or 0)), int(current_shares)))
        if settlement_rule == "T+0":
            return max(int(current_shares), 0)
        return 0

    def _floor_sellable_quantity(self, sellable_shares: int, lot_size: int) -> int:
        if sellable_shares <= 0:
            return 0
        lot = max(int(lot_size), 1)
        return sellable_shares // lot * lot

    def _build_exchange_order(
        self,
        *,
        ticker: str,
        execution_action: str,
        quantity: int,
        price_hint: float,
    ) -> dict[str, Any]:
        return {
            "symbol": ticker,
            "action": execution_action,
            "order_type": "Limit",
            "quantity": int(quantity),
            "price_hint": round_or_none(price_hint, 4),
        }

    def _build_decision_record(
        self,
        *,
        symbol: str,
        name: str,
        signal: dict[str, Any],
        execution_action: str,
        effective_weight_target: float,
        current_position: float,
        target_value: float,
        raw_delta: float,
        final_delta: float,
        planned_trade_amount: float,
        decision_note: str,
        velocity_capped: bool,
        suppressed_by_friction: bool,
        current_shares: int = 0,
        target_shares: int = 0,
        raw_share_delta: int = 0,
        final_share_delta: int = 0,
        quantity: int = 0,
        last_price: float | None = None,
        price_hint: float | None = None,
        exchange_order: dict[str, Any] | None = None,
        ledger_position_cny: float | None = None,
        slippage_buffer: float | None = None,
        estimated_slippage_cost_cny: float = 0.0,
        expected_notional_cny: float | None = None,
        sellable_shares: int | None = None,
        max_allowed_sell_shares: int | None = None,
    ) -> dict[str, Any]:
        execution_type = str(signal.get("execution_type") or "OTC").upper()
        execution_context = signal.get("execution_context") or {}
        ticker = str(signal.get("ticker") or execution_context.get("ticker") or "").strip() or None
        lot_size = max(int(signal.get("lot_size") or execution_context.get("lot_size") or 100), 1)

        return {
            "symbol": symbol,
            "name": name,
            "bucket": signal.get("bucket"),
            "is_cash_sweeper": bool(signal.get("is_cash_sweeper")),
            "execution_type": execution_type,
            "ticker": ticker,
            "settlement_rule": signal.get("settlement_rule"),
            "lot_size": lot_size,
            "order_type": exchange_order.get("order_type") if exchange_order else None,
            "signal_action": signal.get("Action"),
            "execution_action": execution_action,
            "trade_priority_rank": int(signal.get("bucket_priority_rank") or 999),
            "weight_target": round(safe_float(signal.get("Weight_Target")) or 0.0, 4),
            "effective_weight_target": round(effective_weight_target, 4),
            "total_portfolio_value_cny": self.total_portfolio_value,
            "current_position_cny": round_money(current_position),
            "ledger_position_cny": round_money(ledger_position_cny) if ledger_position_cny is not None else None,
            "target_value_cny": round_money(target_value),
            "raw_delta_cny": round_money(raw_delta),
            "final_delta_cny": round_money(final_delta),
            "planned_trade_amount_cny": round_money(planned_trade_amount),
            "last_price": round_or_none(last_price, 4),
            "price_hint": round_or_none(price_hint, 4),
            "expected_notional_cny": round_money(expected_notional_cny)
            if expected_notional_cny is not None
            else round_money(planned_trade_amount),
            "slippage_buffer": round_or_none(slippage_buffer, 4),
            "estimated_slippage_cost_cny": round_money(estimated_slippage_cost_cny),
            "current_shares": int(current_shares),
            "sellable_shares": int(sellable_shares) if sellable_shares is not None else None,
            "max_allowed_sell_shares": int(max_allowed_sell_shares)
            if max_allowed_sell_shares is not None
            else None,
            "target_shares": int(target_shares),
            "raw_share_delta": int(raw_share_delta),
            "final_share_delta": int(final_share_delta),
            "quantity": int(quantity),
            "exchange_order": exchange_order,
            "velocity_capped": velocity_capped,
            "suppressed_by_friction": suppressed_by_friction,
            "suppressed_by_cash_guardrail": False,
            "cash_guardrail_capped": False,
            "cash_guardrail_remaining_after_trade_cny": None,
            "execution_sequence": None,
            "cash_available_before_trade_cny": None,
            "cash_available_after_trade_cny": None,
            "cash_delta_cny": None,
            "decision_note": decision_note,
            "signal_reasons": signal.get("reasons", []),
            "market_data_symbol": signal.get("market_data_symbol"),
            "allocation_context": signal.get("allocation_context", {}),
            "execution_context": execution_context,
        }

    def process_otc_trade(
        self,
        symbol: str,
        name: str,
        signal: dict[str, Any],
        position: dict[str, Any],
    ) -> dict[str, Any]:
        raw_action = str(signal.get("Action") or "Hold")
        raw_weight_target = safe_float(signal.get("Weight_Target")) or 0.0
        effective_weight_target = self.kill_switch_floor_weight if raw_action == "Kill_Switch" else raw_weight_target
        execution_context = signal.get("execution_context") or {}
        current_position = round_money(position.get("current_position_cny"))
        target_value = round_money(
            execution_context.get("target_amount_cny")
            if raw_action != "Kill_Switch"
            else self.total_portfolio_value * effective_weight_target
        )
        raw_delta = round_money(target_value - current_position)

        if raw_action == "Kill_Switch":
            if current_position <= target_value:
                return self._build_hold_decision(
                    symbol=symbol,
                    name=name,
                    signal=signal,
                    current_position=current_position,
                    target_value=target_value,
                    raw_delta=raw_delta,
                    final_delta=0.0,
                    note="Kill Switch 已触发，但当前仓位已低于绝对下限，无需继续卖出。",
                    suppressed_by_friction=False,
                    effective_weight_target=effective_weight_target,
                )

            return self._build_decision_record(
                symbol=symbol,
                name=name,
                signal=signal,
                execution_action="Sell",
                effective_weight_target=effective_weight_target,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=raw_delta,
                planned_trade_amount=abs(raw_delta),
                decision_note="Kill Switch 熔断指令，无视最小交易门槛，强制压降至绝对下限。",
                velocity_capped=False,
                suppressed_by_friction=False,
            )

        execution_action, base_note = self._resolve_execution_action(raw_action, raw_delta)
        if execution_action == "Hold":
            return self._build_hold_decision(
                symbol=symbol,
                name=name,
                signal=signal,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=0.0,
                note=base_note,
                suppressed_by_friction=False,
                effective_weight_target=effective_weight_target,
            )

        filtered_delta, velocity_note, velocity_capped = self._apply_velocity_filter(
            raw_action=raw_action,
            execution_action=execution_action,
            raw_delta=raw_delta,
        )
        abs_filtered_delta = abs(filtered_delta)
        if abs_filtered_delta < self.min_trade_amount:
            friction_note = (
                f"原始调仓缺口为 {format_money(abs(raw_delta))} 元；"
                f"限速后可执行金额为 {format_money(abs_filtered_delta)} 元，仍小于摩擦成本阈值 {format_money(self.min_trade_amount)} 元，静默处理。"
            )
            if velocity_note:
                friction_note = f"{velocity_note} {friction_note}"
            return self._build_hold_decision(
                symbol=symbol,
                name=name,
                signal=signal,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=0.0,
                note=friction_note,
                suppressed_by_friction=True,
                effective_weight_target=effective_weight_target,
            )

        decision_note = base_note if not velocity_note else f"{base_note} {velocity_note}"
        return self._build_decision_record(
            symbol=symbol,
            name=name,
            signal=signal,
            execution_action=execution_action,
            effective_weight_target=effective_weight_target,
            current_position=current_position,
            target_value=target_value,
            raw_delta=raw_delta,
            final_delta=filtered_delta,
            planned_trade_amount=abs_filtered_delta,
            decision_note=decision_note,
            velocity_capped=velocity_capped,
            suppressed_by_friction=False,
        )

    def process_exchange_trade(
        self,
        symbol: str,
        name: str,
        signal: dict[str, Any],
        position: dict[str, Any],
    ) -> dict[str, Any]:
        raw_action = str(signal.get("Action") or "Hold")
        raw_weight_target = safe_float(signal.get("Weight_Target")) or 0.0
        effective_weight_target = self.kill_switch_floor_weight if raw_action == "Kill_Switch" else raw_weight_target
        execution_context = signal.get("execution_context") or {}
        ticker = str(signal.get("ticker") or execution_context.get("ticker") or symbol).strip()
        settlement_rule = str(signal.get("settlement_rule") or "T+1").upper()
        lot_size = max(int(signal.get("lot_size") or execution_context.get("lot_size") or 100), 1)
        last_price = safe_float(execution_context.get("last_price"))
        slippage_buffer = safe_float(signal.get("slippage_buffer"))
        if slippage_buffer is None:
            slippage_buffer = safe_float(execution_context.get("slippage_buffer"))
        if slippage_buffer is None:
            slippage_buffer = DEFAULT_SLIPPAGE_BUFFER

        if last_price is None or last_price <= 0:
            return self._build_hold_decision(
                symbol=symbol,
                name=name,
                signal=signal,
                current_position=0.0,
                target_value=0.0,
                raw_delta=0.0,
                final_delta=0.0,
                note="场内资产缺少有效最新价，无法换算目标股数，执行层静默处理。",
                suppressed_by_friction=False,
                effective_weight_target=effective_weight_target,
                current_shares=int(position.get("shares") or 0),
                sellable_shares=position.get("sellable_shares"),
                max_allowed_sell_shares=position.get("sellable_shares"),
                target_shares=0,
                raw_share_delta=0,
                last_price=last_price,
                ledger_position_cny=safe_float(position.get("current_position_cny")),
                slippage_buffer=slippage_buffer,
            )

        ledger_position_cny = safe_float(position.get("current_position_cny"))
        current_shares = int(position.get("shares") or 0)
        if current_shares <= 0 and (ledger_position_cny or 0.0) > 0:
            current_shares = floor_lot_quantity(ledger_position_cny, last_price, lot_size)
        sellable_shares = self._resolve_sellable_shares(
            position=position,
            current_shares=current_shares,
            settlement_rule=settlement_rule,
        )
        max_allowed_sell_shares = self._floor_sellable_quantity(sellable_shares, lot_size)

        current_position = round_money(current_shares * last_price)
        if raw_action == "Kill_Switch":
            target_shares = floor_lot_quantity(self.total_portfolio_value * effective_weight_target, last_price, lot_size)
        else:
            target_shares = int(safe_float(execution_context.get("target_shares")) or 0)

        target_shares = max(target_shares, 0)
        target_value = round_money(target_shares * last_price)
        raw_share_delta = int(target_shares - current_shares)
        raw_delta = round_money(target_value - current_position)

        if raw_action == "Kill_Switch":
            if raw_share_delta >= 0:
                return self._build_hold_decision(
                    symbol=symbol,
                    name=name,
                    signal=signal,
                    current_position=current_position,
                    target_value=target_value,
                    raw_delta=raw_delta,
                    final_delta=0.0,
                    note="Kill Switch 已触发，但当前场内仓位已不高于绝对下限，无需继续卖出。",
                    suppressed_by_friction=False,
                    effective_weight_target=effective_weight_target,
                    current_shares=current_shares,
                    sellable_shares=sellable_shares,
                    max_allowed_sell_shares=max_allowed_sell_shares,
                    target_shares=target_shares,
                    raw_share_delta=raw_share_delta,
                    last_price=last_price,
                    ledger_position_cny=ledger_position_cny,
                    slippage_buffer=slippage_buffer,
                )

            requested_sell_shares = abs(raw_share_delta)
            quantity = min(requested_sell_shares, max_allowed_sell_shares)
            if quantity <= 0:
                return self._build_hold_decision(
                    symbol=symbol,
                    name=name,
                    signal=signal,
                    current_position=current_position,
                    target_value=target_value,
                    raw_delta=raw_delta,
                    final_delta=0.0,
                    note=(
                        f"Kill Switch 已触发，但受限于 {settlement_rule} 结算规则，当前仅有 "
                        f"{sellable_shares} 股可卖，无法生成合法卖单。"
                    ),
                    suppressed_by_friction=False,
                    effective_weight_target=effective_weight_target,
                    current_shares=current_shares,
                    sellable_shares=sellable_shares,
                    max_allowed_sell_shares=max_allowed_sell_shares,
                    target_shares=target_shares,
                    raw_share_delta=raw_share_delta,
                    last_price=last_price,
                    ledger_position_cny=ledger_position_cny,
                    slippage_buffer=slippage_buffer,
                )

            settlement_note = None
            if quantity < requested_sell_shares:
                settlement_note = (
                    f"受限于 {settlement_rule} 结算规则，仅执行卖出 {quantity} 股"
                    f"（总持仓 {current_shares} 股，可卖 {sellable_shares} 股）。"
                )
            price_hint = self._build_price_hint(last_price, "Sell", slippage_buffer)
            expected_notional = round_money(quantity * price_hint)
            estimated_slippage_cost = round_money(quantity * abs(price_hint - last_price))
            final_delta = -expected_notional
            return self._build_decision_record(
                symbol=symbol,
                name=name,
                signal=signal,
                execution_action="Sell",
                effective_weight_target=effective_weight_target,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=final_delta,
                planned_trade_amount=abs(final_delta),
                decision_note=" ".join(
                    item
                    for item in [
                        "Kill Switch 熔断指令，无视最小交易门槛和限速，按目标股数一次性压降仓位。",
                        settlement_note,
                    ]
                    if item
                ),
                velocity_capped=False,
                suppressed_by_friction=False,
                current_shares=current_shares,
                sellable_shares=sellable_shares,
                max_allowed_sell_shares=max_allowed_sell_shares,
                target_shares=target_shares,
                raw_share_delta=raw_share_delta,
                final_share_delta=-quantity,
                quantity=quantity,
                last_price=last_price,
                price_hint=price_hint,
                slippage_buffer=slippage_buffer,
                estimated_slippage_cost_cny=estimated_slippage_cost,
                expected_notional_cny=expected_notional,
                exchange_order=self._build_exchange_order(
                    ticker=ticker,
                    execution_action="Sell",
                    quantity=quantity,
                    price_hint=price_hint,
                ),
                ledger_position_cny=ledger_position_cny,
            )

        if raw_share_delta == 0:
            return self._build_hold_decision(
                symbol=symbol,
                name=name,
                signal=signal,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=0.0,
                note="当前场内持仓股数已与目标股数一致，无需调仓。",
                suppressed_by_friction=False,
                effective_weight_target=effective_weight_target,
                current_shares=current_shares,
                sellable_shares=sellable_shares,
                max_allowed_sell_shares=max_allowed_sell_shares,
                target_shares=target_shares,
                raw_share_delta=raw_share_delta,
                last_price=last_price,
                ledger_position_cny=ledger_position_cny,
                slippage_buffer=slippage_buffer,
            )

        execution_action, base_note = self._resolve_execution_action(raw_action, raw_delta)
        if execution_action == "Hold":
            return self._build_hold_decision(
                symbol=symbol,
                name=name,
                signal=signal,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=0.0,
                note=base_note,
                suppressed_by_friction=False,
                effective_weight_target=effective_weight_target,
                current_shares=current_shares,
                sellable_shares=sellable_shares,
                max_allowed_sell_shares=max_allowed_sell_shares,
                target_shares=target_shares,
                raw_share_delta=raw_share_delta,
                last_price=last_price,
                ledger_position_cny=ledger_position_cny,
                slippage_buffer=slippage_buffer,
            )

        price_hint = self._build_price_hint(last_price, execution_action, slippage_buffer)
        filtered_delta, velocity_note, velocity_capped = self._apply_velocity_filter(
            raw_action=raw_action,
            execution_action=execution_action,
            raw_delta=raw_delta,
        )
        quantity = floor_lot_quantity(abs(filtered_delta), price_hint, lot_size)
        quantity = min(quantity, abs(raw_share_delta))
        quantity = quantity // lot_size * lot_size
        settlement_note = None
        if execution_action == "Sell":
            requested_sell_shares = quantity
            quantity = min(quantity, max_allowed_sell_shares)
            quantity = quantity // lot_size * lot_size
            if quantity < requested_sell_shares:
                settlement_note = (
                    f"受限于 {settlement_rule} 结算规则，仅执行卖出 {quantity} 股"
                    f"（总持仓 {current_shares} 股，可卖 {sellable_shares} 股，原始缺口 {abs(raw_share_delta)} 股）。"
                )
        planned_trade_amount = round_money(quantity * price_hint)
        estimated_slippage_cost = round_money(quantity * abs(price_hint - last_price))

        lot_note = None
        if quantity > 0 and not math.isclose(planned_trade_amount, abs(filtered_delta), abs_tol=1e-9):
            lot_note = (
                f"按 {lot_size} 股整手约束折算后，本轮实际委托 {quantity} 股，"
                f"对应 {format_money(planned_trade_amount)} 元。"
            )

        if quantity < lot_size or planned_trade_amount < MIN_EXCHANGE_TRADE_NOTIONAL:
            friction_note = (
                f"目标股数缺口为 {abs(raw_share_delta)} 股，按限速与整手约束折算后仅剩 "
                f"{quantity} 股 / {format_money(planned_trade_amount)} 元，低于场内最小交易价值 "
                f"{format_money(MIN_EXCHANGE_TRADE_NOTIONAL)} 元，静默处理。"
            )
            note_parts = [base_note]
            if velocity_note:
                note_parts.append(velocity_note)
            if lot_note:
                note_parts.append(lot_note)
            if settlement_note:
                note_parts.append(settlement_note)
            note_parts.append(friction_note)
            return self._build_hold_decision(
                symbol=symbol,
                name=name,
                signal=signal,
                current_position=current_position,
                target_value=target_value,
                raw_delta=raw_delta,
                final_delta=0.0,
                note=" ".join(note_parts),
                suppressed_by_friction=True,
                effective_weight_target=effective_weight_target,
                current_shares=current_shares,
                sellable_shares=sellable_shares,
                max_allowed_sell_shares=max_allowed_sell_shares,
                target_shares=target_shares,
                raw_share_delta=raw_share_delta,
                last_price=last_price,
                ledger_position_cny=ledger_position_cny,
                slippage_buffer=slippage_buffer,
            )

        final_share_delta = quantity if execution_action == "Buy" else -quantity
        final_delta = planned_trade_amount if execution_action == "Buy" else -planned_trade_amount

        note_parts = [base_note]
        if velocity_note:
            note_parts.append(velocity_note)
        if lot_note:
            note_parts.append(lot_note)
        if settlement_note:
            note_parts.append(settlement_note)
        note_parts.append(
            f"原始缺口 {abs(raw_share_delta)} 股，本轮执行 {quantity} 股；预估滑点成本 {format_money(estimated_slippage_cost)} 元。"
        )

        return self._build_decision_record(
            symbol=symbol,
            name=name,
            signal=signal,
            execution_action=execution_action,
            effective_weight_target=effective_weight_target,
            current_position=current_position,
            target_value=target_value,
            raw_delta=raw_delta,
            final_delta=final_delta,
            planned_trade_amount=planned_trade_amount,
            decision_note=" ".join(note_parts),
            velocity_capped=velocity_capped,
            suppressed_by_friction=False,
            current_shares=current_shares,
            sellable_shares=sellable_shares,
            max_allowed_sell_shares=max_allowed_sell_shares,
            target_shares=target_shares,
            raw_share_delta=raw_share_delta,
            final_share_delta=final_share_delta,
            quantity=quantity,
            last_price=last_price,
            price_hint=price_hint,
            slippage_buffer=slippage_buffer,
            estimated_slippage_cost_cny=estimated_slippage_cost,
            expected_notional_cny=planned_trade_amount,
            exchange_order=self._build_exchange_order(
                ticker=ticker,
                execution_action=execution_action,
                quantity=quantity,
                price_hint=price_hint,
            ),
            ledger_position_cny=ledger_position_cny,
        )

    def _apply_velocity_filter(
        self,
        *,
        raw_action: str,
        execution_action: str,
        raw_delta: float,
    ) -> tuple[float, str | None, bool]:
        if execution_action == "Hold" or math.isclose(raw_delta, 0.0, abs_tol=1e-9):
            return 0.0, None, False

        if raw_action == "Kill_Switch":
            return raw_delta, None, False

        if raw_action == "Accumulate" and raw_delta > 0:
            filtered_delta = min(raw_delta, MAX_DAILY_ACCUMULATE)
            if filtered_delta < raw_delta:
                return (
                    round_money(filtered_delta),
                    f"原始调仓缺口为 {format_money(raw_delta)} 元，受限于 Accumulate 单日定投上限，按 {format_money(filtered_delta)} 元执行。",
                    True,
                )
            return round_money(filtered_delta), None, False

        if execution_action == "Buy" and raw_delta > 0:
            filtered_delta = min(raw_delta, MAX_DAILY_BUY)
            if filtered_delta < raw_delta:
                return (
                    round_money(filtered_delta),
                    f"原始调仓缺口为 {format_money(raw_delta)} 元，受限于 Buy 单日上限，按 {format_money(filtered_delta)} 元执行。",
                    True,
                )
            return round_money(filtered_delta), None, False

        if execution_action == "Sell" and raw_delta < 0:
            filtered_delta = max(raw_delta, MAX_DAILY_SELL)
            if filtered_delta > raw_delta:
                return (
                    round_money(filtered_delta),
                    f"原始调仓缺口为 {format_money(abs(raw_delta))} 元，受限于 Sell 单日上限，按 {format_money(abs(filtered_delta))} 元执行。",
                    True,
                )
            return round_money(filtered_delta), None, False

        return round_money(raw_delta), None, False

    def _resolve_execution_action(self, raw_action: str, delta: float) -> tuple[str, str]:
        if math.isclose(delta, 0.0, abs_tol=1e-9):
            return "Hold", "当前仓位已接近目标权重，无需调仓。"

        if raw_action in {"Buy", "Accumulate"}:
            if delta > 0:
                reason = "上游信号为买入侧，且目标市值高于当前持仓，执行补仓。"
                if raw_action == "Accumulate":
                    reason = "上游信号为 ERP 左侧 Accumulate，按目标权重执行买入。"
                return "Buy", reason
            return "Hold", "上游信号偏多，但当前仓位已不低于目标，不追价加仓。"

        if raw_action == "Sell":
            if delta < 0:
                return "Sell", "上游信号为卖出侧，且当前持仓高于目标权重，执行减仓。"
            return "Hold", "上游信号要求卖出，但当前仓位已不高于目标，无需继续减仓。"

        if raw_action == "Hold":
            if delta > 0:
                return "Buy", "上游信号要求维持目标仓位，当前低配，执行回补至目标。"
            return "Sell", "上游信号要求维持目标仓位，当前超配，执行回落至目标。"

        return "Hold", f"未识别的上游动作 {raw_action}，执行层默认静默。"

    def _build_hold_decision(
        self,
        *,
        symbol: str,
        name: str,
        signal: dict[str, Any],
        current_position: float,
        target_value: float,
        raw_delta: float,
        final_delta: float,
        note: str,
        suppressed_by_friction: bool,
        effective_weight_target: float | None = None,
        current_shares: int = 0,
        sellable_shares: int | None = None,
        max_allowed_sell_shares: int | None = None,
        target_shares: int = 0,
        raw_share_delta: int = 0,
        last_price: float | None = None,
        ledger_position_cny: float | None = None,
        slippage_buffer: float | None = None,
    ) -> dict[str, Any]:
        return self._build_decision_record(
            symbol=symbol,
            name=name,
            signal=signal,
            execution_action="Hold",
            effective_weight_target=(
                safe_float(signal.get("Weight_Target")) or 0.0
                if effective_weight_target is None
                else effective_weight_target
            ),
            current_position=current_position,
            target_value=target_value,
            raw_delta=raw_delta,
            final_delta=final_delta,
            planned_trade_amount=0.0,
            decision_note=note,
            velocity_capped=False,
            suppressed_by_friction=suppressed_by_friction,
            current_shares=current_shares,
            sellable_shares=sellable_shares,
            max_allowed_sell_shares=max_allowed_sell_shares,
            target_shares=target_shares,
            raw_share_delta=raw_share_delta,
            final_share_delta=0,
            quantity=0,
            last_price=last_price,
            price_hint=None,
            exchange_order=None,
            ledger_position_cny=ledger_position_cny,
            slippage_buffer=slippage_buffer,
        )

    def _build_macro_snapshot(self) -> dict[str, Any]:
        ten_year = safe_float((self.macro_state.get("ten_year_cgb") or {}).get("yield_pct"))
        erp = safe_float(((self.macro_state.get("factors") or {}).get("hs300_erp") or {}).get("value_pct"))
        spread = safe_float(((self.macro_state.get("factors") or {}).get("csi_dividend_spread") or {}).get("value_pct"))

        if erp is None or ten_year is None:
            one_liner = "宏观锚点缺失，执行层无法完整判断 ERP 温度。"
        else:
            if erp >= 5.5:
                erp_phrase = "沪深300 ERP 处于高赔率区"
            elif erp <= 3.0:
                erp_phrase = "沪深300 ERP 偏低，右侧纪律优先"
            else:
                erp_phrase = "沪深300 ERP 中性"

            if spread is None:
                spread_phrase = "红利利差暂无可靠读数"
            elif spread >= 2.0:
                spread_phrase = "红利利差仍在安全区"
            elif spread <= 1.0:
                spread_phrase = "红利利差压缩，拥挤度偏高"
            else:
                spread_phrase = "红利利差进入中性区"

            one_liner = (
                f"10Y 国债 {round_or_none(ten_year, 2)}%，"
                f"沪深300 ERP {round_or_none(erp, 2)}%，{erp_phrase}；"
                f"中证红利利差 {round_or_none(spread, 2) if spread is not None else '--'}%，{spread_phrase}。"
            )

        return {
            "ten_year_cgb_yield_pct": round_or_none(ten_year, 4),
            "hs300_erp_pct": round_or_none(erp, 4),
            "csi_dividend_spread_pct": round_or_none(spread, 4),
            "one_liner": one_liner,
        }


def save_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def update_manifest(*, manifest_path: Path, output_json_path: Path, report_path: Path) -> None:
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["trade_planner_script"] = str(SCRIPT_DIR / "trade_generator.py")
    canonical["next_trade_generator_script"] = str(SCRIPT_DIR / "generate_next_trade_plan.mjs")
    canonical["latest_trade_plan_v4_json"] = str(output_json_path)
    canonical["latest_trade_plan_v4_report"] = str(report_path)
    canonical["latest_next_trade_generator"] = str(report_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    global MANIFEST_PATH
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    MANIFEST_PATH = portfolio_root / "state-manifest.json"
    manifest = read_json(MANIFEST_PATH) if MANIFEST_PATH.exists() else {}
    portfolio_state_payload, portfolio_state_path, portfolio_state_source_kind, _ = load_preferred_portfolio_state(
        portfolio_root=portfolio_root,
        manifest=manifest,
        explicit_portfolio_state=args.portfolio_state,
        explicit_latest_compat=args.latest,
    )
    account_context_path = (
        Path(args.account_context) if args.account_context else portfolio_root / "account_context.json"
    )
    watchlist_path = Path(args.watchlist) if args.watchlist else portfolio_root / "fund-watchlist.json"
    asset_master_path = Path(args.asset_master) if args.asset_master else portfolio_root / "config" / "asset_master.json"
    macro_state_path = Path(args.macro_state) if args.macro_state else portfolio_root / "data" / "macro_state.json"
    signals_path = Path(args.signals) if args.signals else portfolio_root / "signals" / "regime_router_signals.json"
    plan_date = str(args.date or portfolio_state_payload.get("snapshot_date") or current_cn_date())[:10]

    planner = TradePlanner(
        account_id=account_id,
        portfolio_root=portfolio_root,
        portfolio_state_path=portfolio_state_path,
        portfolio_state_source_kind=portfolio_state_source_kind,
        account_context_path=account_context_path,
        watchlist_path=watchlist_path,
        asset_master_path=asset_master_path,
        macro_state_path=macro_state_path,
        signals_path=signals_path,
        min_trade_amount=args.min_trade_amount,
        kill_switch_floor_weight=args.kill_switch_floor_weight,
    )
    payload = planner.plan(plan_date=plan_date)
    markdown = planner.render_markdown(payload)

    output_json_path = Path(args.output_json) if args.output_json else portfolio_root / "data" / "trade_plan_v4.json"
    report_path = (
        Path(args.report_path)
        if args.report_path
        else portfolio_root / "reports" / f"{plan_date}-next-trade-plan-regime-v4.md"
    )

    save_text(output_json_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    save_text(report_path, markdown)
    update_manifest(
        manifest_path=MANIFEST_PATH,
        output_json_path=output_json_path,
        report_path=report_path,
    )

    print(
        json.dumps(
            {
                "account_id": account_id,
                "portfolio_root": str(portfolio_root),
                "plan_date": plan_date,
                "output_json": str(output_json_path),
                "report_path": str(report_path),
                "actionable_trade_count": payload["summary"]["actionable_trade_count"],
                "suppressed_trade_count": payload["summary"]["suppressed_trade_count"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
