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
- ``DmAnhangBezug`` — Zuordnung Nutzlast ↔ Anhang (Etappe E). Ein
  verschluesselter Anhang haengt an den Umschlaegen, die seinen
  Dateischluessel tragen, nicht an einer Nachrichtenzeile: die gibt es im
  verschluesselten Weg nicht.

Details: ``docs/superpowers/specs/2026-08-28-e2e-dm-design.md`` §4 und §5.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    Text,
    func,
    text,
)
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
    #: Das ABSENDER-KONTO — anders als ``absender_device_pubkey`` gilt dieser
    #: Wert fuer alle Geraete des Kontos gemeinsam. Gefuellt aus ``user.id``
    #: des authentifizierten Antragstellers (``routes/postfach.py``). Traegt die
    #: Fairness-Grenze ``postfach_max_offene_zustellungen_je_absender_und_geraet``
    #: (Migration 0076, belegter Fehler 2026-08-29: dieselbe Grenze zaehlte
    #: vorher ueber ``absender_device_pubkey`` und war damit pro GERAET statt
    #: pro Konto umgehbar). Nullable aus demselben Grund wie
    #: ``absender_curve25519``: der Server erzwingt sie nicht.
    absender_user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
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
    #: Der dauerhafte Bestand eines verschluesselten Kanals bei Pulse
    #: (``AblageKanalOrdner.speicher == "pulse"``, Entscheidung 2026-09-03).
    #: Eine Zeile mit ``archiv`` gehoert KEINEM Loescher mehr: Quittung,
    #: verwaist-Sweep und ``user_purge_postfach`` gehen an ihr vorbei — sie
    #: faellt nur mit ihrem Kanal (``routes/channels.py::delete_channel``).
    #: Gesetzt wird sie nur vom Server, fuer den ERSTEN Umschlag eines
    #: Inhalts (``routes/_postfach_festigung.py``), nie vom Klienten.
    archiv: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_dm_nutzlasten_channel", "channel_id"),
        # Die einzige Abfrage auf ``archiv``: „die Archiv-Zeilen dieses
        # Kanals, aufsteigend" (``GET .../ablage/ordner``). Als Teil-Index,
        # weil die allermeisten Postfach-Zeilen nie archiv sind.
        Index(
            "ix_dm_nutzlasten_archiv",
            "channel_id",
            "id",
            postgresql_where=text("archiv"),
            sqlite_where=text("archiv"),
        ),
    )


class DmZustellung(Base):
    __tablename__ = "dm_zustellungen"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    nutzlast_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("dm_nutzlasten.id", ondelete="CASCADE"), nullable=False
    )
    #: Gefuehrt ueber die Geraetekennung — den Wert, an dem auch das
    #: Schluesselbuendel haengt (``DeviceKeyBundle``). Er ist stabil, solange
    #: das Geraet seinen Krypto-Zustand behaelt; ein Wechsel ist ein neues,
    #: leeres Geraet (``web/src/lib/krypto/geraeteKennung.ts``).
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
        # Fuer die NOT-EXISTS-Pruefung beim Quittieren
        # (routes/postfach_abholen.py) und sweep_verwaiste_nutzlasten
        # (postfach_pflege.py) — beide filtern direkt auf diese Spalte,
        # der Empfaenger-Index oben beginnt mit einer anderen Spalte und
        # kann das nicht bedienen (Migration 0070).
        Index("ix_dm_zustellungen_nutzlast", "nutzlast_id"),
    )


class DmAnhangBezug(Base):
    """Welcher Anhang gehoert zu welchem Umschlag (Etappe E, Migration 0073).

    **Viele-zu-viele, und das ist keine Vorratshaltung:** Olm verschluesselt
    je Empfaengergeraet einzeln, dieselbe Nachricht wird also zu mehreren
    Nutzlasten — der eine hochgeladene Klumpen haengt danach an jeder von
    ihnen. Der Dateischluessel steckt im Umschlag selbst; der Server kennt
    ihn nicht und kann den Klumpen nie oeffnen.

    Beide Fremdschluessel kaskadieren. Faellt die letzte Nutzlast eines
    Anhangs weg, bleibt eine Anhang-Zeile ohne jeden Umschlag, der sie
    oeffnen koennte — Muell, den
    ``postfach_pflege.py::sweep_verwaiste_anhaenge`` samt Klumpen wegraeumt.
    """

    __tablename__ = "dm_anhang_bezuege"

    nutzlast_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("dm_nutzlasten.id", ondelete="CASCADE"),
        primary_key=True,
    )
    anhang_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("message_attachments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # "Hat dieser Anhang noch einen Umschlag?" — die Frage jedes
        # Aufraeumlaufs. Der Primaerschluessel beginnt mit ``nutzlast_id``
        # und kann sie nicht bedienen (derselbe Grund wie Migration 0070).
        Index("ix_dm_anhang_bezuege_anhang", "anhang_id"),
    )
