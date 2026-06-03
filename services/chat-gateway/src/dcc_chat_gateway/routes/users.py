"""Numeric user-id → profile resolution (F19 — self-host member names).

``GET /users?ids=1,2,3``

Resolves numeric chat/voice user ids (``GuildMember.user_id`` / the LiveKit
``user-<id>`` identity) to cached profiles via
``CachedUserProfile.synthetic_user_id``.

Why this exists: the Cloud frontend resolves display names against auth-svc
(``/api/auth/users``), but a Self-Host has no auth-svc and its members are keyed
by per-instance synthetic ids the Cloud doesn't know. Self-Host frontends hit
this endpoint instead; the response matches the frontend ``UserSummary`` shape so
the same ``userCache`` code path works in both modes.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.db import get_session
from dcc_chat_gateway.models.moderation import CachedUserProfile
from dcc_chat_gateway.security import AuthenticatedUser, get_current_user

router = APIRouter()

_MAX_IDS = 100


@router.get("/users")
async def resolve_users(
    ids: str = Query(..., description="comma-separated numeric user ids"),
    current_user: AuthenticatedUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """Resolve numeric ids → ``UserSummary[]`` from the profile cache.

    Response shape (matches the frontend ``UserSummary``)::

        [{"id": str, "username": str, "display_name": str|null,
          "avatar_url": str|null}, ...]

    Unknown ids are omitted (the client tombstones them). Requires a valid
    session token — any instance member — but no per-guild gate, since name
    resolution spans channels, voice and DMs. ``current_user`` is unused beyond
    that auth gate.
    """
    _ = current_user  # auth gate only
    parsed: list[int] = []
    for raw in ids.split(","):
        token = raw.strip()
        if token.isdigit():
            parsed.append(int(token))
        if len(parsed) >= _MAX_IDS:
            break
    if not parsed:
        return []

    rows = (
        (
            await session.execute(
                select(CachedUserProfile).where(
                    CachedUserProfile.synthetic_user_id.in_(parsed)
                )
            )
        )
        .scalars()
        .all()
    )

    return [
        {
            "id": str(p.synthetic_user_id),
            "username": p.username,
            "display_name": p.display_name,
            # Self-Host avatars aren't resolvable to a URL here (no cloud
            # user-id mapping) → initials fallback in the UI.
            "avatar_url": None,
        }
        for p in rows
    ]
