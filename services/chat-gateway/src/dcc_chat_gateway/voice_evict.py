"""Service-to-service helper: tell voice-signaling to evict a user
from every voice channel in a guild.

Fired from the kick + ban routes so a kicked/banned member doesn't
linger in their LiveKit voice session. Fire-and-forget: failures are
logged but don't fail the parent request — the membership change has
already been committed and the WS clients have been notified.

Test-monkeypatchable at the function level (same pattern as
``_chat_gateway_request`` and ``_livekit_update_participant`` in
voice-signaling)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_shared import gaeste as _geteilt

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)

# Muss mit ``InternalEvictIn.channel_ids`` (``Field(max_length=100)`` in
# ``voice-signaling/routes/internal.py``) synchron bleiben — dort keine
# gemeinsame Konstante moeglich (Zwei-Service-Grenze), also hier als eigene
# Konstante gefuehrt statt als Magic Number. Ueberschreitet eine Community
# diese Zahl an Sprachkanaelen, lehnt die Gegenseite die GESAMTE Anfrage mit
# 422 ab, bevor irgendein Kanal geworfen wird — deshalb wird unten in
# Bloecken dieser Groesse gesendet statt in einem Rutsch.
_MAX_EVICT_CHANNELS_PER_CALL = 100

# Singleton httpx client for the internal voice-signaling call. Opening a fresh
# ``AsyncClient`` per kick/ban allocates a new connection pool and pays a TCP+TLS
# handshake every time — wasteful on bulk-moderation flows. The pool is reused
# across calls and torn down by the FastAPI lifespan via ``shutdown_client``.
# Lazy-init under a lock so concurrent first-callers share one instance.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _ensure_client() -> httpx.AsyncClient:
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = httpx.AsyncClient(
                timeout=get_settings().voice_signaling_timeout_s
            )
    return _client


async def shutdown_client() -> None:
    """Close the cached httpx client. Called from the lifespan ``finally``
    branch. Safe to call when nothing was ever initialised."""
    global _client
    if _client is None:
        return
    try:
        await _client.aclose()
    except Exception:  # noqa: BLE001 — best-effort shutdown
        pass
    _client = None


async def voice_channels_for_guild(
    session: AsyncSession, guild_id: int
) -> list[int]:
    stmt = select(Channel.id).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
    )
    return list((await session.execute(stmt)).scalars())


async def _post_evict(
    secret: str, channel_ids: list[int], user_id: str
) -> None:
    """Fire one POST /internal/evict-from-voice (one user, N channels).
    Best-effort: logs + swallows transport errors, never raises."""
    url = get_settings().voice_signaling_url.rstrip("/") + "/internal/evict-from-voice"
    body = {
        "channel_ids": [str(cid) for cid in channel_ids],
        "user_id": user_id,
    }
    try:
        http = await _ensure_client()
        resp = await http.post(
            url, json=body, headers={"X-Pulse-Internal-Secret": secret}
        )
        if resp.status_code >= 400:
            # 4xx ist kein Transportfehler, sondern ein abgelehnter Aufruf
            # (z.B. eine zu lange channel_ids-Liste) — lauter als eine
            # Warnung melden, damit ein systematischer Fehlschlag auffaellt.
            log.error(
                "voice-evict %s/%s returned %s", channel_ids, user_id, resp.status_code
            )
    except httpx.HTTPError as exc:
        log.warning("voice-evict %s/%s failed: %s", channel_ids, user_id, exc)


async def evict_user_from_guild_voice(
    session: AsyncSession, guild_id: int, user_id: int
) -> None:
    """Fire-and-forget POST /internal/evict-from-voice on the voice-
    signaling service. No-op when ``internal_service_secret`` is unset
    (dev / no-voice-mod-config) or when no voice channels exist."""
    secret = get_settings().internal_service_secret
    if not secret:
        log.info("voice-evict skipped: internal_service_secret unset")
        return
    channel_ids = await voice_channels_for_guild(session, guild_id)
    if not channel_ids:
        return
    # In Bloecken senden statt in einem Rutsch — die Gegenseite lehnt eine
    # laengere Liste als ``_MAX_EVICT_CHANNELS_PER_CALL`` ganz ab (siehe
    # Konstante oben), das wuerde den Auswurf fuer die GESAMTE Community
    # stumm scheitern lassen, sobald sie mehr Sprachkanaele hat.
    uid = str(user_id)
    for i in range(0, len(channel_ids), _MAX_EVICT_CHANNELS_PER_CALL):
        await _post_evict(
            secret, channel_ids[i : i + _MAX_EVICT_CHANNELS_PER_CALL], uid
        )


async def evict_all_from_voice_channels(
    redis: Any, channel_ids: Iterable[int]
) -> None:
    """Evict EVERY currently-present user from the given voice channels.

    Fired when a voice channel — or its whole guild — is deleted: otherwise the
    occupants linger in a LiveKit room whose channel no longer exists (the UI
    shows them in a ghost channel and nothing self-heals it within a session).
    Reads the ``voice:room:channel-<cid>`` presence sets (same key schema the
    user-purge + reconcile paths use) and fires one per-user eviction each.

    Best-effort: no-op when the secret is unset or redis is unavailable; never
    raises (a failed eviction must not block the delete that triggered it)."""
    secret = get_settings().internal_service_secret
    if not secret or redis is None:
        return
    for cid in channel_ids:
        try:
            members = await redis.smembers(f"voice:room:channel-{cid}")
        except Exception:  # noqa: BLE001 — best-effort, skip this channel
            log.warning("voice-evict: smembers failed for channel %s", cid, exc_info=True)
            continue
        for raw in members:
            uid = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
            # Mitglieder stehen numerisch im Set, Gäste mit ``gast-``-Präfix —
            # der voice-signaling-Endpunkt nimmt beide Formen an. Beide müssen
            # raus, sonst säßen Gäste in einer Geistersitzung ohne Kanal
            # weiter (und könnten sich dort sogar neue Tokens holen).
            if uid.isdigit() or uid.startswith("gast-"):
                await _post_evict(secret, [cid], uid)
                if uid.startswith("gast-"):
                    await kill_gast_whep_sitzungen(
                        await _geteilt.lese_token_werte(redis, uid)
                    )


async def evict_ineligible_from_voice_channels(
    session: AsyncSession,
    redis: Any,
    guild_id: int,
    channel_ids: Iterable[int] | None = None,
) -> None:
    """Nach einer Rechteänderung (Rollen-Update/-Löschung, Rollenentzug,
    Kanal-Overwrite) laufende Sprachsitzungen nachziehen: wer auf einem
    Sprachkanal jetzt kein ``VIEW_CHANNEL``/``CONNECT`` mehr hat, wird
    geworfen. Gemeinsame Stelle für ``routes/roles.py``,
    ``routes/role_members.py`` und ``routes/permission_overwrites.py`` —
    alle drei ändern effektive Kanalrechte, ohne dass die betroffene
    LiveKit-Sitzung das je merkt (der Token-Grant steht bis zu 4 h fest).

    Quelle der Wahrheit für "wer sitzt gerade drin" ist die Redis-
    Präsenzmenge (dieselbe, die der Reconcile-Loop in voice-signaling
    pflegt) — nicht die DB, die nur die Mitgliedschaft kennt. Für jeden
    Anwesenden wird das Recht frisch aufgelöst; fehlt VIEW_CHANNEL oder
    CONNECT, geht derselbe ``_post_evict``-Weg wie bei Bann/Kick.

    ``channel_ids=None`` prüft ALLE Sprachkanäle der Community — nötig
    bei einer Rollenänderung, die jeden Kanal treffen kann (roles.py,
    role_members.py). Ein Kanal-Overwrite betrifft dagegen nur einen
    Kanal; ``permission_overwrites.py`` grenzt entsprechend ein.

    Konservativ bei globalen Admins: die Admin-Flagge liegt in auth-svc
    und ist hier nicht sichtbar (gleiche Einschränkung wie
    ``permissions.members_who_can_view``) — ein globaler Admin ohne
    rollenbasiertes Recht wird im Zweifel mitgeworfen statt ausgenommen.

    Muss NACH dem Commit der Rechteänderung gerufen werden (die neuen
    Rechte müssen stehen, bevor ausgewertet wird, wer noch darf) und ist
    best-effort wie ``_post_evict`` — ein Fehlschlag bricht weder die
    schon gelungene Rechteänderung noch die übrigen Kanäle ab."""
    secret = get_settings().internal_service_secret
    if not secret or redis is None:
        return
    if channel_ids is None:
        channel_ids = await voice_channels_for_guild(session, guild_id)
    channel_ids = list(channel_ids)
    if not channel_ids:
        return

    for cid in channel_ids:
        try:
            members = await redis.smembers(f"voice:room:channel-{cid}")
        except Exception:  # noqa: BLE001 — best-effort, skip this channel
            log.warning("voice-evict: smembers failed for channel %s", cid, exc_info=True)
            continue
        for raw in members:
            uid_str = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
            if not uid_str.isdigit():
                continue
            user = AuthenticatedUser(id=int(uid_str), username="", is_admin=False, payload={})
            value = await resolve_permissions(session, user, guild_id, channel_id=cid)
            if not (
                has_permission(value, Permissions.VIEW_CHANNEL)
                and has_permission(value, Permissions.CONNECT)
            ):
                await _post_evict(secret, [cid], uid_str)


async def evict_gast(channel_id: int, gast_id: str) -> None:
    """Einen Gast aus seinem Sprachkanal werfen (Rauswurf/Link-Entwertung).

    Derselbe Weg wie beim Mitglied, nur mit einer Gast-Kennung
    (``gast-<id>``) statt einer Nutzer-ID — voice-signaling nimmt beide Formen
    an. Best-effort und still, wie der Rest dieses Moduls: der Gast ist durch
    die Redis-Sperre ohnehin ausgeschlossen, der LiveKit-Aufruf beendet nur
    seine laufende Verbindung sofort statt erst beim naechsten Token.

    Der WHEP-Session-Kill gehoert hier NICHT hin: er braucht die Token-Werte
    VOR ``lese_token_loeschen``, und die sammelt der Aufrufer (z. B.
    ``entwerte_link``) selbst — hier waeren sie schon weg.
    """
    secret = get_settings().internal_service_secret
    if not secret:
        log.info("voice-evict (gast) skipped: internal_service_secret unset")
        return
    await _post_evict(secret, [channel_id], gast_id)


async def kill_gast_whep_sitzungen(token_werte: list[str]) -> None:
    """Die laufenden WHEP-Zuschau-Sitzungen eines Gastes hart trennen.

    Die Lese-Token sterben in Redis (``lese_token_loeschen``), aber eine
    bereits etablierte MediaMTX-Session prueft ihr Token nur beim Handshake —
    sie lief sonst bis zum naechsten Client-Reconnect weiter. Der Aufruf an
    media-svc (das den MediaMTX-API-Zugang haelt) reisst die Sitzungen sofort
    ab; die Token-WERTE muessen davor gesammelt werden
    (``gaeste.lese_token_werte``), nach dem Loeschen ist die Zuordnung weg.
    Best-effort: scheitert der Aufruf, bleibt der naechste Reconnect als
    Rueckfallebene — der Gast kommt ohnehin nicht mehr rein.
    """
    if not token_werte:
        return
    settings = get_settings()
    secret = settings.internal_service_secret
    if not secret:
        log.info("gast-whep-kill skipped: internal_service_secret unset")
        return
    try:
        import httpx  # noqa: PLC0415

        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                settings.media_svc_url.rstrip("/")
                + "/internal/streams/kill-sessions",
                json={"tokens": token_werte},
                headers={"X-Pulse-Internal-Secret": secret},
            )
            if resp.status_code >= 400:
                # ``log.warning`` nimmt keine freien Kwargs — der Kontext
                # gehoert in die Nachricht, sonst TypeError im Except-Pfad.
                log.warning(
                    "gast-whep-kill rejected: status=%s tokens=%s",
                    resp.status_code,
                    len(token_werte),
                )
    except Exception:  # noqa: BLE001 — best-effort, siehe Docstring
        log.warning("gast-whep-kill failed", exc_info=True)
