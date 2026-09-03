"""Der dauerhafte Bestand eines verschluesselten Kanals, so weit er IM
Einliefer-Commit entsteht (Entwurf 2026-09-02 §3, Fixwelle 2 R1/R6,
Entscheidung 2026-09-03).

Herausgeloest aus ``routes/postfach.py``, weil die Datei sonst ueber die
Groessen-Policy (``PLAN.md`` §12.1) gewachsen waere. Der Schnitt liegt an
einer Naht: das Einliefern selbst kennt nur noch drei Fragen an diesen Lauf
— zaehlt dieser Umschlag ueberhaupt, was ist an ihm zu vermerken, und
welche Nutzlasten bekommt die Hintergrundaufgabe.

**Zwei Speicher, ein Urteil.** ``AblageKanalOrdner.speicher`` entscheidet,
wo der Bestand liegt:

* ``pulse`` — die Nutzlast SELBST ist der Bestand (Spalte ``archiv``). Kein
  Marker, keine Hintergrundaufgabe, keine fremde Cloud; die Leserouten
  beantworten Liste und Datei aus Postgres.
* ``nextcloud`` — der Umschlag wird nach der Antwort als Datei im
  Konto-Laufwerk des Erstellers abgelegt.

**Zwei Entscheidungen stecken hier, und beide waren Befunde:**

1. **Der Marker geht in DENSELBEN Commit wie die Zustellungen** (nur im
   Nextcloud-Weg). Die Festigung laeuft erst nach der Antwort
   (``festigung_nachlaufen``); quittiert der Empfaenger schneller,
   loeschte ``postfach_quittung`` die Nutzlast, bevor der Hintergrundlauf
   sie ueberhaupt lesen konnte. Beide Loescher — Quittung und
   ``sweep_verwaiste_nutzlasten`` — schonen deshalb jede Nutzlast mit
   Nachtrag-Zeile. Im Pulse-Weg braucht es diesen Schutz auch, aber er
   haengt dort an der Spalte ``archiv`` selbst.
2. **Dedupliziert wird ueber den Inhalt, nicht ueber die Reihenfolge.** Der
   Klient teilt eine Gruppennachricht ab 65 Zielgeraeten in mehrere
   Umschlaege mit bitgleichem ``daten`` (``gruppengeraete.ts``) und markiert
   sie alle mit ``archiv`` — sonst haenge der Bestand daran, dass
   ausgerechnet der markierte Block Empfaenger findet. Bestehen bleibt
   trotzdem nur EINER: im Nextcloud-Weg ist der Dateiname die Nutzlast-ID
   (zwei Dateien liessen sich hinterher durch nichts mehr zusammenfuehren),
   im Pulse-Weg saehe der Leser sonst dieselbe Nachricht doppelt.

``daten`` verlaesst dieses Modul nie — gehasht wird nur, um Dubletten
INNERHALB einer Anfrage zu erkennen.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import AblageKanalNachtrag, AblageKanalOrdner

#: Der Wert in ``AblageKanalOrdner.speicher``, bei dem der Bestand bei Pulse
#: liegt. Der andere (``nextcloud``) braucht keinen Namen: er ist alles, was
#: nicht dieser ist.
SPEICHER_PULSE = "pulse"


@dataclass(frozen=True)
class Umschlagurteil:
    """Was mit EINEM Umschlag zu geschehen hat."""

    #: In die Hintergrundaufgabe (Ablage in der fremden Cloud).
    festigen: bool
    #: Marker „Festigung offen" in diesen Commit — nur im Nextcloud-Weg.
    marker: bool
    #: Spalte ``archiv`` an der Nutzlast — nur im Pulse-Weg.
    pulse_archiv: bool

    @property
    def bestand(self) -> bool:
        """Ob dieser Umschlag auch OHNE Empfaengergeraet anzulegen ist —
        ein Ordner-Kanal, in dem nur der Ersteller sitzt, hat trotzdem
        einen dauerhaften Bestand; genau er ist der Zweck des Kanals."""
        return self.marker or self.pulse_archiv


_NICHTS = Umschlagurteil(festigen=False, marker=False, pulse_archiv=False)


@dataclass
class Festigungslauf:
    """Buchhaltung des Bestands fuer GENAU EINE Einliefer-Anfrage."""

    #: ``None`` = kein Ordner-Kanal, sonst der Wert der ``speicher``-Spalte.
    speicher: str | None
    #: Inhalts-Fingerabdruecke der ``archiv``-Umschlaege dieser Anfrage.
    _gesehen: set[str] = field(default_factory=set)
    #: Nutzlast-IDs fuer die Hintergrundaufgabe.
    ids: list[int] = field(default_factory=list)

    def bewerten(self, archiv: bool, daten: str) -> Umschlagurteil:
        """Das Urteil ueber einen Umschlag — wirksam ist nur der ERSTE
        Umschlag eines Inhalts."""
        if not archiv:
            return _NICHTS
        fingerabdruck = hashlib.sha256(daten.encode()).hexdigest()
        wirksam = fingerabdruck not in self._gesehen
        self._gesehen.add(fingerabdruck)
        if not wirksam:
            return _NICHTS
        if self.speicher == SPEICHER_PULSE:
            return Umschlagurteil(festigen=False, marker=False, pulse_archiv=True)
        # Ohne Ordner-Zeile (``speicher is None``) laeuft die
        # Hintergrundaufgabe trotzdem — sie stellt selbst fest, dass es
        # nichts abzulegen gibt (``ablegen`` gibt dann ``False`` zurueck).
        # Einen Marker gibt es dafuer nicht: der Sweep koennte ihn nur
        # aufgeben.
        return Umschlagurteil(
            festigen=True, marker=self.speicher is not None, pulse_archiv=False
        )

    def vermerken(
        self,
        session: AsyncSession,
        *,
        nutzlast_id: int,
        channel_id: int,
        urteil: Umschlagurteil,
    ) -> None:
        """Merkt die Nutzlast fuer den Hintergrundlauf vor und haengt, wenn
        noetig, den Marker „Festigung offen" in DIESEN Commit."""
        if urteil.festigen:
            self.ids.append(nutzlast_id)
        if urteil.marker:
            session.add(AblageKanalNachtrag(nutzlast_id=nutzlast_id, channel_id=channel_id))


async def festigungslauf_starten(
    session: AsyncSession, channel_id: int, nutzlasten: Sequence[object]
) -> Festigungslauf:
    """Fragt EINMAL je Anfrage, wo der Bestand dieses Kanals liegt — und nur,
    wenn ueberhaupt ein Umschlag ``archiv`` traegt."""
    traegt_archiv = any(getattr(n, "archiv", False) for n in nutzlasten)
    ordner = await session.get(AblageKanalOrdner, channel_id) if traegt_archiv else None
    return Festigungslauf(speicher=ordner.speicher if ordner is not None else None)


__all__ = ["SPEICHER_PULSE", "Festigungslauf", "Umschlagurteil", "festigungslauf_starten"]
