#!/usr/bin/env python3
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from core_data_ingestion import DailyPriceRecord, rebind_runtime_paths, resolve_portfolio_root
from tradingagents_market_lake_refresh import inspect_symbol_freshness, refresh_symbols, summarize_status


class TradingAgentsMarketLakeRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="tradingagents-market-lake-refresh-")
        self.portfolio_root = Path(self.temp_dir.name)
        (self.portfolio_root / "state-manifest.json").write_text(
            '{"canonical_entrypoints": {}}\n',
            encoding="utf-8",
        )
        rebind_runtime_paths(self.portfolio_root)
        self.db_path = self.portfolio_root / "market_lake.db"
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
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (symbol, date)
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
                        "2026-04-23",
                        600.0,
                        610.0,
                        598.0,
                        608.0,
                        608.0,
                        1000.0,
                        "yfinance",
                        "global_market",
                        "QQQ",
                        "yfinance",
                        "tradingagents",
                        "2026-04-23T16:00:00Z",
                    ),
                    (
                        "KWEB",
                        "2026-04-10",
                        28.0,
                        29.0,
                        27.5,
                        28.7,
                        28.7,
                        2000.0,
                        "yfinance",
                        "global_market",
                        "KWEB",
                        "yfinance",
                        "tradingagents",
                        "2026-04-10T16:00:00Z",
                    ),
                ],
            )

    def tearDown(self) -> None:
        rebind_runtime_paths(resolve_portfolio_root())
        self.temp_dir.cleanup()

    def test_inspect_symbol_freshness_marks_fresh_stale_and_missing(self) -> None:
        freshness = inspect_symbol_freshness(
            self.db_path,
            ["QQQ", "KWEB", "SOXX"],
            "2026-04-24",
            4,
        )
        summary = summarize_status(freshness)
        self.assertEqual(summary["fresh"], ["QQQ"])
        self.assertEqual(summary["stale"], ["KWEB"])
        self.assertEqual(summary["missing"], ["SOXX"])

    def test_refresh_symbols_prefers_akshare_us_daily_before_yahoo(self) -> None:
        def fake_akshare_records(spec: dict, period: str) -> list[DailyPriceRecord]:
            self.assertEqual(spec["symbol"], "ASHR")
            self.assertEqual(period, "10y")
            return [
                DailyPriceRecord(
                    symbol="ASHR",
                    date="2026-04-24",
                    open=34.8,
                    high=34.9,
                    low=34.7,
                    close=34.89,
                    adj_close=34.89,
                    volume=3428317,
                    provider="akshare",
                    asset_type="global_market",
                    name="ASHR",
                    close_source="akshare_stock_us_daily",
                    source_tags="tradingagents,decision_cycle",
                )
            ]

        with (
            patch(
                "tradingagents_market_lake_refresh.build_akshare_us_daily_records",
                side_effect=fake_akshare_records,
                create=True,
            ),
            patch(
                "tradingagents_market_lake_refresh.build_yfinance_records",
                side_effect=AssertionError("yfinance should not be called when AkShare succeeds"),
            ),
        ):
            result = refresh_symbols(self.db_path, ["ASHR"], "10y")

        self.assertEqual(result["successCount"], 1)
        self.assertEqual(result["errorCount"], 0)
        with sqlite3.connect(self.db_path) as connection:
            row = connection.execute(
                "SELECT provider, close_source, close FROM daily_prices WHERE symbol = ? AND date = ?",
                ("ASHR", "2026-04-24"),
            ).fetchone()
        self.assertEqual(row, ("akshare", "akshare_stock_us_daily", 34.89))

    def test_refresh_symbols_falls_back_to_yfinance_when_akshare_fails(self) -> None:
        def fake_yfinance_records(spec: dict, period: str) -> list[DailyPriceRecord]:
            self.assertEqual(spec["symbol"], "ARKK")
            self.assertEqual(period, "10y")
            return [
                DailyPriceRecord(
                    symbol="ARKK",
                    date="2026-04-24",
                    open=77.5,
                    high=77.56,
                    low=76.16,
                    close=76.5,
                    adj_close=76.5,
                    volume=7711461,
                    provider="yfinance",
                    asset_type="global_market",
                    name="ARKK",
                    close_source="yfinance",
                    source_tags="tradingagents,decision_cycle",
                )
            ]

        with (
            patch(
                "tradingagents_market_lake_refresh.build_akshare_us_daily_records",
                side_effect=RuntimeError("akshare unavailable"),
                create=True,
            ),
            patch(
                "tradingagents_market_lake_refresh.build_yfinance_records",
                side_effect=fake_yfinance_records,
            ),
        ):
            result = refresh_symbols(self.db_path, ["ARKK"], "10y")

        self.assertEqual(result["successCount"], 1)
        self.assertEqual(result["errorCount"], 0)
        self.assertIn("akshare unavailable", result["successes"][0]["logs"])
        with sqlite3.connect(self.db_path) as connection:
            row = connection.execute(
                "SELECT provider, close_source, close FROM daily_prices WHERE symbol = ? AND date = ?",
                ("ARKK", "2026-04-24"),
            ).fetchone()
        self.assertEqual(row, ("yfinance", "yfinance", 76.5))


if __name__ == "__main__":
    unittest.main()
