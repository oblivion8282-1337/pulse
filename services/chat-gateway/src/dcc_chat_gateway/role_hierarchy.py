"""Role-hierarchy comparison for moderation targets (kick/ban) and for
role editing itself (`assert_actor_outranks_role`).

Discord semantics: a moderator may only act on users whose highest role
sits STRICTLY below their own — equal top positions block the action, so
two mods sharing the same role cannot kick/ban each other. The guild
owner outranks everyone; instance admins bypass too (they already
resolve to GRANT_ALL_SAFE in the permission resolver and act as
instance staff).

@everyone is pinned at position 0 and implicit for every member, so a
user without explicit role assignments has a top position of 0. The
same baseline applies to ban targets that are not members (pre-emptive
bans): no ``member_roles`` rows ⇒ position 0.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Guild, MemberRole, Role
from dcc_chat_gateway.security import AuthenticatedUser


async def highest_role_position(
    session: AsyncSession, guild_id: int, user_id: int
) -> int:
    """Highest explicitly-assigned role position of ``user_id`` in
    ``guild_id``; 0 (the pinned @everyone position) without roles."""
    stmt = (
        select(func.max(Role.position))
        .join(MemberRole, MemberRole.role_id == Role.id)
        .where(
            MemberRole.guild_id == guild_id,
            MemberRole.user_id == user_id,
        )
    )
    pos = (await session.execute(stmt)).scalar()
    return pos if pos is not None else 0


async def assert_actor_outranks(
    session: AsyncSession,
    actor: AuthenticatedUser,
    guild: Guild,
    target_user_id: int,
    *,
    detail: str,
) -> None:
    """403 unless ``actor`` outranks ``target_user_id`` by role hierarchy.

    Call AFTER the permission gate (``check_permission``) so a caller
    without the base permission still sees the generic 403 first.
    """
    if actor.is_admin or guild.owner_id == actor.id:
        return
    actor_pos = await highest_role_position(session, guild.id, actor.id)
    target_pos = await highest_role_position(session, guild.id, target_user_id)
    if actor_pos <= target_pos:
        raise HTTPException(403, detail=detail)


async def assert_actor_outranks_role(
    session: AsyncSession,
    actor: AuthenticatedUser,
    guild: Guild | None,
    role: Role,
    *,
    detail: str,
) -> None:
    """403 unless ``actor`` steht in der Rangfolge STRIKT über ``role``.

    **Warum es das braucht.** Die Bit-Schranke daneben (der Bearbeiter muss
    jedes Recht halten, das die Zielrolle trägt) fängt den Angriff auf eine
    ADMIN-Rolle ab, aber nicht den unter Gleichberechtigten: zwei Moderator-
    Rollen mit denselben Bits und verschiedenem Rang: die NIEDRIGERE konnte die
    höhere umbenennen, leerräumen oder löschen und ihre Träger damit serverweit
    entmachten. Beim Umsortieren wird der Rang längst geprüft, beim Bearbeiten
    und Löschen bis 2026-08-13 nicht (Bughunt, am Code bestätigt).

    **@everyone ist ausgenommen.** Sie ist auf Position 0 festgenagelt; wer
    selbst keine ausdrückliche Rolle hat, steht ebenfalls auf 0 und käme sonst
    nicht mehr an sie heran — eine Verschärfung ohne Sicherheitsgewinn, denn
    @everyone trägt keine Rangmacht. Die Bit-Schranke gilt für sie weiter.

    Nach der Rechteprüfung rufen, wie [`assert_actor_outranks`].
    """
    if actor.is_admin or (guild is not None and guild.owner_id == actor.id):
        return
    if role.is_everyone:
        return
    actor_top = await highest_role_position(session, role.guild_id, actor.id)
    if role.position >= actor_top:
        raise HTTPException(403, detail=detail)
