"""instance_direct_endpoints — Telefonbuch des Direktpfads

Die Server-App (App-Host) meldet per Heartbeat ihre STUN-ermittelte öffentliche
Adresse + den DTLS-Fingerprint ihres direct-adapters; Clients bauen damit eine
direkte WebRTC-Verbindung auf (Chat ohne Cloud im Datenweg).
Plan: docs/plans/2026-07-09-direct-path-webrtc.md, Phase 1.

Revision ID: 0041_instance_direct_endpoints
Revises: 0040_instances_origin
Create Date: 2026-07-09 23:50:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0041_instance_direct_endpoints"
down_revision: str | None = "0040_instances_origin"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "instance_direct_endpoints",
        sa.Column(
            "instance_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.registered_instances.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "candidates", JSONB().with_variant(sa.JSON(), "sqlite"), nullable=False
        ),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("instance_direct_endpoints", schema=SCHEMA)
