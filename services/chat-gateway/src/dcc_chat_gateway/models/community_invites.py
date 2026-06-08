"""Cloud-only Community-Invite-Broker table (Stufe 2 / B-lite).

The broker relays a *private friend-to-friend community invitation* through the
Cloud so the invitee gets a real-time "Beitreten"-Karte even when the target
community lives on a Self-Host. It deliberately holds the *minimum* needed to
render that card + drive the auto-join, and is **B-lite**: the row is deleted
the moment the invitee accepts or declines (no durable membership register on
the Cloud — privacy by design, mirroring how the Cloud already avoids tracking
Self-Host memberships).

Key points (full design in ``docs/plans/2026-06-07-global-friends-and-invites.md``):

* This table lives in the **chat** schema but is served **cloud-only** (the
  ``community_invites`` router carries the ``CloudOnly`` guard). Self-Hosts
  never write/read it.
* ``code`` is the **host-coined** ``GuildInvite`` code (the hosting server —
  Cloud or Self-Host — issued it). The Cloud merely *relays* ``{host, code}``;
  the proof-of-authorisation is the live invite on the host, not anything the
  Cloud verifies. The Cloud never validates the code (it can't reach a
  Self-Host's invite table) — it only delivers it.
* ``target_instance_id`` is informational (helps the client reconcile a server
  entry); ``target_host`` is the authoritative routing key.
* ``expires_at`` mirrors the host invite's intent so the broker can sweep dead
  cards; a missing/expired row simply yields nothing (the host still re-checks
  the actual invite on accept, so an expired broker row can never grant access).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class CommunityInvite(Base):
    """A pending community invitation relayed Cloud → invitee (B-lite)."""

    __tablename__ = "community_invites"

    id: Mapped[int] = snowflake_pk()
    inviter_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    invitee_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Authoritative routing target. ``target_instance_id`` is informational
    # (NULL for the Cloud's own communities; ≥100 for an approved self-host).
    target_host: Mapped[str] = mapped_column(String(255), nullable=False)
    target_instance_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    target_guild_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Preview-only name so the recipient's card renders without a cross-host
    # fetch. Snapshotted at invite time; never used for access control.
    target_guild_name: Mapped[str] = mapped_column(String(128), nullable=False)
    # The host-coined GuildInvite code. The Cloud stores + relays it verbatim.
    code: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # Pending-list lookup for the invitee (newest first).
        Index("ix_community_invites_invitee", "invitee_id", "created_at"),
        # Dedupe / rate-context lookup: one inviter → one invitee → one guild.
        # UNIQUE: the broker collapses repeat invites onto a single row, and the
        # DB constraint is the only thing that makes that race-safe — two
        # near-simultaneous POSTs (a double-clicked button) would otherwise each
        # insert a row and stack two "Beitreten"-Karten. With the unique index
        # the loser's INSERT raises IntegrityError, which the route catches.
        Index(
            "ix_community_invites_dedupe",
            "inviter_id",
            "invitee_id",
            "target_guild_id",
            unique=True,
        ),
        # Sweeper scan over expiring rows.
        Index("ix_community_invites_expires", "expires_at"),
    )
