"""Missbrauchs-Grenzen fuer das Geraete-Schluesselverzeichnis (Bughunt
2026-08-28, Missbrauch). Ausgelagert aus ``routes/schluessel.py``, damit die
Route unter der Groessen-Policy bleibt (``CLAUDE.md`` §Konventionen).

FIX 1 — ``platz_fuer_neues_geraet_schaffen``: ohne Obergrenze haeuft ein
Konto, das seinen Geraete-Signierschluessel oft wechselt (Neuinstallation,
verlorenes Geraet), fuer immer Buendelzeilen an — ``DeviceKeyBundle`` haengt
bewusst an ``device_pubkey``, nicht an ``cert_id`` (s.
``models/geraete_schluessel.py``), und auth-svcs 20-Geraete-Grenze ist ein
ROLLIERENDES Fenster, das Zertifikate abloest, nie Buendel loescht. Das trifft
nicht nur das eigene Konto: ``POST /keys/claim`` laedt ALLE Buendel eines
Ziels ohne Deckel und tut je Buendel eine Redis-Abfrage plus ein bewachtes
Loeschen — wer die eigene Geraeteliste aufblaeht, verteuert damit jede
Anfrage jedes Kontakts.
"""

from __future__ import annotations

from sqlalchemy import delete, func, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.models import DeviceKeyBundle


async def platz_fuer_neues_geraet_schaffen(session, user_id: int) -> None:
    """Raeumt vor dem Anlegen eines NEUEN Buendels Platz, falls das Konto
    ``schluessel_max_buendel_je_konto`` schon erreicht hat.

    Evictiert das am laengsten nicht mehr aktualisierte Buendel (LRU nach
    ``updated_at``), NICHT das juengste — ein Geraet, das sich gerade neu
    anmeldet, ist der Fall, den man NICHT aussperren will; ein Buendel, das
    seit Wochen kein ``PUT /keys/bundle`` mehr gesehen hat, gehoert mit hoher
    Wahrscheinlichkeit zu einem Geraet, das nicht mehr existiert (der Rest
    der Codebase hat kein Signal "Geraet ist weg", s. Kommentar zum
    Sperrlisten-Filter in ``routes/schluessel.py::schluessel_abholen``). Das
    Loeschen der Buendelzeile nimmt ueber ``ON DELETE CASCADE``
    (``models/geraete_schluessel.py``) auch ihre Einmalschluessel mit."""
    settings = chat_config.get_settings()
    vorhandene = (
        await session.execute(
            select(func.count())
            .select_from(DeviceKeyBundle)
            .where(DeviceKeyBundle.user_id == user_id)
        )
    ).scalar_one()
    if vorhandene < settings.schluessel_max_buendel_je_konto:
        return
    aeltestes_id = (
        await session.execute(
            select(DeviceKeyBundle.id)
            .where(DeviceKeyBundle.user_id == user_id)
            .order_by(DeviceKeyBundle.updated_at, DeviceKeyBundle.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if aeltestes_id is not None:
        await session.execute(delete(DeviceKeyBundle).where(DeviceKeyBundle.id == aeltestes_id))
