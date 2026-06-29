"""Der ``ready``-Frame trägt den instanzweiten Anzeigenamen (instance_name),
damit ALLE verbundenen Clients den Server-Namen statt der URL zeigen.
"""

from __future__ import annotations

import asyncio
import random

import dcc_chat_gateway.config as chat_cfg
import pytest
from starlette.testclient import TestClient

from .conftest import receive_skipping

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _set_instance_name(db_url: str, name: str | None) -> None:
    from sqlalchemy import create_engine

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE chat_settings SET instance_name = ? WHERE id = 1",
                (name,),
            )
    finally:
        eng.dispose()


@pytest.mark.asyncio
async def test_ready_instance_name_default_null(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            tok = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={tok}") as ws:
                ready = receive_skipping(ws)
                assert ready["op"] == "ready"
                assert ready["instance_name"] is None

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ready_carries_set_instance_name(ws_app, _auth_signer):
    def _run():
        db = chat_cfg.get_settings().database_url
        _set_instance_name(db, "Unicut Media")
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            tok = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={tok}") as ws:
                ready = receive_skipping(ws)
                assert ready["op"] == "ready"
                assert ready["instance_name"] == "Unicut Media"

    await asyncio.to_thread(_run)
