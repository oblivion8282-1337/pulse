"""grandfather existing accounts past the email-verification gate

The hard email-verification gate ships with this revision: once an admin
configures SMTP, chat-gateway and voice-signaling reject still-unverified
accounts. Without a backfill, every account that registered *before* the
gate existed would be retroactively locked out the moment SMTP is enabled.

This stamps ``email_verified_at`` on every still-unverified row, so only
registrations after this deploy ever face the gate. The admin SMTP-save
endpoint applies the same grandfathering for accounts that register between
this deploy and the moment SMTP is first configured.

Data-only migration — no schema change. Irreversible by nature (the
pre-grandfather verification state cannot be reconstructed), so downgrade
is a deliberate no-op.

Revision ID: 0009_email_gate_grandfather
Revises: 0008_smtp_settings
Create Date: 2026-05-21 14:00:00
"""
from __future__ import annotations

from alembic import op

revision: str = "0009_email_gate_grandfather"
down_revision: str | None = "0008_smtp_settings"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.execute(
        f"UPDATE {SCHEMA}.users SET email_verified_at = now() "
        f"WHERE email_verified_at IS NULL"
    )


def downgrade() -> None:
    # Irreversible: which rows were unverified pre-grandfather is not
    # recoverable. Leaving the stamps in place is the safe no-op.
    pass
