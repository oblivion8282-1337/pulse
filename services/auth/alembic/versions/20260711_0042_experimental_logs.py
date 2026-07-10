"""experimental_logs — Diagnose-Log-Uploads der experimentellen Rust-Sidecar-Version

Eine Tabelle für vom Electron-Client hochgeladene, bereits token-redacted
sidecar.log-Ausschnitte + Systeminfo. Opt-in (Experimental-Checkbox),
anonym + rate-limited wie die Abuse-Reports. Siehe
services/auth/src/dcc_auth/routes_experimental_logs.py.

Revision ID: 0042_experimental_logs
Revises: 0041_instance_direct_endpoints
Create Date: 2026-07-11 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0042_experimental_logs"
down_revision: str | None = "0041_instance_direct_endpoints"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "experimental_logs",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "reason",
            sa.Text(),
            nullable=False,
            server_default="stream_end",
        ),
        sa.Column("sidecar_version", sa.Text(), nullable=True),
        sa.Column(
            "system_info", JSONB().with_variant(sa.JSON(), "sqlite"), nullable=True
        ),
        sa.Column("log_text", sa.Text(), nullable=False),
        sa.Column("client_ip", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    # Retention-/Analyse-Zugriff läuft über created_at.
    op.create_index(
        "ix_experimental_logs_created_at",
        "experimental_logs",
        ["created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_experimental_logs_created_at",
        table_name="experimental_logs",
        schema=SCHEMA,
    )
    op.drop_table("experimental_logs", schema=SCHEMA)
