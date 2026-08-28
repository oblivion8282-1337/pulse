"""Gemeinsame Pruefungen der Postfach-Routen (Etappe D/E, E2E-DM).

Herausgeloest aus ``routes/postfach.py``, als diese mit den verschluesselten
Anhaengen (Etappe E) ueber die Groessen-Policy (PLAN.md §12.1) gewachsen
waere. **Reiner Umzug, kein Verhalten geaendert** — die vier Namen bleiben
ueber ``routes/postfach.py`` erreichbar, weil die Datei sie importiert; die
bestehenden Aufrufer (``routes/postfach_abholen.py``, Tests) brauchten
deshalb keine Aenderung.
"""

from __future__ import annotations

import base64
from collections.abc import Collection

from fastapi import HTTPException, Request
from sqlalchemy import select

from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import DeviceKeyBundle, DirectMessageChannel
from dcc_chat_gateway.routes._deps import resolve_channel_for_user


def _require_redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="postfach_dienst_nicht_verfuegbar")
    return redis


async def _channel_zugriff_pruefen(
    session, channel_id: int, user_id: int
) -> DirectMessageChannel:
    """Dieselbe Regel wie ``ws_op_send.py:139-151``: DM-Kanal laden, fehlt er
    oder ist der Nutzer nicht Mitglied -> abweisen. Ein Durchfallen wuerde das
    Freundschafts-/Block-Gate ueberspringen und eine verwaiste Zustellung
    schreiben. Eine Gilden-Kanal-ID faellt hier ebenfalls durch — Postfach
    traegt heute nur DMs."""
    resolved = await resolve_channel_for_user(session, channel_id, user_id)
    if resolved is None or resolved[0] != "dm":
        raise HTTPException(status_code=403, detail="channel_not_accessible")
    dm_obj = resolved[1]
    other = dm_obj.user_b_id if dm_obj.user_a_id == user_id else dm_obj.user_a_id
    if await block_exists_either_way(session, user_id, other):
        raise HTTPException(status_code=403, detail="blocked")
    if not await friendship_exists(session, user_id, other):
        raise HTTPException(status_code=403, detail="not_friends")
    return dm_obj


async def _bundle_laden(
    session, device_pubkey: str, erlaubte_user_ids: Collection[int]
) -> DeviceKeyBundle | None:
    """Der Verzeichnis-Eintrag eines Geraets, oder ``None`` — ein Geraet ohne
    veroeffentlichtes Buendel ist Alltag (noch nicht veroeffentlicht, gerade
    abgemeldet), kein Fehler; wie damit umzugehen ist, entscheidet die
    jeweilige Aufrufstelle.

    **Skopiert auf ``erlaubte_user_ids``** — die DB-Eindeutigkeit ist das
    Paar ``(user_id, device_pubkey)`` (``UniqueConstraint`` in
    ``models/geraete_schluessel.py``), NICHT der Pubkey allein. Eine unscopte
    Suche wirft ``MultipleResultsFound``, sobald zwei Konten denselben Pubkey
    fuehren — erreichbar z. B. ueber ein geloeschtes und neu registriertes
    Konto, das denselben lokal gespeicherten Geraeteschluessel weiterbenutzt
    (Bughunt 2026-08-28, FIX 2) — und reisst damit die GANZE Anfrage mit,
    auch die Zustellung an jeden anderen, unbeteiligten Empfaenger."""
    return (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.device_pubkey == device_pubkey,
                DeviceKeyBundle.user_id.in_(erlaubte_user_ids),
            )
        )
    ).scalar_one_or_none()


def _envelope_groesse(daten_b64: str) -> int:
    """Bytes VOR der Base64-Kodierung — nie den Inhalt in der Fehlermeldung,
    nur, DASS er ungueltig war.

    **Padding nachtragen, sonst scheitert JEDER echte Umschlag.** Der
    Krypto-Kern kodiert mit vodozemacs ``base64_encode``
    (`STANDARD`-Alphabet, `NO_PAD` — `krypto/pulse-krypto/src/
    utilities/mod.rs`), liefert also nie ein Vielfaches von 4 Zeichen mit
    Fuellzeichen. Pythons ``b64decode`` verlangt Padding IMMER, auch mit
    ``validate=False`` (das Flag steuert nur, ob Zeichen ausserhalb des
    Alphabets stillschweigend uebersprungen werden) — ohne den Zusatz warf
    diese Funktion bei jeder echten Nutzlast, weil ``daten`` fast nie zufaellig
    auf ein Vielfaches von 4 laenge trifft. Ueberschuessiges Padding ignoriert
    Python anstandslos, deshalb reicht ein fester Anhang von zwei
    Gleichheitszeichen (dasselbe Muster wie ``schluessel_nachweis.py::_b64``
    fuer base64url-Werte aus demselben Krypto-Kern).
    """
    try:
        return len(base64.b64decode(daten_b64 + "==", validate=False))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="ungueltige_nutzlast") from exc


__all__ = [
    "_bundle_laden",
    "_channel_zugriff_pruefen",
    "_envelope_groesse",
    "_require_redis",
]
