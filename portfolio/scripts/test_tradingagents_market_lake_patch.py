#!/usr/bin/env python3
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tradingagents_market_lake_patch import (
    _FRAME_CACHE,
    _METHOD_RESULT_CACHE,
    _normalize_indicator_lookback_days,
    _is_recent_enough,
    _read_market_lake_frame,
    _render_stock_csv,
    _wrap_cached_vendor_method,
    resolve_market_lake_db_path,
)


class TradingAgentsMarketLakePatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="tradingagents-market-lake-")
        self.db_path = Path(self.temp_dir.name) / "market_lake.db"
        self.previous_env = os.environ.get("TRADINGAGENTS_MARKET_LAKE_DB")
        self.previous_vendor_cache = os.environ.get("TRADINGAGENTS_VENDOR_CACHE_DIR")
        self.previous_max_rows = os.environ.get("TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS")
        self.previous_indicator_lookback = os.environ.get("TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS")
        os.environ["TRADINGAGENTS_MARKET_LAKE_DB"] = str(self.db_path)
        os.environ["TRADINGAGENTS_VENDOR_CACHE_DIR"] = str(Path(self.temp_dir.name) / "vendor-cache")
        _FRAME_CACHE.clear()
        _METHOD_RESULT_CACHE.clear()

        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """
                CREATE TABLE daily_prices (
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
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.executemany(
                """
                INSERT INTO daily_prices (
                    symbol, date, open, high, low, close, adj_close, volume,
                    provider, asset_type, name, close_source, source_tags, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        "QQQ",
                        "2026-04-22",
                        600.0,
                        610.0,
                        598.0,
                        608.0,
                        608.0,
                        1000.0,
                        "yfinance",
                        "etf",
                        "QQQ",
                        "close",
                        "",
                        "2026-04-22T16:00:00Z",
                    ),
                    (
                        "QQQ",
                        "2026-04-23",
                        608.0,
                        612.0,
                        607.0,
                        611.0,
                        611.0,
                        1100.0,
                        "yfinance",
                        "etf",
                        "QQQ",
                        "close",
                        "",
                        "2026-04-23T16:00:00Z",
                    ),
                ],
            )

    def tearDown(self) -> None:
        if self.previous_env is None:
            os.environ.pop("TRADINGAGENTS_MARKET_LAKE_DB", None)
        else:
            os.environ["TRADINGAGENTS_MARKET_LAKE_DB"] = self.previous_env
        if self.previous_vendor_cache is None:
            os.environ.pop("TRADINGAGENTS_VENDOR_CACHE_DIR", None)
        else:
            os.environ["TRADINGAGENTS_VENDOR_CACHE_DIR"] = self.previous_vendor_cache
        if self.previous_max_rows is None:
            os.environ.pop("TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS", None)
        else:
            os.environ["TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS"] = self.previous_max_rows
        if self.previous_indicator_lookback is None:
            os.environ.pop("TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS", None)
        else:
            os.environ["TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS"] = self.previous_indicator_lookback
        _FRAME_CACHE.clear()
        _METHOD_RESULT_CACHE.clear()
        self.temp_dir.cleanup()

    def test_resolve_market_lake_db_path_prefers_env_override(self) -> None:
        self.assertEqual(resolve_market_lake_db_path(), self.db_path.resolve())

    def test_read_market_lake_frame_returns_normalized_history(self) -> None:
        frame = _read_market_lake_frame("QQQ", "2026-04-01", "2026-04-24")
        self.assertEqual(len(frame), 2)
        self.assertEqual(list(frame.columns), ["Date", "Open", "High", "Low", "Close", "Adj Close", "Volume"])
        self.assertEqual(frame.iloc[-1]["Close"], 611.0)

    def test_read_market_lake_frame_degrades_when_schema_is_missing(self) -> None:
        empty_db_path = Path(self.temp_dir.name) / "empty-market-lake.db"
        os.environ["TRADINGAGENTS_MARKET_LAKE_DB"] = str(empty_db_path)
        _FRAME_CACHE.clear()
        with sqlite3.connect(empty_db_path):
            pass

        frame = _read_market_lake_frame("QQQ", "2026-04-01", "2026-04-24")

        self.assertTrue(frame.empty)

    def test_is_recent_enough_honors_target_gap(self) -> None:
        frame = _read_market_lake_frame("QQQ", "2026-04-01", "2026-04-24")
        self.assertTrue(_is_recent_enough(frame, "2026-04-24", max_gap_days=2))
        self.assertFalse(_is_recent_enough(frame, "2026-04-24", max_gap_days=0))

    def test_render_stock_csv_caps_rows_and_keeps_summary(self) -> None:
        with sqlite3.connect(self.db_path) as connection:
            connection.executemany(
                """
                INSERT INTO daily_prices (
                    symbol, date, open, high, low, close, adj_close, volume,
                    provider, asset_type, name, close_source, source_tags, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    ("QQQ", "2026-04-20", 590.0, 595.0, 588.0, 594.0, 594.0, 900.0, "yfinance", "etf", "QQQ", "close", "", "2026-04-20T16:00:00Z"),
                    ("QQQ", "2026-04-21", 594.0, 603.0, 593.0, 600.0, 600.0, 950.0, "yfinance", "etf", "QQQ", "close", "", "2026-04-21T16:00:00Z"),
                    ("QQQ", "2026-04-24", 611.0, 616.0, 610.0, 615.0, 615.0, 1200.0, "yfinance", "etf", "QQQ", "close", "", "2026-04-24T16:00:00Z"),
                ],
            )
        _FRAME_CACHE.clear()
        os.environ["TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS"] = "2"

        frame = _read_market_lake_frame("QQQ", "2026-04-01", "2026-04-24")
        rendered = _render_stock_csv("QQQ", "2026-04-01", "2026-04-24", frame)

        self.assertIn("# Total records available: 5", rendered)
        self.assertIn("# Records returned: 2 latest rows", rendered)
        self.assertIn("# Latest close: 615.0000 on 2026-04-24", rendered)
        self.assertNotIn("2026-04-20,590", rendered)
        self.assertIn("2026-04-23,608", rendered)
        self.assertIn("2026-04-24,611", rendered)

    def test_indicator_lookback_days_are_capped_for_llm_tool_calls(self) -> None:
        os.environ["TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS"] = "7"

        self.assertEqual(_normalize_indicator_lookback_days(30), 7)
        self.assertEqual(_normalize_indicator_lookback_days(0), 1)
        self.assertEqual(_normalize_indicator_lookback_days("bad"), 7)

    def test_cached_vendor_wrapper_reuses_fresh_result(self) -> None:
        call_counter = {"count": 0}

        def fake_news(ticker, start_date, end_date):
            call_counter["count"] += 1
            return f"news:{ticker}:{start_date}:{end_date}:{call_counter['count']}"

        wrapped = _wrap_cached_vendor_method("get_news", fake_news)

        first = wrapped("QQQ", "2026-04-20", "2026-04-24")
        second = wrapped("QQQ", "2026-04-20", "2026-04-24")

        self.assertEqual(first, second)
        self.assertEqual(call_counter["count"], 1)

    def test_cached_vendor_wrapper_falls_back_to_stale_result_on_error(self) -> None:
        seed_counter = {"count": 0}

        def seed_news(ticker, start_date, end_date):
            seed_counter["count"] += 1
            return f"seed:{ticker}:{seed_counter['count']}"

        seeded_wrapper = _wrap_cached_vendor_method("get_news", seed_news)
        seeded_result = seeded_wrapper("QQQ", "2026-04-20", "2026-04-24")
        self.assertEqual(seed_counter["count"], 1)
        _METHOD_RESULT_CACHE.clear()

        def failing_news(ticker, start_date, end_date):
            return "Error fetching news for QQQ: rate limited"

        fallback_wrapper = _wrap_cached_vendor_method("get_news", failing_news)
        fallback_result = fallback_wrapper("QQQ", "2026-04-20", "2026-04-24")

        self.assertEqual(fallback_result, seeded_result)


if __name__ == "__main__":
    unittest.main()
