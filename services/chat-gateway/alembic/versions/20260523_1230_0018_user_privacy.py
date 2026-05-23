"""user_privacy

Per-user privacy settings driving DM and friend-request acceptance.
One row per user, lazily created on first PUT — the route returns
default values (``dm_policy=0``, ``friend_request_policy=0``,
``show_in_search=true``) when no row exists, so GET is always cheap
even for new accounts.

Policy SMALLINT values are mirrored in ``friend_privacy.py`` constants
(``DM_POLICY_*`` / ``FRIEND_REQ_POLICY_*``). Keeping them numeric
avoids a DB enum migration whenever we add a new policy.

``show_in_search`` is mirrored over to ``auth.users.discoverable`` (a
column on the auth side) via an internal HTTP call from the privacy
route: auth-svc owns the user-search endpoint and needs the flag
locally to keep search filtering single-query.

Revision ID: 0018_user_privacy
Revises: 0017_user_blocks
Create Date: 2026-05-23 12:30:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0018_user_privacy"
down_revision: str | None = "0017_user_blocks"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "user_privacy",
        sa.Column(
            "user_id",
            sa.BigInteger(),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "dm_policy",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "friend_request_policy",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "show_in_search",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("user_privacy", schema=SCHEMA)
