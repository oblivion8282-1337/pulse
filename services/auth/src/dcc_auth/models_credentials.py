"""SQLAlchemy models for DE-11 device credentials + username reservations.

Ausgelagert aus models.py wegen Größen-Policy (≤500 Z.).
Alembic-Discovery läuft via ``from dcc_auth import models`` → re-export dort.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects import sqlite as _sqlite
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from dcc_auth.db import Base


class IssuedCredential(Base):
    """One device-bound Identitäts-Cert (DE 11 A.1, migration 0014).

    Issued by ``POST /credentials/issue`` after the user's browser generates a
    local Ed25519 key-pair and uploads the public key.  The resulting JWT
    (RS256, ~1 year validity) embeds ``cert_id`` as the CRL lookup key.

    Max 20 active rows per user (DE 11 A.5).  Revoked rows stay until
    ``expires_at`` so the CRL can accurately reject them for the remainder of
    their original validity window — removing them early would let Self-Hosts
    "forget" about the revocation (DE 11 A.9, DE 9).
    """

    __tablename__ = "issued_credentials"

    cert_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True).with_variant(_sqlite.TEXT(), "sqlite"),
        primary_key=True,
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # Raw 32-byte Ed25519 public key.  Echoed into the JWT ``device_pubkey``
    # claim (Base64) so Self-Hosts can verify Challenge-Response signatures.
    device_pubkey: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    device_label: Mapped[str] = mapped_column(Text, nullable=False)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped["User"] = relationship(
        "User", back_populates="issued_credentials"
    )

    __table_args__ = (
        # Partial index: one active cert per (user_id, device_pubkey).
        # sqlite_where is accepted by SQLite since 3.8.9 and by the
        # create_all path in tests.  The Alembic migration 0016 creates
        # the equivalent index on Postgres with postgresql_where.
        Index(
            "uq_issued_cred_user_pubkey_active",
            "user_id",
            "device_pubkey",
            unique=True,
            sqlite_where=text("revoked_at IS NULL"),
        ),
        Index("ix_issued_credentials_user_active", "user_id"),
        Index("ix_issued_credentials_expires_at", "expires_at"),
    )


class RevokedCredential(Base):
    """Grabstein eines widerrufenen Geraete-Zertifikats (Migration 0048).

    Warum eine eigene Tabelle und nicht bloss ``issued_credentials.revoked_at``:
    der Fremdschluessel ``issued_credentials.user_id`` steht auf ``ON DELETE
    CASCADE``. Loescht ein Nutzer sein Konto, verschwindet damit jede seiner
    Zertifikatszeilen — und mit ihr die einzige Spur der ``cert_id``. Ein
    Widerruf, der nur in dieser Zeile lebt, ist danach begrifflich unmoeglich:
    die Sperrliste kann nichts veroeffentlichen, dessen Kennung niemand mehr
    kennt, und das Geraet meldet sich auf jedem Self-Host bis zu 365 Tage
    weiter als der geloeschte Nutzer an.

    Diese Zeile haengt an keinem Fremdschluessel und ueberlebt die Kaskade.
    Sie traegt **absichtlich weder ``user_id`` noch ``device_pubkey``**: das
    Loeschversprechen ist hart, und ``cert_id`` ist ein zufaelliges uuid4 ohne
    Bezug zum Konto — ein Self-Host kann daraus nichts verknuepfen, was er
    nicht ohnehin schon aus dem vorgezeigten Zertifikat weiss (pairwise_sub
    bleibt unberuehrt).

    Aufbewahrung: bis ``expires_at``, also genau so lange, wie das Zertifikat
    ohne den Widerruf noch gegolten haette. Frueheres Aufraeumen liesse es
    danach wieder aufleben (der Sweeper in ``cleanup.py`` haelt sich daran).
    """

    __tablename__ = "revoked_credentials"

    cert_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True).with_variant(_sqlite.TEXT(), "sqlite"),
        primary_key=True,
    )
    # Ablauf des urspruenglichen Zertifikats — zugleich der Score im Redis-ZSET
    # und die Aufbewahrungsgrenze dieser Zeile.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Kurzes Etikett fuer die Nachschau ("account_delete", "admin_disable", …).
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_revoked_credentials_expires_at", "expires_at"),
    )


class UsernameReservation(Base):
    """30-day hold on a just-vacated username (Block 1.D, migration 0016).

    When a user changes username the old name is reserved for 30 days so
    only the original holder can reclaim it.  After ``released_at`` the
    name is free again; the cleanup sweep removes expired rows.
    """

    __tablename__ = "username_reservations"

    old_username: Mapped[str] = mapped_column(String(32), primary_key=True)
    original_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    released_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_username_reservations_released_at", "released_at"),
    )
