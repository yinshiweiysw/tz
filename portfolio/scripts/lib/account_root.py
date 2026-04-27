from __future__ import annotations

import os
from pathlib import Path


_DERIVED_WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
WORKSPACE_ROOT = Path(
    str(os.environ.get("PORTFOLIO_WORKSPACE_ROOT") or "").strip() or _DERIVED_WORKSPACE_ROOT
).expanduser().resolve()
PORTFOLIO_STATE_ANCHORS = (
    ("state", "portfolio_state.json"),
    ("data", "dashboard_state.json"),
    ("data", "live_funds_snapshot.json"),
    ("latest.json",),
    ("snapshots", "latest_raw.json"),
)
MAIN_ACCOUNT_ALIASES = {"", "main", "default", "primary", "tz"}


def count_portfolio_state_anchors(portfolio_root: Path) -> int:
    return sum(1 for segments in PORTFOLIO_STATE_ANCHORS if (portfolio_root.joinpath(*segments)).exists())


def discover_default_portfolio_root(workspace_root: Path) -> Path:
    parent_root = workspace_root.parent
    sibling_roots: list[Path] = []
    try:
        sibling_roots = [child.resolve() for child in parent_root.iterdir() if child.is_dir()]
    except OSError:
        sibling_roots = []

    candidates: list[tuple[int, int, Path]] = []
    seen: set[Path] = set()
    for candidate_root in [workspace_root, *sibling_roots]:
        resolved_root = candidate_root.resolve()
        if resolved_root in seen:
            continue
        seen.add(resolved_root)
        portfolio_root = resolved_root / "portfolio"
        if not (portfolio_root / "config" / "asset_master.json").exists():
            continue
        score = count_portfolio_state_anchors(portfolio_root)
        preferred = 1 if resolved_root == workspace_root else 0
        candidates.append((score, preferred, portfolio_root))

    if candidates:
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return candidates[0][2]

    return (workspace_root / "portfolio").resolve()


DEFAULT_PORTFOLIO_ROOT = discover_default_portfolio_root(WORKSPACE_ROOT)
PORTFOLIO_USERS_ROOT = DEFAULT_PORTFOLIO_ROOT.parent / "portfolio_users"


def normalize_account_id(value: str | None) -> str:
    return str(value or "").strip()


def resolve_portfolio_root(user: str | None = None, portfolio_root: str | None = None) -> Path:
    explicit_root = str(portfolio_root or os.environ.get("PORTFOLIO_ROOT") or "").strip()
    if explicit_root:
        return Path(explicit_root).expanduser().resolve()

    account_id = normalize_account_id(user or os.environ.get("PORTFOLIO_USER"))
    if account_id in MAIN_ACCOUNT_ALIASES:
        return DEFAULT_PORTFOLIO_ROOT

    return (PORTFOLIO_USERS_ROOT / account_id).resolve()


def resolve_account_id(user: str | None = None, portfolio_root: str | None = None) -> str:
    explicit_user = normalize_account_id(user or os.environ.get("PORTFOLIO_USER"))
    if explicit_user:
        return "main" if explicit_user in MAIN_ACCOUNT_ALIASES else explicit_user

    root = resolve_portfolio_root(user=user, portfolio_root=portfolio_root)
    return "main" if root == DEFAULT_PORTFOLIO_ROOT else root.name
