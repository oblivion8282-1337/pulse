"""Tests for the CRL endpoint (/.well-known/revoked-credentials).

Redis is mocked via a lightweight in-memory dict-backed fake so the test
suite stays hermetic (no external Redis required).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from dcc_auth.models import IssuedCredential, User


# ---------------------------------------------------------------------------
# Fake Redis for unit tests
# ---------------------------------------------------------------------------


class _FakeRedis:
    """Minimal async Redis-compatible fake covering ZADD/ZRANGE/ZREMRANGEBYSCORE/
    GET/SET/PING used by routes_crl.py."""

    def __init__(self):
        self._zsets: dict[str, dict[str, float]] = defaultdict(dict)
        self._strings: dict[str, str] = {}

    async def ping(self):
        return True

    async def zadd(self, key: str, mapping: dict[str, float]):
        self._zsets[key].update(mapping)

    async def zrange(self, key: str, start: int, stop: int):
        members = sorted(self._zsets[key].items(), key=lambda x: x[1])
        if stop == -1:
            stop = len(members)
        return [m[0].encode() for m in members[start : stop + 1]]

    async def zremrangebyscore(self, key: str, minv: Any, maxv: Any):
        min_score = float("-inf") if minv == "-inf" else float(minv)
        max_score = float("inf") if maxv == "+inf" else float(maxv)
        to_del = [
            m for m, s in list(self._zsets[key].items()) if min_score <= s <= max_score
        ]
        for m in to_del:
            del self._zsets[key][m]

    async def get(self, key: str):
        val = self._strings.get(key)
        return val.encode() if val is not None else None

    async def set(self, key: str, value: str):
        self._strings[key] = value if isinstance(value, str) else value.decode()

    async def aclose(self):
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def fake_redis(app):
    """Attach a fresh FakeRedis to app.state.redis."""
    r = _FakeRedis()
    app.state.redis = r
    yield r
    app.state.redis = None


async def _seed_user(session_factory) -> int:
    """Insert a minimal user row and return its id."""
    from dcc_auth.snowflake import next_id

    uid = next_id()
    async with session_factory() as s:
        u = User(
            id=uid,
            username=f"u{uid}",
            email=f"u{uid}@dcc-test.example.com",
            password_hash="x",
            pairwise_salt=b"\x00" * 32,
        )
        s.add(u)
        await s.commit()
    return uid


async def _seed_cert(
    session_factory,
    user_id: int,
    *,
    revoked: bool = False,
    expires_delta_days: int = 365,
) -> str:
    """Insert an IssuedCredential row and return its cert_id (str)."""
    cid = str(uuid.uuid4())
    now = datetime.now(tz=UTC)
    expires = now + timedelta(days=expires_delta_days)
    async with session_factory() as s:
        cred = IssuedCredential(
            cert_id=cid,
            user_id=user_id,
            device_pubkey=b"\x00" * 32,
            device_label="test-device",
            issued_at=now,
            expires_at=expires,
            revoked_at=now if revoked else None,
        )
        s.add(cred)
        await s.commit()
    return cid


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCrlNoAuth:
    """Endpoint is public — no auth header required."""

    async def test_returns_200_and_json(self, client):
        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        body = r.json()
        assert body["version"] == 1
        assert isinstance(body["cert_ids"], list)

    async def test_empty_list_on_fresh_db(self, client):
        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        assert r.json()["cert_ids"] == []


class TestCrlContent:
    """After revocation the cert appears; after expiry it doesn't."""

    async def test_revoked_cert_appears(self, client, session_factory, fake_redis):
        uid = await _seed_user(session_factory)
        cid = await _seed_cert(session_factory, uid, revoked=True)
        # Also add to ZSET so the Redis path picks it up.
        from dcc_auth.routes_crl import crl_add

        expires_unix = int((datetime.now(tz=UTC) + timedelta(days=365)).timestamp())
        await crl_add(fake_redis, cid, expires_unix)

        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        assert cid in r.json()["cert_ids"]

    async def test_non_revoked_cert_absent(self, client, session_factory, fake_redis):
        uid = await _seed_user(session_factory)
        cid = await _seed_cert(session_factory, uid, revoked=False)
        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        assert cid not in r.json()["cert_ids"]

    async def test_expired_cert_not_listed(self, client, session_factory, fake_redis):
        """A cert that was revoked but has already expired must not appear."""
        uid = await _seed_user(session_factory)
        cid = await _seed_cert(session_factory, uid, revoked=True, expires_delta_days=-1)
        # Add to ZSET with a score in the past (already expired).
        past_unix = int((datetime.now(tz=UTC) - timedelta(days=1)).timestamp())
        await fake_redis.zadd("auth:revoked_certs", {cid: past_unix})

        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        # Auto-prune must have removed it.
        assert cid not in r.json()["cert_ids"]

    async def test_cert_before_expiry_stays_listed(self, client, session_factory, fake_redis):
        """Revoked cert within its validity window stays — replay-bug regression."""
        uid = await _seed_user(session_factory)
        cid = await _seed_cert(session_factory, uid, revoked=True, expires_delta_days=300)
        from dcc_auth.routes_crl import crl_add

        future_unix = int((datetime.now(tz=UTC) + timedelta(days=300)).timestamp())
        await crl_add(fake_redis, cid, future_unix)

        r = await client.get("/.well-known/revoked-credentials")
        assert cid in r.json()["cert_ids"]


class TestETag:
    """ETag behaviour: 200 on first, 304 on repeat, invalidation after mutation."""

    async def test_first_request_returns_etag(self, client, fake_redis):
        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        assert "ETag" in r.headers

    async def test_second_request_304_with_matching_etag(self, client, fake_redis):
        r1 = await client.get("/.well-known/revoked-credentials")
        assert r1.status_code == 200
        etag = r1.headers["ETag"]

        r2 = await client.get(
            "/.well-known/revoked-credentials",
            headers={"If-None-Match": etag},
        )
        assert r2.status_code == 304

    async def test_etag_changes_after_revocation(
        self, client, session_factory, fake_redis
    ):
        r1 = await client.get("/.well-known/revoked-credentials")
        etag1 = r1.headers["ETag"]

        uid = await _seed_user(session_factory)
        cid = await _seed_cert(session_factory, uid, revoked=True)
        from dcc_auth.routes_crl import crl_add

        future_unix = int((datetime.now(tz=UTC) + timedelta(days=365)).timestamp())
        await crl_add(fake_redis, cid, future_unix)

        r2 = await client.get("/.well-known/revoked-credentials")
        assert r2.status_code == 200
        assert r2.headers["ETag"] != etag1

    async def test_wrong_etag_returns_200(self, client, fake_redis):
        r = await client.get(
            "/.well-known/revoked-credentials",
            headers={"If-None-Match": '"stale-etag-value"'},
        )
        assert r.status_code == 200

    async def test_50x_stress_mostly_304(self, client, fake_redis):
        """50 sequential polls with unchanged state → 49× 304."""
        r1 = await client.get("/.well-known/revoked-credentials")
        assert r1.status_code == 200
        etag = r1.headers["ETag"]

        not_modified = 0
        for _ in range(49):
            r = await client.get(
                "/.well-known/revoked-credentials",
                headers={"If-None-Match": etag},
            )
            if r.status_code == 304:
                not_modified += 1
        assert not_modified == 49


class TestCrlFallback:
    """Without Redis the endpoint falls back to a direct DB query."""

    async def test_returns_200_without_redis(self, client, app, session_factory):
        # Ensure no Redis is attached.
        app.state.redis = None
        uid = await _seed_user(session_factory)
        cid = await _seed_cert(session_factory, uid, revoked=True)

        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        # DB-fallback path still includes the cert if expires_at > now.
        body = r.json()
        assert body["version"] == 1
        assert cid in body["cert_ids"]

    async def test_etag_computed_without_redis(self, client, app):
        app.state.redis = None
        r = await client.get("/.well-known/revoked-credentials")
        assert r.status_code == 200
        assert "ETag" in r.headers

    async def test_304_without_redis(self, client, app):
        app.state.redis = None
        r1 = await client.get("/.well-known/revoked-credentials")
        etag = r1.headers["ETag"]
        r2 = await client.get(
            "/.well-known/revoked-credentials",
            headers={"If-None-Match": etag},
        )
        assert r2.status_code == 304


class TestRateLimit:
    """61st request in same window → 429."""

    async def test_rate_limit_enforced(self, client, app, fake_redis):
        from dcc_auth.routes import _reset_rate

        _reset_rate(app)
        responses = []
        for _ in range(61):
            r = await client.get("/.well-known/revoked-credentials")
            responses.append(r.status_code)

        assert responses[-1] == 429
        assert all(s == 200 for s in responses[:60])


class TestVersionPolicy:
    """/.well-known/pulse-version-policy.json is public and returns a version."""

    async def test_returns_200_no_auth(self, client):
        r = await client.get("/.well-known/pulse-version-policy.json")
        assert r.status_code == 200
        body = r.json()
        assert "current_version" in body
        assert isinstance(body["current_version"], str)

    async def test_version_env_override(self, client, monkeypatch):
        import dcc_auth.routes_crl as crl_mod

        crl_mod._VERSION = None  # reset cached value
        monkeypatch.setenv("PULSE_VERSION", "9.9.9-test")
        r = await client.get("/.well-known/pulse-version-policy.json")
        assert r.json()["current_version"] == "9.9.9-test"
        crl_mod._VERSION = None  # cleanup
