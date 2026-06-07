"""Tests for the Self-Host join gate + join-invite admin routes (0032).

Covers ``routes/cert_login.py``'s join gate (owner / existing member /
first-contact by join_mode) and ``routes/admin_join_invites.py`` (mint / list /
revoke + audit log). ``validate_cert`` is monkey-patched just like
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
    InstanceJoinInvite,
    InstanceMember,
    ModAuditLog,
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


async def _set_join_mode(session_factory, mode: str) -> None:
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        row.join_mode = mode
        await s.commit()


async def _attempt_join(
    client,
    _route_settings,
    *,
    user_id: str,
    owner_id: int = 0,
    join_code=None,
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
        if join_code is not None:
            body["join_code"] = join_code
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
# Owner + existing-member paths (every mode)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["open", "invite_only", "closed"])
async def test_owner_joins_without_invite(client, _route_settings, session_factory, mode):
    await _set_join_mode(session_factory, mode)
    resp = await _attempt_join(client, _route_settings, user_id="555", owner_id=555)
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["open", "invite_only", "closed"])
async def test_existing_member_reauth_no_invite(client, _route_settings, session_factory, mode):
    """Re-auth path: an already-joined member never needs an invite again."""
    # First join while open.
    await _set_join_mode(session_factory, "open")
    first = await _attempt_join(client, _route_settings, user_id="777")
    assert first.status_code == 200, first.text
    identifier = first.json()["pairwise_sub"]
    # Now lock the instance down and re-auth — must still pass.
    await _set_join_mode(session_factory, mode)
    cert_login_route._reset_cert_login_rate_for_tests()
    again = await _attempt_join(client, _route_settings, user_id="777")
    assert again.status_code == 200, again.text
    assert again.json()["pairwise_sub"] == identifier


# ---------------------------------------------------------------------------
# First-contact by join_mode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_first_contact_open(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "open")
    resp = await _attempt_join(client, _route_settings, user_id="111")
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1


@pytest.mark.asyncio
async def test_first_contact_closed(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "closed")
    resp = await _attempt_join(client, _route_settings, user_id="222")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_closed"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_first_contact_invite_only_no_code(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "invite_only")
    resp = await _attempt_join(client, _route_settings, user_id="333")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_requires_invite"


@pytest.mark.asyncio
async def test_first_contact_invite_only_valid_code(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "invite_only")
    async with session_factory() as s:
        s.add(InstanceJoinInvite(code="GOODCODE", created_by="admin", max_uses=5))
        await s.commit()
    resp = await _attempt_join(client, _route_settings, user_id="444", join_code="GOODCODE")
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1
    async with session_factory() as s:
        inv = await s.get(InstanceJoinInvite, "GOODCODE")
        assert inv.uses == 1


# ---------------------------------------------------------------------------
# Invite validity
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_max_uses_exhausted(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "invite_only")
    async with session_factory() as s:
        s.add(InstanceJoinInvite(code="SPENT", created_by="admin", max_uses=1, uses=1))
        await s.commit()
    resp = await _attempt_join(client, _route_settings, user_id="901", join_code="SPENT")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_requires_invite"


@pytest.mark.asyncio
async def test_invite_revoked(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "invite_only")
    async with session_factory() as s:
        s.add(InstanceJoinInvite(code="DEAD", created_by="admin", revoked=True))
        await s.commit()
    resp = await _attempt_join(client, _route_settings, user_id="902", join_code="DEAD")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_invite_expired(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "invite_only")
    past = datetime.now(UTC) - timedelta(days=1)
    async with session_factory() as s:
        s.add(InstanceJoinInvite(code="OLD", created_by="admin", expires_at=past))
        await s.commit()
    resp = await _attempt_join(client, _route_settings, user_id="903", join_code="OLD")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_invite_future_expiry_works(client, _route_settings, session_factory):
    await _set_join_mode(session_factory, "invite_only")
    future = datetime.now(UTC) + timedelta(days=7)
    async with session_factory() as s:
        s.add(InstanceJoinInvite(code="FRESH", created_by="admin", expires_at=future))
        await s.commit()
    resp = await _attempt_join(client, _route_settings, user_id="904", join_code="FRESH")
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Community-Invite instance grant (Stufe 2 / B-lite)
# ---------------------------------------------------------------------------
#
# A live community (GuildInvite) invite is itself the permission to join the
# *instance* — community-scoped, no separate join_code. Additive: the legacy
# join_code path still works (covered above), and ``closed`` mode is never
# bypassed by a community invite (the owner's hard lock).


@pytest.mark.asyncio
async def test_community_invite_grants_instance_membership(
    client, _route_settings, session_factory
):
    """A valid community invite admits a first-contact user in invite_only
    mode without any instance join_code, and records membership."""
    await _set_join_mode(session_factory, "invite_only")
    await _seed_guild_invite(session_factory, "LIVECOMM")
    resp = await _attempt_join(
        client, _route_settings, user_id="1001", community_grant_code="LIVECOMM"
    )
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1
    # Provenance marker is the community-invite path.
    async with session_factory() as s:
        ident = resp.json()["pairwise_sub"]
        row = await s.get(InstanceMember, ident)
        assert row.joined_via == "community_invite"


@pytest.mark.asyncio
async def test_community_invite_does_not_consume_guild_invite_use(
    client, _route_settings, session_factory
):
    """The instance grant is non-consuming — the GuildInvite's use is spent
    later by accept_invite, not here. So re-auth on the same code keeps working
    and the use count never moves at cert-login."""
    await _set_join_mode(session_factory, "invite_only")
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
    await _set_join_mode(session_factory, "invite_only")
    resp = await _attempt_join(
        client, _route_settings, user_id="1003", community_grant_code="NOSUCHCODE"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_requires_invite"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_revoked_grants_nothing(
    client, _route_settings, session_factory
):
    await _set_join_mode(session_factory, "invite_only")
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
    await _set_join_mode(session_factory, "invite_only")
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
    await _set_join_mode(session_factory, "invite_only")
    await _seed_guild_invite(session_factory, "FULLCOMM", max_uses=1, uses=1)
    resp = await _attempt_join(
        client, _route_settings, user_id="1006", community_grant_code="FULLCOMM"
    )
    assert resp.status_code == 403
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_does_not_bypass_closed(
    client, _route_settings, session_factory
):
    """``closed`` mode is the owner's hard lock — a live community invite must
    not bypass it (mirrors the future single 'Server gesperrt' toggle)."""
    await _set_join_mode(session_factory, "closed")
    await _seed_guild_invite(session_factory, "LIVECLSD")
    resp = await _attempt_join(
        client, _route_settings, user_id="1007", community_grant_code="LIVECLSD"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_closed"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_community_invite_member_reauth_without_code(
    client, _route_settings, session_factory
):
    """Once joined via a community invite, the member re-auths with no code at
    all (the critical re-auth path — community invites must not be re-demanded
    on every 5-minute token refresh)."""
    await _set_join_mode(session_factory, "invite_only")
    await _seed_guild_invite(session_factory, "REAUTHCM")
    first = await _attempt_join(
        client, _route_settings, user_id="1008", community_grant_code="REAUTHCM"
    )
    assert first.status_code == 200, first.text
    cert_login_route._reset_cert_login_rate_for_tests()
    # Re-auth with NO code — must still pass (existing member).
    again = await _attempt_join(client, _route_settings, user_id="1008")
    assert again.status_code == 200, again.text


# ---------------------------------------------------------------------------
# Public-community instance grant (Stufe 4 / Entscheidung 5)
# ---------------------------------------------------------------------------
#
# A currently-public community is its OWN permission to join the instance —
# join_mode-INDEPENDENT (admits even in ``closed``). A non-public/unknown handle
# grants nothing. Non-consuming, no separate code.


@pytest.mark.asyncio
async def test_public_handle_grants_instance_membership(
    client, _route_settings, session_factory
):
    """In invite_only mode, a public-community handle admits a first-contact
    user with no code and records membership."""
    await _set_join_mode(session_factory, "invite_only")
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
async def test_public_handle_bypasses_closed(client, _route_settings, session_factory):
    """Unlike a community-invite code, a public-community handle is
    join_mode-INDEPENDENT — it admits even in ``closed`` mode (Entscheidung 5;
    only the future 'Server gesperrt' toggle will override it)."""
    await _set_join_mode(session_factory, "closed")
    await _seed_public_guild(session_factory, "evenclosed")
    resp = await _attempt_join(
        client, _route_settings, user_id="2002", public_join_handle="evenclosed"
    )
    assert resp.status_code == 200, resp.text
    assert len(await _members(session_factory)) == 1


@pytest.mark.asyncio
async def test_non_public_handle_grants_nothing(
    client, _route_settings, session_factory
):
    """A community with a handle but NOT public grants no instance access."""
    await _set_join_mode(session_factory, "invite_only")
    await _seed_public_guild(session_factory, "stillprivate", is_public=False)
    resp = await _attempt_join(
        client, _route_settings, user_id="2003", public_join_handle="stillprivate"
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "join_requires_invite"
    assert await _members(session_factory) == set()


@pytest.mark.asyncio
async def test_unknown_handle_grants_nothing(
    client, _route_settings, session_factory
):
    await _set_join_mode(session_factory, "invite_only")
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
    await _set_join_mode(session_factory, "invite_only")
    await _seed_public_guild(session_factory, "reauthpub")
    first = await _attempt_join(
        client, _route_settings, user_id="2005", public_join_handle="reauthpub"
    )
    assert first.status_code == 200, first.text
    cert_login_route._reset_cert_login_rate_for_tests()
    again = await _attempt_join(client, _route_settings, user_id="2005")
    assert again.status_code == 200, again.text


# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_admin_join_invite_mint_list_revoke(client, admin_token, session_factory):
    token, _uid = admin_token
    # mint
    created = await client.post(
        "/admin/join-invites",
        json={"max_uses": 3, "note": "for friends"},
        headers=_auth(token),
    )
    assert created.status_code == 201, created.text
    code = created.json()["code"]
    assert created.json()["max_uses"] == 3
    assert created.json()["uses"] == 0
    assert created.json()["revoked"] is False

    # list (newest first, includes it)
    listed = await client.get("/admin/join-invites", headers=_auth(token))
    assert listed.status_code == 200
    assert any(r["code"] == code for r in listed.json())

    # revoke (idempotent)
    r1 = await client.delete(f"/admin/join-invites/{code}", headers=_auth(token))
    assert r1.status_code == 204
    r2 = await client.delete(f"/admin/join-invites/{code}", headers=_auth(token))
    assert r2.status_code == 204
    async with session_factory() as s:
        inv = await s.get(InstanceJoinInvite, code)
        assert inv.revoked is True

    # audit log written (create + 2x revoke)
    async with session_factory() as s:
        rows = (
            await s.execute(
                select(ModAuditLog.action_type).order_by(ModAuditLog.id)
            )
        ).scalars().all()
    assert "join_invite_create" in rows
    assert "join_invite_revoke" in rows


@pytest.mark.asyncio
async def test_admin_join_invite_requires_admin(client, access_token):
    token, _uid = access_token
    resp = await client.post("/admin/join-invites", json={}, headers=_auth(token))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_patch_join_mode(client, admin_token, session_factory):
    token, _uid = admin_token
    resp = await client.patch(
        "/admin/permissions", json={"join_mode": "closed"}, headers=_auth(token)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["join_mode"] == "closed"
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        assert row.join_mode == "closed"


@pytest.mark.asyncio
async def test_admin_patch_join_mode_invalid(client, admin_token):
    token, _uid = admin_token
    resp = await client.patch(
        "/admin/permissions", json={"join_mode": "bogus"}, headers=_auth(token)
    )
    assert resp.status_code == 422
