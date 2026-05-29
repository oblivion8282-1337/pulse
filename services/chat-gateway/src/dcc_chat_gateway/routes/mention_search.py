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
          "avatar_hash": str|null, "profile_color": str|null, "stale": bool}, ...]

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

    # Prefix search against the cached_user_profiles table.
    # ``LIKE 'prefix%'`` is index-friendly on the ``ix_cached_user_profiles_username``
    # B-tree index.
    #
    # In cloud mode, filter results to only users who are members of the guild
    # (via a JOIN to guild_members). In self-host mode (with pairwise-subs),
    # we cannot correlate CachedUserProfile.user_identifier back to numeric
    # user_ids without a mapping table, so results include all cached users.
    # Self-host admins have full instance visibility anyway.
    #
    # Escape SQL LIKE wildcards in the user-supplied prefix so that
    # ``q=%`` / ``q=_`` can't match every row or every single-char username.
    q_escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    settings = chat_config.get_settings()

    stmt = select(CachedUserProfile).where(
        CachedUserProfile.username.like(f"{q_escaped}%", escape="\\")
    )

    # In cloud mode, add a guild-membership filter.
    if settings.pulse_instance_mode == "cloud":
        stmt = (
            stmt.join(
                GuildMember,
                and_(
                    GuildMember.guild_id == guild_id,
                    # In cloud mode, user_identifier is the numeric user_id as a
                    # string — cast it to int to join against GuildMember.user_id.
                    GuildMember.user_id == cast(CachedUserProfile.user_identifier, Integer),
                ),
            )
            .order_by(CachedUserProfile.username)
            .limit(_MAX_RESULTS)
        )
    else:
        stmt = stmt.order_by(CachedUserProfile.username).limit(_MAX_RESULTS)

    rows = (await session.execute(stmt)).scalars().all()

    return [
        {
            "user_identifier": p.user_identifier,
            "username": p.username,
            "display_name": p.display_name,
            "avatar_hash": p.avatar_hash,
            "profile_color": p.profile_color,
            "stale": p.stale,
        }
        for p in rows
    ]
