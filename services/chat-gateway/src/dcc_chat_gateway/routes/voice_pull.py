"""Voice-Move — einen User in einen Sprach-Channel bringen (vereint).

Ein Verwalter (``MOVE_MEMBERS`` auf dem Ziel-Channel) bringt einen anderen
Guild-Member in einen Sprach-Channel — verbunden oder nicht, öffentlich
oder privat. Der Gebrachte bekommt einen User-Overwrite
``VIEW_CHANNEL|CONNECT`` (damit er den Channel sehen + dem LiveKit-Room
beitreten kann) plus eine Zeile in ``channel_voice_pulls`` (die diesen
Overwrite als *temporär* markiert — beim Verlassen wird er wieder
entzogen, ein permanenter Admin-Grant bleibt unangetastet).

Der Gebrachte wird *kooperativ* verbunden: dieser Endpoint publishht nur
das ``voice_pull``-Signal auf ``user:events``; der Client des Gebrachten
verbindet sich selbst und wechselt dabei ggf. den Raum (``voice.connect``
trennt die alte Verbindung vorher). ``channel_revealed`` legt den Channel
in seine Sidebar, ``channel_permissions_updated`` invalidiert die
``_ws_perms``-Caches, damit er anschließend die Channel-Events bekommt.

Warum ``user:events`` und nicht ``voice:events``: der Gebrachte darf den
(privaten) Channel zum Zeitpunkt des Moves evtl. noch nicht sehen — der
View-Channel-Filter auf ``voice:events`` würde das Signal droppen.

Auto-Revoke (beim Verlassen) und der Reaper-Backstop liegen in
``routes/internal.py``; der Trigger in voice-signaling ``webhook.py``.
Der interne Naming (Marker-Key, Tabelle, Revoke-Endpoint) bleibt
``voice_pull`` — das ist ein Implementierungsdetail, der User sieht
„verschieben".
"""

from __future__ import annotations

from datetime import UTC, datetime

from dcc_shared.events import ChannelRevealedEvent, VoicePullEvent
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    Channel,
    ChannelVoicePull,
    GuildMember,
    PermissionOverwrite,
)
from dcc_chat_gateway.permissions import (
    OVERWRITE_TARGET_USER,
    Permissions,
    check_permission,
)
from dcc_chat_gateway.routes.channels import _channel_dict
from dcc_chat_gateway.routes.permission_overwrites import (
    _fetch_all_overwrites,
    _overwrite_dict,
    _publish_perms_event,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.voice_pull_cleanup import _PULL_ALLOW, marker_key

router = APIRouter()

# Redis marker key TTL. The marker only speeds up the webhook's leave-check
# (EXISTS); correctness does not depend on it (the reaper backstop + the
# revoke endpoint's row-check guard against staleness). 7 d comfortably
# covers any real call; expiry just degrades cleanup to the reaper cadence.
_MARKER_TTL_S = 7 * 24 * 3600


class VoicePullResult(BaseModel):
    pulled: bool = True


@router.post(
    "/channels/{channel_id}/members/{user_id}/voice-move",
    response_model=VoicePullResult,
)
async def voice_pull(
    channel_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Bring ``user_id`` into the voice channel ``channel_id``.

    Works whether the target is currently connected (then it's a channel
    switch) or not (then it's a summon). Grants a temporary
    ``VIEW_CHANNEL|CONNECT`` user-overwrite — tracked in
    ``channel_voice_pulls`` so the auto-revoke on leave knows it's ours —
    and signals the target's client to connect. Caller needs
    ``MOVE_MEMBERS`` on the channel."""
    if user_id == current.id:
        raise HTTPException(400, detail="cannot move yourself")

    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(400, detail="voice-move is only available for voice channels")

    # Caller must be able to manage who joins this voice channel.
    await check_permission(
        session,
        current,
        channel.guild_id,
        Permissions.MOVE_MEMBERS,
        channel_id=channel_id,
    )

    # Target must be a guild member (rejects phantom IDs before they land
    # in the DB or get broadcast).
    member = await session.get(GuildMember, (channel.guild_id, user_id))
    if member is None:
        raise HTTPException(404, detail="target user is not a member of this guild")

    # Upsert the user-overwrite: OR the pull bits into any existing allow,
    # never touch deny (a coexisting permanent grant stays intact).
    overwrite = await session.get(
        PermissionOverwrite, (channel_id, OVERWRITE_TARGET_USER, user_id)
    )
    # Eine bestehende deny-Ausnahme auf VIEW_CHANNEL/CONNECT gewinnt beim
    # Aufloesen immer gegen das frisch verOderte allow-Bit (deny-wins,
    # permission_resolver.py) — das Verschieben wirkte dann nicht, meldete
    # aber Erfolg. Das Verbot bleibt bewusst stehen (kein Rangschranken-
    # oder Eskalations-Check hier); stattdessen ehrlich ablehnen.
    if overwrite is not None and overwrite.deny_bf & _PULL_ALLOW:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="user has an explicit deny on VIEW_CHANNEL or CONNECT for this channel",
        )
    if overwrite is None:
        overwrite = PermissionOverwrite(
            channel_id=channel_id,
            target_type=OVERWRITE_TARGET_USER,
            target_id=user_id,
            allow_bf=_PULL_ALLOW,
            deny_bf=0,
        )
        session.add(overwrite)
    else:
        overwrite.allow_bf = overwrite.allow_bf | _PULL_ALLOW

    # Upsert the pull marker row (re-pull refreshes granted_by/granted_at).
    # ``granted_at`` hat kein ``onupdate`` (nur ``server_default`` fuer den
    # Insert) — ohne die explizite Zuweisung hier bleibt sie beim ersten Wert
    # stehen, und der Reaper (der ausschliesslich nach granted_at auswaehlt)
    # widerruft einen frischen Re-Pull Sekunden statt Minuten spaeter.
    pull = await session.get(ChannelVoicePull, (channel_id, user_id))
    if pull is None:
        session.add(
            ChannelVoicePull(channel_id=channel_id, user_id=user_id, granted_by=current.id)
        )
    else:
        pull.granted_by = current.id
        pull.granted_at = datetime.now(UTC)

    await session.commit()

    # Best-effort Redis marker for the webhook's cheap leave-check. If Redis
    # is unavailable the webhook simply won't fire the revoke on leave and
    # the reaper backstop handles cleanup — not a correctness issue.
    redis = getattr(request.app.state, "redis", None)
    if redis is not None:
        await redis.set(marker_key(channel_id, user_id), "1", ex=_MARKER_TTL_S)

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        overwrites = [_overwrite_dict(ow) for ow in await _fetch_all_overwrites(session, channel_id)]
        # Invalidate every socket's _ws_perms[cid] so the target (now a
        # viewer) starts receiving this channel's events.
        await _publish_perms_event(mgr, session, channel_id, channel.guild_id, overwrites)
        # Direct-to-target signals (user:events bypasses the view filter).
        await mgr.publish_user_event(
            user_id,
            VoicePullEvent(
                user_id=str(user_id),
                channel_id=str(channel_id),
                channel_name=channel.name,
                guild_id=str(channel.guild_id),
                pulled_by=str(current.id),
            ),
        )
        await mgr.publish_user_event(
            user_id,
            ChannelRevealedEvent(channel=_channel_dict(channel)),
        )

    return VoicePullResult()
