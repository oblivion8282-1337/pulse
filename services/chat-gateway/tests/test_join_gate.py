"""Tests for the Self-Host join gate (Stufe 5 — "Server gesperrt" toggle).

Covers ``routes/cert_login.py``'s join gate. Gate order:
    owner → existing member → ``locked`` not-aus → per-community grants
    (public-community handle / community-invite code).

The single ``chat_settings.locked`` toggle overrides BOTH grant paths — it is
checked before either, so a sealed instance admits no new member regardless of
how they arrived. ``validate_cert`` is monkey-patched just like
``test_cert_login.py`` — this file focuses on the join logic layered on top.
"""

from __future__ import annotations

import base64
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dcc_chat_gateway.credential_validator import CertClaims
from dcc_chat_gateway.models import (
    ChatSettings,
    Guild,
    GuildInvite,
    InstanceMember,
)
from dcc_chat_gateway.routes import cert_login as cert_login_route
from dcc_chat_gateway.session_tokens import reset_session_signer
from sqlalchemy import select


@pytest.fixture(autouse=True)
def _route_settings(tmp_path):
    """Bind ``cert_login.get_settings`` to a per-test Settings (same approach as
    ``test_cert_login._route_settings``) so the route sees the test config with
    the session-signing key in ``tmp_path``."""
    from dcc_chat_gateway.config import Settings as _Settings

    cert_login_route._reset_challenge_secret_for_tests()
    cert_login_route._reset_cert_login_rate_for_tests()
    reset_session_signer()

    settings = _Settings(
        session_signing_key_file=str(tmp_path / "session_signing.pem"),
        pulse_instance_mode="self-host",
        pulse_instance_id=0,
        chat_gateway_challenge_secret="",
    )
    original = cert_login_route.get_settings
    cert_login_route.get_settings = lambda: settings  # type: ignore[assignment]
    yield settings
    cert_login_route.get_settings = original  # type: ignore[assignment]
    reset_session_signer()
    cert_login_route._reset_challenge_secret_for_tests()
    cert_login_route._reset_cert_login_rate_for_tests()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _make_claims(*, user_id: str, device_pubkey: str) -> CertClaims:
    now = int(time.time())
    return CertClaims(
        cert_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        user_id=user_id,
        device_pubkey=device_pubkey,
        device_label="Test Device",
        pairwise_seed=_b64url(b"\xab" * 32),
        amr=["pwd"],
        acr="1",
        iat=now,
        exp=now + 3600,
    )


def _patch_validate(claims: CertClaims | None):
    async def _fake(_cert: str, _redis):  # noqa: ARG001
        return claims

    return patch.object(cert_login_route, "validate_cert", _fake)


async def _set_locked(session_factory, locked: bool) -> None:
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        row.locked = locked
        await s.commit()


async def _attempt_join(
    client,
    _route_settings,
    *,
    user_id: str,
    owner_id: int = 0,
    community_grant_code=None,
    public_join_handle=None,
):
    """Run challenge→sign→verify. Returns the httpx Response."""
    priv = Ed25519PrivateKey.generate()
    pub_b64 = _b64url(priv.public_key().public_bytes_raw())
    claims = _make_claims(user_id=user_id, device_pubkey=pub_b64)
    _route_settings.pulse_instance_mode = "self-host"
    _route_settings.pulse_instance_id = 42
    _route_settings.pulse_instance_owner_id = owner_id
    with _patch_validate(claims):
        ch = (await client.post("/cert-login/challenge", json={"cert": "stub"})).json()
        raw = base64.urlsafe_b64decode(ch["nonce"] + "==")
        sig = _b64url(priv.sign(raw))
        body = {"cert": "stub", "challenge_token": ch["challenge_token"], "signature": sig}
        if community_grant_code is not None:
            body["community_grant_code"] = community_grant_code
        if public_join_handle is not None:
            body["public_join_handle"] = public_join_handle
        return await client.post("/cert-login/verify", json=body)


async def _seed_public_guild(
    session_factory, handle: str, *, is_public: bool = True, guild_id: int = 888
) -> None:
    """Install a guild with a handle + public flag so the public-community
    instance grant has a real community to validate against."""
    async with session_factory() as s:
        s.add(
            Guild(
                id=guild_id,
                name="PublicCommunity",
                owner_id=1,
                handle=handle,
                is_public=is_public,
            )
        )
        await s.commit()


async def _seed_guild_invite(
    session_factory,
    code: str,
    *,
    revoked=False,
    expires_at=None,
    max_uses=None,
    uses=0,
) -> None:
    """Install a guild + a GuildInvite so the community-invite instance grant
    has a real (host-coined) invite to validate against."""
    revoked_at = datetime.now(UTC) if revoked else None
    async with session_factory() as s:
        s.add(Guild(id=777, name="Community", owner_id=1))
        s.add(
            GuildInvite(
                code=code,
                guild_id=777,
                creator_id=1,
                revoked_at=revoked_at,
                expires_at=expires_at,
                max_uses=max_uses,
                uses=uses,
            )
        )
        await s.commit()


async def _members(session_factory) -> set[str]:
    async with session_factory() as s:
        rows = (await s.execute(select(InstanceMember.user_identifier))).scalars().all()
    return set(rows)


# ---------------------------------------------------------------------------
# Owner + existing-member paths (locked + unlocked)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("locked", [False, True])
async def test_owner_joins_regardless_of_lock(
    client, _route_settings, session_factory, locked
):
    """The owner always gets in — even on a sealed instance (no self-lockout)."""
    await _set_locked(session_factory, locked)
    resp = await _attempt_join(client, _route_settings, user_id="555", owner_id=555)
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("locked", [False, True])
async def test_existing_member_reauth_regardless_of_lock(
    client, _route_settings, session_factory, locked
):
    """Re-auth path: an already-joined member is checked BEFORE the lock, so a
    sealed instance never evicts current members."""
    # First join while unlocked via a public handle.
    await _set_locked(session_factory, False)
    await _seed_public_guild(session_factory, "firsthouse")
    first = await _attempt_join(
        client, _route_settings, user_id="777", public_join_handle="firsthouse"
    )
    assert first.status_code == 200, first.text
    identifier = first.json()["pairwise_sub"]
    # Now (maybe) seal the instance and re-auth with NO grant — must still pass.
    await _set_locked(session_factory, locked)
    cert_login_route._reset_cert_login_rate_for_tests()
    again = await _attempt_join(client, _route_settings, user_id="777")
    assert again.status_code == 200, again.text
    assert again.json()["pairwise_sub"] == identifier


# ---------------------------------------------------------------------------
# Unlocked: per-community grants admit a new member
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unlocked_no_grant_denied(client, _route_settings, session_factory):
    """Unlocked but no grant at all → still denied (access is per-community)."""
    await _set_locked(session_factory, False)
    resp = await _attempt_join(client, _route_settings, user_id="111")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_not_permitted"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_unlocked_public_handle_admits(client, _route_settings, session_factory):
    await _set_locked(session_factory, False)
    await _seed_public_guild(session_factory, "openhouse")
    resp = await _attempt_join(
        client, _route_settings, user_id="2001", public_join_handle="openhouse"
    )
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1
    async with session_factory() as s:
        ident = resp.json()["pairwise_sub"]
        row = await s.get(InstanceMember, ident)
        assert row.joined_via == "public_community"


@pytest.mark.asyncio
async def test_unlocked_community_invite_admits(client, _route_settings, session_factory):
    await _set_locked(session_factory, False)
    await _seed_guild_invite(session_factory, "LIVECOMM")
    resp = await _attempt_join(
        client, _route_settings, user_id="1001", community_grant_code="LIVECOMM"
    )
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1
    async with session_factory() as s:
        ident = resp.json()["pairwise_sub"]
        row = await s.get(InstanceMember, ident)
        assert row.joined_via == "community_invite"


# ---------------------------------------------------------------------------
# locked: the "Server gesperrt" not-aus overrides BOTH grant paths
# ---------------------------------------------------------------------------
#
# This is the security-critical contract of Stufe 5: a sealed instance admits no
# NEW member, regardless of how they arrived — the lock is checked before every
# grant path.


@pytest.mark.asyncio
async def test_locked_blocks_no_grant(client, _route_settings, session_factory):
    await _set_locked(session_factory, True)
    resp = await _attempt_join(client, _route_settings, user_id="222")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_locked"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_locked_blocks_community_invite(client, _route_settings, session_factory):
    """A live community invite must NOT bypass the lock (overrides Stufe 2)."""
    await _set_locked(session_factory, True)
    await _seed_guild_invite(session_factory, "LIVELCKD")
    resp = await _attempt_join(
        client, _route_settings, user_id="1007", community_grant_code="LIVELCKD"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_locked"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_locked_blocks_public_handle(client, _route_settings, session_factory):
    """A public-community handle must NOT bypass the lock — unlike the old
    ``closed`` asymmetry, the single ``locked`` toggle overrides public too
    (Entscheidung 7 / Stufe 5)."""
    await _set_locked(session_factory, True)
    await _seed_public_guild(session_factory, "evensealed")
    resp = await _attempt_join(
        client, _route_settings, user_id="2002", public_join_handle="evensealed"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_locked"
    assert await _members(session_factory) == set()


# ---------------------------------------------------------------------------
# Community-invite grant validity (unlocked)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_community_invite_does_not_consume_guild_invite_use(
    client, _route_settings, session_factory
):
    """The instance grant is non-consuming — the GuildInvite's use is spent
    later by accept_invite, not here."""
    await _set_locked(session_factory, False)
    await _seed_guild_invite(session_factory, "NOCONSUM", max_uses=1)
    resp = await _attempt_join(
        client, _route_settings, user_id="1002", community_grant_code="NOCONSUM"
    )
    assert resp.status_code == 200, resp.text
    async with session_factory() as s:
        inv = await s.get(GuildInvite, "NOCONSUM")
        assert inv.uses == 0  # not consumed by the instance grant


@pytest.mark.asyncio
async def test_community_invite_unknown_code_grants_nothing(
    client, _route_settings, session_factory
):
    await _set_locked(session_factory, False)
    resp = await _attempt_join(
        client, _route_settings, user_id="1003", community_grant_code="NOSUCHCODE"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_not_permitted"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_revoked_grants_nothing(
    client, _route_settings, session_factory
):
    await _set_locked(session_factory, False)
    await _seed_guild_invite(session_factory, "DEADCOMM", revoked=True)
    resp = await _attempt_join(
        client, _route_settings, user_id="1004", community_grant_code="DEADCOMM"
    )
    assert resp.status_code == 403
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_expired_grants_nothing(
    client, _route_settings, session_factory
):
    await _set_locked(session_factory, False)
    past = datetime.now(UTC) - timedelta(days=1)
    await _seed_guild_invite(session_factory, "OLDCOMM", expires_at=past)
    resp = await _attempt_join(
        client, _route_settings, user_id="1005", community_grant_code="OLDCOMM"
    )
    assert resp.status_code == 403
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_exhausted_grants_nothing(
    client, _route_settings, session_factory
):
    await _set_locked(session_factory, False)
    await _seed_guild_invite(session_factory, "FULLCOMM", max_uses=1, uses=1)
    resp = await _attempt_join(
        client, _route_settings, user_id="1006", community_grant_code="FULLCOMM"
    )
    assert resp.status_code == 403
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_member_reauth_without_code(
    client, _route_settings, session_factory
):
    """Once joined via a community invite, the member re-auths with no code at
    all (the critical re-auth path — community invites must not be re-demanded
    on every 5-minute token refresh)."""
    await _set_locked(session_factory, False)
    await _seed_guild_invite(session_factory, "REAUTHCM")
    first = await _attempt_join(
        client, _route_settings, user_id="1008", community_grant_code="REAUTHCM"
    )
    assert first.status_code == 200, first.text
    cert_login_route._reset_cert_login_rate_for_tests()
    again = await _attempt_join(client, _route_settings, user_id="1008")
    assert again.status_code == 200, again.text


# ---------------------------------------------------------------------------
# Public-community grant validity (unlocked)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_public_handle_grants_nothing(
    client, _route_settings, session_factory
):
    """A community with a handle but NOT public grants no instance access."""
    await _set_locked(session_factory, False)
    await _seed_public_guild(session_factory, "stillprivate", is_public=False)
    resp = await _attempt_join(
        client, _route_settings, user_id="2003", public_join_handle="stillprivate"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_not_permitted"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_unknown_handle_grants_nothing(client, _route_settings, session_factory):
    await _set_locked(session_factory, False)
    resp = await _attempt_join(
        client, _route_settings, user_id="2004", public_join_handle="nosuchhandle"
    )
    assert resp.status_code == 403
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_public_handle_member_reauth_without_handle(
    client, _route_settings, session_factory
):
    """Once joined via a public handle, the member re-auths with no handle at
    all (the critical re-auth path)."""
    await _set_locked(session_factory, False)
    await _seed_public_guild(session_factory, "reauthpub")
    first = await _attempt_join(
        client, _route_settings, user_id="2005", public_join_handle="reauthpub"
    )
    assert first.status_code == 200, first.text
    cert_login_route._reset_cert_login_rate_for_tests()
    again = await _attempt_join(client, _route_settings, user_id="2005")
    assert again.status_code == 200, again.text


# ---------------------------------------------------------------------------
# Admin toggle
# ---------------------------------------------------------------------------


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_admin_patch_locked(client, admin_token, session_factory):
    token, _uid = admin_token
    resp = await client.patch(
        "/admin/permissions", json={"locked": True}, headers=_auth(token)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["locked"] is True
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        assert row.locked is True


@pytest.mark.asyncio
async def test_admin_patch_locked_back_to_false(client, admin_token, session_factory):
    token, _uid = admin_token
    await client.patch(
        "/admin/permissions", json={"locked": True}, headers=_auth(token)
    )
    resp = await client.patch(
        "/admin/permissions", json={"locked": False}, headers=_auth(token)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["locked"] is False
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        assert row.locked is False
