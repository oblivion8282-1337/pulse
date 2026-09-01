"""Wiederherstellungs-Päckchen fürs persönliche Ablage-Archiv (Ablage §8)

Ein undurchsichtiger, base64-codierter Block je Konto: der Server sieht nie
den Inhalt, nur der Client kann ihn mit einem aus dem Wiederherstellungs-Satz
abgeleiteten Schlüssel öffnen. ``user_id`` ist zugleich Primärschlüssel — ein
Konto hat höchstens ein Päckchen, ein PUT ersetzt es atomar.

``ON DELETE CASCADE`` spiegelt ``user_backup_codes``/``webauthn_credentials``
(Migration 0006/0016): beim ``DELETE FROM users`` in ``routes_account.py``
verschwindet die Zeile automatisch, kein eigener Aufräum-Schritt nötig.

Revision ID: 0052_recovery_package
Revises: 0051_drop_geraete_zerts
Create Date: 2026-09-01 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen — ``alembic_version.version_num`` ist
# ``varchar(32)``, eine längere ID lässt die Prod-Migration zurückrollen.
revision: str = "0052_recovery_package"
down_revision: str | None = "0051_drop_geraete_zerts"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "recovery_packages",
        sa.Column("user_id", sa.BigInteger(), primary_key=True, nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("recovery_packages", schema=SCHEMA)
