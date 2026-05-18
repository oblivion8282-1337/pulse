"""Web-Push subscription persistence.

One row per ``(user_id, endpoint)`` (uniqueness enforced at the DB
level). The PK is a snowflake we mint in the route layer so list
output stays sortable + cross-shard safe even though the row itself
never crosses the API boundary as an id.

See migration ``0013_web_push_subscriptions`` for the SQL contract.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class WebPushSubscription(Base):
    """Browser-side ``PushSubscription`` we have permission to push to.

    The triple ``(endpoint, p256dh, auth_secret)`` is what
    ``pywebpush.webpush`` consumes. ``auth_secret`` mirrors the
    ``keys.auth`` field of the browser's ``PushSubscription.toJSON()``;
    renamed because ``auth`` is reserved-ish in some places and the
    longer name avoids confusion.

    No FK on ``user_id`` — auth-svc owns the user table in its own
    schema and per PLAN.md services don't share DB tables. Cross-service
    deletion of subscriptions when a user is purged would be a future
    auth-svc→chat-gateway event.
    """

    __tablename__ = "web_push_subscriptions"

    id: Mapped[int] = snowflake_pk()
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth_secret: Mapped[str] = mapped_column(Text, nullable=False)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_web_push_subscriptions_user", "user_id"),
        Index(
            "uq_web_push_subscriptions_user_endpoint",
            "user_id",
            "endpoint",
            unique=True,
        ),
    )


__all__ = ["WebPushSubscription"]
