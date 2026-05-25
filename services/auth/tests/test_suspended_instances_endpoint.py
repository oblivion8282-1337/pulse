"""Tests für GET /.well-known/pulse-suspended-instances.

Redis wird via FakeRedis gemockt (hermetic, kein externes Redis erforderlich).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

import pytest
import pytest_asyncio

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.snowflake import next_id


# ---------------------------------------------------------------------------
# FakeRedis (analog zu test_crl_endpoint.py)
# ---------------------------------------------------------------------------


class _FakeRedis:
    def __init__(self):
        self._strings: dict[str, str] = {}

    async def ping(self):
        return True

    async def get(self, key: str):
        val = self._strings.get(key)
        return val.encode() if val is not None else None

    async def set(self, key: str, value: str):
        self._strings[key] = value if isinstance(value, str) else value.decode()

    async def delete(self, *keys: str):
        for k in keys:
            self._strings.pop(k, None)

    async def aclose(self):
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def fake_redis(app):
    r = _FakeRedis()
    app.state.redis = r
    yield r
    app.state.redis = None


async def _seed_admin(session_factory) -> User:
    uid = next_id()
    async with session_factory() as s:
        u = User(
            id=uid,
            username=f"admin{uid}",
            email=f"admin{uid}@dcc-test.example.com",
            password_hash="x",
            pairwise_salt=b"\x00" * 32,
            is_admin=True,
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
    return u


async def _seed_instance(session_factory, *, suspended: bool = False) -> int:
    """Insert a RegisteredInstance and optionally a SuspendedInstance. Returns instance_id."""
    iid = next_id()
    admin = await _seed_admin(session_factory)
    async with session_factory() as s:
        inst = RegisteredInstance(
            id=iid,
            hostname=f"inst-{iid}.example.com",
            client_id=f"cid-{iid}",
            client_secret="hash",
            worker_id_chat=iid % 900 + 1,
            worker_id_voice=iid % 900 + 2,
            worker_id_media=iid % 900 + 3,
            status="suspended" if suspended else "active",
            registered_by=admin.id,
        )
        s.add(inst)
        await s.flush()
        if suspended:
            s.add(SuspendedInstance(instance_id=iid, reason="test"))
        await s.commit()
    return iid


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestPublicEndpoint:
    async def test_200_no_auth_required(self, client):
        r = await client.get("/.well-known/pulse-suspended-instances")
        assert r.status_code == 200

    async def test_empty_list_initially(self, client):
        r = await client.get("/.well-known/pulse-suspended-instances")
        body = r.json()
        assert body["version"] == 1
        assert body["instance_ids"] == []
        assert "updated_at" in body

    async def test_suspended_instance_appears(self, client, session_factory, fake_redis):
        iid = await _seed_instance(session_factory, suspended=True)
        r = await client.get("/.well-known/pulse-suspended-instances")
        assert r.status_code == 200
        assert str(iid) in r.json()["instance_ids"]

    async def test_active_instance_not_listed(self, client, session_factory, fake_redis):
        iid = await _seed_instance(session_factory, suspended=False)
        r = await client.get("/.well-known/pulse-suspended-instances")
        assert str(iid) not in r.json()["instance_ids"]

    async def test_returns_etag(self, client, fake_redis):
        r = await client.get("/.well-known/pulse-suspended-instances")
        assert r.status_code == 200
        assert "ETag" in r.headers

    async def test_304_with_matching_etag(self, client, fake_redis):
        r1 = await client.get("/.well-known/pulse-suspended-instances")
        etag = r1.headers["ETag"]
        r2 = await client.get(
            "/.well-known/pulse-suspended-instances",
            headers={"If-None-Match": etag},
        )
        assert r2.status_code == 304

    async def test_200_on_wrong_etag(self, client, fake_redis):
        r = await client.get(
            "/.well-known/pulse-suspended-instances",
            headers={"If-None-Match": '"stale"'},
        )
        assert r.status_code == 200

    async def test_etag_changes_after_suspend(self, client, session_factory, fake_redis):
        r1 = await client.get("/.well-known/pulse-suspended-instances")
        etag1 = r1.headers["ETag"]

        # Invalidate cache (as Phase 2.3 would do via suspended_list_add)
        from dcc_auth.routes_suspended_instances import suspended_list_add

        await _seed_instance(session_factory, suspended=True)
        await suspended_list_add(fake_redis, 999)

        r2 = await client.get("/.well-known/pulse-suspended-instances")
        assert r2.status_code == 200
        # ETag must be different (cache was invalidated)
        assert r2.headers["ETag"] != etag1


class TestFallbackWithoutRedis:
    async def test_200_without_redis(self, client, app, session_factory):
        app.state.redis = None
        iid = await _seed_instance(session_factory, suspended=True)
        r = await client.get("/.well-known/pulse-suspended-instances")
        assert r.status_code == 200
        assert str(iid) in r.json()["instance_ids"]

    async def test_304_without_redis(self, client, app):
        app.state.redis = None
        r1 = await client.get("/.well-known/pulse-suspended-instances")
        etag = r1.headers["ETag"]
        r2 = await client.get(
            "/.well-known/pulse-suspended-instances",
            headers={"If-None-Match": etag},
        )
        assert r2.status_code == 304
