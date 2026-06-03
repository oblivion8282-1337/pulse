"""encrypted_server_vaults — Zero-Knowledge E2E-Sync der Self-Host-Server-Liste

Adds ``auth.encrypted_server_vaults``.  The Cloud stores ONLY ciphertext — it
never learns which self-host instances the user has joined.  The frontend does
all crypto locally via WebCrypto (Argon2id → AES-256-GCM), keyed by the same
Master-Passwort as the Cloud key-backup (unified-password design).

One vault per user (PK = ``user_id``); a PUT replaces the existing row.

Columns
-------
user_id        — BigInteger PK, FK → ``auth.users(id)`` CASCADE.  One vault slot
                 per user — the server list is account-wide, not device-bound.
encrypted_blob — AES-256-GCM ciphertext of the JSON-serialised server list.
kdf_salt       — 16 random bytes, stable per vault so every device derives the
                 same AES key from the Master-Passwort.
kdf_params     — Human-readable KDF parameter JSON string (forward-compat).
gcm_nonce      — 12-byte AES-GCM nonce (unique per write).
created_at     — When the vault was first uploaded.
updated_at     — When the vault was last replaced.

Revision ID: 0026_encrypted_server_vaults
Revises: 0025_email_change_tokens
Create Date: 2026-06-03 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0026_encrypted_server_vaults"
down_revision: str | None = "0025_email_change_tokens"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "encrypted_server_vaults",
        sa.Column("user_id", sa.BigInteger(), primary_key=True),
        sa.Column("encrypted_blob", sa.LargeBinary(), nullable=False),
        sa.Column("kdf_salt", sa.LargeBinary(), nullable=False),
        sa.Column("kdf_params", sa.Text(), nullable=False),
        sa.Column("gcm_nonce", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("encrypted_server_vaults", schema=SCHEMA)
