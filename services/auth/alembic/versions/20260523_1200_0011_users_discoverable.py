"""users.discoverable — opt-out flag for the user-search endpoint

Adds a boolean column controlling whether a user appears in the global
``GET /users/search`` results. Default is ``true`` — pre-existing users
keep their pre-feature visibility. chat-gateway owns the policy UI in
``user_privacy.show_in_search`` and mirrors writes here via an
internal POST so the search endpoint can filter in a single query
without crossing service boundaries.

Revision ID: 0011_users_discoverable
Revises: 0010_webauthn_credentials
Create Date: 2026-05-23 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0011_users_discoverable"
down_revision: str | None = "0010_webauthn_credentials"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "discoverable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "discoverable", schema=SCHEMA)
