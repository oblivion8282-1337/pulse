"""HTTP routes for media-svc.

Endpoints:
  * ``POST /channels/{channel_id}/stream-token`` — issue a short-lived publish
    token (called by chat-gateway after it has checked the user's channel
    membership; the Pulse access token it forwards is verified here and the
    `sub` becomes the token's user_id). The push URL targets a fresh path
    ``channel-<cid>-<uid>-<nonce>`` (nonce = 32 hex per issue, see ``streamkeys``).
  * ``GET /channels/{channel_id}/stream`` — current set of HQ streamers in the
    channel (``{channel_id, user_ids: [...], since?}``).
  * ``GET /channels/{channel_id}/whep?user_id=<uid>`` — the WHEP playback URL
    for that user's *current* stream (reads ``stream:active:*`` to find the
    live path with its nonce). 404 if the user isn't streaming.

All routes require a valid bearer (Cloud RS256 or Self-Host session token) —
chat-gateway forwards the caller's token after its own membership/permission
checks. The whep route used to be anonymous; a self-host Caddy exposing
``/api/media/*`` then leaked stream URLs to anyone, bypassing VIEW_CHANNEL.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import UTC, datetime
from time import monotonic
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from dcc_shared.events import StreamDescriptor
from dcc_shared.streaming import MONITOR_INDEX_MAX, MONITOR_INDEX_MIN, SLOT_MAX

from dcc_media_svc.config import get_settings
from dcc_media_svc.poller import _parse_state, _publish_event
from dcc_media_svc.security import CurrentUser
from dcc_shared.streaming import read_cache_key
from dcc_media_svc.streamkeys import (
    CHANNEL_STATE_KEY,
    TOKEN_KEY,
    active_key,
    path_for_channel_user,
    stopping_key,
    streams_from_state,
)


log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# In-process per-user rate limiter for stream-token issuance.
# Prevents a single user from flooding Redis with token keys.
# Per-process only — for multi-worker deployments this should move to Redis.
# Uses a sliding-window-counter (two fixed buckets: current + previous) to
# avoid O(N) full-dict scans while still approximating a true sliding window.
# ---------------------------------------------------------------------------
_TOKEN_RATE_LIMIT = 10   # max tokens per user per window
_TOKEN_RATE_WINDOW = 60.0  # seconds
# Two buckets: current and previous window. Old entries are discarded.
_token_rate_buckets_current: dict[int, int] = {}
_token_rate_buckets_previous: dict[int, int] = {}
_token_rate_window_boundary = 0.0


def _check_token_rate(user_id: int) -> bool:
    """Return True if the call is allowed, False if over budget.

    Sliding-window-counter: the request's effective count is the current
    window's tally plus the previous window's tally weighted by the fraction
    of the previous window that still overlaps the trailing 60 s
    (``current + previous * (1 - elapsed/window)``). As the current window
    fills, the previous window's contribution decays linearly to zero. This
    closes the fixed-window boundary doubling (where a user could spend the
    full budget at the end of one window and again at the start of the next).
    """
    global _token_rate_window_boundary, _token_rate_buckets_current, _token_rate_buckets_previous
    now = monotonic()
    current_window = int(now / _TOKEN_RATE_WINDOW)
    window_boundary = current_window * _TOKEN_RATE_WINDOW

    # If we've moved to a new window, rotate the buckets.
    if window_boundary != _token_rate_window_boundary:
        # A multi-window jump (idle user) leaves the old "previous" bucket
        # fully stale → drop it rather than carry forward an ancient tally.
        if window_boundary - _token_rate_window_boundary > _TOKEN_RATE_WINDOW:
            _token_rate_buckets_previous = {}
        else:
            _token_rate_buckets_previous = _token_rate_buckets_current
        _token_rate_window_boundary = window_boundary
        _token_rate_buckets_current = {}

    elapsed = now - window_boundary
    prev_weight = 1.0 - (elapsed / _TOKEN_RATE_WINDOW)
    current = _token_rate_buckets_current.get(user_id, 0)
    previous = _token_rate_buckets_previous.get(user_id, 0)
    weighted = current + previous * prev_weight
    if weighted >= _TOKEN_RATE_LIMIT:
        return False
    _token_rate_buckets_current[user_id] = current + 1
    return True

router = APIRouter()

# Highest per-user stream slot. Slots 0.._SLOT_MAX — one user may run that many
# HQ streams at once (e.g. one per monitor). The path/key schema, auth-hook and
# poller already generalise to any slot; only this clamp limits it. Shared with
# chat-gateway via ``dcc_shared.streaming``, which carries the reasoning.
_SLOT_MAX = SLOT_MAX

# Grenzen der Bildschirm-NUMMER — nicht ``_SLOT_MAX`` (der begrenzt
# Stream-PLAETZE, nicht Monitore). Die beiden Zahlen sind verschieden (99
# gegen 8) und meinen Verschiedenes.
#
# Aus ``dcc_shared.streaming`` geholt, aus demselben Grund wie ``SLOT_MAX``:
# die Nummer entsteht am Geraete-Weg des chat-gateway
# (``ws_device_handlers.MAX_MONITORS``) und muss diesen Weg hier passieren.
# Eine eigene, weitere Schranke liesse Nummern durch, die beim Zuschauer nie
# einen gemeldeten Monitor treffen koennen. Beide Dienste validieren weiterhin
# unabhaengig (wie bei ``label``/``ten_bit``) — nur eben gegen dieselbe Zahl.
_MONITOR_INDEX_MIN = MONITOR_INDEX_MIN
_MONITOR_INDEX_MAX = MONITOR_INDEX_MAX

ChannelId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]
UserIdQuery = Annotated[str, Query(min_length=1, max_length=64, pattern=r"^\d+$")]
SlotQuery = Annotated[int, Query(ge=0, le=_SLOT_MAX)]


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The client's protocol WISH. Until 2026-08-02 this was pattern-locked to
    # "rtmp" and ignored; it is now honoured, but only UPWARDS (see the
    # resolution in ``issue_stream_token``). Kept next to the old comment about
    # instances mint WHIP URLs). SRT stays disabled: UDP has no TLS layer so the
    # stream token would be visible in cleartext in the SRT streamid field.
    protocol: Annotated[str, Field(default="rtmp", pattern=r"^(rtmp|whip)$")] = "rtmp"
    # Which of the caller's stream slots this token publishes. 0 == the default
    # single stream (legacy path/key shape); 1 == a second concurrent stream.
    slot: Annotated[int, Field(default=0, ge=0, le=_SLOT_MAX)] = 0
    # Optional human-readable label (e.g. ``"Monitor 1"``, ``"Chrome"``) the
    # streamer's client resolves from the chosen capture source. Surfaces in the
    # viewer's stream picker so someone running several streams can tell them
    # apart. Stripped + bounded here; empty/``None`` → omitted from the token
    # record so the legacy single-stream shape stays byte-identical.
    label: Annotated[str | None, Field(default=None, max_length=80)] = None
    # Welchen Bildschirm des Hosts dieser Strom zeigt (1-basiert — die 0 ist
    # beim Klienten als „keine Nummer" vergeben, s. ``MONITOR_INDEX_MIN`` in
    # ``dcc_shared.streaming``). Reist wie ``label`` weiter bis in den
    # Token-Record → auth-hook → ``stream:active`` → Poller, wo es dem
    # Zuschauer die Zuordnung Strom → Monitor eindeutig macht (der Name allein
    # kann das bei baugleichen Geraeten nicht).
    monitor_index: Annotated[
        int | None, Field(default=None, ge=_MONITOR_INDEX_MIN, le=_MONITOR_INDEX_MAX)
    ] = None
    # Sendet der Streamer mit 10 bit Farbtiefe? Fährt denselben Weg wie
    # ``label`` (Token-Record → auth-hook → ``stream:active``) und wird dem
    # Zuschauer in der WHEP-Antwort gemeldet: nur der native Player kann mehr
    # als 8 bit darstellen, und ohne diesen Hinweis wüsste der Zuschauer die
    # Tiefe erst NACH dem Dekodieren — also erst, nachdem er sich für einen
    # Wiedergabeweg entschieden hat. Fehlt das Feld (ältere Clients), gilt
    # 8 bit.
    ten_bit: bool = False
    # **Kann der Sidecar dieses Streamers Eingaben einspielen?** Reist genau wie
    # ``ten_bit`` mit bis zum Zuschauer — dort entscheidet sich, ob der Knopf
    # „Fernsteuerung anfragen" ueberhaupt erscheint. Der Wert kommt aus der
    # Fähigkeitsmeldung des Sidecars (``health.gsr.remote_input``), nicht aus
    # dem Betriebssystem des Streamers: massgeblich ist, was das Programm kann,
    # das die Frames am Ende einspielen muesste. Fehlt das Feld (Linux-Sidecar,
    # aeltere Clients), gilt ``False`` — fail-closed.
    remote_input: bool = False


class StreamTokenOut(BaseModel):
    token: str
    mediamtx_path: str
    push_protocol: str
    push_url: str
    expires_in_s: int


class StreamStateOut(BaseModel):
    channel_id: str
    user_ids: list[str] = []
    # Additive per-slot descriptors. Only populated once a user runs slot ≥ 1;
    # single-stream channels leave it empty and clients fall back to user_ids.
    streams: list[StreamDescriptor] = []
    since: str | None = None


class WhepOut(BaseModel):
    whep_url: str
    # Sendet dieser Stream mit 10 bit? Aus dem ``stream:active``-Record. Der
    # Zuschauer entscheidet daran, ob er den nativen Player nimmt (nur der
    # kann mehr als 8 bit ausgeben) oder das ``<video>``-Element.
    ten_bit: bool = False
    # Siehe ``StreamTokenIn.remote_input``. Aus dem ``stream:active``-Record.
    remote_input: bool = False


def _get_redis(request: Request) -> Redis:
    redis: Redis | None = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable")
    return redis


def _push_url(path: str, protocol: str, token: str) -> str:
    """Full push URL incl. the stream-token, ready for the HQ sidecar.

    RTMP: ``rtmps://host:port/<path>?user=pulse&pass=<token>`` —
          over TLS so the token isn't on the wire in cleartext; MediaMTX maps
          the query ``user``/``pass`` onto the authHTTP body.
    WHIP: ``{mediamtx_public_base}/<path>/whip?token=<token>`` — WebRTC ingest,
          mirrors the WHEP playback URL shape; the auth-hook reads the token
          from the query exactly like it does for WHEP reads.
    SRT:  ``srt://host:port?streamid=publish:<path>:pulse:<token>``.
    """
    s = get_settings()
    if protocol == "whip":
        return f"{s.mediamtx_public_base}/{path}/whip?token={token}"
    if protocol == "srt":
        return (
            f"srt://{s.mediamtx_ingest_host}:{s.mediamtx_srt_port}"
            f"?streamid=publish:{path}:pulse:{token}"
        )
    return (
        f"rtmps://{s.mediamtx_ingest_host}:{s.mediamtx_rtmps_port}"
        f"/{path}?user=pulse&pass={token}"
    )


@router.post("/channels/{channel_id}/stream-token", response_model=StreamTokenOut)
async def issue_stream_token(
    channel_id: ChannelId,
    payload: StreamTokenIn,
    user: CurrentUser,
    request: Request,
) -> StreamTokenOut:
    if not _check_token_rate(user.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="stream token rate limit exceeded")
    settings = get_settings()
    redis = _get_redis(request)
    user_id = str(user.id)
    # Push-Weg: der Server erzwingt, der Client darf zusaetzlich wuenschen —
    # aber nur NACH OBEN, also Richtung WHIP.
    #
    # Der Zwang bleibt, wozu er da ist: app-gehostete Instanzen setzen
    # MEDIAMTX_PUSH_PROTOCOL=whip, damit Gaeste ueber die NAT-durchstossende
    # WebRTC-Schicht publishen statt ueber TCP 1936, den sie hinter dem NAT des
    # Hosts gar nicht erreichen. Der Instanz-OWNER streamt auf die eigene
    # Maschine und behaelt den bewaehrten RTMPS-Weg.
    #
    # Der Wunsch kam 2026-08-02 dazu: ueber RTMPS fehlt der RTCP-Rueckkanal,
    # und ohne ihn wartet ein beitretender Zuschauer bis zum naechsten
    # regulaeren Vollbild auf sein erstes Bild.
    #
    # **Seit dem 2026-08-07 entscheidet auch der CODEC mit**, und darauf ist
    # beim Lesen der Zahlen zu achten: der Client wuenscht WHIP bei JEDEM
    # H.264-Stream (`web/.../settings.svelte.ts::pushProtokoll`, seit dem
    # 2026-08-18 ohnehin bei jedem). Grund ist `h264_amf`, das wegen
    # `usage=ultralowlatency` von sich aus auffrischt — der Strom hat dann kaum
    # Vollbilder, obwohl niemand welche abbestellt hat. In der Produktion am
    # 2026-08-07 belegt: 0 dekodierte Bilder ueber RTMPS gegen 2681 ueber WHIP,
    # derselbe Kanal, dieselben Minuten. Der RTMPS-Anteil faellt dadurch stark;
    # das ist die Ursache, kein Messfehler.
    #
    # Warum der Wunsch die Owner-Ausnahme schlaegt: die Ausnahme ist eine
    # Bequemlichkeit (der bewaehrte Weg, wo er ohnehin funktioniert), keine
    # Sicherheitsgrenze. Bliebe sie staerker, bekaeme ausgerechnet der Betreiber
    # einer Instanz den Rueckkanal auf ihr nie.
    #
    # Und warum nur nach oben: ein Client, der RTMPS wuenscht, wo der Server
    # WHIP erzwingt, wuerde sich damit den Weg abschneiden, der auf dieser
    # Instanz ueberhaupt funktioniert.
    wunsch_whip = payload.protocol == "whip"
    protocol = settings.mediamtx_push_protocol
    if user_id == settings.pulse_instance_owner_id and not wunsch_whip:
        protocol = "rtmp"
    if wunsch_whip:
        protocol = "whip"
    token = secrets.token_urlsafe(32)
    # Fresh nonce per token → fresh MediaMTX path per publish (see
    # ``streamkeys.py`` for why). 32 hex = 128 bits = offline path-guessing
    # infeasible even for a well-resourced attacker.
    nonce = secrets.token_hex(16)
    slot = payload.slot
    path = path_for_channel_user(channel_id, user_id, nonce, slot=slot)
    record = {
        "channel_id": channel_id,
        "user_id": user_id,
        "nonce": nonce,
        "scope": "publish",
        "protocol": protocol,
        "created_at": int(time.time()),
    }
    # Slot 0 omits the field so the token record stays byte-identical to the
    # legacy single-stream shape (the auth-hook reads a missing slot as 0).
    if slot:
        record["slot"] = slot
    # Label rides the token record → the auth-hook copies it into
    # ``stream:active`` on publish-auth → the poller surfaces it in
    # ``stream:channel``/``stream:events``. Omitted when empty (legacy shape).
    label = (payload.label or "").strip()
    if label:
        record["label"] = label
    if payload.monitor_index is not None:
        record["monitor_index"] = payload.monitor_index
    # Wie ``label``: nur bei True mitschreiben, damit der Record im Normalfall
    # byte-identisch zur alten Form bleibt.
    if payload.ten_bit:
        record["ten_bit"] = True
    if payload.remote_input:
        record["remote_input"] = True
    await redis.set(
        TOKEN_KEY.format(token=token),
        json.dumps(record, separators=(",", ":")),
        ex=settings.token_ttl_s,
    )
    # A new publish intent cancels any pending explicit-stop suppression for this
    # (channel, user, slot) — otherwise a quick stop→restart would stay invisible
    # until the tombstone's TTL lapsed (the poller would keep skipping the slot).
    await redis.delete(stopping_key(channel_id, user_id, slot))
    log.info(
        "stream_token_issued",
        channel_id=channel_id,
        user_id=user.id,
        slot=slot,
        protocol=protocol,
    )
    return StreamTokenOut(
        token=token,
        mediamtx_path=path,
        push_protocol=protocol,
        push_url=_push_url(path, protocol, token),
        expires_in_s=settings.token_ttl_s,
    )


@router.get("/channels/{channel_id}/stream", response_model=StreamStateOut)
async def get_stream_state(
    channel_id: ChannelId,
    user: CurrentUser,
    request: Request,
) -> StreamStateOut:
    redis = _get_redis(request)
    raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=channel_id))
    if raw is None:
        return StreamStateOut(channel_id=channel_id)
    data = _parse_state(raw)
    if data is None:
        return StreamStateOut(channel_id=channel_id)
    uids = [str(u) for u in (data.get("user_ids") or []) if u]
    streams = [StreamDescriptor(**d) for d in streams_from_state(data)]
    return StreamStateOut(
        channel_id=channel_id, user_ids=uids, streams=streams, since=data.get("since")
    )


def _text(wert: bytes | str | None) -> str:
    """Redis-Antwort als Text (die Klienten liefern je nach Aufbau bytes)."""
    if wert is None:
        return ""
    return wert.decode() if isinstance(wert, bytes) else str(wert)


# Ein Lese-Token bestimmen — Zeiger und Datensatz in EINEM Schritt.
#
# **Warum Lua und nicht drei Redis-Rufe.** Der Bann in chat-gateway
# (``stream_revoke.py``) findet die Token eines Zuschauers AUSSCHLIESSLICH ueber
# die Nachschlage-Schluessel: ``scan_iter`` auf ``stream:read-cache:<viewer>:*``,
# dann ``mget``, dann beides loeschen. Ein ausgehaendigtes Token, auf das kein
# Zeiger zeigt, ist damit bis zu eine Stunde lang nicht sperrbar — es gibt
# keinen zweiten Weg zu ihm (der Datensatz kennt Kanal und Streamer, aber nicht
# den Zuschauer). Die Sperre baut also auf einer Zuordnung Zeiger→Token auf, und
# wer sie herstellt, muss sie auch unteilbar herstellen.
#
# Mit einzelnen Rufen ging das zweimal schief: ein Aufruf, der einen verwaisten
# Zeiger raeumt, loescht dabei womoeglich den frisch geschriebenen Zeiger eines
# anderen, dessen Token schon beim Zuschauer ist; und ein Zeiger, der ohne NX
# geschrieben wird, ueberschreibt den eines fremden Gewinners. Beide Male bleibt
# genau das zurueck, was der Bann nicht mehr findet. Im Skript gibt es diese
# Zwischenraeume nicht.
#
# Was das Skript zusagt:
#   * **Zeiger lebt mindestens so lange wie sein Datensatz.** Beim Wiederbeleben
#     wird die Laufzeit des Zeigers deshalb mitgezogen; ein Datensatz, der
#     seinen Zeiger ueberlebte, waere wieder unsperrbar.
#   * **Heil gefundene Paare werden nicht angefasst** — sonst verlaengerte
#     jedes ``GET /whep`` die Laufzeit, und das Token eines dauerhaft
#     zuschauenden Zuschauers wechselte nie.
#   * **Ein verwaister Zeiger wird geheilt, nicht ausgeliefert.** Verwaist heisst
#     hier: Zeiger da, Datensatz weg (Speicherdruck hat ``stream:token:*``
#     verdraengt). Geheilt wird durch Wiederbeleben DESSELBEN Tokens statt durch
#     ein neues — es gehoert ohnehin diesem Zuschauer, und ein neues verlangte
#     wieder ein Loeschen des fremden Zeigers. Ein vom BANN geloeschtes Token
#     kann so nicht auferstehen: der Bann loescht Zeiger und Datensatz in einem
#     einzigen ``DELETE``, es gibt den Zwischenzustand nicht.
_LUA_LESE_TOKEN = """
local zeiger = redis.call('GET', KEYS[1])
if zeiger then
  if redis.call('EXISTS', ARGV[1] .. zeiger) == 1 then
    return zeiger
  end
  redis.call('SET', ARGV[1] .. zeiger, ARGV[2], 'EX', ARGV[3])
  redis.call('SET', KEYS[1], zeiger, 'EX', ARGV[3])
  return zeiger
end
redis.call('SET', ARGV[1] .. ARGV[4], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[3])
return ARGV[4]
"""

# Der Namensraum der Token-Schluessel, wie ihn das Skript zum Anhaengen braucht.
_TOKEN_PRAEFIX = TOKEN_KEY.format(token="")


async def _read_token_fuer(
    redis: Redis,
    viewer_id: str,
    channel_id: str,
    user_id: str,
    slot: int,
) -> str:
    """Das WHEP-Lese-Token fuer genau ein (Zuschauer, Kanal, Streamer, Platz).

    Deterministisch statt je Anfrage frisch: ein Zuschauer in einer
    Wiederverbindungs-Schleife haeufte sonst pro Anlauf einen lebenden
    Redis-Schluessel an (je 1 h TTL), ohne dass sich am Umfang des Tokens
    etwas aenderte.

    Sicherheit: Lese-Token sind **nicht** einmalig — der auth-hook nimmt sie
    ueber die ganze TTL an und verbraucht sie nicht (WHEP macht OPTIONS +
    POST + Wiederverbindungen mit demselben Token).  Ein vorhandenes Token
    weiterzugeben ist deshalb gleichwertig damit, ein neues auszustellen;
    beide sind an Kanal und Streamer gebunden, nicht an den Zuschauer.

    Die Reihenfolge und die Unteilbarkeit begruendet ``_LUA_LESE_TOKEN``: was
    hier herauskommt, muss der Bann in chat-gateway finden koennen.
    """
    s = get_settings()
    # Form in `dcc_shared.streaming` — chat-gateway loescht diese Schluessel
    # beim Bann, und zwei Fassungen davon waeren eine stille Fehlerquelle.
    cache_key = read_cache_key(viewer_id, channel_id, user_id, slot)
    read_record = json.dumps(
        {
            "channel_id": channel_id,
            "user_id": user_id,
            "scope": "read",
            "protocol": "webrtc",
            "created_at": int(time.time()),
        },
        separators=(",", ":"),
    )
    return _text(
        await redis.eval(  # type: ignore[arg-type]
            _LUA_LESE_TOKEN,
            1,
            cache_key,
            _TOKEN_PRAEFIX,
            read_record,
            str(s.read_token_ttl_s),
            secrets.token_urlsafe(32),
        )
    )


@router.get("/channels/{channel_id}/whep", response_model=WhepOut)
async def get_whep_url(
    channel_id: ChannelId,
    user_id: UserIdQuery,
    user: CurrentUser,
    request: Request,
    slot: SlotQuery = 0,
) -> WhepOut:
    """WHEP URL for ``user_id``'s live stream in ``channel_id``.

    The MediaMTX path now carries a per-publish nonce, so we can't compute it
    from (cid, uid) alone — we read ``stream:active:channel-<cid>-<uid>`` which
    the auth-hook updates on every successful publish-auth. 404 if there's no
    live publisher for that user; the WhepPlayer treats that the same as a
    publisher-not-up situation and keeps retrying.

    ``user`` (the verified bearer) is required even though the VIEW_CHANNEL
    check lives in chat-gateway: without it, a deployment that exposes
    media-svc directly (the self-host Caddy used to) hands the nonce'd WHEP
    URL to unauthenticated callers.
    """
    redis = _get_redis(request)
    raw = await redis.get(active_key(channel_id, user_id, slot))
    if raw is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    data = _parse_state(raw)
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    path = data.get("path")
    if not isinstance(path, str) or not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    s = get_settings()

    read_token = await _read_token_fuer(redis, str(user.id), channel_id, user_id, slot)
    base = s.mediamtx_public_base.rstrip("/")
    return WhepOut(
        whep_url=f"{base}/{path}/whep?token={read_token}",
        ten_bit=data.get("ten_bit") is True,
        remote_input=data.get("remote_input") is True,
    )


@router.delete("/channels/{channel_id}/stream", status_code=status.HTTP_204_NO_CONTENT)
async def stop_stream(
    channel_id: ChannelId,
    user: CurrentUser,
    request: Request,
    slot: Annotated[int | None, Query(ge=0, le=_SLOT_MAX)] = None,
) -> Response:
    """Explicit stop of the *caller's own* HQ stream(s) in ``channel_id``.

    ``slot`` omitted → stop *all* of the caller's slots (the normal "stop
    streaming" click); ``slot=N`` → stop only that one stream, leaving the
    caller's other slot live.

    The media plane (WebRTC) stalls the instant the HQ sidecar stops pushing,
    but presence is otherwise derived by polling MediaMTX every few seconds —
    and MediaMTX keeps the path "ready" until its own publisher-disconnect
    detection fires (~readTimeout). So without this, the "live" badge lingers
    ~10-16s after the user clicked stop. This clears it immediately:

      1. set a short ``stream:stopping`` tombstone so the poller won't re-add the
         user from a MediaMTX path that hasn't dropped yet (see poller),
      2. drop the user's ``stream:active`` record,
      3. recompute the channel's streamer set without them and publish the
         updated ``stream:events`` now.

    The user is identified by the verified bearer, so a caller can only stop
    their own stream. The poller stays the backstop for crash/network-drop
    (no clean stop) cases."""
    settings = get_settings()
    redis = _get_redis(request)
    uid = str(user.id)
    targets = [slot] if slot is not None else list(range(_SLOT_MAX + 1))

    # Gepipelined statt einzeln: schon vier Slots waren acht sequentielle
    # Round-Trips für einen einzigen Stop-Klick. Dasselbe Muster begründet der
    # Poller für sich schon ("reduces O(N) sequential round-trips to O(1)").
    #
    # Ohne ``slot`` geht das über ALLE Slots bis ``_SLOT_MAX``, nicht nur über
    # die laufenden — welche Pfade MediaMTX noch führt, weiß hier niemand, und
    # genau dagegen ist der Grabstein gedacht. Bei einer Obergrenze von 99 sind
    # das rund hundert Schreibvorgänge je Stop-Klick, die meisten für Slots, die
    # nie existiert haben; sie verfallen nach ``stop_suppression_s`` von selbst.
    # In Kauf genommen, weil der Klick selten ist und alles in EINEM Round-Trip
    # geht. Die Löschungen gehen als ein ``DEL k1 k2 …``; das ``SET`` kann das
    # wegen der Ablaufzeit je Schlüssel nicht.
    pipe = redis.pipeline()
    for s in targets:
        pipe.set(stopping_key(channel_id, uid, s), "1", ex=settings.stop_suppression_s)
    pipe.delete(*(active_key(channel_id, uid, s) for s in targets))
    await pipe.execute()

    raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=channel_id))
    remaining_uids: list[str] = []
    remaining_streams: list[dict[str, Any]] = []
    since: str | None = None
    if raw is not None:
        data = _parse_state(raw)
        if data is not None:
            since = data.get("since")
            old_streams = streams_from_state(data)
            if old_streams:
                # Slot-aware state: drop the targeted (uid, slot) descriptors and
                # recompute the user set from what survives.
                remaining_streams = [
                    d
                    for d in old_streams
                    if not (d["user_id"] == uid and (slot is None or d["slot"] == slot))
                ]
                remaining_uids = sorted({d["user_id"] for d in remaining_streams})
            else:
                # Legacy single-stream state: no per-slot info, so any stop drops
                # the whole user (matches the pre-slot behaviour).
                remaining_uids = sorted(
                    str(u) for u in (data.get("user_ids") or []) if u and str(u) != uid
                )

    # ``streams`` is only meaningful while it says more than ``user_ids``
    # already does; once nothing extra survives we drop it and the legacy shape
    # returns. **Same condition as the poller's ``_needs_streams``** — a stream
    # carrying a ``label`` or a ``monitor_index`` needs the list even on slot 0,
    # otherwise the viewer loses the screen number the moment a second streamer
    # stops (and the poller would have to put it back on its next pass).
    multi = any(
        d["slot"] >= 1 or "label" in d or "monitor_index" in d for d in remaining_streams
    )
    publish_streams = remaining_streams if multi else None
    if remaining_uids:
        new_state: dict[str, Any] = {
            "user_ids": remaining_uids,
            "since": since or datetime.now(UTC).isoformat(),
        }
        if multi:
            new_state["streams"] = remaining_streams
        await redis.set(
            CHANNEL_STATE_KEY.format(channel_id=channel_id),
            json.dumps(new_state, separators=(",", ":")),
            ex=settings.channel_state_ttl_s,
        )
    else:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=channel_id))

    await _publish_event(redis, channel_id, remaining_uids, streams=publish_streams)
    log.info(
        "stream_stopped",
        channel_id=channel_id,
        user_id=user.id,
        slot=slot,
        remaining=len(remaining_uids),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
