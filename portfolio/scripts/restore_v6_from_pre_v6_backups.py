#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import resolve_portfolio_root  # noqa: E402


MANUAL_CODE_ALIASES = {
    "博时标普500ETF联接(QDII)C": "006075",
    "景顺长城宁景6个月持有期混合A": "011803",
    "景顺长城纳斯达克科技市值加权ETF联接(QDII)E": "019118",
    "国泰大宗商品配置(QDII-LOF-FOF)D": "025162",
    "华宝海外科技股票(QDII-FOF-LOF)C": "017204",
    "摩根纳斯达克100指数(QDII)A": "019172",
    "嘉实纳斯达克100ETF联接(QDII)A": "016532",
    "摩根标普500指数(QDII)A": "017641",
    "国泰黄金ETF联接E": "022502",
    "兴全恒信债券C": "016482",
    "永赢先锋半导体智选混合C": "025209",
    "招商量化精选股票A": "001917",
    "华夏恒生互联网科技业ETF联接(QDII)C": "013172",
    "华夏中证红利低波动ETF发起式联接A": "021482",
    "易方达沪深300ETF联接C": "007339",
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Restore latest/account_context from pre-v6 cold-start backups."
    )
    parser.add_argument("--user", default="")
    parser.add_argument("--portfolio-root", default="")
    return parser.parse_args()


def round_money(value: Any) -> float:
    try:
        return round(float(value or 0.0), 2)
    except Exception:
        return 0.0


def normalize_name(name: str) -> str:
    text = str(name or "").strip().lower()
    replacements = {
        "（": "(",
        "）": ")",
        "人民币": "",
        "美元现汇": "",
        "美元汇": "",
        "美钞": "",
        "qdii": "",
        "fof": "",
        "lof": "",
        "联接": "联接",
        "etf": "etf",
        "持有期": "持有",
        "发起式": "",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"[\s\-_()/]", "", text)
    return text


def build_watchlist_lookup(watchlist: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for item in watchlist.get("watchlist", []):
        code = str(item.get("code") or "").strip()
        name = str(item.get("name") or "").strip()
        if not code or not name:
            continue
        lookup[name] = code
        lookup[normalize_name(name)] = code
    for name, code in MANUAL_CODE_ALIASES.items():
        lookup.setdefault(name, code)
        lookup.setdefault(normalize_name(name), code)
    return lookup


def build_asset_metadata(asset_master: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_symbol: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for asset in asset_master.get("assets", []):
        symbol = str(asset.get("symbol") or "").strip()
        name = str(asset.get("name") or "").strip()
        metadata = {
            "symbol": symbol or None,
            "bucket": asset.get("bucket"),
            "market": asset.get("market"),
            "execution_type": str(asset.get("execution_type") or "OTC").upper(),
            "ticker": str(asset.get("ticker") or "").strip() or None,
            "settlement_rule": asset.get("settlement_rule"),
            "lot_size": asset.get("lot_size"),
            "slippage_buffer": asset.get("slippage_buffer"),
            "category": asset.get("category"),
        }
        if symbol:
            by_symbol[symbol] = metadata
        if name:
            by_name[name] = metadata
            by_name[normalize_name(name)] = metadata
    return by_symbol, by_name


def resolve_code(name: str, watchlist_lookup: dict[str, str], asset_by_name: dict[str, dict[str, Any]]) -> str | None:
    if name in watchlist_lookup:
        return watchlist_lookup[name]
    normalized = normalize_name(name)
    if normalized in watchlist_lookup:
        return watchlist_lookup[normalized]
    asset_meta = asset_by_name.get(name) or asset_by_name.get(normalized)
    if asset_meta and asset_meta.get("symbol"):
        return str(asset_meta["symbol"])
    return None


def enrich_otc_position(
    position: dict[str, Any],
    *,
    watchlist_lookup: dict[str, str],
    asset_by_name: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    enriched = copy.deepcopy(position)
    enriched["execution_type"] = "OTC"

    code = (
        str(enriched.get("code") or enriched.get("symbol") or enriched.get("fund_code") or "").strip()
        or resolve_code(str(enriched.get("name") or ""), watchlist_lookup, asset_by_name)
    )
    if code:
        enriched["symbol"] = code
        enriched["code"] = code
        enriched["fund_code"] = code

    asset_meta = asset_by_name.get(str(enriched.get("name") or "")) or asset_by_name.get(
        normalize_name(str(enriched.get("name") or ""))
    )
    if asset_meta:
        if asset_meta.get("bucket"):
            enriched["bucket"] = asset_meta["bucket"]
        if asset_meta.get("market"):
            enriched["market"] = asset_meta["market"]
        if asset_meta.get("category") and not enriched.get("category"):
            enriched["category"] = asset_meta["category"]

    return enriched


def build_exchange_shells(
    current_latest: dict[str, Any],
    backup_positions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    existing_keys = {
        str(item.get("ticker") or item.get("symbol") or item.get("code") or "").strip()
        for item in backup_positions
    }
    shells: list[dict[str, Any]] = []
    for position in current_latest.get("positions", []):
        if str(position.get("execution_type") or "OTC").upper() != "EXCHANGE":
            continue
        key = str(position.get("ticker") or position.get("symbol") or position.get("code") or "").strip()
        if key and key in existing_keys:
            continue
        shell = copy.deepcopy(position)
        shell["amount"] = 0.0
        shell["shares"] = 0
        shell["sellable_shares"] = 0
        shell["cost_price"] = 0.0
        shell["daily_pnl"] = 0.0
        shell["holding_pnl"] = 0.0
        shell["holding_pnl_rate_pct"] = 0.0
        shell["status"] = "active"
        shells.append(shell)
    return shells


def main() -> int:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(user=args.user or None, portfolio_root=args.portfolio_root or None)
    latest_path = portfolio_root / "latest.json"
    account_context_path = portfolio_root / "account_context.json"
    latest_backup_path = portfolio_root / "latest.pre-v6-cold-start.backup.json"
    account_context_backup_path = portfolio_root / "account_context.pre-v6-cold-start.backup.json"
    asset_master_path = portfolio_root / "config" / "asset_master.json"
    watchlist_path = portfolio_root / "fund-watchlist.json"
    latest_pre_restore_backup_path = portfolio_root / "latest.pre-v6-restore-merge.backup.json"
    account_context_pre_restore_backup_path = (
        portfolio_root / "account_context.pre-v6-restore-merge.backup.json"
    )

    current_latest = read_json(latest_path)
    current_account_context = read_json(account_context_path)
    backup_latest = read_json(latest_backup_path)
    backup_account_context = read_json(account_context_backup_path)
    asset_master = read_json(asset_master_path)
    watchlist = read_json(watchlist_path)

    write_json(latest_pre_restore_backup_path, current_latest)
    write_json(account_context_pre_restore_backup_path, current_account_context)

    watchlist_lookup = build_watchlist_lookup(watchlist)
    _, asset_by_name = build_asset_metadata(asset_master)

    merged_latest = copy.deepcopy(backup_latest)
    backup_positions = list(backup_latest.get("positions", []))
    merged_positions = [
        enrich_otc_position(position, watchlist_lookup=watchlist_lookup, asset_by_name=asset_by_name)
        for position in backup_positions
    ]
    exchange_shells = build_exchange_shells(current_latest, merged_positions)
    merged_positions.extend(exchange_shells)
    merged_latest["positions"] = merged_positions

    active_otc_positions = [
        item
        for item in merged_positions
        if str(item.get("execution_type") or "OTC").upper() == "OTC"
        and str(item.get("status") or "").strip() == "active"
        and round_money(item.get("amount")) > 0
    ]
    restored_otc_amount = round_money(sum(round_money(item.get("amount")) for item in active_otc_positions))

    total_assets_min = round_money(
        (backup_account_context.get("reported_total_assets_range_cny") or {}).get("min")
    )
    total_assets_max = round_money(
        (backup_account_context.get("reported_total_assets_range_cny") or {}).get("max")
    )
    pre_v6_reported_cash_estimate = round_money(backup_account_context.get("reported_cash_estimate_cny"))
    derived_available_cash_cny = round_money(max(total_assets_min - restored_otc_amount, 0.0))

    merged_latest.setdefault("summary", {})
    merged_latest["summary"]["available_cash_cny"] = derived_available_cash_cny
    merged_latest["summary"]["total_fund_assets"] = restored_otc_amount
    merged_latest["summary"]["effective_exposure_after_pending_sell"] = round_money(
        backup_latest.get("summary", {}).get("effective_exposure_after_pending_sell") or restored_otc_amount
    )
    merged_latest["cash_ledger"] = {
        "available_cash_cny": derived_available_cash_cny,
        "frozen_cash_cny": 0.0,
        "pending_buy_confirm_cny": round_money(backup_latest.get("summary", {}).get("pending_buy_confirm")),
        "pending_sell_to_arrive_cny": round_money(
            backup_latest.get("summary", {}).get("pending_sell_to_arrive")
        ),
        "pre_v6_reported_cash_estimate_cny": pre_v6_reported_cash_estimate,
    }
    merged_latest["exposure_summary"] = {
        **(backup_latest.get("exposure_summary") or {}),
        "otc_amount": restored_otc_amount,
        "exchange_amount": 0.0,
    }
    merged_latest["recognition_notes"] = list(backup_latest.get("recognition_notes") or []) + [
        "V6.0 紧急修复：已从 pre-v6 备份恢复真实 OTC 持仓，并保留 513100 的场内空仓壳位。",
        "available_cash_cny 采用 reported_total_assets_range_cny.min 减去已恢复 active OTC 持仓金额推导，以与当前 restored latest.json 保持一致。",
    ]
    merged_latest["related_files"] = {
        **(backup_latest.get("related_files") or {}),
        "pre_v6_backup": str(latest_backup_path),
        "pre_restore_template_backup": str(latest_pre_restore_backup_path),
    }

    merged_account_context = {
        **backup_account_context,
        "as_of": merged_latest.get("snapshot_date") or backup_account_context.get("as_of"),
        "status": "restored_from_pre_v6_backup_for_v6_dual_track",
        "reported_cash_estimate_cny": derived_available_cash_cny,
        "reported_total_assets_range_cny": {
            "min": total_assets_min,
            "max": total_assets_max,
        },
        "available_cash_cny": derived_available_cash_cny,
        "pre_v6_reported_cash_estimate_cny": pre_v6_reported_cash_estimate,
        "broker_accounts": [
            {
                "account_id": "broker_exchange",
                "channel": "broker_exchange",
                "base_currency": "CNY",
                "cash_cny": 0.0,
                "market_value_cny": 0.0,
                "notes": "当前尚无场内持仓，保留双轨空壳位。",
            },
            {
                "account_id": "fund_otc",
                "channel": "fund_otc",
                "base_currency": "CNY",
                "cash_cny": derived_available_cash_cny,
                "market_value_cny": restored_otc_amount,
                "notes": "由恢复后的 OTC 持仓与 total_assets_range.min 推导。",
            },
        ],
        "notes": list(backup_account_context.get("notes") or [])
        + [
            "V6.0 数据修复已执行：reported_cash_estimate_cny 已按 restored OTC 持仓重新校准。",
            f"pre-v6 冷启动前缓存的现金估计为 {pre_v6_reported_cash_estimate:.2f} 元，仅保留作审计参考。",
        ],
        "related_files": {
            "latest_snapshot": str(latest_path),
            "pre_v6_backup": str(account_context_backup_path),
            "pre_restore_template_backup": str(account_context_pre_restore_backup_path),
        },
    }

    write_json(latest_path, merged_latest)
    write_json(account_context_path, merged_account_context)

    active_otc_with_code = [
        item
        for item in active_otc_positions
        if str(item.get("symbol") or item.get("code") or item.get("fund_code") or "").strip()
    ]
    active_otc_missing_code = [
        item.get("name")
        for item in active_otc_positions
        if not str(item.get("symbol") or item.get("code") or item.get("fund_code") or "").strip()
    ]

    print(
        json.dumps(
            {
                "portfolio_root": str(portfolio_root),
                "latest_path": str(latest_path),
                "account_context_path": str(account_context_path),
                "restored_active_otc_position_count": len(active_otc_positions),
                "restored_active_otc_amount_cny": restored_otc_amount,
                "restored_available_cash_cny": derived_available_cash_cny,
                "restored_total_assets_range_cny": {
                    "min": total_assets_min,
                    "max": total_assets_max,
                },
                "exchange_shell_count": len(exchange_shells),
                "active_otc_with_code_count": len(active_otc_with_code),
                "active_otc_missing_code": active_otc_missing_code,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
