"""web_push_subscriptions

Per-device Web-Push subscriptions for notifications when the app/tab is
closed. One row per (user_id, endpoint) — the endpoint is the URL the
browser hands us at ``pushManager.subscribe`` time, and is unique per
(browser-instance, origin). ``p256dh`` + ``auth_secret`` are the
ECDH key + auth secret used by pywebpush to encrypt the payload to that
endpoint's subscription (auth_secret renamed from "auth" since
``auth`` is reserved in some places and the longer name avoids confusion).

No FK to ``auth.users`` — chat-gateway and auth-svc keep their own
schemas (PLAN.md anti-pattern: services never share tables). When a
user is deleted, auth-svc emits a deletion event the chat-gateway
already handles for guild membership cleanup — extend later if needed.

Revision ID: 0013_web_push_subscriptions
Revises: 0012_message_mentions
Create Date: 2026-05-18 18:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0013_web_push_subscriptions"
down_revision: str | None = "0012_message_mentions"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "web_push_subscriptions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        # Browser ``PushSubscription.toJSON().keys.auth`` — renamed to
        # ``auth_secret`` because plain ``auth`` is a reserved-ish word
        # in several SQL dialects and a magnet for confusion.
        sa.Column("auth_secret", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_web_push_subscriptions_user",
        "web_push_subscriptions",
        ["user_id"],
        schema=SCHEMA,
    )
    # Endpoints are URLs and can be long (~512 chars for FCM). Postgres
    # B-tree key size is the gotcha; Text is fine because the actual key
    # is hashed for index pages when over 1700 bytes. The unique constraint
    # is per-(user, endpoint) — a re-subscribe from the same browser tab
    # produces the same endpoint, so we upsert in the route layer.
    op.create_index(
        "uq_web_push_subscriptions_user_endpoint",
        "web_push_subscriptions",
        ["user_id", "endpoint"],
        unique=True,
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_web_push_subscriptions_user_endpoint",
        table_name="web_push_subscriptions",
        schema=SCHEMA,
    )
    op.drop_index(
        "ix_web_push_subscriptions_user",
        table_name="web_push_subscriptions",
        schema=SCHEMA,
    )
    op.drop_table("web_push_subscriptions", schema=SCHEMA)
