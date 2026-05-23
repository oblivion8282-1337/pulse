"""Friend-system + block lifecycle events.

All published on ``user:events`` (direct-delivery to one specific user).
Wire shape mirrors ``mention_added``: ``{op, data}`` with the data body
purposefully small — payloads are notification triggers, not full state
transfers (clients re-fetch from REST when they need detail).

Note: the ``user:events`` channel wrapping adds ``_target_user_id`` for
fan-out routing (stripped by the listener). That wrapper is applied by
``ConnectionManager.publish_user_event``; the event models below
represent the *inner* envelope only.
"""

from __future__ import annotations

from typing import Any, Literal

from dcc_shared.events._base import _EventBase


class _FriendUserIdData(_EventBase):
    user_id: str


class _FriendRequestIdData(_EventBase):
    request_id: str


# ---- Friend requests -------------------------------------------------------


class FriendRequestReceivedEvent(_EventBase):
    """Inbound friend request landed in the receiver's pending-inbox.
    Data = full ``FriendRequestOut`` wire shape (free-form here)."""

    op: Literal["friend_request_received"] = "friend_request_received"
    data: dict[str, Any]


class FriendRequestAcceptedEvent(_EventBase):
    """Either side accepted (or auto-accepted via mutual outgoing
    requests). Data shape varies by caller — typed as free-form."""

    op: Literal["friend_request_accepted"] = "friend_request_accepted"
    data: dict[str, Any]


class FriendRequestDeclinedEvent(_EventBase):
    op: Literal["friend_request_declined"] = "friend_request_declined"
    data: _FriendRequestIdData


class FriendRequestCancelledEvent(_EventBase):
    op: Literal["friend_request_cancelled"] = "friend_request_cancelled"
    data: _FriendRequestIdData


# ---- Friendship lifecycle --------------------------------------------------


class FriendRemovedEvent(_EventBase):
    op: Literal["friend_removed"] = "friend_removed"
    data: _FriendUserIdData


# ---- Block lifecycle -------------------------------------------------------


class UserBlockedEvent(_EventBase):
    """``user_id`` (the *blocked* party) just got blocked by the receiver
    of this event. Receiver = the blocker; their UI updates the blocklist."""

    op: Literal["user_blocked"] = "user_blocked"
    data: _FriendUserIdData


class UserUnblockedEvent(_EventBase):
    op: Literal["user_unblocked"] = "user_unblocked"
    data: _FriendUserIdData
