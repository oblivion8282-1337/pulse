"""Die Ordner-Festigung, so weit sie IM Einliefer-Commit stattfindet
(Entwurf 2026-09-02 §3, Fixwelle 2 R1/R6).

Herausgeloest aus ``routes/postfach.py``, weil die Datei sonst ueber die
Groessen-Policy (``PLAN.md`` §12.1) gewachsen waere. Der Schnitt liegt an
einer Naht: das Einliefern selbst kennt nur noch drei Fragen an diesen Lauf
— zaehlt dieser Umschlag ueberhaupt, entsteht ein Marker, und welche
Nutzlasten bekommt die Hintergrundaufgabe.

**Zwei Entscheidungen stecken hier, und beide waren Befunde:**

1. **Der Marker geht in DENSELBEN Commit wie die Zustellungen.** Die
   Festigung laeuft erst nach der Antwort (``festigung_nachlaufen``);
   quittiert der Empfaenger schneller, loeschte ``postfach_quittung`` die
   Nutzlast, bevor der Hintergrundlauf sie ueberhaupt lesen konnte. Beide
   Loescher — Quittung und ``sweep_verwaiste_nutzlasten`` — schonen deshalb
   jede Nutzlast mit Nachtrag-Zeile.
2. **Dedupliziert wird ueber den Inhalt, nicht ueber die Reihenfolge.** Der
   Klient teilt eine Gruppennachricht ab 65 Zielgeraeten in mehrere
   Umschlaege mit bitgleichem ``daten`` (``gruppengeraete.ts``) und markiert
   sie alle mit ``archiv`` — sonst haenge die Festigung daran, dass
   ausgerechnet der markierte Block Empfaenger findet. Abgelegt werden darf
   trotzdem nur EINE Datei: der Dateiname ist die Nutzlast-ID, zwei Dateien
   liessen sich hinterher durch nichts mehr zusammenfuehren.

``daten`` verlaesst dieses Modul nie — gehasht wird nur, um Dubletten
INNERHALB einer Anfrage zu erkennen.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import AblageKanalNachtrag, AblageKanalOrdner


@dataclass
class Festigungslauf:
    """Buchhaltung der Festigung fuer GENAU EINE Einliefer-Anfrage."""

    #: Ob der Kanal einen Ordner hat, in den gefestigt werden kann.
    ist_ordner_kanal: bool
    #: Inhalts-Fingerabdruecke der ``archiv``-Umschlaege dieser Anfrage.
    _gesehen: set[str] = field(default_factory=set)
    #: Nutzlast-IDs fuer die Hintergrundaufgabe.
    ids: list[int] = field(default_factory=list)

    def bewerten(self, archiv: bool, daten: str) -> tuple[bool, bool]:
        """``(archiv_wirksam, marker_noetig)`` fuer einen Umschlag.

        ``archiv_wirksam`` ist der erste Umschlag eines Inhalts;
        ``marker_noetig`` zusaetzlich nur, wenn es einen Ordner gibt — sonst
        haette der Sweep eine Zeile, die er nur aufgeben kann.
        """
        if not archiv:
            return False, False
        fingerabdruck = hashlib.sha256(daten.encode()).hexdigest()
        wirksam = fingerabdruck not in self._gesehen
        self._gesehen.add(fingerabdruck)
        return wirksam, wirksam and self.ist_ordner_kanal

    def vermerken(
        self,
        session: AsyncSession,
        *,
        nutzlast_id: int,
        channel_id: int,
        archiv_wirksam: bool,
        marker_noetig: bool,
    ) -> None:
        """Merkt die Nutzlast fuer den Hintergrundlauf vor und haengt, wenn
        noetig, den Marker „Festigung offen" in DIESEN Commit."""
        if archiv_wirksam:
            self.ids.append(nutzlast_id)
        if marker_noetig:
            session.add(AblageKanalNachtrag(nutzlast_id=nutzlast_id, channel_id=channel_id))


async def festigungslauf_starten(
    session: AsyncSession, channel_id: int, nutzlasten: Sequence[object]
) -> Festigungslauf:
    """Fragt EINMAL je Anfrage, ob der Kanal ein Ordner-Kanal ist — und nur,
    wenn ueberhaupt ein Umschlag ``archiv`` traegt."""
    traegt_archiv = any(getattr(n, "archiv", False) for n in nutzlasten)
    ordner = await session.get(AblageKanalOrdner, channel_id) if traegt_archiv else None
    return Festigungslauf(ist_ordner_kanal=ordner is not None)


__all__ = ["Festigungslauf", "festigungslauf_starten"]
