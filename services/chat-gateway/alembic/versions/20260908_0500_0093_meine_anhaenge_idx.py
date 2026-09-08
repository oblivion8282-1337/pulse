"""meine_anhaenge — Index für den Backfill der eigenen Anhang-Metadaten

Revision ID: 0093_meine_anhaenge
Revises: 0092_fcm_tokens
Create Date: 2026-09-08 05:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0093_meine_anhaenge"
down_revision: str | Sequence[str] | None = "0092_fcm_tokens"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # GET /meine-anhaenge blättert newest-first über die Uploads eines
    # Kontos — ohne diesen Index wäre jede Seite ein Seq-Scan über
    # message_attachments (Plan: docs/plans/2026-09-08-medien-nachziehen.md).
    op.create_index(
        "ix_message_attachments_uploader",
        "message_attachments",
        ["uploader_id", "id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_message_attachments_uploader", table_name="message_attachments", schema=SCHEMA
    )
