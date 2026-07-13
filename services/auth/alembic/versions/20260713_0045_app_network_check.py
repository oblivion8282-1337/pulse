"""instance_applications.network_check — Anschluss-Check-Ergebnis am Antrag

Der App-Host-Antragsweg führt client-seitig einen beratenden Anschluss-Check
aus (Browser-STUN-Probe: CGNAT/DS-Lite/symmetrisches NAT erkennen). Das
Ergebnis (ok | cgnat | symmetric | blocked | unknown) wird mit dem Antrag
gespeichert und dem Admin als Chip angezeigt — reine Information, keine
Server-Logik. NULL = nicht geprüft (VPS-Anträge, Alt-Clients).

Revision ID: 0045_app_network_check
Revises: 0044_unified_applications
Create Date: 2026-07-13
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0045_app_network_check"
down_revision: str | None = "0044_unified_applications"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "instance_applications",
        sa.Column("network_check", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("instance_applications", "network_check", schema=SCHEMA)
