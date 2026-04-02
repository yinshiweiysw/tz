#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from copy import deepcopy
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import resolve_account_id, resolve_portfolio_root  # noqa: E402


MATERIALIZER_SCRIPT = SCRIPT_DIR / "materialize_portfolio_state.mjs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Interactively reconcile today's trade plan fills into execution_ledger.json."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--latest", default="")
    parser.add_argument("--trade-plan", default="")
    parser.add_argument("--ledger", default="")
    parser.add_argument("--backup-path", default="")
    parser.add_argument("--snapshot-date", default="")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview generated execution ledger entries without writing files.",
    )
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
    if numeric != numeric or numeric in {float("inf"), float("-inf")}:
        return None
    return numeric


def round_money(value: Any) -> float:
    return round(safe_float(value) or 0.0, 2)


def round_or_none(value: Any, digits: int = 4) -> float | None:
    numeric = safe_float(value)
    if numeric is None:
        return None
    return round(numeric, digits)


def format_money(value: Any) -> str:
    return f"{round_money(value):,.2f}"


def business_day_offset(date_text: str, offset: int) -> str:
    base = date.fromisoformat(date_text)
    cursor = base
    remaining = max(int(offset), 0)
    while remaining > 0:
        cursor += timedelta(days=1)
        if cursor.weekday() < 5:
            remaining -= 1
    return cursor.isoformat()


def infer_category_from_name(name: str) -> str:
    text = str(name or "")
    if "半导体" in text or "芯片" in text:
        return "A股主动"
    if "黄金" in text:
        return "黄金"
    if "沪深300" in text:
        return "A股宽基"
    if "红利" in text:
        return "A股红利低波"
    if "恒生科技" in text:
        return "港股科技/QDII"
    if "恒生互联网" in text or "港股通互联网" in text or "港股互联网" in text:
        return "港股互联网/QDII"
    if "纳斯达克" in text or "海外科技" in text:
        return "美股科技/QDII"
    if "标普500" in text:
        return "美股指数/QDII"
    if "大宗商品" in text:
        return "大宗商品/QDII"
    if "债" in text or "持有期混合" in text:
        return "偏债混合"
    if "货币" in text or "现金" in text or "银华日利" in text:
        return "现金管理"
    return "未分类"


def prompt_text(message: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default not in {None, ""} else ""
    while True:
        try:
            text = input(f"{message}{suffix}: ").strip()
        except EOFError:
            raise KeyboardInterrupt from None
        if text:
            return text
        if default is not None:
            return str(default)


def prompt_int(message: str, default: int) -> int:
    while True:
        raw = prompt_text(message, str(int(default)))
        try:
            value = int(raw)
        except ValueError:
            print("  输入无效，请填写整数股数。")
            continue
        if value < 0:
            print("  输入无效，股数不能为负。")
            continue
        return value


def prompt_float(message: str, default: float) -> float:
    while True:
        raw = prompt_text(message, f"{default:.4f}")
        numeric = safe_float(raw)
        if numeric is None or numeric < 0:
            print("  输入无效，请填写非负数字。")
            continue
        return float(numeric)


def prompt_yes_no(message: str, default: bool) -> bool:
    default_hint = "Y/n" if default else "y/N"
    while True:
        raw = prompt_text(f"{message} ({default_hint})", "").lower()
        if raw == "":
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print("  输入无效，请回答 y 或 n。")


class LedgerSync:
    def __init__(
        self,
        *,
        portfolio_root: Path,
        latest_path: Path,
        trade_plan_path: Path,
        ledger_path: Path,
        backup_path: Path,
        snapshot_date: str,
        dry_run: bool,
        account_id: str,
    ) -> None:
        self.portfolio_root = portfolio_root
        self.latest_path = latest_path
        self.trade_plan_path = trade_plan_path
        self.ledger_path = ledger_path
        self.backup_path = backup_path
        self.snapshot_date = snapshot_date
        self.dry_run = dry_run
        self.account_id = account_id

        self.latest = read_json(latest_path)
        self.trade_plan = read_json(trade_plan_path)
        self.execution_ledger = read_json(ledger_path)

        self.summary = deepcopy(self.latest.get("summary") or {})
        self.positions = deepcopy(self.latest.get("positions") or [])
        self.cash_ledger = deepcopy(self.latest.get("cash_ledger") or {})

        self.starting_available_cash_cny = self._resolve_starting_available_cash()
        self.current_available_cash_cny = self.starting_available_cash_cny
        self.starting_pending_sell_to_arrive_cny = round_money(
            self.cash_ledger.get("pending_sell_to_arrive_cny") or self.summary.get("pending_sell_to_arrive")
        )
        self.pending_sell_to_arrive_cny = self.starting_pending_sell_to_arrive_cny

        self.execution_results: list[dict[str, Any]] = []
        self.generated_entries: list[dict[str, Any]] = []
        self.generated_index = 0

    def run(self) -> None:
        trades = self._collect_reconcilable_trades()
        if not trades:
            print("未发现需要对账的可执行交易，退出。")
            return

        print(f"账户：{self.account_id}")
        print(f"计划文件：{self.trade_plan_path}")
        print(f"兼容状态：{self.latest_path}")
        print(f"执行账本：{self.ledger_path}")
        print(f"起始可用现金：{format_money(self.current_available_cash_cny)} 元")
        print("")

        for index, trade in enumerate(trades, start=1):
            print(f"===== {index}/{len(trades)} =====")
            execution_type = str(trade.get("execution_type") or "OTC").upper()
            if execution_type == "EXCHANGE":
                result = self._reconcile_exchange_trade(trade)
            else:
                result = self._reconcile_otc_trade(trade)
            self.execution_results.append(result)
            print(f"  当前可用现金：{format_money(self.current_available_cash_cny)} 元")
            print("")

        self._print_summary()

        if self.dry_run:
            print("Dry run 模式：未写 execution_ledger.json，也未重算 latest.json。")
            print(json.dumps({"generated_entries": self.generated_entries}, ensure_ascii=False, indent=2))
            return

        if not self.generated_entries:
            print("没有有效成交需要写入 execution_ledger.json。")
            return

        if not prompt_yes_no("确认写入 execution_ledger.json 并重算兼容 latest.json", True):
            print("用户取消写回，未改动任何文件。")
            return

        self._backup_and_write()
        self._run_materializer()
        print(
            f"对账完成：已写回 {self.ledger_path}，备份文件为 {self.backup_path}，并已重算 latest.json。"
        )

    def _resolve_starting_available_cash(self) -> float:
        candidates = [
            self.cash_ledger.get("available_cash_cny"),
            self.summary.get("available_cash_cny"),
            (self.trade_plan.get("portfolio_context") or {}).get("cash_estimate_cny"),
            (self.trade_plan.get("cash_guardrail") or {}).get("starting_cash_estimate_cny"),
        ]
        for candidate in candidates:
            numeric = safe_float(candidate)
            if numeric is not None and numeric >= 0:
                return round_money(numeric)
        return 0.0

    def _collect_reconcilable_trades(self) -> list[dict[str, Any]]:
        trades = []
        for trade in self.trade_plan.get("trades", []):
            action = str(trade.get("execution_action") or "").strip()
            if action not in {"Buy", "Sell"}:
                continue
            trades.append(trade)
        return sorted(trades, key=lambda item: int(item.get("execution_sequence") or 999))

    def _next_entry_id(self, type_name: str, symbol: str) -> str:
        self.generated_index += 1
        compact_symbol = symbol or "unknown"
        return f"ledger-sync::{self.snapshot_date}::{type_name}::{compact_symbol}::{self.generated_index}"

    def _append_entry(self, *, type_name: str, symbol: str, normalized: dict[str, Any], original: dict[str, Any]) -> None:
        entry = {
            "id": self._next_entry_id(type_name, symbol),
            "account_id": self.account_id,
            "type": type_name,
            "status": "recorded",
            "recorded_at": format_now(),
            "effective_trade_date": self.snapshot_date,
            "profit_effective_on": normalized.get("profit_effective_on"),
            "source": "ledger_sync_manual_reconciliation",
            "source_file": str(self.trade_plan_path),
            "normalized": normalized,
            "original": original,
        }
        self.generated_entries.append(entry)

    def _reconcile_exchange_trade(self, trade: dict[str, Any]) -> dict[str, Any]:
        ticker = str(trade.get("ticker") or trade.get("symbol") or "").strip()
        name = trade.get("name") or ticker
        action = str(trade.get("execution_action") or "Buy")
        planned_quantity = max(int(safe_float(trade.get("quantity")) or 0), 0)
        default_price = safe_float(trade.get("price_hint")) or safe_float(trade.get("last_price")) or 0.0

        print(
            f"> 计划 [{'买入' if action == 'Buy' else '卖出'}] {ticker} ({name}) "
            f"{planned_quantity} 股, Limit {round_or_none(default_price, 4) or 0:.4f}"
        )
        actual_quantity = prompt_int(
            f"> 请输入实际成交股数 (直接回车表示全部成交 {planned_quantity}, 输入 0 表示未成交)",
            planned_quantity,
        )
        if actual_quantity == 0:
            print("  记录为未成交。")
            return {
                "symbol": ticker,
                "name": name,
                "execution_type": "EXCHANGE",
                "execution_action": action,
                "planned_quantity": planned_quantity,
                "actual_quantity": 0,
                "actual_avg_price": None,
                "actual_notional_cny": 0.0,
                "status": "failed_order",
            }

        actual_price = prompt_float(
            f"> 请输入实际成交均价 (直接回车表示按 Limit {round_or_none(default_price, 4) or 0:.4f} 成交)",
            default_price,
        )
        actual_notional = round_money(actual_quantity * actual_price)
        settlement_rule = str(trade.get("settlement_rule") or "T+1").upper()

        if action == "Buy":
            self.current_available_cash_cny = round_money(self.current_available_cash_cny - actual_notional)
        else:
            self.current_available_cash_cny = round_money(self.current_available_cash_cny + actual_notional)

        self._append_entry(
            type_name=action.lower(),
            symbol=ticker,
            normalized={
                "fund_name": name,
                "symbol": ticker,
                "code": ticker,
                "ticker": ticker,
                "quantity": actual_quantity,
                "actual_avg_price": round_or_none(actual_price, 4),
                "actual_notional_cny": actual_notional,
                "execution_type": "EXCHANGE",
                "settlement_rule": settlement_rule,
                "category": infer_category_from_name(name),
                "cash_effect_cny": -actual_notional if action == "Buy" else actual_notional,
            },
            original={
                "trade_plan": trade,
                "prompt_confirmed_quantity": actual_quantity,
                "prompt_confirmed_avg_price": actual_price,
            },
        )

        print(
            f"  已登记证券成交：{ticker} {actual_quantity} 股 @ {actual_price:.4f}，"
            f"成交额 {format_money(actual_notional)} 元。"
        )
        return {
            "symbol": ticker,
            "name": name,
            "execution_type": "EXCHANGE",
            "execution_action": action,
            "planned_quantity": planned_quantity,
            "actual_quantity": actual_quantity,
            "actual_avg_price": round_or_none(actual_price, 4),
            "actual_notional_cny": actual_notional,
            "settlement_rule": settlement_rule,
            "status": "filled" if actual_quantity == planned_quantity else "partial_fill",
        }

    def _reconcile_otc_trade(self, trade: dict[str, Any]) -> dict[str, Any]:
        symbol = str(trade.get("symbol") or "").strip()
        name = trade.get("name") or symbol
        action = str(trade.get("execution_action") or "Buy")
        planned_amount = round_money(trade.get("planned_trade_amount_cny"))

        print(
            f"> 计划 [{'买入' if action == 'Buy' else '卖出'}] {symbol} ({name}) "
            f"{format_money(planned_amount)} 元"
        )
        actual_amount = prompt_float(
            f"> 请输入实际确认金额 (直接回车表示按计划 {format_money(planned_amount)} 元, 输入 0 表示未成交)",
            planned_amount,
        )
        actual_amount = round_money(actual_amount)
        if actual_amount <= 0:
            print("  记录为未成交。")
            return {
                "symbol": symbol,
                "name": name,
                "execution_type": "OTC",
                "execution_action": action,
                "planned_amount_cny": planned_amount,
                "actual_amount_cny": 0.0,
                "status": "failed_order",
            }

        if action == "Buy":
            self.current_available_cash_cny = round_money(self.current_available_cash_cny - actual_amount)
            credited_to_position = prompt_yes_no(
                "> 该笔 OTC 买入是否已确认并计入持仓", False
            )
            if credited_to_position:
                profit_effective_on = self.snapshot_date
                status = "filled"
            else:
                submitted_before_cutoff = prompt_yes_no(
                    "> 该笔买入是否在 15:00 前提交", True
                )
                offset = 1 if submitted_before_cutoff else 2
                profit_effective_on = business_day_offset(self.snapshot_date, offset)
                status = "queued_pending"

            self._append_entry(
                type_name="buy",
                symbol=symbol or name,
                normalized={
                    "fund_name": name,
                    "symbol": symbol or None,
                    "code": symbol or None,
                    "fund_code": symbol or None,
                    "amount_cny": actual_amount,
                    "category": infer_category_from_name(name),
                    "execution_type": "OTC",
                    "submitted_before_cutoff": False if credited_to_position else bool(submitted_before_cutoff),
                    "cutoff_time_local": "15:00",
                    "profit_effective_on": profit_effective_on,
                    "cash_effect_cny": -actual_amount,
                },
                original={
                    "trade_plan": trade,
                    "credited_to_position": credited_to_position,
                },
            )
        else:
            cash_arrived = prompt_yes_no(
                "> 该笔 OTC 卖出资金是否已经到账并可用", False
            )
            if cash_arrived:
                self.current_available_cash_cny = round_money(self.current_available_cash_cny + actual_amount)
                status = "filled"
            else:
                self.pending_sell_to_arrive_cny = round_money(
                    self.pending_sell_to_arrive_cny + actual_amount
                )
                status = "sell_pending_arrival"

            self._append_entry(
                type_name="sell",
                symbol=symbol or name,
                normalized={
                    "fund_name": name,
                    "symbol": symbol or None,
                    "code": symbol or None,
                    "fund_code": symbol or None,
                    "amount_cny": actual_amount,
                    "category": infer_category_from_name(name),
                    "execution_type": "OTC",
                    "cash_effect_cny": actual_amount if cash_arrived else 0,
                    "pending_sell_to_arrive_cny": actual_amount if not cash_arrived else 0,
                },
                original={
                    "trade_plan": trade,
                    "cash_arrived": cash_arrived,
                },
            )

        print(
            f"  已登记基金成交：{name} {format_money(actual_amount)} 元，状态 {status}。"
        )
        return {
            "symbol": symbol,
            "name": name,
            "execution_type": "OTC",
            "execution_action": action,
            "planned_amount_cny": planned_amount,
            "actual_amount_cny": actual_amount,
            "status": status,
        }

    def _backup_and_write(self) -> None:
        self.backup_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.ledger_path, self.backup_path)
        existing_ids = {
            str(item.get("id"))
            for item in self.execution_ledger.get("entries", [])
            if str(item.get("id") or "").strip()
        }
        self.execution_ledger.setdefault("entries", [])
        for entry in self.generated_entries:
            if entry["id"] not in existing_ids:
                self.execution_ledger["entries"].append(entry)

        self.execution_ledger["updated_at"] = format_now()
        notes = self.execution_ledger.setdefault("notes", [])
        notes.append(
            f"{format_now()} 已通过 ledger_sync.py 录入 {len(self.generated_entries)} 笔执行事件，来源 {self.trade_plan_path.name}。"
        )
        write_json(self.ledger_path, self.execution_ledger)

    def _run_materializer(self) -> None:
        command = [
            "node",
            str(MATERIALIZER_SCRIPT),
            "--portfolio-root",
            str(self.portfolio_root),
            "--date",
            self.snapshot_date,
        ]
        subprocess.run(command, check=True)

    def _print_summary(self) -> None:
        exchange_count = sum(1 for item in self.execution_results if item.get("execution_type") == "EXCHANGE")
        otc_count = sum(1 for item in self.execution_results if item.get("execution_type") == "OTC")
        partial_count = sum(1 for item in self.execution_results if item.get("status") == "partial_fill")
        failed_count = sum(1 for item in self.execution_results if item.get("status") == "failed_order")

        print("===== 对账摘要 =====")
        print(f"证券订单确认数：{exchange_count}")
        print(f"基金订单确认数：{otc_count}")
        print(f"部分成交数：{partial_count}")
        print(f"废单数：{failed_count}")
        print(f"起始可用现金：{format_money(self.starting_available_cash_cny)} 元")
        print(f"结束可用现金：{format_money(self.current_available_cash_cny)} 元")
        print(f"待到账赎回：{format_money(self.pending_sell_to_arrive_cny)} 元")
        print(f"新增执行事件：{len(self.generated_entries)}")


def ensure_dual_ledger_seed(portfolio_root: Path, snapshot_date: str) -> None:
    subprocess.run(
        [
            "node",
            str(MATERIALIZER_SCRIPT),
            "--portfolio-root",
            str(portfolio_root),
            "--date",
            snapshot_date,
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def main() -> None:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user, portfolio_root=args.portfolio_root)
    account_id = resolve_account_id(user=args.user, portfolio_root=args.portfolio_root)
    snapshot_date = args.snapshot_date or current_cn_date()

    ensure_dual_ledger_seed(portfolio_root, snapshot_date)

    latest_path = Path(args.latest).expanduser().resolve() if args.latest else (portfolio_root / "latest.json")
    trade_plan_path = (
        Path(args.trade_plan).expanduser().resolve()
        if args.trade_plan
        else (portfolio_root / "data" / "trade_plan_v4.json")
    )
    ledger_path = (
        Path(args.ledger).expanduser().resolve()
        if args.ledger
        else (portfolio_root / "ledger" / "execution_ledger.json")
    )
    backup_path = (
        Path(args.backup_path).expanduser().resolve()
        if args.backup_path
        else ledger_path.with_name(f"{ledger_path.name}.bak")
    )

    if not latest_path.exists():
        raise FileNotFoundError(f"latest.json not found: {latest_path}")
    if not trade_plan_path.exists():
        raise FileNotFoundError(f"trade_plan_v4.json not found: {trade_plan_path}")
    if not ledger_path.exists():
        raise FileNotFoundError(f"execution_ledger.json not found: {ledger_path}")

    runner = LedgerSync(
        portfolio_root=portfolio_root,
        latest_path=latest_path,
        trade_plan_path=trade_plan_path,
        ledger_path=ledger_path,
        backup_path=backup_path,
        snapshot_date=snapshot_date,
        dry_run=bool(args.dry_run),
        account_id=account_id,
    )
    try:
        runner.run()
    except KeyboardInterrupt:
        print("\n已取消对账，未写回文件。")


if __name__ == "__main__":
    main()
