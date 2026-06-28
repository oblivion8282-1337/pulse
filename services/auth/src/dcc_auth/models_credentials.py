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
    backup: Mapped["EncryptedKeyBackup | None"] = relationship(
        "EncryptedKeyBackup",
        back_populates="credential",
        cascade="all, delete-orphan",
        uselist=False,
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


class EncryptedKeyBackup(Base):
    """Zero-Knowledge Cloud-Backup of a device's Ed25519 private key
    (DE 11 A.6, migration 0015).

    The Cloud stores ONLY ciphertext; the plaintext (private key) and
    Master-Passwort never leave the user's browser.  The ``previous_blob``
    column supports Master-Passwort-Change-Flow: the old ciphertext is kept
    for 30 days so offline devices can still decrypt with the old password
    until they come online and migrate (Review #4 point 6).
    """

    __tablename__ = "encrypted_key_backups"

    cert_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True).with_variant(_sqlite.TEXT(), "sqlite"),
        ForeignKey("issued_credentials.cert_id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # Cleartext label for the recovery UI ("Mein Laptop") — no sensitive data.
    device_label: Mapped[str] = mapped_column(Text, nullable=False)
    # AES-256-GCM ciphertext of the raw Ed25519 private-key bytes.
    encrypted_blob: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    # Previous ciphertext kept for 30 days during MP-Change-Flow.
    previous_blob: Mapped[bytes | None] = mapped_column(LargeBinary(), nullable=True)
    # 16-byte KDF salt used to derive AES key from Master-Passwort.
    kdf_salt: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    # KDF params string, e.g. '{"name":"PBKDF2","hash":"SHA-256","iterations":600000}'.
    # Stored as TEXT for forward-compatibility (KDF can change without schema change).
    kdf_params: Mapped[str] = mapped_column(Text, nullable=False)
    # 12-byte AES-GCM nonce (unique per encryption).
    gcm_nonce: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Timestamp of the last MP-Change-Flow; cron clears previous_blob after
    # ``previous_replaced_at + 30d``.
    previous_replaced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    credential: Mapped["IssuedCredential"] = relationship(
        "IssuedCredential", back_populates="backup"
    )


class AccountKey(Base):
    """Der mit dem Wiederherstellungs-Schlüssel „eingewickelte" Account-Key
    (Envelope-Encryption, migration 0028).

    Ein Account hat genau EINEN zufälligen Account-Key (AK, 32 Bytes,
    client-seitig erzeugt). Der AK verschlüsselt alles Weitere (Geräte-Key-
    Backups v3, Server-Vault v2); das Master-Passwort wickelt nur den AK ein.
    Dadurch ist ein zweiter, abweichender Wiederherstellungs-Schlüssel
    strukturell unmöglich, und ein Passwort-Wechsel ersetzt nur diese eine
    Zeile (re-wrap) statt alle Blobs.

    Die Cloud sieht ausschließlich Chiffretext — Zero-Knowledge wie beim
    Key-Backup/Vault. ``wrapped_key`` = AES-GCM(KDF(Passwort, salt), AK).
    """

    __tablename__ = "account_keys"

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # AES-256-GCM-Chiffretext der 32 rohen AK-Bytes (inkl. GCM-Tag).
    wrapped_key: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    # 16-Byte-Salt der KDF (Argon2id) für den Wrap-Schlüssel.
    kdf_salt: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    # KDF-Parameter als JSON-String (forward-compat).
    kdf_params: Mapped[str] = mapped_column(Text, nullable=False)
    # 12-Byte-AES-GCM-Nonce des Wraps.
    gcm_nonce: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
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
