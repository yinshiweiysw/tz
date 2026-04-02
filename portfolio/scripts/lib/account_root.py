from __future__ import annotations

import os
from pathlib import Path


WORKSPACE_ROOT = Path("/Users/yinshiwei/codex/tz")
DEFAULT_PORTFOLIO_ROOT = WORKSPACE_ROOT / "portfolio"
PORTFOLIO_USERS_ROOT = WORKSPACE_ROOT / "portfolio_users"
MAIN_ACCOUNT_ALIASES = {"", "main", "default", "primary", "tz"}


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
