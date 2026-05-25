"""cred_pubkey_unique — Partial Unique Index (user_id, device_pubkey) WHERE revoked_at IS NULL

Closes the concurrent-issue race window for POST /credentials/issue.

Without this index two concurrent requests can both pass the SELECT-WHERE-NOT-EXISTS
check and both INSERT, leaving two active rows with the same public key for the same
user.  The partial unique index makes the second INSERT fail with IntegrityError; the
endpoint catches that and re-SELECTs the winner row, returning idempotent output.

On SQLite (test DB) partial unique indexes are supported since SQLite 3.8.9; aiosqlite
ships a recent enough SQLite so no fallback is needed.

Revision ID: 0017_cred_pubkey_unique
Revises: 0016_username_reservations
Create Date: 2026-05-25 04:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0017_cred_pubkey_unique"
down_revision: str | None = "0016_username_reservations"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    # Partial unique index: only one active cert per (user_id, device_pubkey).
    # Revoked rows are excluded so a user can re-issue a cert for a key they
    # previously revoked (e.g. factory-reset the device, re-enrol).
    op.create_index(
        "uq_issued_cred_user_pubkey_active",
        "issued_credentials",
        ["user_id", "device_pubkey"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("revoked_at IS NULL"),
        sqlite_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_issued_cred_user_pubkey_active",
        table_name="issued_credentials",
        schema=SCHEMA,
    )
