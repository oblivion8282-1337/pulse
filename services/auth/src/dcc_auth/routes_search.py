"""User-search + internal discoverable-flag routes.

``GET /users/search`` is the public-facing username-autocomplete used
by the friends-add UI. Three guards stack:
  * caller must be authenticated (bearer token);
  * search target's ``discoverable`` must be true (opt-out, default
    true on existing accounts via migration 0011);
  * per-user rate limit (default 30/min) blocks bulk enumeration.

``POST /internal/users/discoverable`` is the chat-gateway → auth-svc
mirror that keeps ``auth.users.discoverable`` in sync with
``user_privacy.show_in_search``. Gated by the shared
``INTERNAL_SERVICE_SECRET`` header (same pattern as
``routes_account``'s outgoing call and
``mediamtx-auth-hook``'s gating).
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func, or_, select

import dcc_auth.config as _config
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.routes import _check_rate, _get_current_user
from dcc_auth.schemas import UserSummary

router = APIRouter()


# ---- Public search --------------------------------------------------------


@router.get("/users/search", response_model=list[UserSummary])
async def search_users(
    request: Request,
    session: SessionDep,
    q: str,
    current: Annotated[User, Depends(_get_current_user)],
    limit: int = 20,
):
    """Case-insensitive *prefix* match on ``username`` OR ``display_name``.

    Prefix-only (not full-text) keeps the query indexable. Display-name
    is included so a user can be found by their visible name even when
    the @handle is something cryptic (``alex_42``). Username matches
    rank above display-name matches so the exact-handle hit is at the
    top of the list. ``q`` must be at least 2 chars (1-char queries
    would just dump the whole alphabet bucket); ``limit`` is hard-
    capped at 50 to keep responses small.
    """
    settings = _config.get_settings()
    await _check_rate(request, "user_search", settings.rate_limit_user_search)

    needle = q.strip()
    if len(needle) < 2:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="query_too_short",
        )
    if limit < 1:
        limit = 1
    if limit > 50:
        limit = 50

    # Case-insensitive prefix on both fields. ``display_name`` is nullable —
    # ``LOWER(NULL) LIKE pattern`` evaluates to NULL which the WHERE drops,
    # so no COALESCE is needed. Username matches sort first (CASE-rank 0),
    # then display-name-only matches (rank 1), each block by username.
    pattern = needle.lower() + "%"
    username_match = func.lower(User.username).like(pattern)
    display_match = func.lower(User.display_name).like(pattern)
    stmt = (
        select(User)
        .where(
            or_(username_match, display_match),
            User.discoverable.is_(True),
            User.disabled.is_(False),
            User.id != current.id,
        )
        .order_by(case((username_match, 0), else_=1), User.username)
        .limit(limit)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


# ---- Internal discoverable mirror -----------------------------------------


class _DiscoverableIn(BaseModel):
    """Body for the chat-gateway → auth-svc mirror call.

    ``user_id`` arrives as a string (snowflake-style, matches every
    other cross-service body in Pulse). Parsed to int below.
    """

    model_config = ConfigDict(extra="forbid")
    user_id: Annotated[str, Field(min_length=1, max_length=32)]
    discoverable: bool


def _check_internal_secret(provided: str | None) -> None:
    """Mirror of ``routes/internal.py::_check_internal_secret`` in
    chat-gateway. Fail-closed when the server-side secret is unset."""
    expected = _config.get_settings().internal_service_secret
    if not expected:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret"
        )


@router.post(
    "/internal/users/discoverable", status_code=status.HTTP_204_NO_CONTENT
)
async def set_user_discoverable(
    payload: _DiscoverableIn,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    _check_internal_secret(x_pulse_internal_secret)
    try:
        uid = int(payload.user_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="invalid user_id"
        ) from exc
    user = await session.get(User, uid)
    if user is None:
        # 204 either way — the caller (chat-gateway) doesn't need to
        # know whether the auth row still exists; if the user just
        # purged themselves, the mirror call is a harmless no-op.
        return None
    user.discoverable = bool(payload.discoverable)
    await session.commit()
    return None
