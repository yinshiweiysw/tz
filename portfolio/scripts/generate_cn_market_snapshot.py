#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = DEFAULT_PORTFOLIO_ROOT
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")

STYLE_PATTERNS = {
    "资源周期": [
        "有色",
        "煤炭",
        "石油",
        "油气",
        "化工",
        "钢铁",
        "黄金",
        "贵金属",
        "稀土",
        "能源金属",
        "工业金属",
        "小金属",
        "锂",
        "铜",
        "磷",
        "矿",
    ],
    "制造升级": [
        "电池",
        "储能",
        "风电",
        "光伏",
        "机械",
        "机器人",
        "自动化",
        "汽车",
        "军工",
        "装备",
        "设备",
    ],
    "科技成长": [
        "计算机",
        "通信",
        "电子",
        "半导体",
        "软件",
        "算力",
        "芯片",
        "服务器",
        "数据",
        "人工智能",
        "AI",
        "CPO",
        "消费电子",
        "传媒",
    ],
    "金融红利防守": [
        "银行",
        "保险",
        "证券",
        "红利",
        "高股息",
        "公用事业",
        "电力",
        "运营商",
        "铁路",
        "高速",
        "港口",
        "航运",
        "交运",
    ],
    "内需消费医药": [
        "医药",
        "医疗",
        "制药",
        "中药",
        "食品",
        "饮料",
        "零售",
        "消费",
        "旅游",
        "酒店",
        "家电",
        "美容",
    ],
    "地产基建": [
        "地产",
        "房地产",
        "建筑",
        "建材",
        "基建",
        "工程",
        "水泥",
    ],
}


def ensure_runtime() -> None:
    if os.environ.get("AKSHARE_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent

    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import akshare  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["AKSHARE_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)

def resolve_date(date_arg: str | None) -> str:
    if date_arg:
        return date_arg
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def safe_float(value):
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.replace(",", "").replace("%", "").strip()
        if normalized in {"", "--", "-", "None", "nan"}:
            return None
        value = normalized
    try:
        numeric = float(value)
        if not math.isfinite(numeric):
            return None
        return numeric
    except Exception:
        return None


def round_or_none(value, digits: int = 2):
    if value is None:
        return None
    numeric = float(value)
    if not math.isfinite(numeric):
        return None
    return round(numeric, digits)


def amount_to_100m(value):
    if value is None:
        return None
    return round_or_none(float(value) / 100000000)


def normalize_connect_intraday_100m(value):
    numeric = safe_float(value)
    if numeric is None:
        return None

    # AkShare intraday connect endpoints may return already-normalized "亿元"
    # or raw "万元"-style magnitudes. Large values are scaled down to 100m units.
    if abs(numeric) >= 10000:
        numeric = numeric / 10000
    return round_or_none(numeric)


def frame_has_rows(frame) -> bool:
    if frame is None:
        return False

    empty = getattr(frame, "empty", None)
    if empty is not None:
        return not bool(empty)

    try:
        return len(frame) > 0
    except Exception:
        return True


def iter_frame_rows(frame):
    if frame is None:
        return

    if hasattr(frame, "iterrows"):
        for _, row in frame.iterrows():
            yield row
        return

    if isinstance(frame, list):
        for row in frame:
            yield row


def filter_rows_equals(frame, column: str, expected: str):
    return [
        row
        for row in iter_frame_rows(frame)
        if str(getattr(row, "get", lambda *_: None)(column, "")) == expected
    ]


def column_values(frame, column: str):
    values = frame[column]
    if hasattr(values, "tolist"):
        return values.tolist()
    return list(values)


def guardrails():
    return [
        "仅用于中国市场补充核验，不替代 market-mcp 主链。",
        "不得作为 latest.json、risk_dashboard.json 或基金估值主底座的唯一来源。",
        "优先用于 A 股广度、板块资金流、宏观周期和 sector rotation 验证。",
    ]


def direction_label(values, lookback: int = 5) -> str:
    series = [value for value in values if value is not None]
    if len(series) < 2:
        return "数据不足"

    recent = series[-lookback:]
    if len(recent) < 2:
        return "数据不足"

    delta = recent[-1] - recent[0]
    if delta > 0:
        return "改善"
    if delta < 0:
        return "走弱"
    return "持平"


def classify_style(name: str) -> str:
    text = str(name or "")
    for label, keywords in STYLE_PATTERNS.items():
        if any(keyword in text for keyword in keywords):
            return label
    return "其他"


def format_name_list(items, limit: int = 3) -> str:
    values = [str(item) for item in items if item]
    return "、".join(values[:limit]) if values else "暂无"


def build_stub_snapshot(trade_date: str, message: str) -> dict:
    return {
        "version": 2,
        "trade_date": trade_date,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "dependency_missing",
        "source": "AkShare",
        "runtime": {
            "python": sys.executable,
            "auto_venv_path": str(VENV_PYTHON),
        },
        "layer_role": "china_market_supplement_only",
        "guardrails": guardrails(),
        "notes": [
            "AkShare 运行环境不可用，因此当前仅保留补充层骨架。",
            "若本地存在 /.venv-akshare，脚本会自动尝试切换过去运行。",
        ],
        "errors": [
            {
                "stage": "import",
                "message": message,
            }
        ],
        "sections": {},
    }


def fetch_market_breadth(ak) -> dict:
    import pandas as pd

    df = ak.stock_zh_a_spot_em()
    if df is None or df.empty:
        return {"status": "unavailable", "message": "未获取到 A 股全市场快照"}

    working = df.copy()
    working["涨跌幅_num"] = pd.to_numeric(working["涨跌幅"], errors="coerce")
    working["成交额_num"] = pd.to_numeric(working["成交额"], errors="coerce")
    valid = working.dropna(subset=["涨跌幅_num"])
    if valid.empty:
        return {"status": "unavailable", "message": "A 股快照缺少涨跌幅字段"}

    top_turnover = (
        working.sort_values("成交额_num", ascending=False)
        .head(5)[["代码", "名称", "涨跌幅_num", "成交额_num"]]
        .to_dict(orient="records")
    )

    return {
        "status": "ok",
        "total_count": int(len(valid)),
        "up_count": int((valid["涨跌幅_num"] > 0).sum()),
        "down_count": int((valid["涨跌幅_num"] < 0).sum()),
        "flat_count": int((valid["涨跌幅_num"] == 0).sum()),
        "up_ratio_pct": round_or_none((valid["涨跌幅_num"] > 0).mean() * 100),
        "average_change_pct": round_or_none(valid["涨跌幅_num"].mean()),
        "median_change_pct": round_or_none(valid["涨跌幅_num"].median()),
        "strong_up_count": int((valid["涨跌幅_num"] >= 2).sum()),
        "strong_down_count": int((valid["涨跌幅_num"] <= -2).sum()),
        "top_turnover": [
            {
                "code": str(item.get("代码", "")),
                "name": str(item.get("名称", "")),
                "change_pct": round_or_none(item.get("涨跌幅_num")),
                "turnover_cny": round_or_none(item.get("成交额_num"), 0),
            }
            for item in top_turnover
        ],
    }


def fetch_northbound_flow(ak) -> dict:
    result = {
        "status": "partial",
        "channels": [],
    }

    summary = None
    intraday = None

    try:
        summary = ak.stock_hsgt_fund_flow_summary_em()
    except Exception as exc:
        result["summary_error"] = str(exc)

    if frame_has_rows(summary):
        north_rows = filter_rows_equals(summary, "资金方向", "北向")
        if north_rows:
            channels = []
            net_buy_values = []
            latest_date = None
            for row in north_rows:
                latest_date = str(row.get("交易日", latest_date))
                net_buy = safe_float(row.get("成交净买额"))
                net_buy_values.append(net_buy)
                channels.append(
                    {
                        "channel": str(row.get("板块", "")),
                        "related_index": str(row.get("相关指数", "")),
                        "index_change_pct": round_or_none(safe_float(row.get("指数涨跌幅"))),
                        "up_count": int(safe_float(row.get("上涨数")) or 0),
                        "flat_count": int(safe_float(row.get("持平数")) or 0),
                        "down_count": int(safe_float(row.get("下跌数")) or 0),
                        "net_buy_100m_cny": round_or_none(net_buy),
                        "trading_status": str(row.get("交易状态", "")),
                    }
                )

            result["channels"] = channels
            result["latest_date"] = latest_date
            valid_summary = [value for value in net_buy_values if value is not None]
            if valid_summary:
                result["latest_summary_net_buy_100m_cny"] = round_or_none(sum(valid_summary))

    try:
        intraday = ak.stock_hsgt_fund_min_em(symbol="北向资金")
    except Exception as exc:
        result["intraday_error"] = str(exc)

    if frame_has_rows(intraday):
        recent = intraday.tail(20)
        last_row = recent.iloc[-1]
        series = [safe_float(item) for item in column_values(recent, "北向资金")]
        result["latest_intraday_time"] = str(last_row.get("时间", ""))
        result["latest_intraday_net_inflow_100m_cny"] = normalize_connect_intraday_100m(
            last_row.get("北向资金")
        )
        result["intraday_trend_label"] = direction_label(series, lookback=10)

    summary_value = result.get("latest_summary_net_buy_100m_cny")
    intraday_value = result.get("latest_intraday_net_inflow_100m_cny")
    has_nonzero_signal = any(
        value is not None and abs(value) > 0.01 for value in [summary_value, intraday_value]
    )

    if result.get("channels") and has_nonzero_signal:
        result["status"] = "ok"
    elif result.get("channels"):
        result["note"] = "当前北向端点可返回通道状态，但当日净流入数值回零，暂不做强解释。"
    else:
        result["status"] = "unavailable"
        result["message"] = "未获取到可用的北向资金补充数据"

    return result


def fetch_southbound_flow(ak) -> dict:
    result = {
        "status": "partial",
        "channels": [],
    }

    summary = None
    intraday = None

    try:
        summary = ak.stock_hsgt_fund_flow_summary_em()
    except Exception as exc:
        result["summary_error"] = str(exc)

    if frame_has_rows(summary):
        south_rows = filter_rows_equals(summary, "资金方向", "南向")
        if south_rows:
            channels = []
            net_buy_values = []
            latest_date = None
            for row in south_rows:
                latest_date = str(row.get("交易日", latest_date))
                net_buy = safe_float(row.get("成交净买额"))
                net_buy_values.append(net_buy)
                channels.append(
                    {
                        "channel": str(row.get("板块", "")),
                        "related_index": str(row.get("相关指数", "")),
                        "index_change_pct": round_or_none(safe_float(row.get("指数涨跌幅"))),
                        "up_count": int(safe_float(row.get("上涨数")) or 0),
                        "flat_count": int(safe_float(row.get("持平数")) or 0),
                        "down_count": int(safe_float(row.get("下跌数")) or 0),
                        "net_buy_100m_hkd": round_or_none(net_buy),
                        "trading_status": str(row.get("交易状态", "")),
                    }
                )

            result["channels"] = channels
            result["latest_date"] = latest_date
            valid_summary = [value for value in net_buy_values if value is not None]
            if valid_summary:
                result["latest_summary_net_buy_100m_hkd"] = round_or_none(sum(valid_summary))

    try:
        intraday = ak.stock_hsgt_fund_min_em(symbol="南向资金")
    except Exception as exc:
        result["intraday_error"] = str(exc)

    if frame_has_rows(intraday):
        recent = intraday.tail(20)
        last_row = recent.iloc[-1]
        series = [safe_float(item) for item in column_values(recent, "南向资金")]
        result["latest_intraday_time"] = str(last_row.get("时间", ""))
        result["latest_intraday_net_inflow_100m_hkd"] = normalize_connect_intraday_100m(
            last_row.get("南向资金")
        )
        result["intraday_trend_label"] = direction_label(series, lookback=10)
        result["sh_connect_net_inflow_100m_hkd"] = normalize_connect_intraday_100m(
            last_row.get("港股通(沪)")
        )
        result["sz_connect_net_inflow_100m_hkd"] = normalize_connect_intraday_100m(
            last_row.get("港股通(深)")
        )

    summary_value = result.get("latest_summary_net_buy_100m_hkd")
    intraday_value = result.get("latest_intraday_net_inflow_100m_hkd")
    has_nonzero_signal = any(
        value is not None and abs(value) > 0.01 for value in [summary_value, intraday_value]
    )

    if result.get("channels") and has_nonzero_signal:
        result["status"] = "ok"
    elif result.get("channels"):
        result["note"] = "当前南向端点可返回通道状态，但当日净流入数值回零，暂不做强解释。"
    else:
        result["status"] = "unavailable"
        result["message"] = "未获取到可用的南向资金补充数据"

    return result


def fetch_macro_cycle(ak) -> dict:
    result = {
        "status": "partial",
        "phase": "transition",
        "phase_label": "过渡期",
        "favored_groups": ["均衡配置"],
        "disfavored_groups": [],
    }

    pmi_value = None
    cpi_value = None
    m2_value = None

    try:
        df_pmi = ak.macro_china_pmi()
        if df_pmi is not None and not df_pmi.empty:
            pmi_value = safe_float(df_pmi.iloc[0, 1])
    except Exception:
        pass

    try:
        df_cpi = ak.macro_china_cpi_monthly()
        if df_cpi is not None and not df_cpi.empty:
            cpi_value = safe_float(df_cpi.iloc[-1, 2])
    except Exception:
        pass

    try:
        df_m2 = ak.macro_china_money_supply()
        if df_m2 is not None and not df_m2.empty:
            m2_value = safe_float(df_m2.iloc[0, 2])
    except Exception:
        pass

    if pmi_value is not None and pmi_value >= 50 and (m2_value is None or m2_value >= 7.5):
        result.update(
            {
                "phase": "recovery",
                "phase_label": "修复/扩张",
                "favored_groups": ["宽基核心", "制造升级", "景气资源"],
                "disfavored_groups": ["纯题材追高"],
            }
        )
    elif pmi_value is not None and pmi_value < 50 and (cpi_value is None or cpi_value <= 1):
        result.update(
            {
                "phase": "contraction",
                "phase_label": "偏收缩",
                "favored_groups": ["高股息", "低波防守", "现金流稳定资产"],
                "disfavored_groups": ["高弹性成长", "纯情绪周期"],
            }
        )

    if pmi_value is not None or cpi_value is not None or m2_value is not None:
        result["status"] = "ok"

    result["manufacturing_pmi"] = round_or_none(pmi_value)
    result["cpi_yoy"] = round_or_none(cpi_value)
    result["m2_yoy"] = round_or_none(m2_value)

    return result


def normalize_sector_flow_records(df, indicator: str) -> dict:
    if df is None or df.empty:
        return {"status": "unavailable", "message": f"{indicator} 板块资金流为空"}

    change_col = f"{indicator}涨跌幅"
    net_col = f"{indicator}主力净流入-净额"
    ratio_col = f"{indicator}主力净流入-净占比"
    leader_col = f"{indicator}主力净流入最大股"

    records = []
    for _, row in df.iterrows():
        records.append(
            {
                "name": str(row.get("名称", "")),
                "change_pct": round_or_none(safe_float(row.get(change_col))),
                "main_net_inflow_100m_cny": amount_to_100m(safe_float(row.get(net_col))),
                "main_net_inflow_pct": round_or_none(safe_float(row.get(ratio_col))),
                "leader_stock": str(row.get(leader_col, "")),
                "style_label": classify_style(str(row.get("名称", ""))),
            }
        )

    valid = [item for item in records if item["main_net_inflow_100m_cny"] is not None]
    if not valid:
        return {"status": "unavailable", "message": f"{indicator} 板块资金流缺少主力净流入字段"}

    leaders = sorted(valid, key=lambda item: item["main_net_inflow_100m_cny"], reverse=True)[:5]
    laggards = sorted(valid, key=lambda item: item["main_net_inflow_100m_cny"])[:5]

    return {
        "status": "ok",
        "leaders": leaders,
        "laggards": laggards,
        "positive_sector_count": sum(
            1 for item in valid if item["main_net_inflow_100m_cny"] is not None and item["main_net_inflow_100m_cny"] > 0
        ),
        "negative_sector_count": sum(
            1 for item in valid if item["main_net_inflow_100m_cny"] is not None and item["main_net_inflow_100m_cny"] < 0
        ),
    }


def fetch_sector_fund_flow(ak) -> dict:
    result = {
        "status": "ok",
        "industry": {},
        "concept": {},
    }

    query_plan = {
        "industry": "行业资金流",
        "concept": "概念资金流",
    }
    indicators = {
        "today": "今日",
        "five_day": "5日",
    }

    for scope, sector_type in query_plan.items():
        for key, indicator in indicators.items():
            try:
                df = ak.stock_sector_fund_flow_rank(indicator=indicator, sector_type=sector_type)
                result[scope][key] = normalize_sector_flow_records(df, indicator)
                if result[scope][key].get("status") != "ok":
                    result["status"] = "partial"
            except Exception as exc:
                result[scope][key] = {
                    "status": "error",
                    "message": str(exc),
                }
                result["status"] = "partial"

    return result


def aggregate_style_scores(*groups: tuple[list[dict], float]) -> list[dict]:
    scores: dict[str, float] = {}

    for items, weight in groups:
        for item in items or []:
            label = item.get("style_label") or classify_style(item.get("name"))
            inflow = safe_float(item.get("main_net_inflow_100m_cny"))
            if inflow is None:
                continue
            scores[label] = scores.get(label, 0) + max(inflow, 0) * weight

    if len(scores) > 1 and "其他" in scores:
        scores["其他"] *= 0.3

    ordered = sorted(scores.items(), key=lambda pair: pair[1], reverse=True)
    return [{"label": label, "score": round_or_none(score)} for label, score in ordered if score > 0]


def fetch_sector_rotation_validation(snapshot_sections: dict) -> dict:
    breadth = snapshot_sections.get("market_breadth", {})
    macro_cycle = snapshot_sections.get("macro_cycle", {})
    sector_flow = snapshot_sections.get("sector_fund_flow", {})

    industry_today = (sector_flow.get("industry", {}).get("today", {}) or {}).get("leaders", [])
    industry_five = (sector_flow.get("industry", {}).get("five_day", {}) or {}).get("leaders", [])
    concept_today = (sector_flow.get("concept", {}).get("today", {}) or {}).get("leaders", [])
    concept_five = (sector_flow.get("concept", {}).get("five_day", {}) or {}).get("leaders", [])

    if not industry_today and not concept_today:
        return {
            "status": "unavailable",
            "message": "板块资金流不足，无法生成 sector rotation 验证",
        }

    today_style_scores = aggregate_style_scores((industry_today, 1.0), (concept_today, 0.7))
    five_day_style_scores = aggregate_style_scores((industry_five, 1.0), (concept_five, 0.7))

    today_focus_styles = [item["label"] for item in today_style_scores[:3]]
    five_day_focus_styles = [item["label"] for item in five_day_style_scores[:3]]
    overlap_industries = sorted(
        set(item.get("name") for item in industry_today[:5]) & set(item.get("name") for item in industry_five[:5])
    )
    style_overlap = set(today_focus_styles) & set(five_day_focus_styles)
    breadth_up_ratio = safe_float(breadth.get("up_ratio_pct"))
    macro_phase = str(macro_cycle.get("phase", "transition"))

    if style_overlap and len(overlap_industries) >= 2:
        rotation_mode = "trend_extension"
        rotation_mode_label = "趋势延续"
        confirmation_level = "high" if breadth_up_ratio is not None and breadth_up_ratio >= 55 else "medium"
        conclusion = (
            f"今日与近 5 日的资金主线都围绕 {format_name_list(today_focus_styles, 2)} 展开，"
            "说明轮动并非完全随机，短期主线具有延续性。"
        )
    elif "金融红利防守" in today_focus_styles and (
        breadth_up_ratio is None or breadth_up_ratio < 50 or macro_phase == "contraction"
    ):
        rotation_mode = "defensive_drift"
        rotation_mode_label = "防守漂移"
        confirmation_level = "medium" if breadth_up_ratio is not None and breadth_up_ratio < 50 else "low"
        conclusion = "资金更偏向防守与红利稳定器，说明当前更适合结构修复而不是追逐高弹性方向。"
    elif not style_overlap:
        rotation_mode = "fast_rotation"
        rotation_mode_label = "快速轮动"
        confirmation_level = "low"
        conclusion = "今日强势方向与近 5 日主线重叠较少，当前更像短线切换，不宜把单日强势直接当成中期主线。"
    else:
        rotation_mode = "mixed"
        rotation_mode_label = "混合轮动"
        confirmation_level = "medium"
        conclusion = "主线并未完全统一，既有延续也有切换，仍需结合后续两三个交易日确认。"

    evidence = [
        f"今日行业净流入前三：{format_name_list([item.get('name') for item in industry_today], 3)}",
        f"5日行业净流入前三：{format_name_list([item.get('name') for item in industry_five], 3)}",
        f"今日概念净流入前三：{format_name_list([item.get('name') for item in concept_today], 3)}",
    ]
    if overlap_industries:
        evidence.append(f"行业重叠：{format_name_list(overlap_industries, 3)}")
    if macro_cycle.get("phase_label"):
        evidence.append(f"宏观相位：{macro_cycle.get('phase_label')}")

    return {
        "status": "ok",
        "rotation_mode": rotation_mode,
        "rotation_mode_label": rotation_mode_label,
        "confirmation_level": confirmation_level,
        "confirmation_level_label": {
            "high": "高",
            "medium": "中",
            "low": "低",
        }.get(confirmation_level, "中"),
        "today_focus_styles": today_focus_styles,
        "five_day_focus_styles": five_day_focus_styles,
        "industry_overlap": overlap_industries[:5],
        "today_style_scores": today_style_scores[:4],
        "five_day_style_scores": five_day_style_scores[:4],
        "conclusion": conclusion,
        "evidence": evidence[:5],
    }


def build_notes(snapshot: dict) -> list[str]:
    notes = []
    breadth = snapshot.get("sections", {}).get("market_breadth", {})
    macro_cycle = snapshot.get("sections", {}).get("macro_cycle", {})
    rotation = snapshot.get("sections", {}).get("sector_rotation_validation", {})
    northbound = snapshot.get("sections", {}).get("northbound_flow", {})
    southbound = snapshot.get("sections", {}).get("southbound_flow", {})

    up_ratio = safe_float(breadth.get("up_ratio_pct"))
    phase = macro_cycle.get("phase")
    rotation_mode = rotation.get("rotation_mode")
    today_styles = rotation.get("today_focus_styles", [])

    if up_ratio is not None and up_ratio >= 60 and rotation_mode == "trend_extension":
        notes.append("A股广度与板块资金流同时偏暖，当前修复并非只靠少数权重拉动。")
    elif up_ratio is not None and up_ratio < 50 and rotation_mode == "fast_rotation":
        notes.append("市场宽度一般且板块轮动过快，说明当前更像短线资金腾挪而非清晰主升。")

    if phase == "contraction":
        notes.append("宏观背景仍偏向高股息和低波防守，补充层不能被误用成激进加仓理由。")
    elif phase == "recovery" and today_styles:
        notes.append(f"宏观修复背景下，资金当前更集中在 {format_name_list(today_styles, 2)}。")

    if northbound.get("note"):
        notes.append("北向资金当日净流入端点回零，当前只保留其为辅助核验，不把它作为单独拍板依据。")
    if southbound.get("note"):
        notes.append("南向资金当日净流入端点回零，当前只把它作为港股风险偏好的辅助核验。")

    if not notes:
        notes.append("当前 AkShare 补充层更适合做中国市场线索核验，而不是替代主链。")

    return notes[:4]


def generate_snapshot(trade_date: str) -> dict:
    try:
        import akshare as ak
    except Exception as exc:
        return build_stub_snapshot(trade_date, f"{exc}")

    sections = {}
    status = "ok"

    for name, loader in {
        "market_breadth": fetch_market_breadth,
        "northbound_flow": fetch_northbound_flow,
        "southbound_flow": fetch_southbound_flow,
        "macro_cycle": fetch_macro_cycle,
        "sector_fund_flow": fetch_sector_fund_flow,
    }.items():
        try:
            sections[name] = loader(ak)
            if sections[name].get("status") != "ok":
                status = "partial"
        except Exception as exc:
            sections[name] = {
                "status": "error",
                "message": str(exc),
            }
            status = "partial"

    try:
        sections["sector_rotation_validation"] = fetch_sector_rotation_validation(sections)
        if sections["sector_rotation_validation"].get("status") != "ok":
            status = "partial"
    except Exception as exc:
        sections["sector_rotation_validation"] = {
            "status": "error",
            "message": str(exc),
        }
        status = "partial"

    snapshot = {
        "version": 2,
        "trade_date": trade_date,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": status,
        "source": "AkShare",
        "runtime": {
            "python": sys.executable,
            "auto_venv_path": str(VENV_PYTHON),
        },
        "layer_role": "china_market_supplement_only",
        "guardrails": guardrails(),
        "sections": sections,
    }
    snapshot["notes"] = build_notes(snapshot)
    return snapshot


def write_manifest(manifest_path: Path, output_path: Path):
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    except Exception:
        return

    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["latest_cn_market_snapshot"] = str(output_path)
    manifest_path.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf8")


def main():
    ensure_runtime()
    parser = argparse.ArgumentParser(description="Generate AkShare-based China market supplement snapshot")
    parser.add_argument("--date", help="Trade date in YYYY-MM-DD")
    parser.add_argument("--portfolio-root", default="", help="Override portfolio root")
    parser.add_argument("--no-manifest", action="store_true", help="Do not update state-manifest.json")
    args = parser.parse_args()

    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    manifest_path = portfolio_root / "state-manifest.json"
    trade_date = resolve_date(args.date)
    output_dir = portfolio_root / "cn_market_snapshots"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{trade_date}-cn-snapshot.json"

    snapshot = generate_snapshot(trade_date)
    output_path.write_text(f"{json.dumps(snapshot, ensure_ascii=False, indent=2)}\n", encoding="utf8")

    if not args.no_manifest:
        write_manifest(manifest_path, output_path)

    print(
        json.dumps(
            {
                "outputPath": str(output_path),
                "status": snapshot["status"],
                "source": snapshot["source"],
                "runtimePython": snapshot["runtime"]["python"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
