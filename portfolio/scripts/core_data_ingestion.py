#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import random
import runpy
import sqlite3
import subprocess
import sys
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.append(str(LIB_DIR))

from account_root import PORTFOLIO_USERS_ROOT  # noqa: E402
from account_root import DEFAULT_PORTFOLIO_ROOT, resolve_portfolio_root  # noqa: E402

PORTFOLIO_ROOT = DEFAULT_PORTFOLIO_ROOT
WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
ASSET_MASTER_PATH = PORTFOLIO_ROOT / "config" / "asset_master.json"
BACKTEST_PROXY_CONFIG_PATH = PORTFOLIO_ROOT / "config" / "backtest_proxy_mapping.json"
MACRO_RADAR_SCRIPT = SCRIPT_DIR / "generate_macro_radar.py"
QDII_PROXY_SCRIPT = SCRIPT_DIR / "generate_qdii_valuation_proxy.py"
OUTPUT_DIR = PORTFOLIO_ROOT / "data"
DB_PATH = OUTPUT_DIR / "market_lake.db"
MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"
VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")
SYSTEM_PYTHON = Path("/opt/homebrew/bin/python3")

DEFAULT_YFINANCE_PERIOD = "10y"
DEFAULT_FUND_INDICATOR = "累计净值走势"
DEFAULT_CN_EXCHANGE_ETF_START_DATE = "19700101"
MAX_CN_EXCHANGE_ETF_RETRIES = 3
MAX_YFINANCE_RETRIES = 3
YFINANCE_SLEEP_MIN_SECONDS = 1.5
YFINANCE_SLEEP_MAX_SECONDS = 3.5
YAHOO_CHART_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
}


def ensure_runtime() -> None:
    if os.environ.get("AKSHARE_VENV_REEXEC") == "1":
        return

    expected_venv_root = VENV_PYTHON.parent.parent
    if VENV_PYTHON.exists() and Path(sys.prefix) != expected_venv_root:
        try:
            import akshare  # noqa: F401
            import curl_cffi  # noqa: F401
            import pandas  # noqa: F401
            import pydantic  # noqa: F401
            import requests  # noqa: F401
            import yfinance  # noqa: F401
            return
        except Exception:
            env = os.environ.copy()
            env["AKSHARE_VENV_REEXEC"] = "1"
            os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv], env)


ensure_runtime()

import akshare as ak  # noqa: E402
import pandas as pd  # noqa: E402
import requests  # noqa: E402
import yfinance as yf  # noqa: E402
from curl_cffi import requests as curl_requests  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator  # noqa: E402


class DailyPriceRecord(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    symbol: str = Field(min_length=1)
    date: date
    open: float
    high: float
    low: float
    close: float
    adj_close: float
    volume: float | None = Field(default=None, ge=0)
    provider: str = Field(min_length=1)
    asset_type: str = Field(min_length=1)
    name: str | None = None
    close_source: str | None = None
    source_tags: str | None = None

    @field_validator("symbol", "provider", "asset_type")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("open", "high", "low", "close", "adj_close")
    @classmethod
    def validate_price_finite(cls, value: float) -> float:
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError("price fields must be finite numbers")
        return numeric


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest local market data lake from AkShare funds and yfinance global symbols."
    )
    parser.add_argument("--portfolio-root", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--period", default=DEFAULT_YFINANCE_PERIOD)
    parser.add_argument("--fund-indicator", default=DEFAULT_FUND_INDICATOR)
    parser.add_argument(
        "--only-symbols",
        default="",
        help="Comma-separated symbols to ingest. Empty means full universe.",
    )
    return parser.parse_args()


def rebind_runtime_paths(portfolio_root: Path) -> None:
    global PORTFOLIO_ROOT
    global WATCHLIST_PATH
    global ASSET_MASTER_PATH
    global BACKTEST_PROXY_CONFIG_PATH
    global OUTPUT_DIR
    global DB_PATH
    global MANIFEST_PATH

    PORTFOLIO_ROOT = portfolio_root
    WATCHLIST_PATH = PORTFOLIO_ROOT / "fund-watchlist.json"
    ASSET_MASTER_PATH = PORTFOLIO_ROOT / "config" / "asset_master.json"
    BACKTEST_PROXY_CONFIG_PATH = PORTFOLIO_ROOT / "config" / "backtest_proxy_mapping.json"
    OUTPUT_DIR = PORTFOLIO_ROOT / "data"
    DB_PATH = OUTPUT_DIR / "market_lake.db"
    MANIFEST_PATH = PORTFOLIO_ROOT / "state-manifest.json"


def format_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_optional_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return read_json(path)


def current_cn_date_compact() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d")


def parse_symbol_filter(raw: str) -> set[str]:
    return {item.strip() for item in str(raw or "").split(",") if item.strip()}


def normalize_cn_exchange_symbol(symbol: str) -> str:
    ticker = str(symbol or "").strip().lower()
    if not ticker:
        raise ValueError("missing cn exchange symbol")
    if ticker.startswith(("sh", "sz")) and ticker[2:].isdigit():
        return ticker
    if ticker.endswith(".sh"):
        return f"sh{ticker.split('.')[0]}"
    if ticker.endswith(".sz"):
        return f"sz{ticker.split('.')[0]}"
    if ticker.isdigit():
        return f"sh{ticker}" if ticker[0] in {"5", "6"} else f"sz{ticker}"
    raise ValueError(f"unsupported cn exchange symbol: {symbol}")


def collect_watchlist_specs() -> list[tuple[str, Path]]:
    specs: list[tuple[str, Path]] = []

    if WATCHLIST_PATH.exists():
        specs.append(("main", WATCHLIST_PATH))

    if PORTFOLIO_USERS_ROOT.exists():
        for child in sorted(PORTFOLIO_USERS_ROOT.iterdir(), key=lambda item: item.name):
            if not child.is_dir():
                continue
            watchlist_path = child / "fund-watchlist.json"
            if watchlist_path.exists():
                specs.append((child.name, watchlist_path))

    return specs


def normalize_download_frame(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
    if df.empty:
        return df

    working = df.copy()
    if isinstance(working.columns, pd.MultiIndex):
        level_values = list(working.columns.get_level_values(-1))
        if ticker in level_values:
            working = working.xs(ticker, axis=1, level=-1, drop_level=True)
        else:
            working.columns = working.columns.get_level_values(0)

    working.columns = [str(column) for column in working.columns]
    working.index = pd.to_datetime(working.index, errors="coerce")
    working = working[~working.index.isna()].sort_index()
    return working


def create_yfinance_session() -> Any:
    session = curl_requests.Session(impersonate="chrome")
    session.headers.update(YAHOO_CHART_HEADERS)
    return session


def is_rate_limit_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "429" in message or "too many requests" in message or "rate limit" in message


def download_yfinance_frame(
    symbol: str,
    period: str,
    session: Any,
) -> pd.DataFrame:
    last_error: Exception | None = None

    for attempt in range(MAX_YFINANCE_RETRIES):
        time.sleep(random.uniform(YFINANCE_SLEEP_MIN_SECONDS, YFINANCE_SLEEP_MAX_SECONDS))
        try:
            raw_df = yf.download(
                symbol,
                period=period,
                interval="1d",
                progress=False,
                auto_adjust=False,
                actions=False,
                threads=False,
                timeout=30,
                session=session,
            )
            normalized = normalize_download_frame(raw_df, symbol)
            if normalized.empty:
                raise ValueError(f"yfinance returned empty dataframe for symbol={symbol}")
            return normalized
        except Exception as exc:  # pragma: no cover
            last_error = exc
            retry_delay = 5 * (attempt + 1)
            retryable = is_rate_limit_error(exc)
            rate_limit_tag = " [rate-limit]" if retryable else ""
            print(
                f"[warn] yfinance download failed for {symbol} "
                f"(attempt {attempt + 1}/{MAX_YFINANCE_RETRIES}){rate_limit_tag}: {exc}"
            )
            if retryable and attempt < MAX_YFINANCE_RETRIES - 1:
                time.sleep(retry_delay)
                continue
            break

    if last_error is None:
        raise ValueError(f"yfinance download failed for symbol={symbol}")
    raise last_error


def download_yahoo_chart_frame(symbol: str, period: str) -> pd.DataFrame:
    params = {
        "range": period,
        "interval": "1d",
        "includeAdjustedClose": "true",
        "events": "div,splits",
    }
    hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
    last_error: Exception | None = None

    for attempt in range(MAX_YFINANCE_RETRIES):
        time.sleep(random.uniform(YFINANCE_SLEEP_MIN_SECONDS, YFINANCE_SLEEP_MAX_SECONDS))
        try:
            host = hosts[attempt % len(hosts)]
            response = requests.get(
                f"https://{host}/v8/finance/chart/{symbol}",
                params=params,
                headers=YAHOO_CHART_HEADERS,
                timeout=30,
            )
            if response.status_code == 429:
                raise requests.HTTPError(
                    f"429 Client Error: Too Many Requests for url: {response.url}",
                    response=response,
                )
            response.raise_for_status()
            payload = response.json()
            chart = payload.get("chart", {})
            result = chart.get("result") or []
            if not result:
                error = chart.get("error") or {}
                raise ValueError(f"Yahoo chart api returned empty result: {error}")

            node = result[0]
            timestamps = node.get("timestamp") or []
            indicators = node.get("indicators") or {}
            quote = (indicators.get("quote") or [{}])[0]
            adjclose = (indicators.get("adjclose") or [{}])[0].get("adjclose")
            if not timestamps:
                raise ValueError("Yahoo chart api returned empty timestamps")

            frame = pd.DataFrame(
                {
                    "Open": quote.get("open"),
                    "High": quote.get("high"),
                    "Low": quote.get("low"),
                    "Close": quote.get("close"),
                    "Adj Close": adjclose,
                    "Volume": quote.get("volume"),
                },
                index=pd.to_datetime(timestamps, unit="s", utc=True).tz_convert(None).normalize(),
            )
            frame.index.name = "Date"
            return frame.sort_index()
        except Exception as exc:  # pragma: no cover
            last_error = exc
            retry_delay = 5 * (attempt + 1)
            rate_limit_tag = " [rate-limit]" if is_rate_limit_error(exc) else ""
            print(
                f"[warn] yahoo chart fallback failed for {symbol} "
                f"(attempt {attempt + 1}/{MAX_YFINANCE_RETRIES}){rate_limit_tag}: {exc}"
            )
            if attempt < MAX_YFINANCE_RETRIES - 1:
                time.sleep(retry_delay)

    if last_error is None:
        raise ValueError(f"Yahoo chart api failed for symbol={symbol}")
    if is_rate_limit_error(last_error) and SYSTEM_PYTHON.exists():
        print(f"[warn] spawning isolated fallback process for {symbol} after repeated 429 responses")
        return download_yahoo_chart_frame_subprocess(symbol, period)
    raise last_error


def download_yahoo_chart_frame_subprocess(symbol: str, period: str) -> pd.DataFrame:
    helper_code = """
import json
import requests
import sys
from datetime import datetime, timezone

symbol = sys.argv[1]
period = sys.argv[2]
headers = {'User-Agent': 'Mozilla/5.0'}
hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']
last_error = None

for host in hosts:
    try:
        response = requests.get(
            f'https://{host}/v8/finance/chart/{symbol}',
            params={
                'range': period,
                'interval': '1d',
                'includeAdjustedClose': 'true',
                'events': 'div,splits',
            },
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        chart = payload.get('chart', {})
        result = chart.get('result') or []
        if not result:
            raise ValueError(f'empty result: {chart.get("error") or {}}')
        node = result[0]
        timestamps = node.get('timestamp') or []
        indicators = node.get('indicators') or {}
        quote = (indicators.get('quote') or [{}])[0]
        adjclose = (indicators.get('adjclose') or [{}])[0].get('adjclose')
        rows = []
        for i, raw_ts in enumerate(timestamps):
            open_ = quote.get('open', [None] * len(timestamps))[i]
            high = quote.get('high', [None] * len(timestamps))[i]
            low = quote.get('low', [None] * len(timestamps))[i]
            close = quote.get('close', [None] * len(timestamps))[i]
            volume = quote.get('volume', [None] * len(timestamps))[i]
            adj_value = adjclose[i] if adjclose and i < len(adjclose) else close
            if None in (open_, high, low, close):
                continue
            rows.append({
                'date': datetime.fromtimestamp(raw_ts, tz=timezone.utc).date().isoformat(),
                'Open': open_,
                'High': high,
                'Low': low,
                'Close': close,
                'Adj Close': adj_value,
                'Volume': volume,
            })
        print(json.dumps({'rows': rows}, ensure_ascii=False))
        raise SystemExit(0)
    except Exception as exc:
        last_error = str(exc)

raise SystemExit(last_error or 'subprocess chart fallback failed')
"""
    completed = subprocess.run(
        [str(SYSTEM_PYTHON), "-c", helper_code, symbol, period],
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        stdout = (completed.stdout or "").strip()
        detail = stderr or stdout or f"subprocess fallback failed for symbol={symbol}"
        raise ValueError(detail)

    payload = json.loads(completed.stdout)
    rows = payload.get("rows") or []
    if not rows:
        raise ValueError(f"subprocess fallback returned empty rows for symbol={symbol}")

    frame = pd.DataFrame(rows)
    frame["Date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame = frame.dropna(subset=["Date"]).set_index("Date").drop(columns=["date"])
    return frame.sort_index()


def choose_price_column(df: pd.DataFrame, preferences: list[str]) -> str | None:
    for column in preferences:
        if column in df.columns:
            return column
    return None


def choose_fund_nav_column(df: pd.DataFrame) -> str | None:
    for column in ("累计净值", "单位净值"):
        if column in df.columns:
            return column
    return None


def load_script_globals(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(path)
    return runpy.run_path(str(path), run_name="__data_lake__")


def collect_fund_specs() -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}

    for account_id, watchlist_path in collect_watchlist_specs():
        payload = read_json(watchlist_path)
        for item in payload.get("watchlist", []):
            if not item.get("enabled", True):
                continue

            code = str(item.get("code", "")).strip()
            if not code:
                continue

            existing = deduped.get(code)
            merged_tags = {
                "fund-watchlist",
                "generate_correlation_matrix",
                "generate_fund_signals_matrix",
                f"account:{account_id}",
            }
            if existing and existing.get("source_tags"):
                merged_tags.update(str(existing["source_tags"]).split(","))

            deduped[code] = {
                "symbol": code,
                "name": item.get("name") or (existing or {}).get("name"),
                "provider": "akshare",
                "asset_type": "cn_fund",
                "close_source": DEFAULT_FUND_INDICATOR,
                "source_tags": ",".join(sorted(tag for tag in merged_tags if tag)),
            }

    return sorted(deduped.values(), key=lambda item: item["symbol"])


def collect_yfinance_specs() -> list[dict[str, Any]]:
    specs_by_symbol: dict[str, dict[str, Any]] = {}

    macro_globals = load_script_globals(MACRO_RADAR_SCRIPT)
    for key, config in (macro_globals.get("SERIES_CONFIG") or {}).items():
        for ticker in config.get("candidates", []):
            entry = specs_by_symbol.setdefault(
                ticker,
                {
                    "symbol": ticker,
                    "name": config.get("label"),
                    "provider": "yfinance",
                    "asset_type": "global_market",
                    "field_preference": list(config.get("field_preference", ["Adj Close", "Close"])),
                    "source_tags": set(),
                },
            )
            entry["source_tags"].add(f"macro:{key}")

    qdii_globals = load_script_globals(QDII_PROXY_SCRIPT)
    for key, config in (qdii_globals.get("QDII_PROXY_MAPPING") or {}).items():
        for ticker in config.get("proxy_candidates", []):
            entry = specs_by_symbol.setdefault(
                ticker,
                {
                    "symbol": ticker,
                    "name": config.get("name"),
                    "provider": "yfinance",
                    "asset_type": "global_market",
                    "field_preference": ["Adj Close", "Close"],
                    "source_tags": set(),
                },
            )
            entry["source_tags"].add(f"qdii_proxy:{key}")

    result: list[dict[str, Any]] = []
    for spec in specs_by_symbol.values():
        result.append(
            {
                "symbol": spec["symbol"],
                "name": spec.get("name"),
                "provider": spec["provider"],
                "asset_type": spec["asset_type"],
                "field_preference": spec["field_preference"],
                "close_source": "yfinance_close_series",
                "source_tags": ",".join(sorted(spec["source_tags"])),
            }
        )

    return sorted(result, key=lambda item: item["symbol"])


def collect_cn_exchange_etf_specs() -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}

    if ASSET_MASTER_PATH.exists():
        asset_master = read_json(ASSET_MASTER_PATH)
        for asset in asset_master.get("assets", []):
            execution_type = str(asset.get("execution_type") or "OTC").upper()
            market = str(asset.get("market") or "").upper()
            ticker = str(asset.get("ticker") or asset.get("symbol") or "").strip()
            name = str(asset.get("name") or "").strip()
            category = str(asset.get("category") or "").strip()
            if execution_type != "EXCHANGE" or market != "CN" or not ticker:
                continue
            if not ticker.isdigit():
                continue
            if "ETF" not in f"{name} {category}".upper():
                continue

            source_tags = {
                "asset_master",
                "execution:exchange",
                "market:cn",
                "provider:akshare_fund_etf_hist_em",
            }
            bucket = str(asset.get("bucket") or "").strip()
            if bucket:
                source_tags.add(f"bucket:{bucket}")

            regime_type = str((asset.get("strategy_regime") or {}).get("type") or "").strip()
            if regime_type:
                source_tags.add(f"regime:{regime_type}")

            deduped[ticker] = {
                "symbol": ticker,
                "name": name or None,
                "provider": "akshare",
                "asset_type": "cn_exchange_etf",
                "close_source": "fund_etf_hist_em",
                "source_tags": ",".join(sorted(source_tags)),
                "start_date": DEFAULT_CN_EXCHANGE_ETF_START_DATE,
                "end_date": current_cn_date_compact(),
            }

    proxy_payload = load_optional_json(BACKTEST_PROXY_CONFIG_PATH)
    for item in proxy_payload.get("exchange_backfill_universe", []):
        ticker = str(item.get("symbol") or "").strip()
        if not ticker or not ticker.isdigit():
            continue

        existing = deduped.get(ticker, {})
        source_tags = {
            "backtest_proxy",
            "market:cn",
            "provider:akshare_fund_etf_hist_em",
        }
        asset_key = str(item.get("asset_key") or "").strip()
        if asset_key:
            source_tags.add(f"backtest_asset:{asset_key}")
        if existing.get("source_tags"):
            source_tags.update(str(existing["source_tags"]).split(","))

        deduped[ticker] = {
            "symbol": ticker,
            "name": str(item.get("name") or existing.get("name") or "").strip() or None,
            "provider": "akshare",
            "asset_type": "cn_exchange_etf",
            "close_source": "fund_etf_hist_em",
            "source_tags": ",".join(sorted(tag for tag in source_tags if tag)),
            "start_date": DEFAULT_CN_EXCHANGE_ETF_START_DATE,
            "end_date": current_cn_date_compact(),
        }

    return sorted(deduped.values(), key=lambda item: item["symbol"])


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS daily_prices (
          symbol TEXT NOT NULL,
          date TEXT NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          adj_close REAL NOT NULL,
          volume REAL,
          provider TEXT NOT NULL,
          asset_type TEXT NOT NULL,
          name TEXT,
          close_source TEXT,
          source_tags TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (symbol, date)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_prices_symbol_date
          ON daily_prices(symbol, date);
        """
    )


def build_fund_records(spec: dict[str, Any], indicator: str) -> list[DailyPriceRecord]:
    raw_df = ak.fund_open_fund_info_em(symbol=spec["symbol"], indicator=indicator)
    if raw_df is None or raw_df.empty:
        raise ValueError("AkShare returned empty dataframe")

    nav_column = choose_fund_nav_column(raw_df)
    if nav_column is None:
        raise ValueError("missing 累计净值/单位净值 column")

    working = raw_df.copy()
    working["净值日期"] = pd.to_datetime(working["净值日期"], errors="coerce")
    working[nav_column] = pd.to_numeric(working[nav_column], errors="coerce")
    working = working.dropna(subset=["净值日期", nav_column]).sort_values("净值日期")
    if working.empty:
        raise ValueError("fund history is empty after cleaning")

    records: list[DailyPriceRecord] = []
    for _, row in working.iterrows():
        record = DailyPriceRecord(
            symbol=spec["symbol"],
            date=row["净值日期"],
            open=row[nav_column],
            high=row[nav_column],
            low=row[nav_column],
            close=row[nav_column],
            adj_close=row[nav_column],
            volume=None,
            provider=spec["provider"],
            asset_type=spec["asset_type"],
            name=spec.get("name"),
            close_source=nav_column,
            source_tags=spec.get("source_tags"),
        )
        records.append(record)

    return records


def build_yfinance_records(spec: dict[str, Any], period: str) -> list[DailyPriceRecord]:
    session = create_yfinance_session()
    download_source = "yfinance"
    try:
        normalized = download_yfinance_frame(spec["symbol"], period, session=session)
    except Exception as exc:
        print(
            f"[warn] yfinance retries exhausted for {spec['symbol']}; "
            f"switching to yahoo chart fallback: {exc}"
        )
        normalized = download_yahoo_chart_frame(spec["symbol"], period)
        download_source = "yahoo_chart_fallback"
    if normalized.empty:
        raise ValueError("yfinance returned empty dataframe")

    working = normalized.copy()
    required_ohlc = ["Open", "High", "Low", "Close"]
    missing_ohlc = [column for column in required_ohlc if column not in working.columns]
    if missing_ohlc:
        raise ValueError(f"missing OHLC columns: {', '.join(missing_ohlc)}")

    for column in required_ohlc:
        working[column] = pd.to_numeric(working[column], errors="coerce")

    if "Adj Close" in working.columns:
        working["Adj Close"] = pd.to_numeric(working["Adj Close"], errors="coerce")
    else:
        working["Adj Close"] = working["Close"]

    if "Volume" in working.columns:
        working["Volume"] = pd.to_numeric(working["Volume"], errors="coerce")
    else:
        working["Volume"] = pd.NA
    working = working.dropna(subset=required_ohlc).sort_index()
    working["Adj Close"] = working["Adj Close"].fillna(working["Close"])
    if working.empty:
        raise ValueError("yfinance history is empty after cleaning")

    records: list[DailyPriceRecord] = []
    for index, row in working.iterrows():
        volume_value = row.get("Volume")
        if volume_value is not None and (pd.isna(volume_value) or not math.isfinite(float(volume_value))):
            volume_value = None

        record = DailyPriceRecord(
            symbol=spec["symbol"],
            date=index,
            open=row["Open"],
            high=row["High"],
            low=row["Low"],
            close=row["Close"],
            adj_close=row["Adj Close"],
            volume=float(volume_value) if volume_value is not None else None,
            provider=spec["provider"],
            asset_type=spec["asset_type"],
            name=spec.get("name"),
            close_source=download_source,
            source_tags=spec.get("source_tags"),
        )
        records.append(record)

    return records


def build_cn_exchange_etf_records(spec: dict[str, Any]) -> list[DailyPriceRecord]:
    start_date = str(spec.get("start_date") or DEFAULT_CN_EXCHANGE_ETF_START_DATE)
    end_date = str(spec.get("end_date") or current_cn_date_compact())
    raw_df: pd.DataFrame | None = None
    close_source = "fund_etf_hist_em"
    last_error: Exception | None = None

    for attempt in range(MAX_CN_EXCHANGE_ETF_RETRIES):
        try:
            raw_df = ak.fund_etf_hist_em(
                symbol=spec["symbol"],
                period="daily",
                start_date=start_date,
                end_date=end_date,
                adjust="",
            )
            if raw_df is None or raw_df.empty:
                raise ValueError("AkShare returned empty ETF dataframe")
            break
        except Exception as exc:
            last_error = exc
            print(
                f"[warn] fund_etf_hist_em failed for {spec['symbol']} "
                f"(attempt {attempt + 1}/{MAX_CN_EXCHANGE_ETF_RETRIES}): {exc}"
            )
            if attempt < MAX_CN_EXCHANGE_ETF_RETRIES - 1:
                time.sleep(2 * (attempt + 1))

    if raw_df is None or raw_df.empty:
        sina_symbol = normalize_cn_exchange_symbol(spec["symbol"])
        print(
            f"[warn] switching to fund_etf_hist_sina for {spec['symbol']} after EM retries exhausted: {last_error}"
        )
        raw_df = ak.fund_etf_hist_sina(symbol=sina_symbol)
        close_source = "fund_etf_hist_sina"
        if raw_df is None or raw_df.empty:
            raise ValueError("AkShare returned empty ETF dataframe from both EM and Sina")

    working = raw_df.copy()
    rename_map = {
        "日期": "date",
        "date": "date",
        "开盘": "open",
        "open": "open",
        "最高": "high",
        "high": "high",
        "最低": "low",
        "low": "low",
        "收盘": "close",
        "close": "close",
        "成交量": "volume",
        "volume": "volume",
    }
    working = working.rename(columns=rename_map)
    required_columns = ["date", "open", "high", "low", "close", "volume"]
    missing_columns = [column for column in required_columns if column not in working.columns]
    if missing_columns:
        raise ValueError(f"missing ETF columns after normalization: {', '.join(missing_columns)}")
    working["date"] = pd.to_datetime(working["date"], errors="coerce")
    for column in ["open", "high", "low", "close", "volume"]:
        working[column] = pd.to_numeric(working[column], errors="coerce")
    working = (
        working.dropna(subset=["date", "open", "high", "low", "close"])
        .loc[lambda frame: frame["date"].dt.strftime("%Y%m%d").between(start_date, end_date)]
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
    )
    if working.empty:
        raise ValueError("ETF history is empty after cleaning")

    records: list[DailyPriceRecord] = []
    for _, row in working.iterrows():
        volume_value = row.get("volume")
        if volume_value is not None and (pd.isna(volume_value) or not math.isfinite(float(volume_value))):
            volume_value = None

        records.append(
            DailyPriceRecord(
                symbol=spec["symbol"],
                date=row["date"],
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=row["close"],
                adj_close=row["close"],
                volume=float(volume_value) if volume_value is not None else None,
                provider=spec["provider"],
                asset_type=spec["asset_type"],
                name=spec.get("name"),
                close_source=close_source,
                source_tags=spec.get("source_tags"),
            )
        )

    return records


def upsert_records(connection: sqlite3.Connection, records: list[DailyPriceRecord]) -> int:
    timestamp = format_now()
    payload = [
        (
            record.symbol,
            record.date.isoformat(),
            record.open,
            record.high,
            record.low,
            record.close,
            record.adj_close,
            record.volume,
            record.provider,
            record.asset_type,
            record.name,
            record.close_source,
            record.source_tags,
            timestamp,
        )
        for record in records
    ]

    connection.executemany(
        """
        INSERT INTO daily_prices (
          symbol,
          date,
          open,
          high,
          low,
          close,
          adj_close,
          volume,
          provider,
          asset_type,
          name,
          close_source,
          source_tags,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, date) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          adj_close = excluded.adj_close,
          volume = excluded.volume,
          provider = excluded.provider,
          asset_type = excluded.asset_type,
          name = excluded.name,
          close_source = excluded.close_source,
          source_tags = excluded.source_tags,
          updated_at = excluded.updated_at
        """,
        payload,
    )
    return len(payload)


def update_manifest(db_path: Path) -> None:
    if not MANIFEST_PATH.exists():
        return

    manifest = read_json(MANIFEST_PATH)
    canonical = manifest.setdefault("canonical_entrypoints", {})
    canonical["core_data_ingestion_script"] = str(Path(__file__).resolve())
    canonical["market_lake_db"] = str(db_path)
    MANIFEST_PATH.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    portfolio_root = resolve_portfolio_root(portfolio_root=args.portfolio_root or None)
    rebind_runtime_paths(portfolio_root)
    db_path = Path(args.db).expanduser() if args.db else DB_PATH
    db_path.parent.mkdir(parents=True, exist_ok=True)
    only_symbols = parse_symbol_filter(args.only_symbols)

    fund_specs = collect_fund_specs()
    yfinance_specs = collect_yfinance_specs()
    exchange_etf_specs = collect_cn_exchange_etf_specs()
    if only_symbols:
        fund_specs = [spec for spec in fund_specs if spec["symbol"] in only_symbols]
        yfinance_specs = [spec for spec in yfinance_specs if spec["symbol"] in only_symbols]
        exchange_etf_specs = [spec for spec in exchange_etf_specs if spec["symbol"] in only_symbols]
    errors: list[dict[str, Any]] = []
    written_rows = 0
    written_symbols = 0
    fund_symbols_written = 0
    yfinance_symbols_written = 0
    exchange_symbols_written = 0

    with sqlite3.connect(db_path) as connection:
        ensure_schema(connection)

        for spec in fund_specs:
            try:
                records = build_fund_records(spec, indicator=args.fund_indicator)
                with connection:
                    written_rows += upsert_records(connection, records)
                written_symbols += 1
                fund_symbols_written += 1
            except (ValidationError, Exception) as exc:  # pragma: no cover
                errors.append(
                    {
                        "symbol": spec["symbol"],
                        "provider": spec["provider"],
                        "name": spec.get("name"),
                        "error": str(exc),
                    }
                )

        for spec in yfinance_specs:
            try:
                records = build_yfinance_records(spec, period=args.period)
                with connection:
                    written_rows += upsert_records(connection, records)
                written_symbols += 1
                yfinance_symbols_written += 1
            except (ValidationError, Exception) as exc:  # pragma: no cover
                errors.append(
                    {
                        "symbol": spec["symbol"],
                        "provider": spec["provider"],
                        "name": spec.get("name"),
                        "error": str(exc),
                    }
                )

        for spec in exchange_etf_specs:
            try:
                records = build_cn_exchange_etf_records(spec)
                with connection:
                    written_rows += upsert_records(connection, records)
                written_symbols += 1
                exchange_symbols_written += 1
                latest = records[-1]
                print(
                    "[ok] exchange_etf {symbol} rows={rows} latest={latest_date} close={close:.4f}".format(
                        symbol=spec["symbol"],
                        rows=len(records),
                        latest_date=latest.date.isoformat(),
                        close=latest.close,
                    )
                )
            except (ValidationError, Exception) as exc:  # pragma: no cover
                errors.append(
                    {
                        "symbol": spec["symbol"],
                        "provider": spec["provider"],
                        "name": spec.get("name"),
                        "error": str(exc),
                    }
                )

        total_rows = connection.execute("SELECT COUNT(*) FROM daily_prices").fetchone()[0]

    update_manifest(db_path)
    print(
        json.dumps(
            {
                "dbPath": str(db_path),
                "fundSymbolsRequested": len(fund_specs),
                "fundSymbolsWritten": fund_symbols_written,
                "yfinanceSymbolsRequested": len(yfinance_specs),
                "yfinanceSymbolsWritten": yfinance_symbols_written,
                "exchangeSymbolsRequested": len(exchange_etf_specs),
                "exchangeSymbolsWritten": exchange_symbols_written,
                "symbolsWritten": written_symbols,
                "rowsWrittenThisRun": written_rows,
                "totalRowsInLake": total_rows,
                "errorCount": len(errors),
                "errors": errors[:10],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
