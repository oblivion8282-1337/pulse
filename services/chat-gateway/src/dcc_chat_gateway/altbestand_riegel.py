"""Startverweigerung, wenn dieser Server noch Daten aus der Pseudonym-Zeit trägt.

Warum es das gibt
-----------------
Bis zum 2026-08-28 führte ein Self-Host je Nutzer eine **serverabhängige**
Kennung: ein Base64url-Pseudonym in ``instance_members.user_identifier``, und
davon abgeleitet eine synthetische Zahl in ``guild_members.user_id``,
``messages.author_id``, ``guilds.owner_id`` und einem Dutzend weiterer Spalten.
Mit dem Ticket-Weg ist die Kennung die Cloud-Kennung selbst.

**Zwischen beiden gibt es keinen Übergang mehr.** Es gab einmal einen
(``identitaet_umschreiben``); er ist entfallen, weil entschieden wurde, die
bestehenden Server neu aufzusetzen.

Das Problem an dieser Entscheidung ist nicht sie selbst, sondern dass sie eine
Handlung verlangt, die niemand auslöst: Ein Self-Host zieht sich sein Update
**alle fünf Minuten unbeaufsichtigt** (systemd-Timer, s. ``install.sh``). Ohne
diesen Riegel liefe er nach dem Update einfach an — und wäre still halb kaputt:
Jedes Mitglied fällt durch ``is_member``, bekommt ``join_not_permitted``, und
selbst der Betreiber (der über ``PULSE_INSTANCE_OWNER_ID`` wieder Admin wird)
besitzt keine einzige seiner Communities mehr, weil ``guilds.owner_id`` auf die
alte Zahl zeigt.

Ein Server, der nicht startet, ist in dieser Lage das mildere Ergebnis: Der
Betreiber sieht sofort, was zu tun ist, statt Fehlern nachzujagen, die aussehen
wie ein Rechteproblem.

Warum die Erkennung exakt ist
-----------------------------
Ein Pseudonym ist Base64url (16 Zeichen, enthält fast immer Buchstaben), eine
Cloud-Kennung ist eine Dezimalzahl. Geprüft wird deshalb auf **nicht-numerisch**
— keine Heuristik über Länge oder Zeichensatz. Ein leerer Bestand ist kein
Altbestand; ein frisch aufgesetzter Server läuft an.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

MELDUNG = (
    "Dieser Server traegt noch Nutzerdaten aus der Zeit vor dem Ticket-Weg "
    "(2026-08-28): {anzahl} Eintraege in chat.instance_members fuehren ein "
    "serverabhaengiges Pseudonym statt der Cloud-Kennung.\n"
    "\n"
    "Es gibt keinen Uebergang zwischen beiden Formen. Wuerde dieser Server "
    "starten, waere er still halb kaputt: Jedes Mitglied fiele durch die "
    "Beitrittspruefung, und selbst dir gehoerte keine deiner Communities mehr "
    "(guilds.owner_id zeigt auf die alte Kennung).\n"
    "\n"
    "Was zu tun ist: Diesen Server neu aufsetzen. Die Anleitung steht unter "
    "https://howispulse.com/self-host. Willst du die alten Daten vorher sichern, "
    "leg jetzt eine Kopie der Datenbank an — der Server startet bis dahin nicht."
)


async def pruefe_altbestand(session_factory: Any) -> None:
    """Wirft ``RuntimeError``, wenn Alt-Kennungen in der Datenbank stehen.

    Fehler beim Prüfen selbst (Tabelle fehlt, DB noch nicht migriert) sind
    **kein** Altbestand und lassen den Start durch: Ein frischer Server hat die
    Tabelle unter Umständen noch gar nicht.
    """
    try:
        async with session_factory() as session:
            anzahl = (
                await session.execute(
                    text(
                        "SELECT count(*) FROM instance_members "
                        "WHERE user_identifier NOT GLOB '[0-9]*'"
                        if session.bind.dialect.name == "sqlite"
                        else "SELECT count(*) FROM instance_members "
                        "WHERE user_identifier !~ '^[0-9]+$'"
                    )
                )
            ).scalar_one()
    except Exception:  # noqa: BLE001
        return

    if anzahl:
        raise RuntimeError(MELDUNG.format(anzahl=anzahl))
