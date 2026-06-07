"""Self-Host instance membership model.

Backs the Self-Host join gate. Access is decided **per community** (a friend
community-invite grant or a public-community address) with a single
``chat_settings.locked`` not-aus toggle on top (the "Server gesperrt" switch,
lives on the :class:`ChatSettings` row). The former 3-way
``join_mode`` + ``InstanceJoinInvite`` code system was removed in Stufe 5.

* :class:`InstanceMember` — who has actually joined this instance. The
  cert-login handler checks this on **every** re-auth, so an existing
  member never needs an invite again (the critical re-auth path).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class InstanceMember(Base):
    """A user who has joined this Self-Host instance.

    ``user_identifier`` matches the cross-mode identifier used everywhere else
    (pairwise-sub on self-host, decimal user_id on cloud). ``joined_via`` is a
    free-text provenance marker: ``owner`` | ``migrated`` | ``community_invite``
    | ``public_community``.
    """

    __tablename__ = "instance_members"

    user_identifier: Mapped[str] = mapped_column(Text, primary_key=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    joined_via: Mapped[str | None] = mapped_column(Text, nullable=True)
