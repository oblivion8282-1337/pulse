"""Self-Host instance membership + join-invite models.

Two tables that back the Self-Host "join mode / invite-only" gate (the
``chat_settings.join_mode`` column lives on the :class:`ChatSettings` row):

* :class:`InstanceMember` — who has actually joined this instance. The
  cert-login handler checks this on **every** re-auth, so an existing
  member never needs an invite again (the critical re-auth path).
* :class:`InstanceJoinInvite` — invite codes. Mirrors the auth-svc
  ``RegistrationInvite`` shape, but ``created_by`` is TEXT: on a self-host
  the admin's identifier is a pairwise-sub string, not a BIGINT user_id.
  Redemption is a single guarded UPDATE (``uses < max_uses``) so concurrent
  joins can't over-spend a single-use code.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class InstanceMember(Base):
    """A user who has joined this Self-Host instance.

    ``user_identifier`` matches the cross-mode identifier used everywhere else
    (pairwise-sub on self-host, decimal user_id on cloud). ``joined_via`` is a
    free-text provenance marker: ``owner`` | ``open`` | ``migrated`` | the
    invite-code string that was redeemed.
    """

    __tablename__ = "instance_members"

    user_identifier: Mapped[str] = mapped_column(Text, primary_key=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    joined_via: Mapped[str | None] = mapped_column(Text, nullable=True)


class InstanceJoinInvite(Base):
    """Invite code for ``join_mode == "invite_only"`` (Self-Host).

    ``max_uses`` NULL = unlimited; otherwise the code is spent up to that many
    times. ``revoked`` is a soft kill-switch (the row is kept for the audit
    trail rather than deleted).
    """

    __tablename__ = "instance_join_invites"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    # TEXT (not BIGINT): the minting admin's ``user_identifier`` — a pairwise-sub
    # string on self-host.
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # NULL = unlimited uses.
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    uses: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    revoked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    note: Mapped[str | None] = mapped_column(String(100), nullable=True)

    __table_args__ = (
        Index("ix_instance_join_invites_created", "created_at"),
    )
