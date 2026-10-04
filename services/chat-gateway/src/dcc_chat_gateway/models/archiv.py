"""Archiv-Modelle für DM-Verlauf (Übergabe 2026-10-04, §5).

**ArchivZeile** — eine Textnachricht, verschlüsselt beim Server, 120 Tage
ab Versand (Sweeper in ``anruf_pflege``-Stil: ``archiv_pflege``). Die
Nutzlast ist AES-256-GCM unter einem Kanal-Schlüssel; der Server sieht
nur Chiffre. 1:1-DMs zuerst — Gruppen analog später (Megolm-Weg).

**ArchivKanalSchluessel** — der Kanal-Schlüssel je Teilnehmer, gewrappt an
dessen Archiv-Public-Key (X25519, Klient im auth-Dienst ``archiv_schluessel``):
der Absender kann den Schlüssel an beide Seiten wickeln, ohne je einen
geheimen Schlüssel des anderen zu sehen. Ohne eigene Zeile kann ein Konto
den Kanal nicht lesen — fail-closed.

Zugang ist die ganz normale Anmeldung: der private Archiv-Schlüssel liegt
zweifach gewrappt beim auth-Dienst (Passwort-KDF + Server-Schrank für den
Reset-Weg), keine QR- und kein Wiederherstellungs-Päckchen (Entscheidung
03./04.10. — frühere QR-Pläne verworfen).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, LargeBinary, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk

# Vorhaltezeit des Archivs ab Versand (Übergabe §5.1).
ARCHIV_VORHALTE_TAGE = 120


class ArchivZeile(Base):
    __tablename__ = "archiv_zeilen"

    id: Mapped[int] = snowflake_pk()
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # AES-256-GCM unter dem Kanal-Schlüssel: 12-Byte-Nonce vorangestellt.
    nutzlast: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    erstellt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_archiv_zeilen_kanal_id", "channel_id", "id"),
        Index("ix_archiv_zeilen_erstellt", "erstellt_at"),
    )


class ArchivKanalSchluessel(Base):
    __tablename__ = "archiv_kanal_schluessel"

    channel_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Kanal-Schlüssel, gewrappt an den Archiv-Public-Key dieses Kontos
    # (ephemeral X25519 + HKDF + AES-GCM; Format im Klienten archiv/krypto.ts).
    wrap: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    erstellt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
