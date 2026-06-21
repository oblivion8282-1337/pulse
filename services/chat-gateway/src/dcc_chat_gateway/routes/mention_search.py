"""Mention-candidate search endpoint (Phase 3.2 / Plan §P.14).

``GET /guilds/{guild_id}/mention-candidates?q=<prefix>``

Returns up to 20 usernames / display names from ``cached_user_profiles``
whose ``username`` starts with ``q``.  Requires the caller to be a guild
member (standard membership gate).

The endpoint is intentionally narrow:
  - No wildcard or infix search — prefix-only, maps cleanly to a
    ``LIKE 'prefix%'`` index scan on ``ix_cached_user_profiles_username``.
  - No auth-side user lookup — data comes exclusively from the profile
    cache; stale rows are included (unavoidable until a fresh statement
    arrives).
  - Limit of 20 results, ascending by username, for stable pageable UX.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Integer, and_, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.db import get_session
from dcc_chat_gateway.models import GuildMember
from dcc_chat_gateway.models.moderation import CachedUserProfile
from dcc_chat_gateway.security import AuthenticatedUser, get_current_user

router = APIRouter()

_MAX_RESULTS = 20


@router.get("/guilds/{guild_id}/mention-candidates")
async def mention_candidates(
    guild_id: int,
    q: str = Query(..., min_length=1, max_length=50),
    current_user: AuthenticatedUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """Return up to 20 profile-cache entries whose username starts with ``q``.

    Response shape::

        [{"user_identifier": str, "username": str, "display_name": str,
          "avatar_hash": str|null, "profile_color": str|null,
          "profile_color_secondary": str|null,
          "profile_gradient_angle": int|null, "stale": bool}, ...]

    Sorted ascending by ``username``.

    Errors:
      403 — caller is not a member of the guild.
      422 — ``q`` is missing or empty (FastAPI built-in).
    """
    # Membership gate
    member = await session.get(GuildMember, (guild_id, current_user.id))
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="not a member of this guild",
        )

    # Prefix search against the cached_user_profiles table, restricted to
    # members of the requested guild via a JOIN to guild_members.
    # ``LIKE 'prefix%'`` is index-friendly on ``ix_cached_user_profiles_username``.
    #
    # Cloud mode:   user_identifier is the numeric user_id as a string → cast
    #               to int to join against GuildMember.user_id.
    # Self-host:    user_identifier is a pairwise-sub (opaque string), but
    #               CachedUserProfile.synthetic_user_id carries the same numeric
    #               id that GuildMember.user_id holds (derived via
    #               synthesize_self_host_user_id on upsert).  Join on that.
    #
    # Escape LIKE wildcards in the user-supplied prefix.
    q_escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    settings = chat_config.get_settings()

    stmt = select(CachedUserProfile).where(
        CachedUserProfile.username.like(f"{q_escaped}%", escape="\\")
    )
    if settings.pulse_instance_mode == "cloud":
        join_cond = and_(
            GuildMember.guild_id == guild_id,
            GuildMember.user_id == cast(CachedUserProfile.user_identifier, Integer),
        )
    else:
        join_cond = and_(
            GuildMember.guild_id == guild_id,
            GuildMember.user_id == CachedUserProfile.synthetic_user_id,
        )

    stmt = (
        stmt.join(GuildMember, join_cond)
        .order_by(CachedUserProfile.username)
        .limit(_MAX_RESULTS)
    )

    rows = (await session.execute(stmt)).scalars().all()

    return [
        {
            "user_identifier": p.user_identifier,
            "username": p.username,
            "display_name": p.display_name,
            "avatar_hash": p.avatar_hash,
            "profile_color": p.profile_color,
            "profile_color_secondary": p.profile_color_secondary,
            "profile_gradient_angle": p.profile_gradient_angle,
            "stale": p.stale,
        }
        for p in rows
    ]
