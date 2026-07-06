"""Voice-Pull — User in einen privaten Voice-Channel ziehen + Auto-Revoke.

Deckt die chat-gateway-Hälfte: der Pull-Endpoint (Sichtbarkeits-Grant +
Markerzeile + Events) und der interne Revoke-Endpoint (Entzug beim
Verlassen). Die voice-signaling-Webhook-Seite des Revoke-Kreises wohnt
in services/voice-signaling/tests/test_webhook.py.

Fokus auf die Lader-tragenden Invarianten:
* Pull grantet genau VIEW_CHANNEL|CONNECT und macht den Gezogenen zum
  Viewer (Resolver-!VIEW→0-Invariante umgangen).
* Revoke ist idempotent und tastet einen koexistierenden permanenten
  User-Overwrite NICHT an (maskiert nur die Pull-Bits weg).
* Revoke ohne Internal-Secret → 401 (fail-closed).
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest
from dcc_chat_gateway.models import Channel, ChannelVoicePull, PermissionOverwrite
from dcc_chat_gateway.permissions import OVERWRITE_TARGET_USER, resolve_permissions
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.voice_pull_cleanup import _PULL_ALLOW, _reap_once, revoke_voice_pull
from dcc_shared.permission_resolver import OVERWRITE_TARGET_ROLE
from dcc_shared.permissions import Permissions


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _everyone_id(client, g, t_owner) -> str:
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    return next(r["id"] for r in roles if r["is_everyone"])


async def _make_private_voice_channel(client, _auth_signer):
    """Owner + a second member; a VOICE channel with @everyone deny-VIEW
    (i.e. private). Returns (t_owner, uid_owner, t_other, uid_other, g, v)."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    v = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "secret", "type": 1},
            headers=auth(t_owner),
        )
    ).json()
    everyone_id = await _everyone_id(client, g, t_owner)
    await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
        json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
        headers=auth(t_owner),
    )
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, uid_owner, t_other, uid_other, g, v


def _overwrite_for(rows, uid) -> dict | None:
    return next(
        (
            r
            for r in rows
            if r["target_type"] == OVERWRITE_TARGET_USER and r["target_id"] == str(uid)
        ),
        None,
    )


# ---- Pull grantet Sichtbarkeit --------------------------------------------


@pytest.mark.asyncio
async def test_pull_grants_view_connect_and_marker(client, _auth_signer, session_factory):
    t_owner, _, _, uid_other, _, v = await _make_private_voice_channel(client, _auth_signer)
    r = await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-pull", headers=auth(t_owner)
    )
    assert r.status_code == 200, r.text

    rows = (await client.get(f"/channels/{v['id']}/permissions", headers=auth(t_owner))).json()
    ow = _overwrite_for(rows, uid_other)
    assert ow is not None and int(ow["allow"]) == _PULL_ALLOW

    # Resolver: der Gezogene ist jetzt Viewer (VIEW+CONNECT gehalten).
    other = AuthenticatedUser(id=uid_other, username="o", is_admin=False, payload={})
    async with session_factory() as s:
        value = await resolve_permissions(s, other, int(v["guild_id"]), channel_id=int(v["id"]))
    assert value & Permissions.VIEW_CHANNEL and value & Permissions.CONNECT

    async with session_factory() as s:
        row = await s.get(ChannelVoicePull, (int(v["id"]), uid_other))
    assert row is not None and row.granted_by is not None


@pytest.mark.asyncio
async def test_pull_publishes_voice_pull_and_revealed(client, _auth_signer, app, monkeypatch):
    posted: list[tuple[int, str]] = []

    async def _capture(target, envelope):
        posted.append((int(target), getattr(envelope, "op", None)))

    monkeypatch.setattr(app.state.connection_manager, "publish_user_event", _capture)

    t_owner, _, _, uid_other, _, v = await _make_private_voice_channel(client, _auth_signer)
    await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-pull", headers=auth(t_owner)
    )
    ops = {op for target, op in posted if target == uid_other}
    assert "voice_pull" in ops and "channel_revealed" in ops


# ---- Gating ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_pull_self_forbidden(client, _auth_signer):
    t_owner, uid_owner, _, _, _, v = await _make_private_voice_channel(client, _auth_signer)
    r = await client.post(
        f"/channels/{v['id']}/members/{uid_owner}/voice-pull", headers=auth(t_owner)
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_pull_text_channel_forbidden(client, _auth_signer):
    t_owner, _, _, uid_other, g, _ = await _make_private_voice_channel(client, _auth_signer)
    text = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "txt", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    r = await client.post(
        f"/channels/{text['id']}/members/{uid_other}/voice-pull", headers=auth(t_owner)
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_pull_requires_manage_permissions(client, _auth_signer):
    """Ein normales Mitglied (ohne MANAGE_PERMISSIONS) darf niemanden
    ziehen — nicht mal den Owner in den Channel."""
    _, uid_owner, t_other, _, _, v = await _make_private_voice_channel(client, _auth_signer)
    r = await client.post(
        f"/channels/{v['id']}/members/{uid_owner}/voice-pull", headers=auth(t_other)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_pull_target_not_member(client, _auth_signer):
    t_owner, _, _, _, _, v = await _make_private_voice_channel(client, _auth_signer)
    phantom = random.randint(2_000_000, 9_000_000)
    r = await client.post(
        f"/channels/{v['id']}/members/{phantom}/voice-pull", headers=auth(t_owner)
    )
    assert r.status_code == 404


# ---- Internal Revoke -------------------------------------------------------


def _internal(secret: str | None) -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if secret is not None:
        h["X-Pulse-Internal-Secret"] = secret
    return h


@pytest.mark.asyncio
async def test_revoke_removes_grant_and_hides(
    client, _auth_signer, app, monkeypatch, _isolate_chat_settings
):
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "s")
    posted: list[str] = []

    async def _capture(_target, envelope):
        posted.append(getattr(envelope, "op", None))

    monkeypatch.setattr(app.state.connection_manager, "publish_user_event", _capture)

    t_owner, _, _, uid_other, _, v = await _make_private_voice_channel(client, _auth_signer)
    await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-pull", headers=auth(t_owner)
    )
    r = await client.post(
        "/internal/voice-pull-revoke",
        json={"channel_id": int(v["id"]), "user_id": uid_other},
        headers=_internal("s"),
    )
    assert r.status_code == 200 and r.json() == {"revoked": True}
    rows = (await client.get(f"/channels/{v['id']}/permissions", headers=auth(t_owner))).json()
    assert _overwrite_for(rows, uid_other) is None
    assert "channel_hidden" in posted


@pytest.mark.asyncio
async def test_revoke_without_secret_unauthorized(client, _isolate_chat_settings, monkeypatch):
    # Secret unset in the shared settings → endpoint disabled (fail-closed).
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "")
    r = await client.post(
        "/internal/voice-pull-revoke",
        json={"channel_id": 1, "user_id": 2},
        headers=_internal(None),
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_revoke_idempotent(
    client, _auth_signer, monkeypatch, _isolate_chat_settings
):
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "s")
    t_owner, _, _, uid_other, _, v = await _make_private_voice_channel(client, _auth_signer)
    await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-pull", headers=auth(t_owner)
    )
    body = {"channel_id": int(v["id"]), "user_id": uid_other}
    first = await client.post("/internal/voice-pull-revoke", json=body, headers=_internal("s"))
    second = await client.post("/internal/voice-pull-revoke", json=body, headers=_internal("s"))
    assert first.json() == {"revoked": True}
    assert second.json() == {"revoked": False}


# ---- Revoke schont permanenten Overwrite (Lader-tragend) -------------------


@pytest.mark.asyncio
async def test_revoke_preserves_permanent_overwrite(
    client, _auth_signer, monkeypatch, _isolate_chat_settings
):
    """Ein permanenter User-Overwrite mit zusätzlichen Bits überlebt den
    Revoke — nur die Pull-Bits werden wegmaskiert, die Zeile bleibt."""
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "s")
    t_owner, _, _, uid_other, _, v = await _make_private_voice_channel(client, _auth_signer)
    # Permanent: VIEW|CONNECT (Pull-Bits) PLUS SEND_MESSAGES.
    extra = _PULL_ALLOW | int(Permissions.SEND_MESSAGES)
    await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": str(extra), "deny": "0"},
        headers=auth(t_owner),
    )
    await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-pull", headers=auth(t_owner)
    )
    await client.post(
        "/internal/voice-pull-revoke",
        json={"channel_id": int(v["id"]), "user_id": uid_other},
        headers=_internal("s"),
    )
    rows = (await client.get(f"/channels/{v['id']}/permissions", headers=auth(t_owner))).json()
    ow = _overwrite_for(rows, uid_other)
    assert ow is not None and int(ow["allow"]) == int(Permissions.SEND_MESSAGES)


# ---- Helper direkt: revoke_voice_pull Idempotenz + Reaper-Fail-Safe --------


@pytest.mark.asyncio
async def test_revoke_voice_pull_noop_without_row(session_factory):
    async with session_factory() as s:
        revoked = await revoke_voice_pull(s, channel_id=999, user_id=999)
    assert revoked is False


class _FakeRedis:
    """Minimal stand-in: only ``sismember``/``delete`` are touched by the reaper path."""

    def __init__(self, present: bool, raise_on_check: bool = False):
        self._present = present
        self._raise = raise_on_check

    async def sismember(self, _key, _uid):
        if self._raise:
            raise RuntimeError("redis down")
        return self._present

    async def delete(self, _key) -> int:
        return 1


@pytest.mark.asyncio
async def test_reap_revokes_on_confirmed_absence(session_factory, engine):
    cid, uid = await _seed_pull_row(session_factory, stale=True)
    n = await _reap_once(engine, _FakeRedis(present=False), grace_s=0)
    assert n == 1
    async with session_factory() as s:
        assert await s.get(ChannelVoicePull, (cid, uid)) is None


@pytest.mark.asyncio
async def test_reap_skips_when_still_present(session_factory, engine):
    cid, uid = await _seed_pull_row(session_factory, stale=True)
    n = await _reap_once(engine, _FakeRedis(present=True), grace_s=0)
    assert n == 0
    async with session_factory() as s:
        assert await s.get(ChannelVoicePull, (cid, uid)) is not None


@pytest.mark.asyncio
async def test_reap_skips_on_redis_error(session_factory, engine):
    """Fail-safe: bei Redis-Fehler wird die Zeile NICHT angerührt
    (sonst könnte ein mid-Call-Grant gekillt werden)."""
    cid, uid = await _seed_pull_row(session_factory, stale=True)
    n = await _reap_once(engine, _FakeRedis(present=False, raise_on_check=True), grace_s=0)
    assert n == 0
    async with session_factory() as s:
        assert await s.get(ChannelVoicePull, (cid, uid)) is not None


async def _seed_pull_row(session_factory, *, stale: bool) -> tuple[int, int]:
    """Insert a channel + a stale pull row directly. Returns (channel_id, user_id)."""
    cid = 500_000 + random.randint(0, 100_000)
    uid = 100_000 + random.randint(0, 100_000)
    granted_at = datetime.now(UTC) - timedelta(hours=1) if stale else datetime.now(UTC)
    async with session_factory() as s:
        s.add(Channel(id=cid, guild_id=1, name="v", type=1, position=0))
        s.add(
            PermissionOverwrite(
                channel_id=cid,
                target_type=OVERWRITE_TARGET_USER,
                target_id=uid,
                allow_bf=_PULL_ALLOW,
                deny_bf=0,
            )
        )
        s.add(ChannelVoicePull(channel_id=cid, user_id=uid, granted_by=1, granted_at=granted_at))
        await s.commit()
    return cid, uid
