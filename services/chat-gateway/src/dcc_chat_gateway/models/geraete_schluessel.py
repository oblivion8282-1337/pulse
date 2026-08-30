"""Das Verzeichnis der Verschluesselungs-Schluessel je Geraet.

Gefuehrt wird ueber ``device_pubkey`` — die Kennung, die sich das Geraet
selbst gibt (``web/src/lib/krypto/geraeteKennung.ts``) und die der Server
gegen das angemeldete Konto haelt (``schluessel_nachweis.py``).

**Zwei Spalten sind mit den Zertifikaten entfallen** (Migration 0079,
Spec §3b): ``cert_id`` (der Schluessel, unter dem die Sperrliste ein
widerrufenes Geraet fuehrte) und ``signatur`` (die Selbst-Unterschrift des
Geraets ueber sein eigenes Buendel — sie wurde nur durchgereicht und von
keiner Fassung des Klienten je geprueft). Beide hatten nach dem Wegfall des
Zertifikats keine Quelle mehr; eine Spalte weiterzufuehren, die niemand
befuellen kann, waere eine Behauptung ohne Deckung.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class DeviceKeyBundle(Base):
    __tablename__ = "device_key_bundles"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Base64, Ed25519 — die Identitaet des Geraets, stabil ueber Erneuerungen.
    device_pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    #: Base64, Curve25519 — der Schluessel, mit dem verschluesselt wird.
    curve25519: Mapped[str] = mapped_column(Text, nullable=False)
    #: Greift, wenn der Vorrat an Einmalschluesseln leer ist.
    rueckfallschluessel: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Selbstauskunft des Geraets (Electron- oder Android-App), Grundlage der
    #: Koexistenz-Regel (Spec §3), s. Kommentar an
    #: ``BundleVeroeffentlichenRequest.dauerhaft`` in ``schemas.py``. Vorgabe
    #: ``False`` — ein unbekanntes/altes Geraet gilt als nicht dauerhaft
    #: (fail closed).
    dauerhaft: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    #: Wann dieses Geraet per Kopplungscode an das Konto gebunden wurde
    #: (``POST /kopplung/einloesen``). **Vom Server gesetzt, nicht gemeldet** —
    #: im Unterschied zu ``dauerhaft`` oben ist das ein Ereignis, das der
    #: Server selbst durchgefuehrt hat. Ein gekoppelter Browser zaehlt damit
    #: als vollwertiges Geraet (Spec §3a Punkt 2), bleibt aber ``dauerhaft =
    #: False`` und verfaellt deshalb nach ``geraete_verfall_tage`` ohne
    #: Benutzung. Ein Bit kann diese drei Klassen (App, gekoppelter Browser,
    #: loser Tab) nicht auseinanderhalten, deshalb die zweite Spalte
    #: (Migration 0078).
    gekoppelt_am: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Grabstein: gesetzt, sobald dieses Geraet als verfallen erkannt wurde
    #: (``schluessel_verfall.py``). **Klebt** — ein spaeterer Nachweis frischt
    #: zwar ``zuletzt_benutzt`` wieder auf, hebt den Verfall aber nicht auf;
    #: nur eine neue Kopplung tut das. Ohne diesen Grabstein waere der Verfall
    #: nicht mitteilbar: eine geloeschte Zeile ist von "hat noch nie
    #: veroeffentlicht" nicht zu unterscheiden, und der Klient darf den
    #: Verfall nie aus einer Abwesenheit schliessen — er loescht daraufhin
    #: seinen lokalen Verlauf, und der ist die einzige Kopie.
    verfallen_am: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Grabstein: gesetzt, sobald der Kontoinhaber dieses Geraet aus seiner
    #: Geraeteliste geworfen hat (``geraete_widerruf.py``, Spec §3b Punkt 4).
    #: **Klebt ebenso wie ``verfallen_am``** — ein erneutes Veroeffentlichen
    #: hebt ihn nicht auf, sonst waere er ueberhaupt kein Widerruf: ``PUT
    #: /keys/bundle`` laesst unbekannte Geraete zu, das entfernte Geraet
    #: legte sich beim naechsten Start also einfach wieder an. Zurueck geht
    #: es nur ueber eine neue Kopplung (``routes/kopplung.py``), also einen
    #: Entschluss des Nutzers an einem zweiten Geraet.
    #: Getrennt von ``verfallen_am``, weil der Grund verschieden ist und der
    #: Nutzer den Unterschied sieht (Migration 0080).
    entfernt_am: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: Zeitpunkt der letzten VEROEFFENTLICHUNG (``PUT /keys/bundle``) — NICHT
    #: der letzten Benutzung, s. ``zuletzt_benutzt`` unten. Bleibt bei einem
    #: treu angemeldeten Geraet lange stehen, das ist beabsichtigt: diese
    #: Spalte beantwortet "wann wurde das Buendel zuletzt ersetzt?", nicht
    #: "lebt das Geraet noch?".
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: Zeitpunkt des letzten erfolgreichen Geraete-Nachweises (jede Route, die
    #: ``schluessel_nachweis.py::pruefe_geraet`` ruft — Buendel, Postfach,
    #: Kopplung), grob aufgeloest (Begruendung dort). Traegt zwei Dinge:
    #: die Verdraengung bei ``schluessel_max_buendel_je_konto`` Geraeten
    #: (``schluessel_grenzen.py``) und den 14-Tage-Ablauf nicht-dauerhafter
    #: Geraete (Spec §3a, ``schluessel_verfall.py``). Migration 0077 befuellt
    #: Bestandszeilen aus ``updated_at`` — der beste verfuegbare Wert.
    zuletzt_benutzt: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("user_id", "device_pubkey", name="uq_device_key_bundles_geraet"),
        Index("ix_device_key_bundles_user", "user_id"),
        # Fuer die beiden Abfragen, die NUR nach device_pubkey suchen
        # (routes/postfach.py, routes/postfach_abholen.py) — der obige
        # Unique-Constraint und der user_id-Index beginnen beide mit
        # user_id und koennen eine reine device_pubkey-Suche nicht
        # bedienen (Migration 0070).
        Index("ix_device_key_bundles_pubkey", "device_pubkey"),
    )


class DeviceOneTimeKey(Base):
    __tablename__ = "device_one_time_keys"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    bundle_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("device_key_bundles.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Base64, Curve25519. Wird beim Abholen GELOESCHT, nicht markiert —
    #: „einmal" ist sonst nur eine Absichtserklaerung.
    schluessel: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("bundle_id", "schluessel", name="uq_device_otk"),
        Index("ix_device_otk_bundle", "bundle_id"),
    )
