"""Tests for user_profile_cache.py (Phase 3.2 / DE 11 A.2).

Coverage:
1. Valid statement → upserted profile returned
2. Replay (iat == previous) → ProfileStatementReplay raised
3. Replay (iat < previous) → ProfileStatementReplay raised
4. Expired JWT (exp < now) → ProfileStatementInvalid raised
5. Wrong purpose claim → ProfileStatementInvalid raised
6. Bad / missing signature → ProfileStatementInvalid raised
7. Cloud-mode: user_identifier == sub
8. Self-host-mode: user_identifier == pairwise(instance_id, sub, seed) — deterministic
9. Stale-marking after 24h
10. Second valid statement (iat > previous) → upserted successfully (replay guard advances)
"""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from dcc_chat_gateway.db import Base
from dcc_chat_gateway.models.moderation import CachedUserProfile
from dcc_chat_gateway.user_profile_cache import (
    ProfileStatementInvalid,
    ProfileStatementReplay,
    mark_stale_if_expired,
    upsert_profile_statement,
)

# ─── Test RSA keypair ─────────────────────────────────────────────────────────

_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_RSA_PUBLIC_KEY = _RSA_KEY.public_key()
_KID = "profile-test-key-1"
_ALT_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _cloud_jwks() -> dict[str, Any]:
    """Build a JWKS dict for the test RSA key."""
    nums = _RSA_PUBLIC_KEY.public_numbers()

    def _b64(n: int) -> str:
        bl = (n.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(n.to_bytes(bl, "big")).rstrip(b"=").decode()

    return {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "alg": "RS256",
                "kid": _KID,
                "n": _b64(nums.n),
                "e": _b64(nums.e),
            }
        ]
    }


def _make_statement(
    *,
    sub: str = "user-100",
    username: str = "alice",
    display_name: str = "Alice",
    avatar_hash: str | None = "abc123",
    profile_color: str | None = "#ff0000",
    profile_color_secondary: str | None = "#00ff00",
    profile_gradient_angle: int | None = 135,
    purpose: str = "profile-statement",
    iat_offset: int = 0,
    exp_offset: int = 3600,
    sign_key=None,
    kid: str = _KID,
) -> str:
    now = int(time.time())
    payload = {
        "sub": sub,
        "username": username,
        "display_name": display_name,
        "avatar_hash": avatar_hash,
        "profile_color": profile_color,
        "profile_color_secondary": profile_color_secondary,
        "profile_gradient_angle": profile_gradient_angle,
        "purpose": purpose,
        "iat": now + iat_offset,
        "exp": now + exp_offset,
    }
    return jwt.encode(
        payload,
        sign_key if sign_key is not None else _RSA_KEY,
        algorithm="RS256",
        headers={"kid": kid},
    )


# ─── DB fixtures ─────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        for table in Base.metadata.tables.values():
            table.schema = None
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as sess:
        yield sess
    await engine.dispose()


# ─── Tests ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_valid_statement_upserts_profile(session: AsyncSession):
    stmt = _make_statement()
    profile = await upsert_profile_statement(
        session,
        stmt,
        cloud_jwks=_cloud_jwks(),
        instance_mode="cloud",
    )
    await session.flush()
    assert profile.user_identifier == "user-100"
    assert profile.username == "alice"
    assert profile.display_name == "Alice"
    assert profile.avatar_hash == "abc123"
    assert profile.profile_color == "#ff0000"
    assert profile.profile_color_secondary == "#00ff00"
    assert profile.profile_gradient_angle == 135
    assert not profile.stale


@pytest.mark.asyncio
async def test_replay_same_iat_raises(session: AsyncSession):
    now = int(time.time())
    stmt = _make_statement(iat_offset=0)
    await upsert_profile_statement(
        session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    await session.flush()

    # Same iat → replay
    with pytest.raises(ProfileStatementReplay):
        await upsert_profile_statement(
            session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
        )


@pytest.mark.asyncio
async def test_replay_older_iat_raises(session: AsyncSession):
    # First insert with iat = now
    stmt_first = _make_statement(iat_offset=0)
    await upsert_profile_statement(
        session, stmt_first, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    await session.flush()

    # Second statement with iat = now - 10 (older) → replay
    stmt_old = _make_statement(iat_offset=-10)
    with pytest.raises(ProfileStatementReplay):
        await upsert_profile_statement(
            session, stmt_old, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
        )


@pytest.mark.asyncio
async def test_expired_jwt_raises(session: AsyncSession):
    # exp in the past
    stmt = _make_statement(iat_offset=-3700, exp_offset=-100)
    with pytest.raises(ProfileStatementInvalid, match="expired"):
        await upsert_profile_statement(
            session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
        )


@pytest.mark.asyncio
async def test_wrong_purpose_raises(session: AsyncSession):
    stmt = _make_statement(purpose="access-token")
    with pytest.raises(ProfileStatementInvalid, match="purpose"):
        await upsert_profile_statement(
            session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
        )


@pytest.mark.asyncio
async def test_bad_signature_raises(session: AsyncSession):
    # Signed with a different key — JWKS only contains _RSA_KEY's public key
    stmt = _make_statement(sign_key=_ALT_RSA_KEY)
    with pytest.raises(ProfileStatementInvalid):
        await upsert_profile_statement(
            session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
        )


@pytest.mark.asyncio
async def test_unknown_kid_raises(session: AsyncSession):
    stmt = _make_statement(kid="unknown-kid")
    with pytest.raises(ProfileStatementInvalid, match="kid"):
        await upsert_profile_statement(
            session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
        )


@pytest.mark.asyncio
async def test_cloud_mode_identifier_equals_sub(session: AsyncSession):
    stmt = _make_statement(sub="user-42")
    profile = await upsert_profile_statement(
        session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    assert profile.user_identifier == "user-42"


@pytest.mark.asyncio
async def test_self_host_mode_identifier_ist_die_cloud_kennung(session: AsyncSession):
    """Auf einem Self-Host ist die Kennung das ``sub`` selbst.

    Bis zum 2026-08-28 stand hier das Gegenteil: Die Kennung war ein Pseudonym
    je Server, damit ein Betreiber nicht erfaehrt, welches Cloud-Konto
    dahintersteckt. Diese Zusage ist mit dem Ticket-Weg bewusst zurueckgenommen
    (Abschnitt 20 der Datenschutzerklaerung) — das Ticket traegt die Kennung
    offen, und eine zweite Identitaet daraus abzuleiten waere genau die
    Doppelbuchfuehrung, die der Umbau beseitigt hat.
    """
    stmt = _make_statement(sub="4711")
    profile = await upsert_profile_statement(
        session,
        stmt,
        cloud_jwks=_cloud_jwks(),
        instance_mode="self-host",
        instance_id="7",
    )
    assert profile.user_identifier == "4711"


@pytest.mark.asyncio
async def test_self_host_dieselbe_kennung_auf_verschiedenen_instanzen(
    session: AsyncSession,
):
    """Und zwar auf JEDEM Server dieselbe.

    Das ist die Kehrseite derselben Entscheidung: Zwei Betreiber koennen ihre
    Listen abgleichen und dieselbe Person wiedererkennen. Der Test haelt die
    Eigenschaft fest, damit sie nicht versehentlich zurueckgedreht wird — sie
    steht so in der Datenschutzerklaerung.
    """
    a = await upsert_profile_statement(
        session,
        _make_statement(sub="4711"),
        cloud_jwks=_cloud_jwks(),
        instance_mode="self-host",
        instance_id="1",
    )
    kennung_a = a.user_identifier
    await session.rollback()
    b = await upsert_profile_statement(
        session,
        _make_statement(sub="4711", iat_offset=1),
        cloud_jwks=_cloud_jwks(),
        instance_mode="self-host",
        instance_id="2",
    )
    assert b.user_identifier == kennung_a


@pytest.mark.asyncio
async def test_self_host_synthetic_user_id_ist_die_kennung(session: AsyncSession):
    """``synthetic_user_id`` ist die Zahl, die der Rest des Schemas benutzt
    (``GuildMember.user_id``, LiveKit ``user-<id>``).

    Sie wurde frueher aus dem Pseudonym gerechnet. Jetzt IST sie die Kennung —
    eine Identitaet statt zweier.
    """
    stmt = _make_statement(sub="4711")
    profile = await upsert_profile_statement(
        session,
        stmt,
        cloud_jwks=_cloud_jwks(),
        instance_mode="self-host",
        instance_id="7",
    )
    assert profile.synthetic_user_id == 4711


@pytest.mark.asyncio


@pytest.mark.asyncio
async def test_stale_marking_after_24h(session: AsyncSession):
    stmt = _make_statement()
    profile = await upsert_profile_statement(
        session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    await session.flush()

    # Manually age the last_statement_iat by 25 hours
    profile.last_statement_iat = datetime.now(tz=timezone.utc) - timedelta(hours=25)
    session.add(profile)
    await session.flush()

    was_stale = await mark_stale_if_expired(session, profile, ttl_seconds=86400)
    assert was_stale
    assert profile.stale


@pytest.mark.asyncio
async def test_stale_marking_fresh_profile_unchanged(session: AsyncSession):
    stmt = _make_statement()
    profile = await upsert_profile_statement(
        session, stmt, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    await session.flush()

    was_stale = await mark_stale_if_expired(session, profile, ttl_seconds=86400)
    assert not was_stale
    assert not profile.stale


@pytest.mark.asyncio
async def test_second_newer_statement_updates_profile(session: AsyncSession):
    stmt1 = _make_statement(username="alice", iat_offset=0)
    await upsert_profile_statement(
        session, stmt1, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    await session.flush()

    stmt2 = _make_statement(username="alice_updated", iat_offset=60)
    profile = await upsert_profile_statement(
        session, stmt2, cloud_jwks=_cloud_jwks(), instance_mode="cloud"
    )
    await session.flush()

    assert profile.username == "alice_updated"
    assert not profile.stale
