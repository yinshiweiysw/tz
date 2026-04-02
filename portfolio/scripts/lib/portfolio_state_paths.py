from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_json_or_none(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def build_portfolio_state_paths(portfolio_root: Path, manifest: dict[str, Any] | None = None) -> dict[str, Path]:
    canonical = manifest.get("canonical_entrypoints", {}) if isinstance(manifest, dict) else {}
    return {
        "portfolio_state_path": Path(
            canonical.get("portfolio_state") or portfolio_root / "state" / "portfolio_state.json"
        ),
        "latest_compat_path": Path(
            canonical.get("latest_snapshot") or portfolio_root / "latest.json"
        ),
        "latest_raw_path": Path(
            canonical.get("latest_raw_snapshot") or portfolio_root / "snapshots" / "latest_raw.json"
        ),
    }


def load_preferred_portfolio_state(
    *,
    portfolio_root: Path,
    manifest: dict[str, Any] | None = None,
    explicit_portfolio_state: str | Path | None = None,
    explicit_latest_compat: str | Path | None = None,
) -> tuple[dict[str, Any], Path, str, dict[str, Path]]:
    paths = build_portfolio_state_paths(portfolio_root, manifest)
    portfolio_state_path = (
        Path(explicit_portfolio_state).expanduser().resolve()
        if explicit_portfolio_state
        else paths["portfolio_state_path"]
    )
    latest_compat_path = (
        Path(explicit_latest_compat).expanduser().resolve()
        if explicit_latest_compat
        else paths["latest_compat_path"]
    )

    preferred_payload = read_json_or_none(portfolio_state_path)
    if preferred_payload is not None:
        return preferred_payload, portfolio_state_path, "portfolio_state", paths

    compat_payload = read_json_or_none(latest_compat_path)
    if compat_payload is not None:
        return compat_payload, latest_compat_path, "latest_compat", paths

    raise FileNotFoundError(
        f"Neither portfolio_state.json nor latest.json compatibility view could be loaded under {portfolio_root}"
    )
