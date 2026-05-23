"""Friendship + pending friend-request tables.

``Friendship`` carries the *sorted* user pair (``user_a < user_b``,
mirroring the DM-channel trick) so a single row covers both directions
and ``UNIQUE`` plus ``CHECK`` cannot diverge. ``FriendRequest`` is
directional (sender → receiver) and carries its own snowflake ``id``
so accept/decline/cancel routes can address the row by URL without
exposing the pair tuple.

No FK to ``auth.users`` — auth and chat own separate schemas (cross-
service tables stay independent per the PLAN anti-pattern). User
purge cleans these rows explicitly, see ``user_purge.py``.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    PrimaryKeyConstraint,
    SmallInteger,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class Friendship(Base):
    """Mutual friendship between two users.

    Stored sorted: ``user_a_id < user_b_id``. The route layer always
    sorts before INSERT so the CHECK never fires in normal operation —
    it's a belt-and-suspenders DB guard.
    """

    __tablename__ = "friendships"

    user_a_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_b_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("user_a_id", "user_b_id", name="pk_friendships"),
        CheckConstraint("user_a_id < user_b_id", name="ck_friendships_sorted"),
        Index("ix_friendships_user_b", "user_b_id"),
    )


class FriendRequest(Base):
    """Pending friend request — one row per ordered (sender, receiver).

    Accept turns the row into a ``Friendship`` and DELETEs the row in
    the same TX. Decline / cancel just DELETE. If a POST arrives while
    the *reverse* row already exists, the route auto-accepts (atomic
    SELECT…FOR UPDATE → DELETE reverse → INSERT Friendship) so the user
    doesn't have to ping-pong through a redundant "accept your own
    incoming" step.
    """

    __tablename__ = "friend_requests"

    id: Mapped[int] = snowflake_pk()
    sender_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    receiver_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "sender_id", "receiver_id", name="uq_friend_requests_pair"
        ),
        CheckConstraint(
            "sender_id <> receiver_id", name="ck_friend_requests_no_self"
        ),
        # Mirror of the migration's DESC indices. SQLAlchemy emits plain
        # column lists here (no DESC), which is fine for tests; the
        # production migration installs the DESC variant explicitly.
        Index("ix_friend_requests_receiver_created", "receiver_id", "created_at"),
        Index("ix_friend_requests_sender_created", "sender_id", "created_at"),
    )


class UserBlock(Base):
    """Directional block: ``blocker_id`` no longer accepts contact from
    ``blocked_id``. Applied bidirectionally by the friend/DM gates: a
    block in either direction stops both directions. PK is the ordered
    pair so each side can independently install a block."""

    __tablename__ = "user_blocks"

    blocker_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    blocked_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("blocker_id", "blocked_id", name="pk_user_blocks"),
        CheckConstraint(
            "blocker_id <> blocked_id", name="ck_user_blocks_no_self"
        ),
        Index("ix_user_blocks_blocked", "blocked_id"),
    )


class UserPrivacy(Base):
    """Per-user privacy + discoverability settings.

    Row is lazily created on first PUT. GET returns the defaults
    (``dm_policy=0`` / ``friend_request_policy=0`` / ``show_in_search=
    True``) when no row exists, so a brand-new account doesn't need a
    DB write before the privacy page can render.

    ``show_in_search`` is mirrored over to ``auth.users.discoverable``
    so the auth-side search endpoint can filter in a single query.
    """

    __tablename__ = "user_privacy"

    user_id: Mapped[int] = mapped_column(
        BigInteger, primary_key=True, autoincrement=False
    )
    dm_policy: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("0"), default=0
    )
    friend_request_policy: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("0"), default=0
    )
    show_in_search: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), default=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
