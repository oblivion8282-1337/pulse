"""Per-channel permission overwrites.

A channel overwrite layers (allow, deny) bitfields on top of a member's
guild-resolved permissions. The resolver applies @everyone overwrites
first, then role overwrites (low → high position), then user overwrites
— and revokes everything if VIEW_CHANNEL is missing at the end.

The editor of an overwrite must hold MANAGE_PERMISSIONS in the channel
*and* must already possess every bit they are granting (newly allowed
bits or newly un-denied bits) — Stoatchat's anti-escalation pattern,
implemented in ``permissions.assert_overwrite_within_editor_scope``.

Zweite, unabhängige Schranke: der Rang des ZIELS
(``_assert_editor_outranks_target``) — beim Setzen wie beim Löschen.
"""

from __future__ import annotations

from dcc_shared.events import ChannelPermissionsUpdatedEvent
from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    Channel,
    Guild,
    GuildMember,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.role_hierarchy import (
    assert_actor_outranks,
    assert_actor_outranks_role,
)
from dcc_chat_gateway.permissions import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
    Permissions,
    check_permission,
    restricted_channel_ids,
)
from dcc_chat_gateway.schemas import OverwriteIn, OverwriteOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.voice_evict import evict_ineligible_from_voice_channels

router = APIRouter()


def _anti_escalation_check(
    editor_perms: int,
    *,
    new_allow: int,
    new_deny: int,
    existing_allow: int = 0,
    existing_deny: int = 0,
) -> None:
    """Inline anti-escalation guard (Stoatchat pattern).

    Reuses the pre-resolved ``editor_perms`` bitfield from
    ``check_permission`` to avoid a redundant ``_load_context`` call.
    Logic mirrors ``permissions.assert_overwrite_within_editor_scope``."""
    granted_now = (~existing_allow) & new_allow
    ungated_now = existing_deny & (~new_deny)
    must_have = granted_now | ungated_now
    if must_have & ~editor_perms:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="cannot grant permissions you do not yourself have",
        )


async def _assert_editor_outranks_target(
    session,
    current: CurrentUser,
    guild_id: int,
    target_type: int,
    target_id: int,
    *,
    verb: str,
) -> None:
    """Rangschranke für das ZIEL der Ausnahme — Rolle wie Benutzer.

    Die Anti-Eskalation daneben prüft nur, welche BITS der Bearbeiter selbst
    hält, nicht, WEN er trifft: ein rangniedriger Moderator konnte einem
    ranghöheren Mitglied ``deny VIEW_CHANNEL`` setzen — und weil ohne
    VIEW_CHANNEL alles wegfällt, kam das Opfer an die Sperre nicht mehr heran,
    um sie zurückzunehmen. Beim LÖSCHEN ebenso: im privaten Kanal (@everyone
    deny VIEW) hält die ``allow``-Ausnahme die höhere Rolle als Einziges drin,
    sie zu entfernen wirkt wie ein deny (Bughunt 2026-08-16, beides belegt).

    Ein Ziel, das es nicht (mehr) gibt, geht durch: verwaiste Zeilen müssen
    aufräumbar bleiben. Das Anlegen prüft die Existenz vorher selbst (400).
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if target_type == OVERWRITE_TARGET_ROLE:
        role = await session.get(Role, target_id)
        if role is not None and role.guild_id == guild_id:
            await assert_actor_outranks_role(
                session, current, guild, role,
                detail=f"cannot {verb} an overwrite for a role at or above your highest role",
            )
    elif await session.get(GuildMember, (guild_id, target_id)) is not None:
        await assert_actor_outranks(
            session, current, guild, target_id,
            detail=f"cannot {verb} an overwrite for a member at or above your highest role",
        )


def _overwrite_dict(ow: PermissionOverwrite) -> dict[str, object]:
    return {
        "target_type": ow.target_type,
        "target_id": str(ow.target_id),
        "allow": str(ow.allow_bf),
        "deny": str(ow.deny_bf),
    }


async def _publish_perms_event(
    manager,
    session,
    channel_id: int,
    guild_id: int,
    overwrites: list[dict],
) -> None:
    """Publish ``channel_permissions_updated`` — the signal every socket
    uses to invalidate its cached ``_ws_perms[channel_id]``. Takes the
    manager directly so request-less callers (background reaper, internal
    service-to-service revoke) can fan out the same invalidation."""
    if manager is None:
        return
    restricted = await restricted_channel_ids(session, guild_id, [channel_id])
    await manager.publish_guild_event(
        ChannelPermissionsUpdatedEvent(
            channel_id=str(channel_id),
            guild_id=str(guild_id),
            overwrites=overwrites,
            restricted=channel_id in restricted,
        )
    )


async def _publish(
    request: Request,
    session,
    channel_id: int,
    guild_id: int,
    overwrites: list[dict],
) -> None:
    await _publish_perms_event(
        getattr(request.app.state, "connection_manager", None),
        session,
        channel_id,
        guild_id,
        overwrites,
    )


async def _fetch_all_overwrites(
    session, channel_id: int
) -> list[PermissionOverwrite]:
    stmt = select(PermissionOverwrite).where(
        PermissionOverwrite.channel_id == channel_id
    )
    return list((await session.execute(stmt)).scalars())


def _validate_target_type(target_type: int) -> None:
    if target_type not in (OVERWRITE_TARGET_ROLE, OVERWRITE_TARGET_USER):
        raise HTTPException(400, detail="target_type must be 0 (role) or 1 (user)")


@router.get(
    "/channels/{channel_id}/permissions", response_model=list[OverwriteOut]
)
async def list_overwrites(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    """Read-side: every channel member can see the channel's overwrites
    so the frontend can render its 'Permissions'-tab without a separate
    privileged call. The shape mirrors what the resolver consumes."""
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await check_permission(
        session, current, channel.guild_id, Permissions.VIEW_CHANNEL,
        channel_id=channel_id,
    )
    rows = await _fetch_all_overwrites(session, channel_id)
    return [
        OverwriteOut(
            target_type=ow.target_type,
            target_id=ow.target_id,
            allow=ow.allow_bf,
            deny=ow.deny_bf,
        )
        for ow in rows
    ]


@router.put(
    "/channels/{channel_id}/permissions/{target_type}/{target_id}",
    response_model=OverwriteOut,
)
async def set_overwrite(
    channel_id: int,
    target_type: int,
    target_id: int,
    payload: OverwriteIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Create or replace one (channel, target_type, target_id) overwrite.

    Idempotent: PUTting the same value twice is a no-op-ish. Editor
    needs MANAGE_PERMISSIONS *and* must hold every bit they're granting
    — see anti-escalation note at module top."""
    _validate_target_type(target_type)
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    editor_perms = await check_permission(
        session, current, channel.guild_id, Permissions.MANAGE_PERMISSIONS,
        channel_id=channel_id,
    )

    # Validate that the target belongs to this guild — rejects phantom IDs
    # before they can land in the DB or be broadcast to other clients.
    if target_type == OVERWRITE_TARGET_ROLE:
        role = await session.get(Role, target_id)
        if role is None or role.guild_id != channel.guild_id:
            raise HTTPException(400, detail="role not found in this guild")
    else:  # OVERWRITE_TARGET_USER
        member = await session.get(GuildMember, (channel.guild_id, target_id))
        if member is None:
            raise HTTPException(400, detail="user is not a member of this guild")
    await _assert_editor_outranks_target(
        session, current, channel.guild_id, target_type, target_id, verb="set"
    )

    existing = await session.get(
        PermissionOverwrite, (channel_id, target_type, target_id)
    )
    _anti_escalation_check(
        editor_perms,
        new_allow=payload.allow,
        new_deny=payload.deny,
        existing_allow=existing.allow_bf if existing else 0,
        existing_deny=existing.deny_bf if existing else 0,
    )

    if existing is None:
        existing = PermissionOverwrite(
            channel_id=channel_id,
            target_type=target_type,
            target_id=target_id,
            allow_bf=payload.allow,
            deny_bf=payload.deny,
        )
        session.add(existing)
    else:
        existing.allow_bf = payload.allow
        existing.deny_bf = payload.deny

    await session.commit()
    await session.refresh(existing)

    all_ows = await _fetch_all_overwrites(session, channel_id)
    await _publish(
        request,
        session,
        channel_id,
        channel.guild_id,
        [_overwrite_dict(ow) for ow in all_ows],
    )
    # Ein neuer deny auf VIEW_CHANNEL/CONNECT darf niemanden in einer
    # laufenden Sprachsitzung auf DIESEM Kanal zurücklassen — nach dem
    # Commit, best-effort. Nur relevant fuer Sprachkanäle.
    if channel.type == CHANNEL_TYPE_VOICE:
        await evict_ineligible_from_voice_channels(
            session,
            getattr(request.app.state, "redis", None),
            channel.guild_id,
            channel_ids=[channel_id],
        )

    return OverwriteOut(
        target_type=existing.target_type,
        target_id=existing.target_id,
        allow=existing.allow_bf,
        deny=existing.deny_bf,
    )


@router.delete(
    "/channels/{channel_id}/permissions/{target_type}/{target_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_overwrite(
    channel_id: int,
    target_type: int,
    target_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Remove a channel overwrite. Anti-escalation check still applies —
    removing a *deny* effectively grants those bits to the target, so
    the editor must hold them. Same shape as the set-call with
    new_allow=0 / new_deny=0. Die Rangschranke gilt hier ebenso: in einem
    privaten Kanal entzieht das Löschen einer *allow*-Ausnahme dem Ziel den
    Kanal — derselbe Effekt, den das PUT mit 403 abweist."""
    _validate_target_type(target_type)
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    editor_perms = await check_permission(
        session, current, channel.guild_id, Permissions.MANAGE_PERMISSIONS,
        channel_id=channel_id,
    )

    existing = await session.get(
        PermissionOverwrite, (channel_id, target_type, target_id)
    )
    if existing is None:
        return  # idempotent

    await _assert_editor_outranks_target(
        session, current, channel.guild_id, target_type, target_id, verb="remove"
    )
    _anti_escalation_check(
        editor_perms,
        new_allow=0,
        new_deny=0,
        existing_allow=existing.allow_bf,
        existing_deny=existing.deny_bf,
    )

    await session.execute(
        delete(PermissionOverwrite).where(
            PermissionOverwrite.channel_id == channel_id,
            PermissionOverwrite.target_type == target_type,
            PermissionOverwrite.target_id == target_id,
        )
    )
    await session.commit()

    all_ows = await _fetch_all_overwrites(session, channel_id)
    await _publish(
        request,
        session,
        channel_id,
        channel.guild_id,
        [_overwrite_dict(ow) for ow in all_ows],
    )
    # Wie bei set_overwrite: das Loeschen einer allow-Ausnahme kann
    # VIEW_CHANNEL/CONNECT gekostet haben — nachziehen.
    if channel.type == CHANNEL_TYPE_VOICE:
        await evict_ineligible_from_voice_channels(
            session,
            getattr(request.app.state, "redis", None),
            channel.guild_id,
            channel_ids=[channel_id],
        )
