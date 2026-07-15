"""guilds.attachment_storage_quota_bytes — Gesamt-Speicher-Kontingent (Etappe 3.2)

Pro-Community-Obergrenze für die Summe aller (nicht gelöschten) Chat-Upload-
Bytes. NULL = unbegrenzt. Serverseitig beim Upload erzwungen — der größte
nicht umgehbare Kosten-Hebel. Nur der Cloud-Betreiber setzt es.

Revision ID: 0053_guild_storage_quota
Revises: 0052_guild_quality_caps
Create Date: 2026-07-16 14:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0053_guild_storage_quota"
down_revision: str | None = "0052_guild_quality_caps"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column("attachment_storage_quota_bytes", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guilds", "attachment_storage_quota_bytes", schema=SCHEMA)
