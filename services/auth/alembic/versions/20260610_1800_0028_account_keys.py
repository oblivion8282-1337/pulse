"""account_keys — Envelope-Encryption: ein gewrappter Account-Key pro User

Adds ``auth.account_keys``. Ein Account hat genau EINEN zufälligen Account-Key
(client-seitig erzeugt); das Master-Passwort wickelt nur ihn ein. Geräte-Key-
Backups (v3) und Server-Vault (v2) werden ab dann mit dem AK verschlüsselt —
ein zweiter, abweichender Wiederherstellungs-Schlüssel ist damit strukturell
unmöglich, und ein Passwort-Wechsel ersetzt nur diese eine Zeile.

Columns
-------
user_id     — BigInteger PK, FK → ``auth.users(id)`` CASCADE. Ein AK pro User.
wrapped_key — AES-256-GCM-Chiffretext der 32 rohen AK-Bytes.
kdf_salt    — 16-Byte-Salt der Wrap-KDF (Argon2id).
kdf_params  — KDF-Parameter-JSON (forward-compat).
gcm_nonce   — 12-Byte-AES-GCM-Nonce des Wraps.
created_at / updated_at.

Revision ID: 0028_account_keys
Revises: 0027_instance_bootstrap_tokens
Create Date: 2026-06-10 18:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0028_account_keys"
down_revision: str | None = "0027_instance_bootstrap_tokens"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "account_keys",
        sa.Column("user_id", sa.BigInteger(), primary_key=True),
        sa.Column("wrapped_key", sa.LargeBinary(), nullable=False),
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
    op.drop_table("account_keys", schema=SCHEMA)
