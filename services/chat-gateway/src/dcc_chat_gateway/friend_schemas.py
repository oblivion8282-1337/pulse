"""Pydantic schemas for the friends / blocks / privacy endpoints.

Lives outside ``schemas.py`` because that file is already over the
350-line soft cap (PLAN.md §12.1) and this is a fresh domain group —
nothing here is referenced by the existing chat routes.

ID serialisation mirrors ``schemas.py``: snowflakes cross the wire as
strings to keep JS clients on the safe side of ``Number.MAX_SAFE_INTEGER``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from dcc_chat_gateway.friend_privacy import (
    DM_POLICY_VALUES,
    FRIEND_REQ_POLICY_VALUES,
)
from dcc_chat_gateway.schemas import SnowflakeId


def _id_str(value: int) -> str:
    return str(value)


# ---- Friend requests + friendships --------------------------------------


class CreateFriendRequestIn(BaseModel):
    target_user_id: SnowflakeId


class FriendRequestOut(BaseModel):
    """A pending friend request, addressable by ``id``."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    sender_id: int
    receiver_id: int
    created_at: datetime

    @field_serializer("id", "sender_id", "receiver_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class FriendOut(BaseModel):
    """One friend on the caller's friend list.

    ``user_id`` is *always* the other person (computed in the route from
    the sorted-pair row), never the caller. ``since`` is the friendship's
    ``created_at`` — the moment the second-side accepted, not the first
    request.
    """

    user_id: int
    since: datetime

    @field_serializer("user_id")
    def _ser_uid(self, v: int) -> str:
        return _id_str(v)


class FriendRequestListOut(BaseModel):
    """Combined inbox + outbox response for ``GET /friend-requests``.

    Returning both in one envelope (rather than two separate endpoints)
    matches how the UI renders the page — and avoids a second round-
    trip when the user just wants their full pending-state.
    """

    incoming: list[FriendRequestOut]
    outgoing: list[FriendRequestOut]


class FriendRequestAutoAcceptOut(BaseModel):
    """Response shape when POST /friend-requests auto-accepts because the
    reverse request was already pending. ``auto_accepted`` is the
    discriminator the frontend branches on (a normal pending response
    omits it — see ``FriendRequestOut``)."""

    auto_accepted: bool = True
    friendship: FriendOut


# ---- Blocks --------------------------------------------------------------


class CreateBlockIn(BaseModel):
    target_user_id: SnowflakeId


class BlockOut(BaseModel):
    """One row of the caller's block list."""

    user_id: int
    since: datetime

    @field_serializer("user_id")
    def _ser_uid(self, v: int) -> str:
        return _id_str(v)


# ---- Privacy -------------------------------------------------------------


def _validate_dm_policy(v: int) -> int:
    if v not in DM_POLICY_VALUES:
        raise ValueError(
            f"dm_policy must be one of {sorted(DM_POLICY_VALUES)}, got {v}"
        )
    return v


def _validate_friend_req_policy(v: int) -> int:
    if v not in FRIEND_REQ_POLICY_VALUES:
        raise ValueError(
            "friend_request_policy must be one of "
            f"{sorted(FRIEND_REQ_POLICY_VALUES)}, got {v}"
        )
    return v


class PrivacyOut(BaseModel):
    """The user's effective privacy settings.

    GET returns the defaults (everyone / everyone / true) when no row
    exists, so this is always populated — the frontend doesn't need a
    separate "first time?" branch.
    """

    dm_policy: int
    friend_request_policy: int
    show_in_search: bool


class PrivacyUpdate(BaseModel):
    """All fields optional — PUT is a partial-update upsert."""

    dm_policy: Annotated[
        int | None, Field(default=None, ge=0, le=255)
    ] = None
    friend_request_policy: Annotated[
        int | None, Field(default=None, ge=0, le=255)
    ] = None
    show_in_search: bool | None = None


# ---- User search (returned by auth-svc, mirrored here for typing) -------


class UserSearchHit(BaseModel):
    """Wire shape for one search hit returned by ``GET /users/search``.

    Re-exposed here only so chat-gateway tests + frontend can import a
    matching shape from a single place; the actual endpoint lives in
    auth-svc.
    """

    id: int
    username: str
    display_name: str | None = None
    avatar_url: str | None = None

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)
