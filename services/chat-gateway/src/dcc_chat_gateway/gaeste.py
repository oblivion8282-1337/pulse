"""Gast-Zustand und Gast-Ticket-Beschaffung.

Ein Gast hat kein Konto und keine Zeile in der Datenbank. Was von ihm
existiert, lebt in Redis und stirbt mit seinem Ticket:

    gast:<gast_id>           HASH {name, link_id, channel_id, guild_id}
    gast:gesperrt:<gast_id>  "1"          (Rauswurf, hält bis Ticket-Ablauf)
    gast:link:<link_id>      SET gast_id  (wen die Entwertung rauswerfen muss)

Alle drei tragen dieselbe TTL wie das Ticket. Der Zustand darf nie länger
leben als die Berechtigung, sonst müsste ihn jemand aufräumen — und dieser
Jemand fällt irgendwann aus.

**Der Name des Gastes ist selbst getippt und nicht verifiziert.** Er steht
hier, damit voice-signaling ihn in die Präsenz schreiben kann (die
Mitglieder-Oberfläche kann für eine Gast-ID nirgendwo ein Profil
nachschlagen). Jede Anzeige markiert ihn als Gast.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from typing import Any

import httpx
from fastapi import HTTPException, status

from dcc_shared import gaeste as _geteilt

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.zeit import als_utc  # noqa: F401 — Weiterreichung für die Gast-Routen

log = logging.getLogger(__name__)

def code_hash(code: str) -> str:
    """SHA-256-Hex eines Link-Codes. In der Datenbank steht nur das."""
    return hashlib.sha256(code.encode()).hexdigest()


def neuer_code() -> str:
    """Ein Link-Code mit 128 bit Zufall (22 Zeichen URL-sicher).

    Nicht zu erraten — die Ratenbremse auf den anonymen Routen schützt
    deshalb die Datenbank, nicht den Code.
    """
    return secrets.token_urlsafe(16)


# ---------------------------------------------------------------------------
# Ratenbremse für die anonymen Routen
# ---------------------------------------------------------------------------


async def bremse(redis: Any, schluessel: str, limit: int, fenster_s: int) -> bool:
    """True = erlaubt. Zählt ``schluessel`` in einem festen Fenster.

    Warum Redis und nicht ``ratelimit.py``: der dortige Zähler hängt an einer
    Nutzer-ID und lebt im Prozess. Die Gast-Routen haben keine Nutzer-ID, und
    hinter mehreren Instanzen wäre ein Prozess-Zähler ein Zähler pro Instanz.

    Fail-open bei Redis-Ausfall — wie die übrige Präsenzschicht. Eine
    Ratenbremse, die bei Störung die Tür zumauert, verwandelt einen
    Redis-Ausfall in einen Totalausfall der Besprechungen.
    """
    if redis is None:
        return True
    try:
        n = await redis.incr(schluessel)
        # ``nx=True`` statt ``if n == 1``: der Zähler und seine Frist sind zwei
        # Befehle, und dazwischen kann etwas dazwischenkommen. Schlug das
        # ``expire`` beim ersten Aufruf fehl, blieb der Schlüssel OHNE Frist
        # liegen — er zählte weiter, lief nie ab, und die IP wäre dauerhaft
        # ausgesperrt gewesen. So bekommt auch ein fristloser Altbestand beim
        # nächsten Aufruf seine Frist, und ein bereits laufendes Fenster wird
        # nicht verlängert (sonst hielte ein bestürmender Aufrufer sich selbst
        # unbegrenzt im Sperrzustand — und den Nachbarn hinter derselben IP
        # gleich mit).
        await redis.expire(schluessel, fenster_s, nx=True)
        return n <= limit
    except Exception:  # noqa: BLE001 — Redis-Transportfehler
        return True


async def bremse_pruefen(
    redis: Any, *, ip: str | None, code_h: str, aktion: str
) -> None:
    """429, wenn ein Aufrufer zu oft klopft. Zwei Zähler, zwei Angriffe:

    * pro IP — jemand probiert viele Codes durch;
    * pro Code — viele Quellen probieren denselben Code (oder ein geteilter
      Link wird von einem Skript bestürmt).
    """
    if ip and not await bremse(redis, f"gast:rate:ip:{aktion}:{ip}", 30, 60):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen"
        )
    if not await bremse(redis, f"gast:rate:code:{aktion}:{code_h}", 60, 60):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen"
        )


# ---------------------------------------------------------------------------
# Ticket beim auth-svc holen
# ---------------------------------------------------------------------------


async def ticket_holen(
    *,
    gast_id: str,
    guild_id: int,
    channel_id: int,
    name: str,
    ttl_s: int,
    http: httpx.AsyncClient | None = None,
) -> tuple[str, int]:
    """Gast-Ticket bei auth-svc bestellen. Gibt ``(token, ttl)`` zurück.

    chat-gateway unterschreibt selbst nichts: den RS256-Schlüssel hält
    auth-svc, und dessen JWKS ist das einzige Vertrauensverhältnis, das
    voice-signaling und media-svc in beiden Betriebsarten schon haben.
    """
    settings = get_settings()
    if not settings.internal_service_secret:
        # Ohne das Dienst-Geheimnis kann auth-svc den Aufruf nicht annehmen.
        # Deutlich scheitern statt eine kaputte Besprechung anzubieten.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="guest links unavailable — INTERNAL_SERVICE_SECRET not set",
        )
    ttl = max(_geteilt.TICKET_MIN_TTL_S, min(int(ttl_s), _geteilt.TICKET_MAX_TTL_S))
    url = settings.auth_svc_url.rstrip("/") + "/internal/guest-token"
    body = {
        "gast_id": gast_id,
        "guild_id": str(guild_id),
        "channel_id": str(channel_id),
        "name": name,
        "ttl_s": ttl,
    }
    headers = {"X-Pulse-Internal-Secret": settings.internal_service_secret}
    try:
        if http is not None:
            resp = await http.post(url, json=body, headers=headers)
        else:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        log.warning("gast_ticket_auth_svc_unreachable", exc_info=exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="auth service unavailable"
        ) from exc
    if resp.status_code >= 400:
        log.warning("gast_ticket_abgelehnt status=%s", resp.status_code)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="could not issue guest ticket"
        )
    daten = resp.json()
    return daten["token"], int(daten.get("expires_in", ttl))


# ---------------------------------------------------------------------------
# Zustand
# ---------------------------------------------------------------------------


async def gast_eintragen(
    redis: Any,
    *,
    gast_id: str,
    name: str,
    link_id: int,
    guild_id: int,
    channel_id: int,
    ttl_s: int,
) -> None:
    """Den frisch ausgestellten Gast in Redis vermerken."""
    if redis is None:
        return
    try:
        key = _geteilt.GAST_KEY.format(gast_id=gast_id)
        await redis.hset(
            key,
            mapping={
                "name": name,
                "link_id": str(link_id),
                "guild_id": str(guild_id),
                "channel_id": str(channel_id),
            },
        )
        await redis.expire(key, ttl_s)
        link_key = _geteilt.GAST_LINK_KEY.format(link_id=link_id)
        await redis.sadd(link_key, gast_id)
        await redis.expire(link_key, ttl_s)
    except Exception:  # noqa: BLE001
        # Der Beitritt selbst hängt nicht daran: das Ticket ist ausgestellt,
        # der Gast kommt rein. Verloren geht die Anzeige seines Namens bei den
        # Mitgliedern und der Zugriff der Entwertung auf ihn — beides
        # unangenehm, aber kein Grund, die Besprechung zu verweigern.
        log.warning("gast_eintragen fehlgeschlagen gast_id=%s", gast_id)


async def gaeste_des_links(redis: Any, link_id: int) -> list[str]:
    """Die Gast-IDs, die über diesen Link beigetreten sind."""
    if redis is None:
        return []
    try:
        roh = await redis.smembers(_geteilt.GAST_LINK_KEY.format(link_id=link_id))
    except Exception:  # noqa: BLE001
        return []
    return [m.decode() if isinstance(m, bytes) else m for m in roh]



