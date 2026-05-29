"""Per-channel permission overwrites.

A channel overwrite layers (allow, deny) bitfields on top of a member's
guild-resolved permissions. The resolver applies @everyone overwrites
first, then role overwrites (low → high position), then user overwrites
— and revokes everything if VIEW_CHANNEL is missing at the end.

The editor of an overwrite must hold MANAGE_PERMISSIONS in the channel
*and* must already possess every bit they are granting (newly allowed
bits or newly un-denied bits) — Stoatchat's anti-escalation pattern,
implemented in ``permissions.assert_overwrite_within_editor_scope``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Channel, PermissionOverwrite
from dcc_chat_gateway.permissions import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
    Permissions,
    check_permission,
)
from dcc_chat_gateway.schemas import OverwriteIn, OverwriteOut
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import ChannelPermissionsUpdatedEvent

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


def _overwrite_dict(ow: PermissionOverwrite) -> dict[str, object]:
    return {
        "target_type": ow.target_type,
        "target_id": str(ow.target_id),
        "allow": str(ow.allow_bf),
        "deny": str(ow.deny_bf),
    }


async def _publish(
    request: Request, channel_id: int, guild_id: int, overwrites: list[dict]
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(
            ChannelPermissionsUpdatedEvent(
                channel_id=str(channel_id),
                guild_id=str(guild_id),
                overwrites=overwrites,
            )
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
        channel_id,
        channel.guild_id,
        [_overwrite_dict(ow) for ow in all_ows],
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
    new_allow=0 / new_deny=0."""
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
        channel_id,
        channel.guild_id,
        [_overwrite_dict(ow) for ow in all_ows],
    )
