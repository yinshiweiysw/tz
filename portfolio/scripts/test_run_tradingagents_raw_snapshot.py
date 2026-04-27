#!/usr/bin/env python3
import argparse
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_tradingagents_raw_snapshot import (
    build_symbol_cache_path,
    enrich_call_with_cache_metadata,
    install_llm_runtime_patch,
    install_tool_runtime_limits,
    load_cached_symbol_call,
    parse_selected_analysts,
    persist_symbol_call_cache,
    resolve_provider_api_keys,
    TradingAgentsGraph,
    with_provider_api_key,
    tradingagents_openai_client,
)


def make_args(**overrides):
    base = {
        "provider": "glm",
        "deep_model": "glm-5.1",
        "quick_model": "glm-5",
        "selected_analysts": "market,social,news,fundamentals",
        "trade_date": "2026-04-24",
        "symbol_cache_ttl_hours": 18.0,
        "market_data_tool_max_rows": 120,
        "indicator_tool_max_lookback_days": 30,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


class TradingAgentsRawSnapshotCacheTests(unittest.TestCase):
    def tearDown(self):
        TradingAgentsGraph._get_provider_kwargs = getattr(self, "_original_get_provider_kwargs", TradingAgentsGraph._get_provider_kwargs)

    def test_symbol_cache_round_trip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            original_portfolio_root = os.environ.get("PORTFOLIO_ROOT")
            try:
                os.environ["PORTFOLIO_ROOT"] = tmpdir
                args = make_args()
                call_payload = {
                    "symbol": "QQQ",
                    "rating": "BUY",
                    "runtimeDiagnostics": {
                        "symbolAttempts": 1
                    }
                }

                cache_path = persist_symbol_call_cache(args, "QQQ", call_payload)
                cached = load_cached_symbol_call(args, "QQQ", allow_stale=False)

                self.assertEqual(cache_path, build_symbol_cache_path(args, "QQQ"))
                self.assertIsNotNone(cached)
                self.assertEqual(cached["call"]["symbol"], "QQQ")
                self.assertEqual(cached["call"]["rating"], "BUY")
                self.assertTrue(Path(cache_path).exists())
            finally:
                if original_portfolio_root is None:
                    os.environ.pop("PORTFOLIO_ROOT", None)
                else:
                    os.environ["PORTFOLIO_ROOT"] = original_portfolio_root

    def test_stale_symbol_cache_can_be_used_only_when_allowed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            original_portfolio_root = os.environ.get("PORTFOLIO_ROOT")
            try:
                os.environ["PORTFOLIO_ROOT"] = tmpdir
                args = make_args(symbol_cache_ttl_hours=1.0)
                cache_path = build_symbol_cache_path(args, "QQQ")
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                payload = {
                    "generatedAt": (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat(),
                    "asOf": "2026-04-24",
                    "provider": "glm",
                    "deepModel": "glm-5.1",
                    "quickModel": "glm-5",
                    "symbol": "QQQ",
                    "call": {
                        "symbol": "QQQ",
                        "rating": "HOLD",
                    },
                }
                cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

                fresh_only = load_cached_symbol_call(args, "QQQ", allow_stale=False)
                stale_allowed = load_cached_symbol_call(args, "QQQ", allow_stale=True)

                self.assertIsNone(fresh_only)
                self.assertIsNotNone(stale_allowed)
                self.assertEqual(stale_allowed["call"]["rating"], "HOLD")
            finally:
                if original_portfolio_root is None:
                    os.environ.pop("PORTFOLIO_ROOT", None)
                else:
                    os.environ["PORTFOLIO_ROOT"] = original_portfolio_root

    def test_enrich_call_with_cache_metadata_preserves_existing_runtime_fields(self):
        enriched = enrich_call_with_cache_metadata(
            {
                "symbol": "QQQ",
                "runtimeDiagnostics": {
                    "symbolAttempts": 2
                },
            },
            cache_status="stale_fallback_on_error",
            cache_age_hours=3.25,
            provider_error="provider_rate_limited:glm",
        )

        self.assertEqual(enriched["runtimeDiagnostics"]["symbolAttempts"], 2)
        self.assertEqual(enriched["runtimeDiagnostics"]["cacheStatus"], "stale_fallback_on_error")
        self.assertEqual(enriched["runtimeDiagnostics"]["cacheAgeHours"], 3.25)
        self.assertEqual(enriched["runtimeDiagnostics"]["providerError"], "provider_rate_limited:glm")

    def test_llm_runtime_patch_forwards_output_controls_to_openai_client(self):
        self._original_get_provider_kwargs = TradingAgentsGraph._get_provider_kwargs
        TradingAgentsGraph._get_provider_kwargs = lambda self: {}
        args = make_args(
            request_timeout_seconds=12.0,
            request_max_retries=0,
            max_tokens=789,
            temperature=0.15,
            thinking_type="disabled",
            invoke_max_attempts=1,
            invoke_backoff_seconds=0,
            invoke_max_backoff_seconds=0,
            invoke_interval_seconds=0,
        )

        install_llm_runtime_patch(args)
        kwargs = TradingAgentsGraph._get_provider_kwargs(object())

        self.assertEqual(kwargs["max_tokens"], 789)
        self.assertEqual(kwargs["temperature"], 0.15)
        self.assertIn("max_tokens", tradingagents_openai_client._PASSTHROUGH_KWARGS)
        self.assertIn("temperature", tradingagents_openai_client._PASSTHROUGH_KWARGS)
        self.assertIn("extra_body", tradingagents_openai_client._PASSTHROUGH_KWARGS)

    def test_llm_runtime_patch_adds_deepseek_thinking_control(self):
        self._original_get_provider_kwargs = TradingAgentsGraph._get_provider_kwargs
        TradingAgentsGraph._get_provider_kwargs = lambda self: {}
        args = make_args(
            provider="deepseek",
            request_timeout_seconds=12.0,
            request_max_retries=0,
            max_tokens=789,
            temperature=0.15,
            thinking_type="disabled",
            invoke_max_attempts=1,
            invoke_backoff_seconds=0,
            invoke_max_backoff_seconds=0,
            invoke_interval_seconds=0,
        )

        install_llm_runtime_patch(args)
        kwargs = TradingAgentsGraph._get_provider_kwargs(object())

        self.assertEqual(kwargs["extra_body"], {"thinking": {"type": "disabled"}})

    def test_tool_runtime_limits_are_exposed_as_env_controls(self):
        previous_rows = os.environ.get("TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS")
        previous_lookback = os.environ.get("TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS")
        try:
            install_tool_runtime_limits(
                make_args(
                    market_data_tool_max_rows=88,
                    indicator_tool_max_lookback_days=12,
                )
            )

            self.assertEqual(os.environ["TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS"], "88")
            self.assertEqual(os.environ["TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS"], "12")
        finally:
            if previous_rows is None:
                os.environ.pop("TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS", None)
            else:
                os.environ["TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS"] = previous_rows
            if previous_lookback is None:
                os.environ.pop("TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS", None)
            else:
                os.environ["TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS"] = previous_lookback

    def test_parse_selected_analysts_defaults_and_normalizes(self):
        self.assertEqual(parse_selected_analysts("market, NEWS,market"), ["market", "news", "market"])
        self.assertEqual(parse_selected_analysts(""), ["market", "social", "news", "fundamentals"])

    def test_resolve_provider_api_keys_reads_primary_numbered_and_pool_without_duplicates(self):
        previous = {
            key: os.environ.get(key)
            for key in ["ZHIPU_API_KEY", "ZHIPU_API_KEY_2", "ZHIPU_API_KEY_3", "ZHIPU_API_KEY_POOL"]
        }
        try:
            os.environ["ZHIPU_API_KEY"] = "primary"
            os.environ["ZHIPU_API_KEY_2"] = "secondary"
            os.environ["ZHIPU_API_KEY_3"] = ""
            os.environ["ZHIPU_API_KEY_POOL"] = "secondary, tertiary;quaternary\nprimary"

            self.assertEqual(
                resolve_provider_api_keys("glm"),
                ["primary", "secondary", "tertiary", "quaternary"],
            )
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_with_provider_api_key_restores_primary_env(self):
        previous = os.environ.get("ZHIPU_API_KEY")
        try:
            os.environ["ZHIPU_API_KEY"] = "primary"

            seen = with_provider_api_key("glm", "secondary", lambda: os.environ.get("ZHIPU_API_KEY"))

            self.assertEqual(seen, "secondary")
            self.assertEqual(os.environ.get("ZHIPU_API_KEY"), "primary")
        finally:
            if previous is None:
                os.environ.pop("ZHIPU_API_KEY", None)
            else:
                os.environ["ZHIPU_API_KEY"] = previous


if __name__ == "__main__":
    unittest.main()
