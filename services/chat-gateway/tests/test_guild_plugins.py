"""Tests für die Pro-Guild-Plugin-Toggle-API.

Routen ``/guilds/{id}/plugins`` + ``/guilds/{id}/plugins/{name}``.
Permission-Gate: ``MANAGE_GUILD`` (Owner-Bypass greift automatisch).
``hello`` ist nicht togglebar; nur Allowlist-Plugins können getoggelt
werden.
"""

from __future__ import annotations

import asyncio
import random
import uuid

import pytest
from dcc_chat_gateway.models import GuildPlugin, InstancePluginAllowlist
from starlette.testclient import TestClient
from .conftest import receive_skipping


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _make_token(signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}"), uid


async def _create_guild(client, token: str, name: str = "test-guild") -> int:
    r = await client.post(
        "/guilds", json={"name": name}, headers=_auth(token)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _seed_allowlist(session_factory, names: list[str]) -> None:
    """Direkt-Insert in die Allowlist (umgeht den Admin-Endpoint, der
    Discovery prüft — wir wollen unabhängige Test-Daten)."""
    async with session_factory() as s:
        for n in names:
            s.add(InstancePluginAllowlist(plugin_name=n, added_by_user_id=None))
        await s.commit()


@pytest.mark.asyncio
async def test_list_guild_plugins_returns_hello_enabled(
    client, _auth_signer, session_factory
):
    """``hello`` muss in der GET-Antwort als ``enabled=true`` auftauchen,
    auch ohne Allowlist-Row — instanzweite Konvention."""
    await _seed_allowlist(session_factory, ["hello"])
    token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    r = await client.get(
        f"/guilds/{guild_id}/plugins", headers=_auth(token)
    )
    assert r.status_code == 200
    entries = r.json()
    hello = next(e for e in entries if e["plugin_name"] == "hello")
    assert hello["enabled"] is True


@pytest.mark.asyncio
async def test_list_guild_plugins_default_disabled_for_other_plugins(
    client, _auth_signer, session_factory
):
    """Ein Plugin in der Allowlist, aber kein guild_plugins-Row → enabled=False."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    r = await client.get(
        f"/guilds/{guild_id}/plugins", headers=_auth(token)
    )
    assert r.status_code == 200
    by_name = {e["plugin_name"]: e for e in r.json()}
    assert by_name["tamagotchi"]["enabled"] is False
    assert by_name["hello"]["enabled"] is True


@pytest.mark.asyncio
async def test_list_guild_plugins_non_member_403(
    client, _auth_signer, session_factory
):
    """Non-Mitglieder sehen die Plugin-Liste der fremden Guild nicht."""
    await _seed_allowlist(session_factory, ["hello"])
    owner_token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, owner_token)

    outsider_token, _ = await _make_token(_auth_signer)
    r = await client.get(
        f"/guilds/{guild_id}/plugins", headers=_auth(outsider_token)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_put_toggle_enabled_writes_row(
    client, _auth_signer, session_factory
):
    """PUT enabled=true legt die guild_plugins-Row an."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    token, owner_id = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    r = await client.put(
        f"/guilds/{guild_id}/plugins/tamagotchi",
        json={"enabled": True},
        headers=_auth(token),
    )
    assert r.status_code == 200
    assert r.json() == {"plugin_name": "tamagotchi", "enabled": True}

    async with session_factory() as s:
        row = await s.get(GuildPlugin, (guild_id, "tamagotchi"))
        assert row is not None
        assert row.enabled is True
        assert row.enabled_by_user_id == owner_id


@pytest.mark.asyncio
async def test_put_toggle_disable_then_re_enable_updates_row(
    client, _auth_signer, session_factory
):
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    await client.put(
        f"/guilds/{guild_id}/plugins/tamagotchi",
        json={"enabled": True},
        headers=_auth(token),
    )
    r = await client.put(
        f"/guilds/{guild_id}/plugins/tamagotchi",
        json={"enabled": False},
        headers=_auth(token),
    )
    assert r.status_code == 200
    assert r.json()["enabled"] is False

    async with session_factory() as s:
        row = await s.get(GuildPlugin, (guild_id, "tamagotchi"))
        assert row is not None
        assert row.enabled is False


@pytest.mark.asyncio
async def test_put_toggle_hello_409(client, _auth_signer, session_factory):
    """``hello`` ist nicht togglebar — schützt den Loader-Smoketest."""
    await _seed_allowlist(session_factory, ["hello"])
    token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    r = await client.put(
        f"/guilds/{guild_id}/plugins/hello",
        json={"enabled": False},
        headers=_auth(token),
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_put_toggle_unknown_plugin_404(
    client, _auth_signer, session_factory
):
    """Plugin nicht in der Allowlist → 404 (nicht 400 / nicht 403, damit
    die UI klar zwischen "fehlt in der Allowlist" und "fehlt die
    Permission" unterscheidet)."""
    await _seed_allowlist(session_factory, ["hello"])
    token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    r = await client.put(
        f"/guilds/{guild_id}/plugins/tamagotchi",
        json={"enabled": True},
        headers=_auth(token),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_put_toggle_non_member_403(
    client, _auth_signer, session_factory
):
    """Non-Mitglied → 403 (kein MANAGE_GUILD ohne Membership)."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    owner_token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, owner_token)

    outsider_token, _ = await _make_token(_auth_signer)
    r = await client.put(
        f"/guilds/{guild_id}/plugins/tamagotchi",
        json={"enabled": True},
        headers=_auth(outsider_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_put_toggle_member_without_manage_guild_403(
    client, _auth_signer, session_factory
):
    """Plain Member ohne MANAGE_GUILD darf nicht togglen — Owner-Bypass
    greift nur für den Guild-Owner. ``@everyone``-Default hat
    MANAGE_GUILD nicht.
    """
    from dcc_chat_gateway.models import GuildMember

    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    owner_token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, owner_token)

    member_token, member_id = await _make_token(_auth_signer)
    # Direkt in die guild_members-Tabelle einfügen (kein Invite-Flow nötig
    # für diesen Test).
    async with session_factory() as s:
        s.add(GuildMember(guild_id=guild_id, user_id=member_id))
        await s.commit()

    r = await client.put(
        f"/guilds/{guild_id}/plugins/tamagotchi",
        json={"enabled": True},
        headers=_auth(member_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_put_toggle_invalid_plugin_name_400(
    client, _auth_signer, session_factory
):
    await _seed_allowlist(session_factory, ["hello"])
    token, _ = await _make_token(_auth_signer)
    guild_id = await _create_guild(client, token)

    r = await client.put(
        f"/guilds/{guild_id}/plugins/HAS_UPPER",
        json={"enabled": True},
        headers=_auth(token),
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# WS-Broadcast-Tests (PUT/DELETE pusht ``guild_plugins_changed`` an Member).
#
# Backend-Verhalten:
#  * PUT /guilds/{id}/plugins/{name}    → ein Event mit enabled=<neuer Wert>.
#  * DELETE /admin/plugins/{name}       → ein Event pro Guild, die das Plugin
#                                          aktiv hatte (enabled=False).
# Listener-Filter (``_GUILD_MEMBER_SCOPED_OPS``) scoped es auf Guild-Member;
# Outsider sehen das Event NICHT.
# ---------------------------------------------------------------------------


def _seed_allowlist_sync(db_url: str, names: list[str]) -> None:
    """Synchroner Insert in die Allowlist-Tabelle (für ws_app-Tests, die
    kein async session_factory zur Hand haben)."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with Session(eng) as s:
            for n in names:
                s.merge(
                    InstancePluginAllowlist(plugin_name=n, added_by_user_id=None)
                )
            s.commit()
    finally:
        eng.dispose()


def _add_member_sync(db_url: str, guild_id: int, user_id: int) -> None:
    from dcc_chat_gateway.models import GuildMember
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with Session(eng) as s:
            s.add(GuildMember(guild_id=guild_id, user_id=user_id))
            s.commit()
    finally:
        eng.dispose()


def _receive_until(ws, target_op: str, max_frames: int = 10):
    for _ in range(max_frames):
        try:
            m = ws.receive_json()
        except Exception:
            return None
        if m.get("op") == target_op:
            return m
    return None


def _drain_for(ws, target_op: str, max_wait_s: float = 1.0) -> bool:
    """True, wenn ``target_op`` innerhalb von max_wait_s ankommt — sonst False.

    Identisches Pattern wie in ``test_tamagotchi_broadcast.py``: Worker
    pollt receive_json bis target_op kommt, Hauptthread wartet max_wait_s
    auf ein Event und bricht ab (daemon-Thread wird beim TestClient-
    Shutdown implizit beendet)."""
    import threading

    found = threading.Event()
    saw_target = [False]

    def _worker():
        for _ in range(20):
            try:
                m = ws.receive_json()
            except Exception:
                return
            if m.get("op") == target_op:
                saw_target[0] = True
                found.set()
                return
        found.set()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    found.wait(timeout=max_wait_s)
    return saw_target[0]


@pytest.mark.asyncio
async def test_put_toggle_broadcasts_to_guild_members(ws_app, _auth_signer):
    """Owner aktiviert ein Plugin per PUT; ein Mit-Member empfängt den
    ``guild_plugins_changed``-Frame mit ``enabled=True``."""

    def _run():
        with TestClient(ws_app) as tc:
            from dcc_chat_gateway.config import get_settings

            db_url = get_settings().database_url
            _seed_allowlist_sync(db_url, ["hello", "tamagotchi"])

            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post(
                "/guilds", json={"name": "g"}, headers=_auth(owner_token)
            ).json()
            gid = g["id"]

            member_uid = random.randint(1_000_001, 2_000_000)
            member_token = _auth_signer.issue_access(member_uid, f"m{member_uid}")
            _add_member_sync(db_url, int(gid), member_uid)

            with tc.websocket_connect(f"/ws?token={member_token}") as ws_m:
                receive_skipping(ws_m)  # skip hello + ready
                r = tc.put(
                    f"/guilds/{gid}/plugins/tamagotchi",
                    json={"enabled": True},
                    headers=_auth(owner_token),
                )
                assert r.status_code == 200, r.text
                evt = _receive_until(ws_m, "guild_plugins_changed")
                assert evt is not None, "member never got guild_plugins_changed"
                assert evt["guild_id"] == gid
                assert evt["plugin_name"] == "tamagotchi"
                assert evt["enabled"] is True

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_put_toggle_does_not_broadcast_to_outsider(ws_app, _auth_signer):
    """Ein User, der NICHT in der Guild ist, empfängt den
    ``guild_plugins_changed``-Frame NICHT (Member-Scoping greift)."""

    def _run():
        with TestClient(ws_app) as tc:
            from dcc_chat_gateway.config import get_settings

            db_url = get_settings().database_url
            _seed_allowlist_sync(db_url, ["hello", "tamagotchi"])

            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post(
                "/guilds", json={"name": "g"}, headers=_auth(owner_token)
            ).json()
            gid = g["id"]

            # Outsider: eigene Guild, kein Member der ersten.
            outsider_uid = random.randint(2_000_001, 3_000_000)
            outsider_token = _auth_signer.issue_access(
                outsider_uid, f"x{outsider_uid}"
            )
            tc.post(
                "/guilds", json={"name": "other"}, headers=_auth(outsider_token)
            )

            with tc.websocket_connect(f"/ws?token={outsider_token}") as ws_x:
                receive_skipping(ws_x)  # skip hello + ready
                r = tc.put(
                    f"/guilds/{gid}/plugins/tamagotchi",
                    json={"enabled": True},
                    headers=_auth(owner_token),
                )
                assert r.status_code == 200, r.text
                leaked = _drain_for(ws_x, "guild_plugins_changed", 1.0)
                assert not leaked, "outsider got guild_plugins_changed"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_delete_plugin_broadcasts_disabled_to_affected_guilds(
    ws_app, _auth_signer, admin_token
):
    """Admin-DELETE auf der Allowlist pusht einen
    ``guild_plugins_changed``-Frame mit ``enabled=False`` an jede Guild,
    die das Plugin aktiv hatte. Hier: Owner-User auf der einzigen
    betroffenen Guild empfängt den Frame.
    """
    # Admin-Token via Fixture (signed im selben event loop wie der
    # ws_app — also nicht direkt im sync-Thread reusable). Wir bauen den
    # Token deshalb hier nochmal frisch über _auth_signer + is_admin=True.
    def _run():
        with TestClient(ws_app) as tc:
            admin_uid = random.randint(1, 1_000_000)
            admin_tok = _auth_signer.issue_access(
                admin_uid, f"a{admin_uid}", is_admin=True
            )
            # PUT auf der Admin-Allowlist legt die Row UND triggert
            # die Discovery-Prüfung; tamagotchi ist via plugins/-Ordner
            # discovered.
            r = tc.put("/admin/plugins/tamagotchi", headers=_auth(admin_tok))
            assert r.status_code == 200, r.text

            # Owner + Guild + Plugin auf der Guild aktiv.
            owner_uid = random.randint(1_000_001, 2_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post(
                "/guilds", json={"name": "g"}, headers=_auth(owner_token)
            ).json()
            gid = g["id"]
            r = tc.put(
                f"/guilds/{gid}/plugins/tamagotchi",
                json={"enabled": True},
                headers=_auth(owner_token),
            )
            assert r.status_code == 200, r.text

            with tc.websocket_connect(f"/ws?token={owner_token}") as ws_o:
                receive_skipping(ws_o)  # skip hello + ready
                # Admin-DELETE: instanzweit raus → für jede Guild ein
                # guild_plugins_changed mit enabled=False.
                r = tc.delete(
                    "/admin/plugins/tamagotchi", headers=_auth(admin_tok)
                )
                assert r.status_code == 204, r.text
                evt = _receive_until(ws_o, "guild_plugins_changed")
                assert evt is not None
                assert evt["guild_id"] == gid
                assert evt["plugin_name"] == "tamagotchi"
                assert evt["enabled"] is False

    await asyncio.to_thread(_run)
