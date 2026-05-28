"""kdf_rename — argon2_* Spalten in encrypted_key_backups umbenennen

``argon2_salt`` und ``argon2_params`` waren auf Argon2id zugeschnitten.
Block 2.B nutzt PBKDF2-SHA256 (interim); die Spalten werden KDF-agnostisch
umbenannt, damit die Namen nicht mehr semantisch lügen.

``gcm_nonce`` bleibt — das ist AES-GCM-spezifisch und korrekt.
``kdf_params`` bleibt Text, kein Typ-Change (zu invasiv für ein Rename).

Revision ID: 0019_kdf_rename
Revises: 0018_revoke_refresh_tokens
Create Date: 2026-05-26 03:00:00
"""
from __future__ import annotations

from alembic import op

revision: str = "0019_kdf_rename"
down_revision: str | None = "0018_revoke_refresh_tokens"
branch_labels = None
depends_on = None

SCHEMA = "auth"
TABLE = "encrypted_key_backups"


def upgrade() -> None:
    op.alter_column(TABLE, "argon2_salt", new_column_name="kdf_salt", schema=SCHEMA)
    op.alter_column(TABLE, "argon2_params", new_column_name="kdf_params", schema=SCHEMA)


def downgrade() -> None:
    op.alter_column(TABLE, "kdf_salt", new_column_name="argon2_salt", schema=SCHEMA)
    op.alter_column(TABLE, "kdf_params", new_column_name="argon2_params", schema=SCHEMA)
