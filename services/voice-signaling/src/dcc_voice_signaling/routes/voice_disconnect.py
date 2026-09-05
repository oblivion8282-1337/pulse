"""``POST /channels/{cid}/members/{uid}/voice-disconnect`` — admin
kick from a voice channel (requires ``MOVE_MEMBERS``)."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Path, Query, Request, status

from dcc_shared import gaeste

from dcc_voice_signaling import routes as voice_routes
from dcc_voice_signaling.routes import chat_gateway
from dcc_voice_signaling.security import CurrentUser

router = APIRouter()

# Snowflake-format path parameter constraint (mirrors InternalEvictIn.user_id).
# Nutzer-ID (nur Ziffern) ODER Gast-Kennung (``gast-<id>``): derselbe Rauswurf
# trifft beide, und ein zweiter Pfad dafür wäre eine zweite Stelle, an der die
# MOVE_MEMBERS-Prüfung stehen müsste.
_SnowflakePath = Annotated[
    str, Path(min_length=1, max_length=25, pattern=r"^(gast-)?\d+$")
]


async def _nachziehen_gast_aufräumen(
    redis, user_id: str, token_werte: list[str], link_entwerten: bool
) -> None:
    """Best-effort-Nacharbeiten nach einem Gast-Rauswurf (beides optional):
    laufende WHEP-Sitzungen hart trennen (media-svc hält den MediaMTX-API-
    Zugang) und auf Wunsch den Link mit entwerten (die Link-Zeile lebt in
    der chat-gateway-DB, deren Internal-Route dieselbe Räum-Logik wie der
    Entwerten-Knopf fährt). Scheitert etwas, bleibt es ohne Folgen — die
    Redis-Sperre verhindert ohnehin jeden Wiederbeitritt."""
    import httpx

    from dcc_voice_signaling.config import get_settings

    s = get_settings()

    async with httpx.AsyncClient(timeout=5.0) as client:
        if token_werte and s.media_svc_url and s.internal_service_secret:
            try:
                await client.post(
                    s.media_svc_url.rstrip("/") + "/internal/streams/kill-sessions",
                    json={"tokens": token_werte},
                    headers={"X-Pulse-Internal-Secret": s.internal_service_secret},
                )
            except Exception:  # noqa: BLE001 — best-effort
                pass
        if link_entwerten:
            link_id_roh = await redis.hget(
                gaeste.GAST_KEY.format(gast_id=user_id), "link_id"
            )
            link_id = (
                link_id_roh.decode() if isinstance(link_id_roh, bytes) else link_id_roh
            )
            if link_id and s.chat_gateway_url and s.internal_service_secret:
                try:
                    await client.post(
                        s.chat_gateway_url.rstrip("/")
                        + "/internal/guest-links/revoke",
                        json={"link_id": int(link_id)},
                        headers={
                            "X-Pulse-Internal-Secret": s.internal_service_secret
                        },
                    )
                except Exception:  # noqa: BLE001 — best-effort
                    pass


@router.post("/channels/{channel_id}/members/{user_id}/voice-disconnect")
async def disconnect_from_voice(
    channel_id: _SnowflakePath,
    user_id: _SnowflakePath,
    caller: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    link_entwerten: Annotated[bool, Query()] = False,
) -> dict[str, bool]:
    """Force a participant out of a voice channel. Requires
    ``MOVE_MEMBERS`` (Discord uses the same bit for moving + kicking
    from voice — Pulse-v1 only supports the kick variant; "move to
    another channel" can land later).

    Implementation:
      * LiveKit ``remove_participant`` (best-effort — silent if the
        target isn't currently connected);
      * publish ``voice_disconnect`` on ``voice:events`` so the
        target's own client can drop its local voice state without
        waiting for the LiveKit ParticipantLeft webhook.

    Voice-overrides (mute/deafen) are *not* cleared. Matches Discord's
    server-mute semantics — the mod state persists across disconnect/
    rejoin in the same guild. It also closes the race where a
    concurrent ``PUT /voice-override mute=true`` committed between the
    admin's disconnect-decision and the clear: an unconditional clear
    would silently swallow that mute.
    """
    if user_id == str(caller.id):
        raise HTTPException(400, detail="cannot disconnect yourself via the admin endpoint")
    bearer = voice_routes._bearer_from_header(authorization)
    # Both calls are independent GETs — fire them concurrently.
    _, perms = await asyncio.gather(
        voice_routes._require_voice_channel_member(channel_id, bearer),
        voice_routes._resolve_channel_permissions(channel_id, bearer),
    )
    if not (perms & voice_routes._PERM_MOVE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: MOVE_MEMBERS"
        )

    ist_gast = gaeste.ist_gast(user_id)
    if not ist_gast:
        # Verify that the target user is a member of the channel's guild. This
        # prevents an admin from removing arbitrary user IDs outside their guild.
        await chat_gateway._require_target_in_guild(channel_id, user_id, bearer)

    redis = voice_routes._get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable"
        )

    if ist_gast:
        # Cross-Community-Schutz (Audit 2026-09): die Gast-Sperre greift auf
        # einen GLOBALEN Schlüssel — ohne Kanalvergleich könnte ein
        # MOVE_MEMBERS-Inhaber aus Community B den Gast von Community A
        # sperren und ihm das Zuschauen kappen. Der Gast-Hash nennt den
        # Kanal seines Tickets; weicht er vom Pfad-Kanal ab, ist der
        # Aufrufer nicht in dem Kanal, in dem der Gast sitzt → abweisen.
        ticket_kanal = await redis.hget(
            gaeste.GAST_KEY.format(gast_id=user_id), "channel_id"
        )
        ticket_kanal = (
            ticket_kanal.decode() if isinstance(ticket_kanal, bytes) else ticket_kanal
        )
        if ticket_kanal is not None and ticket_kanal != channel_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="guest is in another channel",
            )

        # Erst sperren, dann werfen: andersherum könnte der Gast in der Lücke
        # mit demselben Ticket ein neues LiveKit-Token holen und wäre sofort
        # wieder da. Die Sperre lebt so lange wie das längstmögliche Ticket —
        # länger muss sie nicht, kürzer darf sie nicht.
        await gaeste.sperren(redis, user_id)
        # Und ihm die WHEP-Lese-Token wegnehmen: ohne das liefe eine bereits
        # geholte Zuschau-Adresse bis zu einer Stunde weiter, obwohl er den
        # Raum verlassen musste (Begründung ausführlich in ``gaeste``). Die
        # Token-WERTE bleiben für den Session-Kill bei media-svc.
        token_werte = await gaeste.lese_token_werte(redis, user_id)
        await gaeste.lese_token_loeschen(redis, user_id)

    livekit_api = getattr(request.app.state, "livekit_api", None)
    await voice_routes._livekit_remove_participant(channel_id, user_id, api_client=livekit_api)

    if ist_gast and (token_werte or link_entwerten):
        await _nachziehen_gast_aufräumen(redis, user_id, token_werte, link_entwerten)

    from dcc_shared.events import VoiceDisconnectEvent

    envelope = VoiceDisconnectEvent(
        channel_id=channel_id, user_id=user_id
    )
    await redis.publish(
        voice_routes._VOICE_EVENTS_CHANNEL,
        json.dumps(envelope.model_dump(mode="json")),
    )
    return {"disconnected": True}
