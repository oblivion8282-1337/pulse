"""users.is_owner — Owner-Stufe (genau ein Betreiber pro Cloud)

Nur der Owner darf Self-Host-/App-Host-Anträge GENEHMIGEN und ist gegen
Demote/Ban geschützt. Backfill: der älteste existierende Admin wird Owner —
so hat die laufende Cloud nach dem Deploy sofort einen Owner (sonst würden
alle Approve-Routen 403en). Auf einer leeren DB greift stattdessen der
Register-Bootstrap (erster User wird Owner, analog Bootstrap-Admin).

Revision ID: 0039_users_is_owner
Revises: 0038_instance_membership_prefs
Create Date: 2026-06-29 14:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0039_users_is_owner"
down_revision: str | None = "0038_instance_membership_prefs"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_owner",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )
    # Bestandsdaten: ältesten Admin zum Owner machen (Prod hat bereits Admins,
    # aber Default false → ohne Backfill kein Owner → Approve-Routen 403).
    op.execute(
        sa.text(
            """
            UPDATE auth.users SET is_owner = true
            WHERE id = (
                SELECT id FROM auth.users
                WHERE is_admin = true
                ORDER BY id ASC
                LIMIT 1
            )
            """
        )
    )


def downgrade() -> None:
    op.drop_column("users", "is_owner", schema=SCHEMA)
