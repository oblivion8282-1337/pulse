"""Tests für die Pro-Guild-Plugin-Toggle-API.

Routen ``/guilds/{id}/plugins`` + ``/guilds/{id}/plugins/{name}``.
Permission-Gate: ``MANAGE_GUILD`` (Owner-Bypass greift automatisch).
``hello`` ist nicht togglebar; nur Allowlist-Plugins können getoggelt
werden.
"""

from __future__ import annotations

import uuid

import pytest
from dcc_chat_gateway.models import GuildPlugin, InstancePluginAllowlist


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
