"""Geraete-Kopplung und Verlaufsumzug (Etappe F, E2E-DM).

Zwei Tabellen, dieselbe Trennung wie beim Postfach (``models/postfach.py``):
die **Verabredung** zwischen zwei Geraeten desselben Kontos, und die
**Stuecke**, die dabei hinuebergeschoben werden.

**Was der Server hier NICHT hat, und warum das der Kern des Entwurfs ist:**
Er kennt den Kopplungscode nicht. Gespeichert wird nur ``code_hash``, ein
SHA-256 ueber den Code — die Suche funktioniert damit, das Rueckrechnen
nicht. Und weil der Schluessel, mit dem die Stuecke verschluesselt sind, aus
demselben Code abgeleitet wird (HKDF, ``web/src/lib/kopplung/transport.ts``),
kann der Server die Stuecke auch dann nicht oeffnen, wenn er beide Geraete
belaeuft. Der Code reist ausschliesslich ueber den Bildschirm des alten
Geraets zum Auge des Nutzers — nie ueber diese Leitung.

Zur Sicherheitsfrage („was beweist der Code, wie lange gilt er, was bei
mehrfacher Einloesung, was kann ein Abfotografierer") steht die vollstaendige
Antwort im Kopf von ``routes/kopplung.py``.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class Kopplung(Base):
    """Eine Verabredung zwischen einem eingerichteten und einem neuen Geraet.

    Die Zeile durchlaeuft genau zwei Zustaende, und ``eingeloest_am``
    unterscheidet sie:

    * **offen** — angelegt, noch nicht eingeloest. ``verfaellt_am`` liegt
      wenige Minuten in der Zukunft (``kopplung_code_gueltig_minuten``).
    * **eingeloest** — ein zweites Geraet hat den Code vorgelegt.
      ``neu_device_pubkey`` steht fest, ``verfaellt_am`` wird auf die
      laengere Umzugsfrist gesetzt (``umzug_frist_stunden``).

    Es gibt keinen dritten Zustand. Fertig heisst: die Zeile ist weg (und mit
    ihr per CASCADE jedes Stueck).
    """

    __tablename__ = "kopplungen"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Base64url(SHA-256 ueber den domaenengetrennten Code). **Eindeutig** —
    #: der Code IST der Suchschluessel des einloesenden Geraets, das die
    #: ``id`` noch nicht kennt. Ohne die Eindeutigkeit koennten zwei Zeilen
    #: denselben Hash tragen und die Einloesung waere nicht mehr
    #: entscheidbar.
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)
    #: Das Geraet, das den Code ANZEIGT und den Verlauf schiebt. Gefuehrt
    #: ueber die Geraetekennung — dieselbe Festlegung wie bei
    #: ``DeviceKeyBundle`` und ``DmZustellung``.
    alt_device_pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    #: Das einloesende Geraet — ``NULL``, solange niemand eingeloest hat.
    #: Sobald es steht, ist es die einzige Stelle, die Stuecke abholen darf.
    neu_device_pubkey: Mapped[str | None] = mapped_column(Text, nullable=True)
    eingeloest_am: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Wie viele Stuecke der Umzug insgesamt hat — ``NULL``, solange das alte
    #: Geraet es nicht gemeldet hat. Der Empfaenger darf erst abschliessen,
    #: wenn diese Zahl steht UND er sie alle hat; ohne das Feld koennte ein
    #: Abbruch mitten im Schieben wie ein vollstaendiger Umzug aussehen.
    gesamt_stuecke: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: NICHT nullable, aus demselben Grund wie ``DmZustellung.verfaellt_am``:
    #: eine Kopplung ohne Frist ist ein Generalschluessel ohne Ablauf.
    verfaellt_am: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("code_hash", name="uq_kopplungen_code_hash"),
        Index("ix_kopplungen_user", "user_id"),
        # Fuer den Verfallslauf (``kopplung_pflege.py``).
        Index("ix_kopplungen_verfaellt", "verfaellt_am"),
    )


class UmzugStueck(Base):
    """Ein verschluesseltes Stueck des Verlaufs.

    **Warum eine eigene Tabelle und nicht das Postfach:** die Begruendung
    steht im Kopf von ``routes/kopplung_umzug.py`` und ist gemessen, nicht
    geschaetzt. Kurz: das Postfach deckelt offene Zustellungen je
    (Absendergeraet, Empfaengergeraet) auf 50, und es verlangt einen
    DM-Kanal, den es zwischen zwei Geraeten DESSELBEN Kontos nicht gibt.

    ``folge`` ist die Position, nicht bloss eine Nummer: sie geht in die
    zusaetzlichen authentifizierten Daten der AES-GCM-Verschluesselung ein
    (``transport.ts``). Ein vom Server vertauschtes oder untergeschobenes
    Stueck faellt beim Entschluesseln auf, statt still eine falsche
    Reihenfolge zu ergeben.
    """

    __tablename__ = "umzug_stuecke"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kopplung_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("kopplungen.id", ondelete="CASCADE"), nullable=False
    )
    folge: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Base64 — dasselbe Format wie ``DmNutzlast.daten``, aus demselben
    #: Grund (keine Umkodierung an der JSON-Grenze).
    daten: Mapped[str] = mapped_column(Text, nullable=False)
    #: Bytes VOR der Base64-Kodierung — damit Obergrenzen und
    #: Aufraeum-Statistiken ohne Lesen der Nutzlast auskommen.
    groesse: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Ein vom Klienten aus dem KLARTEXT abgeleiteter HMAC (Schluessel wie
    #: der Transportschluessel per HKDF aus dem Kopplungscode, eigener
    #: Kontext — ``web/src/lib/kopplung/transport.ts``). Der Server kann
    #: daraus den Klartext nicht zurueckrechnen (HMAC, nicht Hash des
    #: Klartexts allein) und lernt auch bei gleichem Inhalt nichts, weil der
    #: Schluessel je Kopplung verschieden ist — er dient ausschliesslich dem
    #: SENDER als spaeterer Abgleich „ist das, was hier liegt, noch genau
    #: das, was ich gerade lokal habe". Ohne Kryptomaterial des Kopplungscodes
    #: (den der Server nie sieht) ist kein zweiter Wert herstellbar, der
    #: passend zu einem gegebenen Klartext daherkaeme.
    #: ``NULL`` nur fuer Zeilen, die vor diesem Feld entstanden — die Rechnung
    #: auf der Sendeseite behandelt ein fehlendes Kennzeichen als
    #: Nicht-Uebereinstimmung (sicherer Vorgabewert, s. ``kopplung.py``).
    kennung: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Erzwingt die Fortsetzbarkeit: ein zweites Hochladen derselben
        # Position kollidiert, statt eine Dublette anzulegen. Der Sender
        # darf nach einem Abbruch also blind wiederholen.
        UniqueConstraint("kopplung_id", "folge", name="uq_umzug_stuecke_folge"),
        Index("ix_umzug_stuecke_kopplung", "kopplung_id", "folge"),
    )
