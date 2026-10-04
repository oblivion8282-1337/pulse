"""archiv_schluessel — privater Archiv-Schlüssel je Konto, zweifach gewrappt
(Übergabe 2026-10-04 §5): einmal unter Passwort-KDF (clientseitig), einmal
unter dem Server-Schrank-Geheimnis — der E-Mail-Passwort-Reset wickelt
damit neu und verliert nichts.

``ON DELETE CASCADE`` wie ``recovery_packages`` (0052): Kontolöschung
trägt die Zeile mit.

Revision ID: 0054_archiv_schluessel
Revises: 0053_users_username_lower_unique
Create Date: 2026-10-04 02:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen — ``alembic_version.version_num`` ist
# ``varchar(32)``, eine längere ID lässt die Prod-Migration zurückrollen.
revision: str = "0054_archiv_schluessel"
down_revision: str | None = "0053_users_username_lower_unique"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "archiv_schluessel",
        sa.Column("user_id", sa.BigInteger(), primary_key=True, nullable=False),
        sa.Column("pubkey", sa.LargeBinary(), nullable=False),
        sa.Column("kdf_salt", sa.LargeBinary(), nullable=False),
        sa.Column("wrap_kdf", sa.LargeBinary(), nullable=False),
        sa.Column("wrap_schrank", sa.LargeBinary(), nullable=False),
        sa.Column(
            "erstellt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "geaendert_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("archiv_schluessel", schema=SCHEMA)
