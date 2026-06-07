"""Per-user privacy + discoverability routes.

GET /me/privacy — returns the caller's effective settings, falling
back to defaults when no row exists. The frontend gets a populated
object on first load, no special-case branch needed.

PUT /me/privacy — partial-update upsert. Whatever fields the body
carries are written; the others stay as-is (or as defaults on a fresh
row). When ``show_in_search`` flips, we mirror the new value over to
auth-svc's ``users.discoverable`` so the search endpoint can filter
in a single query.
"""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.auth_mirror import push_discoverable
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_privacy import (
    DEFAULT_DM_POLICY,
    DEFAULT_FRIEND_REQ_POLICY,
    DEFAULT_SHOW_IN_SEARCH,
    DM_POLICY_VALUES,
    FRIEND_REQ_POLICY_VALUES,
)
from dcc_chat_gateway.friend_schemas import PrivacyOut, PrivacyUpdate
from dcc_chat_gateway.models import UserPrivacy
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.security import CurrentUser

# Privacy settings are part of the Social layer (dm_policy / friend_request_policy /
# show_in_search) — cloud-only, same as friends / DMs / blocks.
router = APIRouter(dependencies=[CloudOnly])


def _row_to_out(row: UserPrivacy | None) -> PrivacyOut:
    if row is None:
        return PrivacyOut(
            dm_policy=DEFAULT_DM_POLICY,
            friend_request_policy=DEFAULT_FRIEND_REQ_POLICY,
            show_in_search=DEFAULT_SHOW_IN_SEARCH,
        )
    return PrivacyOut(
        dm_policy=row.dm_policy,
        friend_request_policy=row.friend_request_policy,
        show_in_search=row.show_in_search,
    )


@router.get("/me/privacy", response_model=PrivacyOut)
async def get_my_privacy(session: SessionDep, current: CurrentUser):
    row = await session.get(UserPrivacy, current.id)
    return _row_to_out(row)


@router.put("/me/privacy", response_model=PrivacyOut)
async def update_my_privacy(
    payload: PrivacyUpdate,
    session: SessionDep,
    current: CurrentUser,
):
    """Upsert the caller's privacy row.

    Validation: ``dm_policy`` / ``friend_request_policy`` must be in
    their respective allowed-value sets (enforced here rather than via
    Pydantic so unknown integers fail with HTTP 422 + a readable
    detail). Returns the post-write effective settings.
    """
    if (
        payload.dm_policy is not None
        and payload.dm_policy not in DM_POLICY_VALUES
    ):
        from fastapi import HTTPException

        raise HTTPException(422, detail="invalid_dm_policy")
    if (
        payload.friend_request_policy is not None
        and payload.friend_request_policy not in FRIEND_REQ_POLICY_VALUES
    ):
        from fastapi import HTTPException

        raise HTTPException(422, detail="invalid_friend_request_policy")

    row = await session.get(UserPrivacy, current.id)
    prev_show_in_search: bool | None = None
    if row is None:
        row = UserPrivacy(
            user_id=current.id,
            dm_policy=(
                payload.dm_policy
                if payload.dm_policy is not None
                else DEFAULT_DM_POLICY
            ),
            friend_request_policy=(
                payload.friend_request_policy
                if payload.friend_request_policy is not None
                else DEFAULT_FRIEND_REQ_POLICY
            ),
            show_in_search=(
                payload.show_in_search
                if payload.show_in_search is not None
                else DEFAULT_SHOW_IN_SEARCH
            ),
        )
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            # Concurrent insert won the race; re-fetch and apply patch
            # to whatever's there.
            await session.rollback()
            row = await session.get(UserPrivacy, current.id)
            if row is None:
                from fastapi import HTTPException

                raise HTTPException(500, detail="privacy_race_lost")
            prev_show_in_search = row.show_in_search
            _apply_patch(row, payload)
            await session.commit()
        else:
            # On true first-create, the "previous" show_in_search is
            # the migration default (True). Only push when the row's
            # final value diverges from that default.
            prev_show_in_search = DEFAULT_SHOW_IN_SEARCH
    else:
        prev_show_in_search = row.show_in_search
        _apply_patch(row, payload)
        await session.commit()

    if (
        payload.show_in_search is not None
        and payload.show_in_search != prev_show_in_search
    ):
        await push_discoverable(current.id, row.show_in_search)

    await session.refresh(row)
    return _row_to_out(row)


def _apply_patch(row: UserPrivacy, payload: PrivacyUpdate) -> None:
    if payload.dm_policy is not None:
        row.dm_policy = payload.dm_policy
    if payload.friend_request_policy is not None:
        row.friend_request_policy = payload.friend_request_policy
    if payload.show_in_search is not None:
        row.show_in_search = payload.show_in_search
