"""Das Pulse-Laufwerk — vermieteter Speicher auf dem eigenen Objektspeicher
(Spezifikation ``docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md``).

Zwei Tabellen, dieselbe Trennung wie beim Zwischenlager:

``ablage_pulse_laufwerke`` — der Verbunden-Marker je Community. Er ersetzt
bei E8-Communitys die Freigabe-Adresse aus ``ablage_guild_laufwerke``: Es
gibt keinen Fremdanbieter-Link mehr, dessen Geheimhaltung die eigene Tabelle
brauchte — ein Pulse-Laufwerk ist nur „verbunden oder nicht", plus der
Angabe, wer es verbunden hat (für Ansicht und Support). Kein Zweittisch für
Konten/Archive in dieser Etappe: vermietet wird hier nur der
Community-Speicher; das persönliche Archiv läuft unverändert über
Sync-Ordner und die bestehenden Wege.

``ablage_pulse_objekte`` — die namenlosen Metadaten je Chiffrat-Klumpen.
Der Name im Pfad (``a-3f2b….puls``) ist ein Klient-Zufallsname, trägt also
keine Information; Klartext-Dateiname und MIME-Typ liegen verschlüsselt im
PADF-Kopf IN den Bytes (``ablage/dateiablage.ts``). Der Server sieht von
einer Datei: Größe, Zeitpunkt, Uploader — sonst nichts.

``zustand`` ersetzt einen separates Wartezimmer: 0 = angekündigt (presigned
PUT ausgestellt), 1 = hochgeladen (Klient hat bestätigt). Nur Zustand 1
zählt ins Kontingent; was angekündigt bleibt, verliert der Klient durch
Neuankündigung desselben Namens wieder.

``ponytail:`` kein Alters-Sweep für hängengebliebene Ankündigungen (E8 hat
einen fürs Zwischenlager, ``ablage_zwischenlager_pflege.py``) — im Dev-Betrieb
harmlos, weil nur Zustand 1 zählt; Upgrade-Pfad: denselben Sweep hierher
spiegeln, wenn erste echte Mieter davor sind.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, SmallInteger, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class AblagePulseLaufwerk(Base):
    """Das Pulse-Laufwerk einer Community — EINES je Guild.

    ``ON DELETE CASCADE`` auf ``guilds.id`` — verschwindet die Community,
    verliert der Marker jeden Sinn. Die Objekte selbst hängen an ihrer
    eigenen Tabelle mit demselben CASCADE und räumen sich selbst weg.
    """

    __tablename__ = "ablage_pulse_laufwerke"

    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("guilds.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Wer das Laufwerk verbunden hat — der Community-Besitzer zum Zeitpunkt
    # des Verbindens. Nur Anzeige/Kontext; die Route prüft Rechte gegen den
    # AKTUELLEN ``Guild.owner_id``, nicht gegen dieses Feld (dieselbe Regel
    # wie ``AblageGuildLaufwerk``, Modulkopf dort).
    erstellt_von: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AblagePulseObjekt(Base):
    """Ein Chiffrat-Klumpen auf dem Pulse-Laufwerk — namenlos, je Guild.

    ``storage_key`` ist eindeutig, weil er den Guild-Bezug trägt
    (``pulse-laufwerk/guild-{id}/{name}``) — der Klient-Name allein wäre es
    auch, aber der Schlüssel im Bucket ist es, den Presigning und Löschen
    handhaben. Upsert beim Ankündigen: das Verzeichnis
    (``verzeichnis.puls``) wird bei JEDEM Schreibvorgang neu geschrieben,
    die Zeile also immer wieder angestoßen — kein Zweit-INSERT-Wettlauf.
    """

    __tablename__ = "ablage_pulse_objekte"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    hochgeladen_von: Mapped[int] = mapped_column(BigInteger, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # Bytes des Klumpens — für die Kontingent-Rechnung ohne HEAD je Zeile,
    # dieselbe Regel wie beim Zwischenlager.
    groesse: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # 0 = angekündigt, 1 = hochgeladen (Klient bestätigte das PUT).
    zustand: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Kontingent-Summe und Namensliste je Community beginnen mit guild_id.
        Index("ix_ablage_pulse_guild", "guild_id", "zustand"),
    )
