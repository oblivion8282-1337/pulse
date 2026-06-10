"""Selbst-Austritt aus einer Self-Host-Instanz.

DELETE /me/instance-membership — „Server entfernen" im Client ist echtes
Austreten (User-Entscheidung 2026-06-10), nicht nur das Löschen der lokalen
Verknüpfung: die Instanz-Mitgliedschaft (``instance_members``) fällt, alle
Community-Mitgliedschaften werden mit derselben Mechanik wie leave/kick
abgebaut (inkl. ``guild_member_removed``-Events + Voice-Eviction) — ein
erneuter Beitritt braucht wieder eine Einladung oder öffentliche Adresse.

Guards:
* Der Instanz-OWNER (``joined_via == 'owner'``) kann nicht austreten → 403.
  Cert-Login würde ihn ohnehin beim nächsten Login wieder als Owner eintragen;
  der Client entfernt den Server dann nur aus der Ansicht.
* Wer noch Communitys BESITZT, muss erst übertragen/löschen → 409 (eine
  Community darf nie ownerless zurückbleiben — Spiegel von leave_guild).
* Cloud-Modus kennt keine Instanz-Mitgliedschaft → 404.
* Idempotent: keine Mitgliedschaft → 204.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Guild, GuildMember, InstanceMember
from dcc_chat_gateway.routes.guilds import _remove_guild_member
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()

# Instanzweite Aktionen sind nicht guild-scoped; ModAuditLog verlangt eine
# BIGINT guild_id → Sentinel 0 (wie admin_members).
_INSTANCE_GUILD = 0


@router.delete("/me/instance-membership", status_code=status.HTTP_204_NO_CONTENT)
async def leave_instance(
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> None:
    """Aus dieser Self-Host-Instanz austreten (Selbst-Entfernung)."""
    if get_settings().pulse_instance_mode != "self-host":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    row = await session.get(InstanceMember, current.user_identifier)
    if row is not None and row.joined_via == "owner":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="owner_cannot_leave_instance"
        )

    owns = (
        await session.execute(
            select(Guild.id).where(Guild.owner_id == current.id).limit(1)
        )
    ).scalar_one_or_none()
    if owns is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="owns_communities")

    # Alle Community-Mitgliedschaften abbauen — committet + broadcastet pro
    # Guild (gleiche Mechanik wie leave/kick). Bewusst NICHT eine große
    # Transaktion: ein Teilfehler lässt die InstanceMember-Zeile stehen, der
    # nächste DELETE-Aufruf räumt den Rest ab (retry-bar, konvergiert).
    memberships = (
        (
            await session.execute(
                select(GuildMember).where(GuildMember.user_id == current.id)
            )
        )
        .scalars()
        .all()
    )
    for member in memberships:
        await _remove_guild_member(session, request, member.guild_id, current.id, member)

    if row is not None:
        await session.delete(row)
        await write_audit_log(
            session,
            guild_id=_INSTANCE_GUILD,
            actor_user_id=current.id,
            action_type="instance_leave",
            target_kind="user",
            target_id=None,
            payload={"user_identifier": current.user_identifier},
        )
        await session.commit()
