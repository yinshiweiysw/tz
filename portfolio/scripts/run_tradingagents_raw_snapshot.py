#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import time
from contextlib import suppress
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

EXTERNAL_REPO = Path(os.environ.get("TRADINGAGENTS_REPO", "/Users/yinshiwei/codex/external/TradingAgents"))
if str(EXTERNAL_REPO) not in sys.path:
    sys.path.insert(0, str(EXTERNAL_REPO))

from tradingagents_market_lake_patch import install_market_lake_fallback

install_market_lake_fallback()

import openai
import httpx

from openai import DefaultHttpxClient
from tradingagents.default_config import DEFAULT_CONFIG  # type: ignore
from tradingagents.graph.trading_graph import TradingAgentsGraph  # type: ignore
import tradingagents.llm_clients.openai_client as tradingagents_openai_client  # type: ignore
from tradingagents.llm_clients.openai_client import NormalizedChatOpenAI  # type: ignore

PROVIDER_ENV_VARS = {
    "openai": "OPENAI_API_KEY",
    "google": "GOOGLE_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "xai": "XAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
    "glm": "ZHIPU_API_KEY"
}
PROVIDER_KEY_POOL_MAX_NUMBERED_KEYS = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run TradingAgents and emit a raw suggestion snapshot.")
    parser.add_argument("--symbols", required=True, help="Comma-separated proxy symbols, e.g. QQQ,SOXX")
    parser.add_argument("--trade-date", required=True, help="Trade date in YYYY-MM-DD")
    parser.add_argument("--provider", default="glm")
    parser.add_argument("--deep-model", default="glm-5.1")
    parser.add_argument("--quick-model", default="glm-5")
    parser.add_argument("--selected-analysts", default="market,social,news,fundamentals")
    parser.add_argument("--output-language", default="Chinese")
    parser.add_argument("--output", default="-", help="Output path or '-' for stdout")
    parser.add_argument("--backend-url", default="https://api.z.ai/api/paas/v4/")
    parser.add_argument("--request-timeout-seconds", type=float, default=45.0)
    parser.add_argument("--request-max-retries", type=int, default=2)
    parser.add_argument("--max-tokens", type=int, default=1200)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--thinking-type", default="disabled")
    parser.add_argument("--market-data-tool-max-rows", type=int, default=120)
    parser.add_argument("--indicator-tool-max-lookback-days", type=int, default=30)
    parser.add_argument("--invoke-max-attempts", type=int, default=3)
    parser.add_argument("--invoke-backoff-seconds", type=float, default=8.0)
    parser.add_argument("--invoke-max-backoff-seconds", type=float, default=45.0)
    parser.add_argument("--invoke-interval-seconds", type=float, default=2.0)
    parser.add_argument("--symbol-max-attempts", type=int, default=2)
    parser.add_argument("--symbol-backoff-seconds", type=float, default=20.0)
    parser.add_argument("--symbol-max-backoff-seconds", type=float, default=90.0)
    parser.add_argument("--symbol-interval-seconds", type=float, default=5.0)
    parser.add_argument("--symbol-cache-ttl-hours", type=float, default=18.0)
    parser.add_argument("--allow-stale-symbol-cache-on-error", type=int, default=1)
    return parser.parse_args()


def _split_key_pool(raw_value: str) -> list[str]:
    return [
        item.strip()
        for item in re.split(r"[,;\n]+", str(raw_value or ""))
        if item.strip()
    ]


def resolve_provider_api_keys(provider: str) -> list[str]:
    env_name = PROVIDER_ENV_VARS.get(provider.lower())
    if not env_name:
        return []

    keys = []
    for value in [
        os.environ.get(env_name),
        *[
            os.environ.get(f"{env_name}_{index}")
            for index in range(2, PROVIDER_KEY_POOL_MAX_NUMBERED_KEYS + 1)
        ],
        os.environ.get(f"{env_name}_POOL"),
    ]:
        for item in _split_key_pool(value or ""):
            if item not in keys:
                keys.append(item)
    return keys


def ensure_provider_key(provider: str) -> None:
    env_name = PROVIDER_ENV_VARS.get(provider.lower())
    if env_name and not resolve_provider_api_keys(provider):
        raise SystemExit(f"Missing required API key: {env_name}")


def clamp_non_negative_float(value: float, fallback: float) -> float:
    numeric = float(value)
    if numeric < 0:
        return float(fallback)
    return numeric


def clamp_positive_int(value: int, fallback: int) -> int:
    numeric = int(value)
    if numeric < 1:
        return int(fallback)
    return numeric


def parse_selected_analysts(value: str) -> list[str]:
    analysts = [
        item.strip().lower()
        for item in str(value or "").split(",")
        if item.strip()
    ]
    return analysts or ["market", "social", "news", "fundamentals"]


def is_rate_limited_error(error: Exception) -> bool:
    text = str(error)
    return isinstance(error, openai.RateLimitError) or bool(
        re.search(r"RateLimitError|Rate limit reached|Error code:\s*429|code['\"]?:\s*['\"]?1302", text, re.I)
    )


def is_connectionish_error(error: Exception) -> bool:
    text = str(error)
    return isinstance(error, (openai.APIConnectionError, openai.APITimeoutError, TimeoutError)) or bool(
        re.search(
            r"APIConnectionError|APITimeoutError|ReadTimeout|timed out|RemoteProtocolError|Connection error",
            text,
            re.I,
        )
    )


def is_transient_provider_error(error: Exception) -> bool:
    return is_rate_limited_error(error) or is_connectionish_error(error)


def compute_backoff_seconds(base_seconds: float, max_seconds: float, attempt_index: int) -> float:
    return min(max_seconds, max(0.0, base_seconds) * (2 ** max(0, attempt_index - 1)))


def _slugify(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(text or "").strip()) or "unknown"


def resolve_symbol_cache_root() -> Path:
    explicit = str(os.environ.get("TRADINGAGENTS_SYMBOL_CACHE_DIR", "")).strip()
    if explicit:
        return Path(explicit).expanduser()

    portfolio_root = str(os.environ.get("PORTFOLIO_ROOT", "")).strip()
    if portfolio_root:
        return Path(portfolio_root).expanduser() / "data" / "tradingagents_symbol_cache"

    script_root = Path(__file__).resolve().parent
    workspace_root = script_root.parent.parent
    return workspace_root / "portfolio" / "data" / "tradingagents_symbol_cache"


def build_symbol_cache_path(args: argparse.Namespace, symbol: str) -> Path:
    root = resolve_symbol_cache_root()
    provider = _slugify(args.provider)
    deep_model = _slugify(args.deep_model)
    quick_model = _slugify(args.quick_model)
    trade_date = _slugify(args.trade_date)
    return root / trade_date / provider / deep_model / quick_model / f"{_slugify(symbol)}.json"


def _parse_iso_datetime(value: str):
    text = str(value or "").strip()
    if not text:
        return None
    with suppress(ValueError):
        if text.endswith("Z"):
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        return datetime.fromisoformat(text)
    return None


def _compute_age_hours(value: str):
    dt = _parse_iso_datetime(value)
    if dt is None:
        return None
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0.0, (now - dt.astimezone(timezone.utc)).total_seconds() / 3600.0)


def load_cached_symbol_call(args: argparse.Namespace, symbol: str, allow_stale: bool = False):
    path = build_symbol_cache_path(args, symbol)
    if not path.exists():
        return None

    with suppress(json.JSONDecodeError, OSError):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if str(payload.get("asOf", "")).strip() != args.trade_date:
            return None
        age_hours = _compute_age_hours(payload.get("generatedAt"))
        ttl_hours = clamp_non_negative_float(args.symbol_cache_ttl_hours, 18.0)
        if not allow_stale and age_hours is not None and age_hours > ttl_hours:
            return None
        call = payload.get("call")
        if not isinstance(call, dict) or not call:
            return None
        return {
            "path": path,
            "payload": payload,
            "call": call,
            "ageHours": age_hours,
        }
    return None


def persist_symbol_call_cache(args: argparse.Namespace, symbol: str, call_payload: dict) -> Path:
    path = build_symbol_cache_path(args, symbol)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "asOf": args.trade_date,
        "provider": args.provider,
        "deepModel": args.deep_model,
        "quickModel": args.quick_model,
        "symbol": symbol,
        "call": call_payload,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def enrich_call_with_cache_metadata(call_payload: dict, cache_status: str, cache_age_hours=None, provider_error: str = None):
    runtime = dict(call_payload.get("runtimeDiagnostics") or {})
    runtime["cacheStatus"] = cache_status
    if cache_age_hours is not None:
        runtime["cacheAgeHours"] = round(float(cache_age_hours), 2)
    if provider_error:
        runtime["providerError"] = str(provider_error).strip()[:240]

    next_call = dict(call_payload)
    next_call["runtimeDiagnostics"] = runtime
    return next_call


def build_stable_http_client(args: argparse.Namespace):
    timeout_seconds = clamp_non_negative_float(args.request_timeout_seconds, 90.0)
    return DefaultHttpxClient(
        timeout=timeout_seconds,
        follow_redirects=True,
        trust_env=False,
        limits=httpx.Limits(max_connections=1, max_keepalive_connections=0, keepalive_expiry=0.0),
        transport=httpx.HTTPTransport(retries=0),
    )


def install_llm_runtime_patch(args: argparse.Namespace) -> None:
    original_get_provider_kwargs = TradingAgentsGraph._get_provider_kwargs
    original_invoke = NormalizedChatOpenAI.invoke
    stable_http_client = build_stable_http_client(args)
    passthrough = tuple(getattr(tradingagents_openai_client, "_PASSTHROUGH_KWARGS", ()))
    for key in ("max_tokens", "temperature", "extra_body"):
        if key not in passthrough:
            passthrough = (*passthrough, key)
    tradingagents_openai_client._PASSTHROUGH_KWARGS = passthrough

    def patched_get_provider_kwargs(self):
        kwargs = original_get_provider_kwargs(self)
        kwargs["timeout"] = clamp_non_negative_float(args.request_timeout_seconds, 90.0)
        kwargs["max_retries"] = max(0, int(args.request_max_retries))
        kwargs["http_client"] = stable_http_client
        kwargs["max_tokens"] = clamp_positive_int(args.max_tokens, 1200)
        kwargs["temperature"] = clamp_non_negative_float(args.temperature, 0.2)
        if str(args.provider).strip().lower() == "deepseek":
            thinking_type = str(args.thinking_type or "disabled").strip().lower()
            if thinking_type in ("disabled", "enabled"):
                kwargs["extra_body"] = {
                    "thinking": {
                        "type": thinking_type
                    }
                }
        return kwargs

    def patched_invoke(self, input, config=None, **kwargs):
        max_attempts = clamp_positive_int(args.invoke_max_attempts, 3)
        for attempt in range(1, max_attempts + 1):
            try:
                response = original_invoke(self, input, config, **kwargs)
                interval_seconds = clamp_non_negative_float(args.invoke_interval_seconds, 2.0)
                if interval_seconds > 0:
                    time.sleep(interval_seconds)
                return response
            except Exception as error:
                if attempt >= max_attempts or not is_transient_provider_error(error):
                    raise
                sleep_seconds = compute_backoff_seconds(
                    clamp_non_negative_float(args.invoke_backoff_seconds, 8.0),
                    clamp_non_negative_float(args.invoke_max_backoff_seconds, 45.0),
                    attempt,
                )
                print(
                    (
                        f"[tradingagents] transient llm error on attempt {attempt}/{max_attempts}: "
                        f"{type(error).__name__}: {str(error).strip()[:180]} ; retrying in {sleep_seconds:.1f}s"
                    ),
                    file=sys.stderr,
                )
                time.sleep(sleep_seconds)

    TradingAgentsGraph._get_provider_kwargs = patched_get_provider_kwargs
    NormalizedChatOpenAI.invoke = patched_invoke


def install_tool_runtime_limits(args: argparse.Namespace) -> None:
    os.environ["TRADINGAGENTS_MARKET_DATA_TOOL_MAX_ROWS"] = str(
        clamp_positive_int(args.market_data_tool_max_rows, 120)
    )
    os.environ["TRADINGAGENTS_INDICATOR_TOOL_MAX_LOOKBACK_DAYS"] = str(
        clamp_positive_int(args.indicator_tool_max_lookback_days, 30)
    )


def build_graph(args: argparse.Namespace) -> TradingAgentsGraph:
    config = deepcopy(DEFAULT_CONFIG)
    config["llm_provider"] = args.provider
    config["deep_think_llm"] = args.deep_model
    config["quick_think_llm"] = args.quick_model
    config["backend_url"] = args.backend_url
    config["output_language"] = args.output_language
    config["request_timeout_seconds"] = clamp_non_negative_float(args.request_timeout_seconds, 45.0)
    config["request_max_retries"] = max(0, int(args.request_max_retries))
    return TradingAgentsGraph(debug=False, config=config, selected_analysts=parse_selected_analysts(args.selected_analysts))


def with_provider_api_key(provider: str, api_key: str, func):
    env_name = PROVIDER_ENV_VARS.get(provider.lower())
    if not env_name:
        return func()

    previous = os.environ.get(env_name)
    os.environ[env_name] = api_key
    try:
        return func()
    finally:
        if previous is None:
            os.environ.pop(env_name, None)
        else:
            os.environ[env_name] = previous


def propagate_with_retries(graph: TradingAgentsGraph, symbol: str, trade_date: str, args: argparse.Namespace):
    max_attempts = clamp_positive_int(args.symbol_max_attempts, 2)

    for attempt in range(1, max_attempts + 1):
        try:
            final_state, rating = graph.propagate(symbol, trade_date)
            return final_state, rating, attempt
        except Exception as error:
            if attempt >= max_attempts or not is_transient_provider_error(error):
                raise
            sleep_seconds = compute_backoff_seconds(
                clamp_non_negative_float(args.symbol_backoff_seconds, 20.0),
                clamp_non_negative_float(args.symbol_max_backoff_seconds, 90.0),
                attempt,
            )
            print(
                (
                    f"[tradingagents] transient symbol failure for {symbol} attempt {attempt}/{max_attempts}: "
                    f"{type(error).__name__}: {str(error).strip()[:180]} ; retrying full symbol in {sleep_seconds:.1f}s"
                ),
                file=sys.stderr,
            )
            time.sleep(sleep_seconds)

    raise RuntimeError(f"unreachable symbol retry loop for {symbol}")


def propagate_with_provider_key_pool(symbol: str, trade_date: str, args: argparse.Namespace, api_keys: list[str]):
    if not api_keys:
        raise RuntimeError(f"Missing required API key: {PROVIDER_ENV_VARS.get(args.provider.lower(), args.provider)}")

    last_error = None
    key_count = len(api_keys)
    for key_index, api_key in enumerate(api_keys, start=1):
        try:
            def run_current_key():
                graph = build_graph(args)
                return propagate_with_retries(graph, symbol, trade_date, args)

            final_state, rating, symbol_attempts = with_provider_api_key(args.provider, api_key, run_current_key)
            return final_state, rating, symbol_attempts, key_index, key_count
        except Exception as error:
            last_error = error
            if is_transient_provider_error(error) and key_index < key_count:
                print(
                    (
                        f"[tradingagents] transient provider failure for {args.provider} "
                        f"key {key_index}/{key_count}; trying next configured key"
                    ),
                    file=sys.stderr,
                )
                continue
            raise

    raise last_error or RuntimeError("provider key pool exhausted")


def main() -> int:
    args = parse_args()
    ensure_provider_key(args.provider)
    install_tool_runtime_limits(args)
    install_llm_runtime_patch(args)
    provider_api_keys = resolve_provider_api_keys(args.provider)
    symbols = [item.strip().upper() for item in args.symbols.split(",") if item.strip()]

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "asOf": args.trade_date,
        "mode": "live",
        "source": "TradingAgents",
        "provider": args.provider,
        "runtimeConfig": {
            "requestTimeoutSeconds": clamp_non_negative_float(args.request_timeout_seconds, 45.0),
            "requestMaxRetries": max(0, int(args.request_max_retries)),
            "selectedAnalysts": parse_selected_analysts(args.selected_analysts),
            "maxTokens": clamp_positive_int(args.max_tokens, 1200),
            "temperature": clamp_non_negative_float(args.temperature, 0.2),
            "thinkingType": str(args.thinking_type or "disabled").strip(),
            "marketDataToolMaxRows": clamp_positive_int(args.market_data_tool_max_rows, 120),
            "indicatorToolMaxLookbackDays": clamp_positive_int(args.indicator_tool_max_lookback_days, 30),
            "httpTransportProfile": "stable_http1_single_connection_no_keepalive",
            "invokeMaxAttempts": clamp_positive_int(args.invoke_max_attempts, 3),
            "invokeBackoffSeconds": clamp_non_negative_float(args.invoke_backoff_seconds, 8.0),
            "invokeMaxBackoffSeconds": clamp_non_negative_float(args.invoke_max_backoff_seconds, 45.0),
            "invokeIntervalSeconds": clamp_non_negative_float(args.invoke_interval_seconds, 2.0),
            "symbolMaxAttempts": clamp_positive_int(args.symbol_max_attempts, 2),
            "symbolBackoffSeconds": clamp_non_negative_float(args.symbol_backoff_seconds, 20.0),
            "symbolMaxBackoffSeconds": clamp_non_negative_float(args.symbol_max_backoff_seconds, 90.0),
            "symbolIntervalSeconds": clamp_non_negative_float(args.symbol_interval_seconds, 5.0),
        },
        "calls": []
    }
    payload["runtimeDiagnostics"] = {
        "cacheHits": 0,
        "cacheFallbacks": 0,
        "liveRuns": 0,
        "providerKeyCount": len(provider_api_keys),
        "symbolCacheTtlHours": clamp_non_negative_float(args.symbol_cache_ttl_hours, 18.0),
        "allowStaleSymbolCacheOnError": bool(int(args.allow_stale_symbol_cache_on_error)),
    }

    for index, symbol in enumerate(symbols):
        fresh_cached = load_cached_symbol_call(args, symbol, allow_stale=False)
        if fresh_cached:
            payload["runtimeDiagnostics"]["cacheHits"] += 1
            payload["calls"].append(
                enrich_call_with_cache_metadata(
                    fresh_cached["call"],
                    cache_status="hit",
                    cache_age_hours=fresh_cached.get("ageHours"),
                )
            )
        else:
            try:
                final_state, rating, symbol_attempts, provider_key_index, provider_key_count = (
                    propagate_with_provider_key_pool(symbol, args.trade_date, args, provider_api_keys)
                )
                call_payload = {
                    "symbol": symbol,
                    "rating": str(rating).strip().upper(),
                    "confidence": 0.5,
                    "confidenceSource": "tradingagents_rating_default",
                    "thesis": str(final_state.get("final_trade_decision", "")).strip(),
                    "risks": [
                        item
                        for item in [
                            str(final_state.get("risk_debate_state", {}).get("judge_decision", "")).strip()
                        ]
                        if item
                    ],
                    "riskJudge": str(final_state.get("risk_debate_state", {}).get("judge_decision", "")).strip(),
                    "investmentJudge": str(
                        final_state.get("investment_debate_state", {}).get("judge_decision", "")
                    ).strip(),
                    "decisionText": str(final_state.get("final_trade_decision", "")).strip(),
                    "marketReport": str(final_state.get("market_report", "")).strip(),
                    "newsReport": str(final_state.get("news_report", "")).strip(),
                    "fundamentalsReport": str(final_state.get("fundamentals_report", "")).strip(),
                    "sentimentReport": str(final_state.get("sentiment_report", "")).strip(),
                    "runtimeDiagnostics": {
                        "symbolAttempts": symbol_attempts,
                        "providerKeyIndex": provider_key_index,
                        "providerKeyCount": provider_key_count,
                        "cacheStatus": "miss_live_generated",
                    }
                }
                persist_symbol_call_cache(args, symbol, call_payload)
                payload["runtimeDiagnostics"]["liveRuns"] += 1
                payload["calls"].append(call_payload)
            except Exception as error:
                if bool(int(args.allow_stale_symbol_cache_on_error)):
                    stale_cached = load_cached_symbol_call(args, symbol, allow_stale=True)
                    if stale_cached:
                        print(
                            (
                                f"[tradingagents] reusing cached symbol snapshot for {symbol} after live failure: "
                                f"{type(error).__name__}: {str(error).strip()[:180]}"
                            ),
                            file=sys.stderr,
                        )
                        payload["runtimeDiagnostics"]["cacheFallbacks"] += 1
                        payload["calls"].append(
                            enrich_call_with_cache_metadata(
                                stale_cached["call"],
                                cache_status="stale_fallback_on_error",
                                cache_age_hours=stale_cached.get("ageHours"),
                                provider_error=str(error),
                            )
                        )
                        continue
                raise
        if index < len(symbols) - 1:
            interval_seconds = clamp_non_negative_float(args.symbol_interval_seconds, 5.0)
            if interval_seconds > 0:
                time.sleep(interval_seconds)

    raw = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output == "-":
        sys.stdout.write(raw + "\n")
    else:
        Path(args.output).write_text(raw + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
