#!/usr/bin/env python3
import argparse
import json
import os
import re
import signal
import sys
import time
import traceback
from contextlib import suppress
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

EXTERNAL_REPO = Path(os.environ.get("TRADINGAGENTS_REPO", "/Users/yinshiwei/codex/external/TradingAgents"))
if str(EXTERNAL_REPO) not in sys.path:
    sys.path.insert(0, str(EXTERNAL_REPO))

os.environ.setdefault("LANGCHAIN_OPENAI_TCP_KEEPALIVE", "0")

from tradingagents_market_lake_patch import install_market_lake_fallback

install_market_lake_fallback()

import openai
import httpx

from openai import DefaultHttpxClient
from tradingagents.default_config import DEFAULT_CONFIG  # type: ignore
from tradingagents.graph.trading_graph import TradingAgentsGraph  # type: ignore
from tradingagents.agents.utils.agent_utils import get_indicators, get_stock_data  # type: ignore
import tradingagents.llm_clients.validators as tradingagents_model_validators  # type: ignore
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
LOCAL_PROVIDER_MODEL_COMPAT = {
    "deepseek": ["deepseek-v4-pro"],
}


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
    parser.add_argument("--symbol-wall-timeout-seconds", type=float, default=0.0)
    parser.add_argument("--max-debate-rounds", type=int, default=1)
    parser.add_argument("--max-risk-discuss-rounds", type=int, default=1)
    parser.add_argument("--max-recur-limit", type=int, default=100)
    parser.add_argument("--diagnostics-dir", default="")
    parser.add_argument("--brain-profile", default="full", choices=["full", "fast"])
    parser.add_argument("--fast-context-max-chars", type=int, default=12000)
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


def clamp_non_negative_int(value: int, fallback: int) -> int:
    numeric = int(value)
    if numeric < 0:
        return int(fallback)
    return numeric


def parse_selected_analysts(value: str) -> list[str]:
    analysts = [
        item.strip().lower()
        for item in str(value or "").split(",")
        if item.strip()
    ]
    return analysts or ["market", "social", "news", "fundamentals"]


def normalize_brain_profile(value: str) -> str:
    text = str(value or "").strip().lower()
    return text if text in ("fast", "full") else "full"


def install_local_model_catalog_compat() -> None:
    """Accept newer provider model IDs before the external repo catalog catches up."""
    valid_models = getattr(tradingagents_model_validators, "VALID_MODELS", {})
    for provider, models in LOCAL_PROVIDER_MODEL_COMPAT.items():
        current = list(valid_models.get(provider, []))
        for model in models:
            if model not in current:
                current.append(model)
        valid_models[provider] = current


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


def summarize_error(error: Exception, limit: int = 500) -> str:
    text = f"{type(error).__name__}: {str(error).strip()}".replace("\n", " ").strip()
    return text[:limit]


class SymbolWallTimeout:
    def __init__(self, seconds: float, provider: str, symbol: str):
        self.seconds = clamp_non_negative_float(seconds, 0.0)
        self.provider = str(provider or "provider").strip().lower() or "provider"
        self.symbol = str(symbol or "symbol").strip().upper() or "symbol"
        self._previous_handler = None
        self._previous_timer = None

    def __enter__(self):
        if self.seconds <= 0 or not hasattr(signal, "setitimer"):
            return self
        self._previous_handler = signal.getsignal(signal.SIGALRM)
        self._previous_timer = signal.getitimer(signal.ITIMER_REAL)

        def handle_timeout(_signum, _frame):
            raise TimeoutError(
                f"provider_timeout:{self.provider} symbol={self.symbol} after {self.seconds:.0f}s"
            )

        signal.signal(signal.SIGALRM, handle_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.seconds)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.seconds > 0 and hasattr(signal, "setitimer"):
            signal.setitimer(signal.ITIMER_REAL, 0)
            if self._previous_handler is not None:
                signal.signal(signal.SIGALRM, self._previous_handler)
            if self._previous_timer and self._previous_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self._previous_timer)
        return False


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


def resolve_run_diagnostics_dir(args: argparse.Namespace) -> Path:
    explicit = str(getattr(args, "diagnostics_dir", "") or "").strip()
    if explicit:
        return Path(explicit).expanduser()

    portfolio_root = str(os.environ.get("PORTFOLIO_ROOT", "")).strip()
    if portfolio_root:
        return Path(portfolio_root).expanduser() / "data" / "tradingagents_run_diagnostics"

    return resolve_symbol_cache_root().parent / "tradingagents_run_diagnostics"


class RunDiagnostics:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.events = []
        self.llm_call_count = 0
        diagnostics_dir = resolve_run_diagnostics_dir(args)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        filename = "_".join(
            [
                _slugify(args.trade_date),
                _slugify(args.provider),
                _slugify(args.deep_model),
                _slugify(args.quick_model),
                str(os.getpid()),
                stamp,
            ]
        )
        self.path = diagnostics_dir / f"{filename}.json"
        self.payload = {
            "generatedAt": self.started_at,
            "tradeDate": args.trade_date,
            "provider": args.provider,
            "deepModel": args.deep_model,
            "quickModel": args.quick_model,
            "brainProfile": normalize_brain_profile(args.brain_profile),
            "selectedAnalysts": parse_selected_analysts(args.selected_analysts),
            "maxDebateRounds": clamp_non_negative_int(args.max_debate_rounds, 1),
            "maxRiskDiscussRounds": clamp_non_negative_int(args.max_risk_discuss_rounds, 1),
            "maxRecurLimit": clamp_positive_int(args.max_recur_limit, 100),
            "symbolWallTimeoutSeconds": clamp_non_negative_float(args.symbol_wall_timeout_seconds, 0.0),
            "events": self.events,
            "status": "running",
        }
        self.write()

    def next_llm_call_id(self) -> int:
        self.llm_call_count += 1
        return self.llm_call_count

    def record(self, event: str, **fields) -> None:
        safe_fields = {
            key: value
            for key, value in fields.items()
            if value is not None and key not in {"prompt", "input", "messages"}
        }
        self.events.append(
            {
                "at": datetime.now(timezone.utc).isoformat(),
                "event": event,
                **safe_fields,
            }
        )
        self.write()

    def finish(self, status: str) -> None:
        self.payload["status"] = status
        self.payload["finishedAt"] = datetime.now(timezone.utc).isoformat()
        self.write()

    def write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_symbol_cache_path(args: argparse.Namespace, symbol: str) -> Path:
    root = resolve_symbol_cache_root()
    provider = _slugify(args.provider)
    deep_model = _slugify(args.deep_model)
    quick_model = _slugify(args.quick_model)
    trade_date = _slugify(args.trade_date)
    profile = normalize_brain_profile(getattr(args, "brain_profile", "full"))
    base = root / trade_date / provider / deep_model / quick_model
    if profile != "full":
        base = base / _slugify(profile)
    return base / f"{_slugify(symbol)}.json"


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
        "brainProfile": normalize_brain_profile(getattr(args, "brain_profile", "full")),
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


def install_llm_runtime_patch(args: argparse.Namespace, diagnostics: RunDiagnostics = None) -> None:
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
        if str(args.provider).strip().lower() in ("deepseek", "glm"):
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
            call_id = diagnostics.next_llm_call_id() if diagnostics else None
            started_at = time.monotonic()
            if diagnostics:
                diagnostics.record(
                    "llm_invoke_start",
                    callId=call_id,
                    attempt=attempt,
                    provider=args.provider,
                    model=getattr(self, "model_name", None) or getattr(self, "model", None),
                )
            try:
                response = original_invoke(self, input, config, **kwargs)
                if diagnostics:
                    diagnostics.record(
                        "llm_invoke_done",
                        callId=call_id,
                        attempt=attempt,
                        durationMs=round((time.monotonic() - started_at) * 1000),
                    )
                interval_seconds = clamp_non_negative_float(args.invoke_interval_seconds, 2.0)
                if interval_seconds > 0:
                    time.sleep(interval_seconds)
                return response
            except Exception as error:
                if diagnostics:
                    diagnostics.record(
                        "llm_invoke_error",
                        callId=call_id,
                        attempt=attempt,
                        durationMs=round((time.monotonic() - started_at) * 1000),
                        error=summarize_error(error),
                    )
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


def build_graph(args: argparse.Namespace, diagnostics: RunDiagnostics = None) -> TradingAgentsGraph:
    config = deepcopy(DEFAULT_CONFIG)
    config["llm_provider"] = args.provider
    config["deep_think_llm"] = args.deep_model
    config["quick_think_llm"] = args.quick_model
    config["backend_url"] = args.backend_url
    config["output_language"] = args.output_language
    config["request_timeout_seconds"] = clamp_non_negative_float(args.request_timeout_seconds, 45.0)
    config["request_max_retries"] = max(0, int(args.request_max_retries))
    config["max_debate_rounds"] = clamp_non_negative_int(args.max_debate_rounds, 1)
    config["max_risk_discuss_rounds"] = clamp_non_negative_int(args.max_risk_discuss_rounds, 1)
    config["max_recur_limit"] = clamp_positive_int(args.max_recur_limit, 100)
    if diagnostics:
        diagnostics.record(
            "graph_build_start",
            selectedAnalysts=parse_selected_analysts(args.selected_analysts),
            maxDebateRounds=config["max_debate_rounds"],
            maxRiskDiscussRounds=config["max_risk_discuss_rounds"],
            maxRecurLimit=config["max_recur_limit"],
        )
    started_at = time.monotonic()
    graph = TradingAgentsGraph(debug=False, config=config, selected_analysts=parse_selected_analysts(args.selected_analysts))
    graph.propagator.max_recur_limit = config["max_recur_limit"]
    if diagnostics:
        diagnostics.record("graph_build_done", durationMs=round((time.monotonic() - started_at) * 1000))
    return graph


def _tool_invoke(tool, payload: dict):
    if hasattr(tool, "invoke"):
        return tool.invoke(payload)
    return tool(**payload)


def _safe_tool_text(tool_name: str, func, diagnostics: RunDiagnostics = None) -> str:
    started_at = time.monotonic()
    if diagnostics:
        diagnostics.record("fast_tool_start", tool=tool_name)
    try:
        value = func()
        text = str(value or "").strip()
        if diagnostics:
            diagnostics.record(
                "fast_tool_done",
                tool=tool_name,
                durationMs=round((time.monotonic() - started_at) * 1000),
                chars=len(text),
            )
        return text
    except Exception as error:
        if diagnostics:
            diagnostics.record(
                "fast_tool_error",
                tool=tool_name,
                durationMs=round((time.monotonic() - started_at) * 1000),
                error=summarize_error(error),
            )
        return f"{tool_name} unavailable: {summarize_error(error, limit=240)}"


def _compact_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    limit = clamp_positive_int(max_chars, 12000)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n...[truncated {len(text) - limit} chars]"


def build_fast_market_context(args: argparse.Namespace, symbol: str, diagnostics: RunDiagnostics = None) -> dict:
    try:
        end_date = datetime.strptime(args.trade_date, "%Y-%m-%d").date()
    except ValueError:
        end_date = datetime.now(timezone.utc).date()
    start_date = (end_date - timedelta(days=120)).isoformat()
    end_text = end_date.isoformat()
    max_chars = clamp_positive_int(args.fast_context_max_chars, 12000)

    stock_data = _safe_tool_text(
        "get_stock_data",
        lambda: _tool_invoke(
            get_stock_data,
            {
                "symbol": symbol,
                "start_date": start_date,
                "end_date": end_text,
            },
        ),
        diagnostics,
    )
    indicator_blocks = []
    for indicator in ["rsi", "macd", "close_50_sma"]:
        indicator_blocks.append(
            _safe_tool_text(
                f"get_indicators:{indicator}",
                lambda indicator=indicator: _tool_invoke(
                    get_indicators,
                    {
                        "symbol": symbol,
                        "indicator": indicator,
                        "curr_date": end_text,
                        "look_back_days": min(30, clamp_positive_int(args.indicator_tool_max_lookback_days, 30)),
                    },
                ),
                diagnostics,
            )
        )

    return {
        "stockData": _compact_text(stock_data, max_chars),
        "indicators": _compact_text("\n\n".join(indicator_blocks), max_chars),
        "startDate": start_date,
        "endDate": end_text,
    }


def extract_json_object(text: str):
    raw = str(text or "").strip()
    if not raw:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S | re.I)
    candidates = [fenced.group(1)] if fenced else []
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        candidates.append(raw[start : end + 1])
    candidates.append(raw)
    for candidate in candidates:
        with suppress(json.JSONDecodeError):
            return json.loads(candidate)
    return None


def normalize_fast_rating(value: str) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in {"BUY", "OVERWEIGHT", "HOLD", "UNDERWEIGHT", "SELL"}:
        return normalized
    text = str(value or "").lower()
    if re.search(r"\b(buy|long|add|overweight)\b|增配|买入|偏多", text):
        return "OVERWEIGHT"
    if re.search(r"\b(sell|short|reduce|underweight)\b|减配|卖出|偏空", text):
        return "UNDERWEIGHT"
    return "HOLD"


def clamp_confidence(value, fallback: float = 0.58) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = fallback
    return max(0.0, min(1.0, numeric))


def first_text(value, fallback: str = "") -> str:
    if isinstance(value, list):
        for item in value:
            text = str(item or "").strip()
            if text:
                return text
        return fallback
    text = str(value or "").strip()
    return text or fallback


def as_text_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(item or "").strip() for item in value if str(item or "").strip()]
    text = str(value or "").strip()
    return [text] if text else []


def run_fast_symbol_with_provider_key_pool(symbol: str, trade_date: str, args: argparse.Namespace, api_keys: list[str], diagnostics: RunDiagnostics = None):
    if not api_keys:
        raise RuntimeError(f"Missing required API key: {PROVIDER_ENV_VARS.get(args.provider.lower(), args.provider)}")

    market_context = build_fast_market_context(args, symbol, diagnostics=diagnostics)
    key_count = len(api_keys)
    last_error = None
    for key_index, api_key in enumerate(api_keys, start=1):
        try:
            def run_current_key():
                graph = build_graph(args, diagnostics=diagnostics)
                llm = graph.quick_thinking_llm
                prompt = [
                    {
                        "role": "system",
                        "content": (
                            "You are TradingAgents fast profile. Produce a compact trading decision "
                            "from market data without running debate committees. Output JSON only. "
                            "Allowed rating values: BUY, OVERWEIGHT, HOLD, UNDERWEIGHT, SELL. "
                            "The result is advisory-only and will be mapped to fund buckets by local guardrails. "
                            "Write Chinese text fields."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Symbol: {symbol}\nTrade date: {trade_date}\n"
                            f"Price window: {market_context['startDate']} to {market_context['endDate']}\n\n"
                            "Stock data:\n"
                            f"{market_context['stockData']}\n\n"
                            "Indicators:\n"
                            f"{market_context['indicators']}\n\n"
                            "Return JSON with keys: rating, confidence, decisionText, marketReport, "
                            "riskJudge, investmentJudge, keyDrivers, risks."
                        ),
                    },
                ]
                started_at = time.monotonic()
                if diagnostics:
                    diagnostics.record("fast_trader_start", symbol=symbol)
                result = llm.invoke(prompt)
                content = str(getattr(result, "content", result) or "").strip()
                if diagnostics:
                    diagnostics.record(
                        "fast_trader_done",
                        symbol=symbol,
                        durationMs=round((time.monotonic() - started_at) * 1000),
                        chars=len(content),
                    )
                parsed = extract_json_object(content) or {}
                rating = normalize_fast_rating(parsed.get("rating") or content)
                confidence = clamp_confidence(parsed.get("confidence"), 0.58)
                key_drivers = as_text_list(parsed.get("keyDrivers"))
                risks = as_text_list(parsed.get("risks"))
                decision_text = first_text(parsed.get("decisionText"), content)
                market_report = first_text(parsed.get("marketReport"), decision_text)
                risk_judge = first_text(parsed.get("riskJudge"), first_text(risks))
                investment_judge = first_text(parsed.get("investmentJudge"), first_text(key_drivers, decision_text))
                return {
                    "symbol": symbol,
                    "rating": rating,
                    "confidence": confidence,
                    "confidenceSource": "model",
                    "thesis": decision_text,
                    "risks": risks or ([risk_judge] if risk_judge else []),
                    "riskJudge": risk_judge,
                    "investmentJudge": investment_judge,
                    "decisionText": decision_text,
                    "marketReport": market_report,
                    "newsReport": "",
                    "fundamentalsReport": "",
                    "sentimentReport": "",
                    "runtimeDiagnostics": {
                        "brainProfile": "fast",
                        "fastProfile": True,
                        "providerKeyIndex": key_index,
                        "providerKeyCount": key_count,
                        "cacheStatus": "miss_live_generated",
                        "runDiagnosticPath": str(diagnostics.path) if diagnostics else None,
                    },
                }

            return with_provider_api_key(args.provider, api_key, run_current_key)
        except Exception as error:
            last_error = error
            if is_transient_provider_error(error) and key_index < key_count:
                if diagnostics:
                    diagnostics.record("fast_provider_key_error", symbol=symbol, keyIndex=key_index, error=summarize_error(error))
                continue
            raise

    raise last_error or RuntimeError("provider key pool exhausted")


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


def propagate_with_retries(
    graph: TradingAgentsGraph,
    symbol: str,
    trade_date: str,
    args: argparse.Namespace,
    diagnostics: RunDiagnostics = None,
):
    max_attempts = clamp_positive_int(args.symbol_max_attempts, 2)

    for attempt in range(1, max_attempts + 1):
        try:
            started_at = time.monotonic()
            if diagnostics:
                diagnostics.record("graph_propagate_start", symbol=symbol, attempt=attempt)
            final_state, rating = graph.propagate(symbol, trade_date)
            if diagnostics:
                diagnostics.record(
                    "graph_propagate_done",
                    symbol=symbol,
                    attempt=attempt,
                    durationMs=round((time.monotonic() - started_at) * 1000),
                    rating=str(rating).strip().upper(),
                )
            return final_state, rating, attempt
        except Exception as error:
            if diagnostics:
                diagnostics.record(
                    "graph_propagate_error",
                    symbol=symbol,
                    attempt=attempt,
                    error=summarize_error(error),
                )
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


def propagate_with_provider_key_pool(
    symbol: str,
    trade_date: str,
    args: argparse.Namespace,
    api_keys: list[str],
    diagnostics: RunDiagnostics = None,
):
    if not api_keys:
        raise RuntimeError(f"Missing required API key: {PROVIDER_ENV_VARS.get(args.provider.lower(), args.provider)}")

    last_error = None
    key_count = len(api_keys)
    for key_index, api_key in enumerate(api_keys, start=1):
        try:
            def run_current_key():
                graph = build_graph(args, diagnostics=diagnostics)
                return propagate_with_retries(graph, symbol, trade_date, args, diagnostics=diagnostics)

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
    diagnostics = RunDiagnostics(args)
    diagnostics.record("runner_start", symbols=[item.strip().upper() for item in args.symbols.split(",") if item.strip()])
    status = "failed"
    try:
        result = run_main(args, diagnostics)
        status = "success"
        return result
    except Exception as error:
        diagnostics.record("runner_error", error=summarize_error(error), tracebackTail=traceback.format_exc()[-2000:])
        raise
    finally:
        diagnostics.finish(status)
        print(f"[tradingagents_diagnostic] path={diagnostics.path}", file=sys.stderr)


def run_main(args: argparse.Namespace, diagnostics: RunDiagnostics) -> int:
    install_local_model_catalog_compat()
    ensure_provider_key(args.provider)
    install_tool_runtime_limits(args)
    install_llm_runtime_patch(args, diagnostics=diagnostics)
    provider_api_keys = resolve_provider_api_keys(args.provider)
    symbols = [item.strip().upper() for item in args.symbols.split(",") if item.strip()]

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "asOf": args.trade_date,
        "mode": "live",
        "source": "TradingAgents",
        "provider": args.provider,
        "brainProfile": normalize_brain_profile(args.brain_profile),
        "runtimeConfig": {
            "requestTimeoutSeconds": clamp_non_negative_float(args.request_timeout_seconds, 45.0),
            "requestMaxRetries": max(0, int(args.request_max_retries)),
            "selectedAnalysts": parse_selected_analysts(args.selected_analysts),
            "brainProfile": normalize_brain_profile(args.brain_profile),
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
            "symbolWallTimeoutSeconds": clamp_non_negative_float(args.symbol_wall_timeout_seconds, 0.0),
            "maxDebateRounds": clamp_non_negative_int(args.max_debate_rounds, 1),
            "maxRiskDiscussRounds": clamp_non_negative_int(args.max_risk_discuss_rounds, 1),
            "maxRecurLimit": clamp_positive_int(args.max_recur_limit, 100),
            "runDiagnosticPath": str(diagnostics.path),
        },
        "calls": []
    }
    payload["runtimeDiagnostics"] = {
        "brainProfile": normalize_brain_profile(args.brain_profile),
        "cacheHits": 0,
        "cacheFallbacks": 0,
        "liveRuns": 0,
        "providerKeyCount": len(provider_api_keys),
        "symbolCacheTtlHours": clamp_non_negative_float(args.symbol_cache_ttl_hours, 18.0),
        "allowStaleSymbolCacheOnError": bool(int(args.allow_stale_symbol_cache_on_error)),
    }

    for index, symbol in enumerate(symbols):
        diagnostics.record("symbol_start", symbol=symbol)
        fresh_cached = load_cached_symbol_call(args, symbol, allow_stale=False)
        if fresh_cached:
            diagnostics.record("symbol_cache_hit", symbol=symbol, cacheAgeHours=fresh_cached.get("ageHours"))
            payload["runtimeDiagnostics"]["cacheHits"] += 1
            payload["calls"].append(
                enrich_call_with_cache_metadata(
                    fresh_cached["call"],
                    cache_status="hit",
                    cache_age_hours=fresh_cached.get("ageHours"),
                )
            )
        else:
            diagnostics.record("symbol_cache_miss", symbol=symbol)
            try:
                with SymbolWallTimeout(args.symbol_wall_timeout_seconds, args.provider, symbol):
                    if normalize_brain_profile(args.brain_profile) == "fast":
                        call_payload = run_fast_symbol_with_provider_key_pool(
                            symbol,
                            args.trade_date,
                            args,
                            provider_api_keys,
                            diagnostics=diagnostics,
                        )
                        rating = call_payload.get("rating")
                    else:
                        final_state, rating, symbol_attempts, provider_key_index, provider_key_count = (
                            propagate_with_provider_key_pool(
                                symbol,
                                args.trade_date,
                                args,
                                provider_api_keys,
                                diagnostics=diagnostics,
                            )
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
                                "brainProfile": "full",
                                "cacheStatus": "miss_live_generated",
                                "runDiagnosticPath": str(diagnostics.path),
                            }
                        }
                persist_symbol_call_cache(args, symbol, call_payload)
                payload["runtimeDiagnostics"]["liveRuns"] += 1
                payload["calls"].append(call_payload)
                diagnostics.record("symbol_live_generated", symbol=symbol, rating=str(rating).strip().upper())
            except Exception as error:
                diagnostics.record("symbol_error", symbol=symbol, error=summarize_error(error))
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
                        diagnostics.record("symbol_stale_cache_fallback", symbol=symbol, cacheAgeHours=stale_cached.get("ageHours"))
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
    diagnostics.record("runner_done", callCount=len(payload["calls"]))
    diagnostics.finish("success")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
