"""Community-Invite-Broker lifecycle events (Stufe 2 / B-lite).

All published on ``user:events`` (direct-delivery to one specific user — the
invitee). Wire shape mirrors the friend events: ``{op, data}`` with a small
data body. The Cloud-only invite-broker relays a community invitation from
``inviter`` to ``invitee``; the recipient's client renders a "Beitreten"-Karte
from the ``community_invite_received`` payload and re-fetches detail from REST
when needed.

The ``user:events`` channel wrapping adds ``_target_user_id`` for fan-out
routing (stripped by the listener). The models below represent the *inner*
envelope only — see ``ConnectionManager.publish_user_event``.

Privacy note: the payload is deliberately *not* the full DB row — it carries
only what the recipient's UI needs to render the card (inviter id, the host +
guild name + the host-coined community-invite code). The broker never relays
anything the inviter could not already share by handing over the same code.
"""

from __future__ import annotations

from typing import Any, Literal

from dcc_shared.events._base import _EventBase


class _CommunityInviteIdData(_EventBase):
    invite_id: str


class CommunityInviteReceivedEvent(_EventBase):
    """A community invitation just landed in the invitee's pending list.

    Data = the ``CommunityInviteOut`` wire shape (free-form here so the
    REST schema can evolve without touching this registry entry)."""

    op: Literal["community_invite_received"] = "community_invite_received"
    data: dict[str, Any]


class CommunityInviteRemovedEvent(_EventBase):
    """A pending community invitation was removed — either the invitee
    accepted/declined it (B-lite: the row is deleted) or it expired. The
    invitee's other tabs drop the matching card by ``invite_id``."""

    op: Literal["community_invite_removed"] = "community_invite_removed"
    data: _CommunityInviteIdData
