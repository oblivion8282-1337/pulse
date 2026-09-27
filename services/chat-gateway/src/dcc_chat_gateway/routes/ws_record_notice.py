"""Aufnahme-Hinweis: der Zuschauer meldet, der Streamer erfährt es.

Zweite Stufe der Aufnahme-Funktion (Entwurf 2026-09-15, gebaut 2026-09-27):
Wer im Player-Fenster aufnimmt oder einen Clip sichert, sagt es dem Server —
und der Server sagt es allen Geräten, die gerade auf diesem Kanal streamen.
Live-only und bewusst OHNE Persistenz (Michaels Entscheidung 2026-09-27):
Ein Hinweis verfällt, wenn der Streamer offline ist, und der Server behält
kein Protokoll darüber, wer wann aufgenommen hat.

**Es ist eine Selbstauskunft.** Der Client ERZÄHLT, dass aufgenommen wird —
ein manipuliertes Gerät kann das verschweigen. Das Signal macht das ehrliche
Verhalten sichtbar, es verhindert nichts; die AGB-Klausel (Einmal-Hinweis im
Zuschauer-Fenster) deckt den Rest. Wer hier Durchsetzung erwartet, findet
sie nicht.

Anti-Flut: pro Verbindung und Kanal wird nur eine VERÄNDERUNG weitergeleitet
— start/stop-Geflacker desselben Zustands erreicht den Streamer nicht. Geht
die Verbindung unter, während eine Aufnahme gemeldet war, räumt der
Disconnect-Hook auf und meldet das Ende nach.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions

from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes._deps import channel_membership, ws_err
from dcc_chat_gateway.permissions import resolve_permissions

log = logging.getLogger(__name__)


async def handle_stream_record(ctx, msg: dict[str, Any], session_factory) -> None:
    """``stream_record``: Mitgliedschaft prüfen, an die Live-Streamer melden."""
    raw_cid = msg.get("channel_id")
    try:
        cid_int = int(str(raw_cid))
    except (TypeError, ValueError):
        await ws_err(ctx.websocket, 4006, "channel_id fehlt/ungueltig")
        return
    recording = msg.get("recording") is True
    clip = msg.get("clip") is True

    # Zustandsweiche: dieselbe Meldung wie vorher geht den Streamer nichts an.
    # Clips sind einmalig (kein Zustand) und werden immer durchgereicht.
    zuletzt = ctx.recording_states.get(cid_int)
    if not clip and zuletzt == recording:
        return

    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, ctx.user.id)
        if channel is None:
            # Wie remote_request: ob der Kanal versteckt ist oder die
            # Mitgliedschaft fehlt, geht niemanden an — dieselbe Antwort.
            await ws_err(ctx.websocket, 4051, "no access")
            return
        perms = await resolve_permissions(session, ctx.user, channel.guild_id, cid_int)
        if not has_permission(perms, Permissions.VIEW_CHANNEL):
            await ws_err(ctx.websocket, 4051, "no access")
            return

    # Wer streamt hier live? Ohne Streamer gibt es niemanden zu informieren —
    # die Meldung verfällt lautlos (live-only, kein Nachholen).
    zustand = await ctx.manager.stream_state_for(str(cid_int))
    user_ids = [int(u) for u in (zustand or {}).get("user_ids", [])] if zustand else []
    if user_ids:
        frame = {
            "op": "stream_record",
            "channel_id": str(cid_int),
            "from_user_id": str(ctx.user.id),
            "recording": recording,
            "clip": clip,
        }
        for uid in user_ids:
            for sock in ctx.manager.remote_user_sockets(uid):
                await send_to_socket(sock, frame)

    # Erst nach der Zustellung merken: ein Fehlschlag beim Senden soll die
    # nächste identische Meldung nicht schlucken.
    if not clip:
        ctx.recording_states[cid_int] = recording


async def cleanup_stream_record_on_disconnect(ctx, manager) -> None:
    """Gemeldete Aufnahmen enden mit der Verbindung des Zuschauers.

    Ohne diesen Hook bliebe der „wird aufgenommen"-Chip beim Streamer
    stehen, obwohl der Zuschauer längst weg ist. Best effort — ist der
    Streamer ebenfalls offline, verfällt die Meldung still (live-only).
    """
    for cid_int, recording in getattr(ctx, "recording_states", {}).items():
        if not recording:
            continue
        zustand = await manager.stream_state_for(str(cid_int))
        user_ids = [int(u) for u in (zustand or {}).get("user_ids", [])] if zustand else []
        frame = {
            "op": "stream_record",
            "channel_id": str(cid_int),
            "from_user_id": str(ctx.user.id),
            "recording": False,
            "clip": False,
        }
        for uid in user_ids:
            for sock in manager.remote_user_sockets(uid):
                await send_to_socket(sock, frame)
    ctx.recording_states.clear()
