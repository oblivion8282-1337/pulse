"""Presence (online/offline + Etappe-3 status) events.

These ride on ``guild:events`` (for status broadcast-to-others) and
``user:events`` (for the sender's own sockets, with the *real* status
that may be masked-to-others — invisible → offline).

The ``_sender_user_id`` field on ``presence_status_changed`` is a
listener-side hint (stripped before fan-out) so the listener can apply
block-aware visibility filtering. Wire-format keeps the leading
underscore — Pydantic exposes it via ``Field(alias=...)``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import ConfigDict, Field

from dcc_shared.events._base import _EventBase


class PresenceUpdateEvent(_EventBase):
    """Hard online/offline transition. Broadcast on connect / final
    disconnect of a user. Block-aware visibility is applied by the
    listener — publishers don't decide who sees it."""

    op: Literal["presence_update"] = "presence_update"
    user_id: str
    online: bool


class PresenceStatusData(_EventBase):
    user_id: str
    status: str


class PresenceStatusChangedEvent(_EventBase):
    """Soft status transition (online/idle/dnd/invisible/offline).

    Two publish patterns:

    * Own sockets via ``user:events`` — real status (no
      ``_sender_user_id`` field).
    * Others via ``guild:events`` — masked status with
      ``_sender_user_id`` so the listener can strip the sender's own
      sockets before fan-out and apply the block-aware visibility
      filter. Publisher does the masking (invisible → offline); the
      listener only drops recipients, never rewrites.
    """

    # Frozen+populate_by_name are inherited; we re-declare model_config
    # to ADD ``serialize_by_alias`` so ``model_dump`` emits the
    # ``_sender_user_id`` wire-key (not ``sender_user_id``).
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        serialize_by_alias=True,
    )

    op: Literal["presence_status_changed"] = "presence_status_changed"
    data: PresenceStatusData
    sender_user_id: str | None = Field(default=None, alias="_sender_user_id")
