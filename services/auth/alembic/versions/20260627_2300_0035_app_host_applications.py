"""app_host_applications — User-Anträge auf App-Hosting-Freischaltung

Adds ``auth.app_host_applications``. User mit ``self_host_enabled=false``
können einen Antrag stellen; Cloud-Admins reviewen ihn im Admin-Panel und
setzen bei Approval automatisch ``users.self_host_enabled=true``.

Disjoint zu ``instance_applications`` (Server-Hosting-Flow Stufe 3): keine
Hostname-/User-Count-Felder — App-Hosting läuft auf dem lokalen Gerät des
Users, es gibt keinen VPS und keine eigene Domain.

Columns
-------
id              — Snowflake-PK.
user_id         — FK → ``auth.users(id)`` CASCADE. Antragsteller.
purpose         — Enum-Snapshot (privat/verein/firma/sonst). Pflicht.
message         — Freitext, ≤2000 Zeichen, optional.
status          — pending | approved | rejected. Default pending.
reviewed_by     — FK → ``auth.users(id)`` SET NULL. Admin, der den Antrag
                  entschieden hat.
reviewed_at     — Zeitpunkt der Entscheidung.
rejection_reason— Pflicht nur bei status='rejected'.
created_at      — Antragszeitpunkt.

Revision ID: 0035_app_host_applications
Revises: 0034_merge_heads
Create Date: 2026-06-27 23:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0035_app_host_applications"
down_revision: str | None = "0034_merge_heads"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "app_host_applications",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("reviewed_by", sa.BigInteger(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            [f"{SCHEMA}.users.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by"],
            [f"{SCHEMA}.users.id"],
            ondelete="SET NULL",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_app_host_applications_user_status",
        "app_host_applications",
        ["user_id", "status"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_app_host_applications_status",
        "app_host_applications",
        ["status"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_app_host_applications_status",
        table_name="app_host_applications",
        schema=SCHEMA,
    )
    op.drop_index(
        "ix_app_host_applications_user_status",
        table_name="app_host_applications",
        schema=SCHEMA,
    )
    op.drop_table("app_host_applications", schema=SCHEMA)