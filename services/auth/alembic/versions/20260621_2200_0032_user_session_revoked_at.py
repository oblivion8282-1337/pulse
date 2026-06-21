"""user_session_revoked_at — explizite Session-Revocation

Adds the nullable ``revoked_at`` column to ``auth.user_sessions``. Distinguishes
an explicit security revocation (Logout-Everywhere / password-change /
admin-disable) from a natural TTL expiry:

* ``validate_session`` rejects any row with ``revoked_at`` set, regardless of
  the expiry clock.
* ``/session/renew``'s ``_strongest_session_context`` refuses to inherit
  acr/amr from a revoked row (a naturally-TTL-expired own cookie still may, to
  preserve the MFA-desktop cookie-recovery path).

NULL = legacy/active rows — no backfill needed (a row that was never revoked is
correctly treated as not-revoked).

Nullable → SQLite-safe ``add_column`` (no table rebuild).

Revision ID: 0032_user_session_revoked_at
Revises: 0031_profile_gradient_angle
Create Date: 2026-06-21 22:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0032_user_session_revoked_at"
down_revision: str | None = "0031_profile_gradient_angle"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "user_sessions",
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("user_sessions", "revoked_at", schema=SCHEMA)
