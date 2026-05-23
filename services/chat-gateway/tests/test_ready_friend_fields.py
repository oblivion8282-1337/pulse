"""The ``ready`` frame must carry the Etappe-2 friend-system payload:
friends + incoming/outgoing requests + blocked user_ids + privacy.

Exercises the ws_app fixture (the only path that emits a real ready
frame), pre-installing rows via raw SQL into the temp-file SQLite.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

import dcc_chat_gateway.config as chat_cfg

from .conftest import install_friendship_sync, receive_skipping


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _install_block_sync(db_url: str, blocker: int, blocked: int) -> None:
    from sqlalchemy import create_engine

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO user_blocks (blocker_id, blocked_id, created_at) "
                "VALUES (?, ?, CURRENT_TIMESTAMP)",
                (blocker, blocked),
            )
    finally:
        eng.dispose()


def _install_request_sync(
    db_url: str, req_id: int, sender: int, receiver: int
) -> None:
    from sqlalchemy import create_engine

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO friend_requests (id, sender_id, receiver_id, created_at) "
                "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
                (req_id, sender, receiver),
            )
    finally:
        eng.dispose()


def _install_privacy_sync(
    db_url: str, uid: int, dm_policy: int, fr_policy: int, show: bool
) -> None:
    from sqlalchemy import create_engine

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO user_privacy (user_id, dm_policy, "
                "friend_request_policy, show_in_search, updated_at) "
                "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
                (uid, dm_policy, fr_policy, 1 if show else 0),
            )
    finally:
        eng.dispose()


@pytest.mark.asyncio
async def test_ready_includes_friend_fields_defaults(ws_app, _auth_signer):
    """A fresh user with no rows still gets the four keys, populated with
    defaults (empty lists + default privacy)."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            tok = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={tok}") as ws:
                ready = receive_skipping(ws)
                assert ready["op"] == "ready"
                assert ready["friends"] == []
                assert ready["friend_requests_in"] == []
                assert ready["friend_requests_out"] == []
                assert ready["blocked_user_ids"] == []
                assert ready["privacy"] == {
                    "dm_policy": 0,
                    "friend_request_policy": 0,
                    "show_in_search": True,
                }

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ready_includes_friends_and_pending_and_blocks(
    ws_app, _auth_signer
):
    """A user with friends + pending requests + blocks sees all of them in
    the ready frame, with snowflake ids serialized as strings."""

    def _run():
        with TestClient(ws_app) as tc:
            db = chat_cfg.get_settings().database_url
            uid = random.randint(1, 1_000_000)
            friend_uid = random.randint(1, 1_000_000)
            sender_uid = random.randint(1, 1_000_000)
            receiver_uid = random.randint(1, 1_000_000)
            blocked_uid = random.randint(1, 1_000_000)
            tok = _auth_signer.issue_access(uid, f"u{uid}")
            install_friendship_sync(db, uid, friend_uid)
            _install_request_sync(db, 11111, sender_uid, uid)  # incoming
            _install_request_sync(db, 22222, uid, receiver_uid)  # outgoing
            _install_block_sync(db, uid, blocked_uid)
            _install_privacy_sync(db, uid, 2, 1, False)  # FRIENDS_ONLY / SERVER_MEMBERS / hidden

            with tc.websocket_connect(f"/ws?token={tok}") as ws:
                ready = receive_skipping(ws)
                assert ready["op"] == "ready"
                assert ready["friends"] == [
                    {"user_id": str(friend_uid), "since": ready["friends"][0]["since"]}
                ]
                assert [r["sender_id"] for r in ready["friend_requests_in"]] == [
                    str(sender_uid)
                ]
                assert [
                    r["receiver_id"] for r in ready["friend_requests_out"]
                ] == [str(receiver_uid)]
                assert ready["blocked_user_ids"] == [str(blocked_uid)]
                assert ready["privacy"] == {
                    "dm_policy": 2,
                    "friend_request_policy": 1,
                    "show_in_search": False,
                }

    await asyncio.to_thread(_run)
