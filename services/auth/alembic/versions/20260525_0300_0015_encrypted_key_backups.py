"""encrypted_key_backups — Zero-Knowledge-Backup (DE 11 A.6)

Adds ``auth.encrypted_key_backups``.  The Cloud stores ONLY ciphertext — it
never sees the user's Ed25519 private key or the Master-Passwort.  The
frontend performs all crypto locally via WebCrypto (Argon2id → AES-256-GCM).

Columns
-------
cert_id        — UUID PK, FK → ``auth.issued_credentials(cert_id)`` CASCADE.
                 One backup slot per Cert; a PUT replaces the existing row.
user_id        — Redundant FK → ``auth.users(id)`` CASCADE.  Kept for fast
                 "list all backups for this user" queries and to survive a Cert
                 row deletion before the backup is cleaned up.
device_label   — Cleartext label (e.g. "Mein Laptop") — needed so the
                 recovery UI can list devices without decrypting anything.
encrypted_blob — AES-256-GCM ciphertext of the raw Ed25519 private-key bytes.
previous_blob  — Previous ciphertext, kept for 30 days during a Master-
                 Passwort-Change-Flow (Review #4 point 6): other devices that
                 were offline when the change happened can still decrypt with
                 the old Master-Passwort until ``previous_replaced_at + 30d``.
                 After 30 days a cleanup cron NULLs this column.
argon2_salt    — 16 random bytes, Argon2id salt used to derive the AES key
                 from the Master-Passwort.
argon2_params  — Human-readable parameter string, e.g. ``"t=3,m=65536,p=4"``.
                 Stored as TEXT so future parameter upgrades can be detected
                 without code changes.
gcm_nonce      — 12-byte AES-GCM nonce (unique per encryption operation).
created_at     — When this backup was first uploaded (or last replaced).
previous_replaced_at — When the ``previous_blob`` was written (i.e., when the
                 MP-Change-Flow ran).  Cron checks
                 ``previous_replaced_at + 30d < now()`` to clean up stale
                 previous blobs.

Revision ID: 0015_encrypted_key_backups
Revises: 0014_issued_credentials
Create Date: 2026-05-25 03:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0015_encrypted_key_backups"
down_revision: str | None = "0014_issued_credentials"
branch_labels = None
depends_on = None

SCHEMA = "auth"

_UUIDOrText = pg.UUID(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "encrypted_key_backups",
        sa.Column("cert_id", _UUIDOrText, primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("device_label", sa.Text(), nullable=False),
        sa.Column("encrypted_blob", sa.LargeBinary(), nullable=False),
        sa.Column("previous_blob", sa.LargeBinary(), nullable=True),
        sa.Column("argon2_salt", sa.LargeBinary(), nullable=False),
        sa.Column("argon2_params", sa.Text(), nullable=False),
        sa.Column("gcm_nonce", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("previous_replaced_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["cert_id"],
            [f"{SCHEMA}.issued_credentials.cert_id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("encrypted_key_backups", schema=SCHEMA)
