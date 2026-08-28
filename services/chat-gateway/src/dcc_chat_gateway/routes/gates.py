"""Beitritts- und Bann-Gate — geteilt von beiden Anmeldewegen.

Herausgezogen aus ``cert_login.py``, als der Ticket-Weg dazukam. Zwei Kopien
dieser Entscheidungen wären genau die Bauform, gegen die der Umbau gerichtet
ist: Die eine wiche still von der anderen ab, sobald jemand nur eine anfasst,
und die Abweichung fiele erst auf, wenn jemand über den einen Weg hineinkommt
und über den anderen nicht.

Der Inhalt ist unverändert übernommen. Wer hier etwas ändert, ändert es für
beide Wege — das ist der Zweck.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select

from dcc_chat_gateway.membership import (
    add_member,
    community_invite_grants_access,
    is_instance_locked,
    is_member,
    public_community_grants_access,
)
from dcc_chat_gateway.models import CachedUserProfile


async def enforce_ban_gate(session, identifier: str, is_owner_admin: bool) -> None:
    """403 ``instance banned``, wenn dieser Nutzer auf dieser Instanz gesperrt ist.

    Ein Cloud-Admin kann einen Nutzer auf diesem Self-Host bannen
    (``banned_at`` auf dem zwischengespeicherten Profil). Der Betreiber ist
    ausgenommen, damit ein Admin sich nicht dauerhaft selbst aussperren kann
    (versehentlicher Selbstbann).
    """
    if is_owner_admin:
        return
    banned_at = (
        await session.execute(
            select(CachedUserProfile.banned_at).where(
                CachedUserProfile.user_identifier == identifier
            )
        )
    ).scalar_one_or_none()
    if banned_at is not None:
        raise HTTPException(status_code=403, detail="instance banned")


async def enforce_join_gate(
    session,
    identifier: str,
    is_owner_admin: bool,
    community_grant_code: str | None = None,
    public_join_handle: str | None = None,
) -> None:
    """Self-Host join gate. Lets the request through or raises 403.

    On success (the owner, an existing member, or a permitted first-contact)
    this commits the membership write so the new ``instance_members`` row
    survives even though the verify route mints its token via Redis (no later
    SQL commit). Raises ``HTTPException`` 403 to deny.

    Gate order (Stufe 5 — security-critical):
      1. **owner** — always in; record membership on first sight.
      2. **existing member** — always in, never asked again (the re-auth path;
         this runs BEFORE the lock so a sealed instance never evicts members).
      3. **``locked``** — the single "Server gesperrt" not-aus toggle. If on,
         403 ``join_locked`` — non-differentiating, BEFORE any grant path, so it
         overrides BOTH community-invite grants AND public-community handles
         (Entscheidung 7). There is no per-community escape hatch above the lock.
      4. **grant paths** (only reached when not locked):
         - ``public_join_handle`` — a currently-public community (Stufe 4 /
           Entscheidung 5). The community's own permission. Non-consuming.
         - ``community_grant_code`` — a live ``GuildInvite`` (Stufe 2 / B-lite).
           Non-consuming (the use is spent later in ``accept_invite``).
         No grant → 403 ``join_not_permitted``.
    """
    # 1. Owner: always in; record membership on first sight.
    if is_owner_admin:
        await add_member(session, identifier, joined_via="owner")
        await session.commit()
        return

    # 2. Existing member: always in, never asked again (re-auth path). Checked
    #    before the lock so a sealed instance never locks out current members.
    if await is_member(session, identifier):
        return

    # 3. "Server gesperrt" not-aus toggle. Checked BEFORE every grant path so it
    #    overrides BOTH the public-community handle AND the community-invite
    #    grant — a sealed instance admits no new member regardless of how they
    #    arrived (Entscheidung 7 / Stufe 5). Non-differentiating 403.
    if await is_instance_locked(session):
        raise HTTPException(status_code=403, detail="join_locked")

    # 4. Per-community grant paths (only reached when the instance is not locked).
    #    Public-community grant (Stufe 4 / Entscheidung 5): a public community is
    #    its OWN permission to join the instance. Non-consuming, no code.
    if await public_community_grants_access(session, public_join_handle or ""):
        await add_member(session, identifier, joined_via="public_community")
        await session.commit()
        return

    #    Community-invite grant (Stufe 2 / B-lite): a live community invite is
    #    itself the permission to join the instance (community-scoped,
    #    non-consuming — the use is spent later in ``accept_invite``).
    if await community_invite_grants_access(session, community_grant_code or ""):
        await add_member(session, identifier, joined_via="community_invite")
        await session.commit()
        return

    # No grant → deny.
    raise HTTPException(status_code=403, detail="join_not_permitted")
