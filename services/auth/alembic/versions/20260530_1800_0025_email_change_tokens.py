"""email_change_tokens — authenticated email-address change with verification

One-shot token table for the "change my email" flow. Mirrors
``email_verification_tokens`` but adds a ``new_email`` column: the user's
``users.email`` is only rewritten once the link sent to that new address is
clicked (token consumed), so an unverified address can't take over an account.

Revision ID: 0025_email_change_tokens
Revises: 0024_users_lower_indexes
Create Date: 2026-05-30 18:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0025_email_change_tokens"
down_revision: str | None = "0024_users_lower_indexes"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "email_change_tokens",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("new_email", sa.String(length=255), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("token_hash", name="uq_email_change_tokens_hash"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_email_change_tokens_user_used",
        "email_change_tokens",
        ["user_id", "used_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_email_change_tokens_user_used",
        "email_change_tokens",
        schema=SCHEMA,
    )
    op.drop_table("email_change_tokens", schema=SCHEMA)
