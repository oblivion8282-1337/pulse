"""Gemeinsame Pruefungen der Postfach-Routen (Etappe D/E, E2E-DM).

Herausgeloest aus ``routes/postfach.py``, als diese mit den verschluesselten
Anhaengen (Etappe E) ueber die Groessen-Policy (PLAN.md §12.1) gewachsen
waere. Der Umzug selbst aenderte kein Verhalten — die vier Namen blieben
ueber ``routes/postfach.py`` erreichbar, weil die Datei sie importiert; die
bestehenden Aufrufer (``routes/postfach_abholen.py``, Tests) brauchten
deshalb keine Aenderung.

**Seither einmal erweitert (Etappe G2):** ``_channel_zugriff_pruefen`` traegt
neben DMs jetzt auch private Gruppen und gibt statt des Kanalobjekts die
Teilnehmermenge zurueck — s. dort.

**Bughunt 2026-08-28/29 (belegter Fehler):** der Rueckgabewert ist seither
``KanalZugriff`` statt eines nackten ``set[int]`` — er traegt zusaetzlich
``ist_dm``. Der einzige Aufrufer, der die Kanalart braucht
(``routes/postfach.py``, die Empfaenger-Schleife), unterscheidet damit, WIE
ein Empfaengergeraet ausserhalb der Teilnehmermenge behandelt wird — s. dort.
"""

from __future__ import annotations

import base64
from collections.abc import Collection
from typing import NamedTuple

from fastapi import HTTPException
from sqlalchemy import select

from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import DeviceKeyBundle
from dcc_chat_gateway.private_gruppen_zugriff import gruppen_teilnehmer
from dcc_chat_gateway.routes._deps import resolve_channel_for_user


class KanalZugriff(NamedTuple):
    """Ergebnis von ``_channel_zugriff_pruefen``: die Konten, an die
    zugestellt werden darf, plus die Kanalart — s. Modul-Docstring."""

    teilnehmer: set[int]
    ist_dm: bool


async def _channel_zugriff_pruefen(session, channel_id: int, user_id: int) -> KanalZugriff:
    """Die Konten, in deren Geraete-Postfaecher dieser Kanal zustellen darf,
    plus die Kanalart (``ist_dm``).

    Zwei Kanalarten, zwei Regeln:

    * **DM** — dieselbe Regel wie ``ws_op_send.py:139-151``: DM-Kanal laden,
      fehlt er oder ist der Nutzer nicht Mitglied -> abweisen. Ein
      Durchfallen wuerde das Freundschafts-/Block-Gate ueberspringen und eine
      verwaiste Zustellung schreiben.
    * **Private Gruppe** (Etappe G2) — Mitgliedschaft entscheidet, sonst
      nichts. **Kein Freundschafts-Gate**: eine Gruppe ist kein Freundespaar,
      und die Mitglieder sind untereinander in aller Regel nicht befreundet.
      **Und kein Block-Gate beim Senden**: geprueft wird eine Blockierung
      dort, wo sie ihre Wirkung entfalten kann — beim HINZUFUEGEN
      (``routes/private_gruppen.py``, ``block_exists_either_way``). Wer
      spaeter blockt, bleibt Mitglied; ihn hier von der Zustellung
      auszunehmen, hiesse seinen Gruppenschluessel veralten zu lassen, ohne
      dass er oder der Absender es merkt — er saehe ab dann eine Gruppe, in
      der niemand mehr schreibt. Das Ausblenden geblockter Absender gehoert
      in die Anzeige, nicht in die Zustellung — und liegt dort seit dem
      Bughunt-Nachtrag 2026-08-29 auch tatsaechlich: ``MessageItem.svelte``
      klappt eine Nachricht eines blockierten Absenders zusammen
      (``nachrichtVonBlockiertem``, ``web/src/lib/nachrichten/blockierteAnzeige.ts``).
      Bis dahin gab es diese Anzeige-Seite nicht, und der Kommentar hier
      behauptete eine Kompensation, die nirgends existierte.

    **Der Rueckgabewert traegt die Teilnehmermenge UND die Kanalart, nicht
    den Kanal.** Der einzige Aufrufer, der ihn auswertet
    (``routes/postfach.py``), brauchte vom DM-Objekt ohnehin nur die beiden
    Konto-IDs; mit einer dritten Kanalart gaebe es kein gemeinsames Objekt
    mehr, das beide Faelle traegt. ``ist_dm`` entscheidet dort, WIE ein
    Empfaengergeraet ausserhalb der Teilnehmermenge behandelt wird — s. den
    Kommentar an der Empfaenger-Schleife dort. ``routes/postfach_anhaenge.py``
    wertet den Rueckgabewert nicht aus (reine Zugangs-Pruefung).

    Eine Gilden-Kanal-ID faellt weiterhin durch — das Postfach traegt DMs und
    private Gruppen, keine Community-Kanaele (Spec §9: „oeffentlich und
    geteilt -> wie bisher")."""
    resolved = await resolve_channel_for_user(session, channel_id, user_id)
    if resolved is not None and resolved[0] == "dm":
        dm_obj = resolved[1]
        other = dm_obj.user_b_id if dm_obj.user_a_id == user_id else dm_obj.user_a_id
        if await block_exists_either_way(session, user_id, other):
            raise HTTPException(status_code=403, detail="blocked")
        if not await friendship_exists(session, user_id, other):
            raise HTTPException(status_code=403, detail="not_friends")
        return KanalZugriff(teilnehmer={dm_obj.user_a_id, dm_obj.user_b_id}, ist_dm=True)

    # ``resolve_channel_for_user`` kennt private Gruppen nicht (und soll es
    # vorerst auch nicht, s. Modulkopf von ``private_gruppen_zugriff.py``) —
    # eine Gruppen-ID kommt hier deshalb als ``None`` an, nicht als dritte
    # Kanalart. Nur dieser Fall wird nachgeschlagen; eine Gilden-Kanal-ID
    # (``resolved[0] == "guild"``) faellt unveraendert durch.
    if resolved is None:
        mitglieder = await gruppen_teilnehmer(session, channel_id, user_id)
        if mitglieder is not None:
            return KanalZugriff(teilnehmer=mitglieder, ist_dm=False)
    raise HTTPException(status_code=403, detail="channel_not_accessible")


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
    Gleichheitszeichen (dasselbe Muster wie
    ``routes/kopplung_umzug.py::_stueck_groesse``, das denselben Krypto-Kern
    entgegennimmt).
    """
    try:
        return len(base64.b64decode(daten_b64 + "==", validate=False))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="ungueltige_nutzlast") from exc


__all__ = [
    "KanalZugriff",
    "_bundle_laden",
    "_channel_zugriff_pruefen",
    "_envelope_groesse",
]
