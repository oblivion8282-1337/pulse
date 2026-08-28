"""Das Postfach: Nutzlast und Zustellung getrennt (Etappe D, E2E-DM).

Der Server nimmt verschluesselte Umschlaege entgegen, haelt sie bis zur
Abholung, und loescht sie danach — quittiert oder verfristet. Er kann
keinen davon oeffnen. Zwei Tabellen, nicht eine:

- ``DmNutzlast`` — der Umschlag selbst. Bei einer DM verschluesselt Olm fuer
  jedes Empfaengergeraet einzeln, also eine Nutzlast je Zustellung. Bei einer
  Gruppe verschluesselt Megolm einmal fuer alle, also eine Nutzlast mit
  vielen Zustellungen — ohne diese Trennung waere der Gruppenfall ein
  Sonderweg (Kopie derselben Bytes je Geraet).
- ``DmZustellung`` — eine Zeile je Empfaengergeraet, die auf eine Nutzlast
  zeigt. Sie faellt weg, sobald das Geraet quittiert oder die Frist
  abgelaufen ist; die Nutzlast faellt weg, sobald ihre letzte Zustellung weg
  ist (``postfach_pflege.py``).

Details: ``docs/superpowers/specs/2026-08-28-e2e-dm-design.md`` §4.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, SmallInteger, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base

#: Sicherheitsnetz, kein Politikwert: die Route (``routes/postfach.py``)
#: setzt ``verfaellt_am`` bei jeder Einlieferung explizit aus den
#: Einstellungen (``postfach_frist_tage``). Dieser Python-Default greift nur,
#: wenn eine Zeile je auf anderem Weg entsteht (z. B. ein Test, der die
#: Frist bewusst nicht mitgibt) — ohne ihn waere die Spalte trotz
#: ``nullable=False`` nur so lange fristbehaftet, wie niemand das vergisst.
_FALLBACK_FRIST = timedelta(days=30)


def _fallback_verfaellt_am() -> datetime:
    return datetime.now(UTC) + _FALLBACK_FRIST


class DmNutzlast(Base):
    __tablename__ = "dm_nutzlasten"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Das Geraet, das den Umschlag eingeliefert hat — nicht der Nutzer,
    #: derselbe Grund wie bei ``DeviceKeyBundle``: ein Konto kann mehrere
    #: Geraete haben, und nur eines davon hat diesen Umschlag verschluesselt.
    absender_device_pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    #: Der Curve25519-Identitaetsschluessel DESSELBEN Geraets — Olm braucht
    #: ihn als eigenes Argument fuer einen frischen Sitzungsaufbau
    #: (``sitzung_eingehend``, s. Migration 0069). Nullable, weil der Server
    #: den Umschlag nie oeffnet und diesen Wert nicht erzwingt.
    absender_curve25519: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 0 = Sitzungsaufbau (Olm-PreKey), 1 = laufende Nachricht — die Zaehlung
    #: des Krypto-Kerns (`Umschlag::art()`, `wasm.rs`), NICHT frei gewaehlt.
    #: Die genaue Bedeutung gehoert dem Klienten; der Server unterscheidet
    #: nur fuer Statistiken/Diagnose, nie fuer Zustellentscheidungen.
    art: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    #: Base64 — dasselbe Format, in dem der Krypto-Kern seine Umschlaege
    #: herausreicht und der Klient sie ueber JSON bekommt. Eine Umkodierung
    #: an der Grenze (z. B. nach LargeBinary) waere eine zusaetzliche
    #: Fehlerquelle ohne Gewinn, deshalb Text statt LargeBinary.
    daten: Mapped[str] = mapped_column(Text, nullable=False)
    #: Bytes VOR der Base64-Kodierung — mitgeschrieben, damit Obergrenzen
    #: und Aufraeum-Statistiken ohne Lesen der Nutzlast auskommen.
    groesse: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_dm_nutzlasten_channel", "channel_id"),)


class DmZustellung(Base):
    __tablename__ = "dm_zustellungen"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    nutzlast_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("dm_nutzlasten.id", ondelete="CASCADE"), nullable=False
    )
    #: Gefuehrt ueber device_pubkey, NICHT ueber cert_id — dieselbe
    #: Festlegung wie bei ``DeviceKeyBundle``: die Zertifikatserneuerung
    #: wechselt alle 30 Tage die cert_id fuer denselben Pubkey, eine an ihr
    #: haengende Zustellung wuerde monatlich verwaisen.
    empfaenger_device_pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    empfaenger_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: NICHT nullable — jede Zustellung hat eine Frist. Eine Zeile ohne
    #: Frist waere eine, die nie wegginge, genau das, was diese Etappe
    #: verhindern soll.
    verfaellt_am: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_fallback_verfaellt_am
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Haeufigste Abfrage: "was liegt fuer mich, aelteste zuerst".
        Index("ix_dm_zustellungen_empfaenger", "empfaenger_device_pubkey", "id"),
        # Fuer den Verfallslauf (postfach_pflege.py, Task 4).
        Index("ix_dm_zustellungen_verfaellt", "verfaellt_am"),
    )
