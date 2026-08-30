"""Missbrauchs-Grenzen fuer das Geraete-Schluesselverzeichnis (Bughunt
2026-08-28, Missbrauch). Ausgelagert aus ``routes/schluessel.py``, damit die
Route unter der Groessen-Policy bleibt (``CLAUDE.md`` §Konventionen).

FIX 1 — ``platz_fuer_neues_geraet_schaffen``: ohne Obergrenze haeuft ein
Konto, das seine Geraetekennung oft wechselt (Neuinstallation, verlorenes
Geraet, geleerte IndexedDB), fuer immer Buendelzeilen an — es gibt keine
Stelle, die eine alte Zeile von sich aus loeschte. Das trifft nicht nur das
eigene Konto: ``POST /keys/claim`` laedt ALLE Buendel eines Ziels ohne
Deckel und tut je Buendel ein bewachtes Loeschen — wer die eigene
Geraeteliste aufblaeht, verteuert damit jede Anfrage jedes Kontakts.

FIX 2 — ``einmalschluessel_budget_uebrig``: ohne Deckel leert ~100 billige
``POST /keys/claim``-Aufrufe den gesamten Einmalschluessel-Vorrat eines
Ziels, danach faellt JEDER Absender (nicht nur der Angreifer) auf den
wiederverwendeten Rueckfallschluessel zurueck — keine Forward Secrecy mehr
je Sitzung.
"""

from __future__ import annotations

from sqlalchemy import delete, func, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.models import DeviceKeyBundle


async def platz_fuer_neues_geraet_schaffen(session, user_id: int) -> None:
    """Raeumt vor dem Anlegen eines NEUEN Buendels Platz, falls das Konto
    ``schluessel_max_buendel_je_konto`` schon erreicht hat.

    Evictiert das am laengsten nicht mehr BENUTZTE Buendel (LRU nach
    ``zuletzt_benutzt``, Migration 0077), NICHT das juengste — ein Geraet,
    das sich gerade neu anmeldet, ist der Fall, den man NICHT aussperren
    will. Vor Migration 0077 sortierte diese Funktion nach ``updated_at``
    (Zeitpunkt der letzten VEROEFFENTLICHUNG) — das trifft das falsche
    Geraet: ein treu angemeldetes Geraet veroeffentlicht sein Buendel nicht
    neu und sah deshalb genauso alt aus wie eines, das niemand mehr
    benutzt. ``zuletzt_benutzt`` wird bei JEDEM Geraete-Nachweis aufgefrischt
    (``schluessel_nachweis.py::pruefe_geraet``), nicht nur beim
    Veroeffentlichen, und traegt damit ein echtes "lebt noch"-Signal. Das
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
            .order_by(DeviceKeyBundle.zuletzt_benutzt, DeviceKeyBundle.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if aeltestes_id is not None:
        await session.execute(delete(DeviceKeyBundle).where(DeviceKeyBundle.id == aeltestes_id))


async def einmalschluessel_budget_uebrig(redis, anfragender_id: int, ziel_id: int) -> bool:
    """True, wenn der Anfragende fuer ``ziel_id`` im aktuellen Fenster noch
    einen Einmalschluessel verbrauchen darf.

    Fixed-Window-Zaehler in Redis (``INCR`` + einmaliges ``EXPIRE``) — kein
    Sliding-Window, das waere hier Overkill: ein Angreifer gewinnt hoechstens
    das erste Fenster einer neuen Periode, nie mehr, und die Kosten fuer den
    Server sind ein Redis-Key statt einer Zaehlerzeile mit bewachtem UPDATE.
    Zaehlt JEDEN Verbrauchsversuch, nicht nur erfolgreiche — ein Ziel ohne
    Vorrat soll das Budget des Anfragenden nicht schonen, sonst liesse sich
    das Budget durch Abklopfen leerer Buendel umgehen. Aufrufer laesst das
    eigene Konto aus (Multi-Geraet-Sync ist kein Angriff auf sich selbst,
    s. ``darf_schluessel_holen`` in ``schluessel_zugriff.py``)."""
    settings = chat_config.get_settings()
    schluessel = f"keys:claim-budget:{anfragender_id}:{ziel_id}"
    aktuell = await redis.incr(schluessel)
    if aktuell == 1:
        await redis.expire(schluessel, settings.schluessel_claim_fenster_sekunden)
    return aktuell <= settings.schluessel_claim_budget_je_ziel
