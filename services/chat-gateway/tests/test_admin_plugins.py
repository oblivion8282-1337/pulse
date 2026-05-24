"""Tests für die instanzweite Plugin-Allowlist-API.

Routen ``/admin/plugins`` + ``/admin/plugins/{name}``. Bootstrap-Admin-
only (JWT ``admin: true``). ``hello`` ist nicht entfernbar; Cascade
auf ``guild_plugins`` wird hier mit-getestet.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.models import GuildPlugin, InstancePluginAllowlist
from sqlalchemy import select


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_list_plugins_includes_discovered_hello(client, admin_token):
    """``hello`` wird via Discovery gefunden und steht standardmäßig in
    der Allowlist (Self-Heal beim ersten Schreiben — die Tabelle wird
    von Frischtests leer gestartet, also legt der Endpoint sie auch
    ohne Lifespan-Seed nicht voll).

    Hier geht's primär darum, dass der Endpoint discovery-Ergebnisse
    + Allowlist-Status korrekt mergen. ``hello`` ist nach Discovery
    ``in_discovery=True``, ``in_allowlist=False`` (frische Test-DB).
    """
    token, _ = admin_token
    r = await client.get("/admin/plugins", headers=_auth(token))
    assert r.status_code == 200
    entries = r.json()
    by_name = {e["plugin_name"]: e for e in entries}
    assert "hello" in by_name
    assert by_name["hello"]["in_discovery"] is True


@pytest.mark.asyncio
async def test_list_plugins_403_for_non_admin(client, access_token):
    token, _ = access_token
    r = await client.get("/admin/plugins", headers=_auth(token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_list_plugins_401_without_token(client):
    r = await client.get("/admin/plugins")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_put_plugin_adds_to_allowlist(
    client, admin_token, session_factory
):
    token, admin_id = admin_token
    r = await client.put("/admin/plugins/hello", headers=_auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "plugin_name": "hello",
        "in_allowlist": True,
        "requires_restart": True,
    }
    # DB-Row da, ``added_by_user_id`` ist der Admin.
    async with session_factory() as s:
        row = await s.get(InstancePluginAllowlist, "hello")
        assert row is not None
        assert row.added_by_user_id == admin_id


@pytest.mark.asyncio
async def test_put_plugin_is_idempotent(client, admin_token):
    token, _ = admin_token
    r1 = await client.put("/admin/plugins/hello", headers=_auth(token))
    assert r1.status_code == 200
    r2 = await client.put("/admin/plugins/hello", headers=_auth(token))
    assert r2.status_code == 200


@pytest.mark.asyncio
async def test_put_unknown_plugin_404(client, admin_token):
    token, _ = admin_token
    r = await client.put(
        "/admin/plugins/this_does_not_exist", headers=_auth(token)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_put_invalid_plugin_name_400(client, admin_token):
    token, _ = admin_token
    # Großbuchstaben sind nicht erlaubt im Plugin-Name-Charset.
    r = await client.put("/admin/plugins/HELLO", headers=_auth(token))
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_put_plugin_403_for_non_admin(client, access_token):
    token, _ = access_token
    r = await client.put("/admin/plugins/hello", headers=_auth(token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_delete_hello_409(client, admin_token, session_factory):
    """``hello`` darf nicht entfernt werden — selbst wenn es nie
    explizit in die Allowlist gesetzt wurde, gibt der Endpoint 409 raus.
    Das schützt vor "Admin probiert aus Versehen, den Smoketest
    abzuschalten"."""
    token, _ = admin_token
    # Erst hinzufügen, damit das Existenz-Argument greift.
    await client.put("/admin/plugins/hello", headers=_auth(token))
    r = await client.delete("/admin/plugins/hello", headers=_auth(token))
    assert r.status_code == 409
    # Bleibt erhalten.
    async with session_factory() as s:
        row = await s.get(InstancePluginAllowlist, "hello")
        assert row is not None


@pytest.mark.asyncio
async def test_delete_plugin_removes_allowlist_and_cascades_guild_plugins(
    client, admin_token, session_factory
):
    """Wenn ein Plugin aus der Allowlist fliegt, müssen alle zugehörigen
    ``guild_plugins``-Rows mit raus. PR1 hat kein DB-FK zwischen den
    Tabellen, der Cascade läuft applikationsseitig.
    """
    token, _ = admin_token
    # Tamagotchi in die Allowlist + zwei fake Guild-Toggle-Rows.
    await client.put("/admin/plugins/tamagotchi", headers=_auth(token))
    async with session_factory() as s:
        s.add(
            GuildPlugin(
                guild_id=12345,
                plugin_name="tamagotchi",
                enabled=True,
                enabled_by_user_id=999,
            )
        )
        s.add(
            GuildPlugin(
                guild_id=67890,
                plugin_name="tamagotchi",
                enabled=False,
                enabled_by_user_id=999,
            )
        )
        await s.commit()

    r = await client.delete(
        "/admin/plugins/tamagotchi", headers=_auth(token)
    )
    assert r.status_code == 204

    async with session_factory() as s:
        # Allowlist-Row weg.
        assert await s.get(InstancePluginAllowlist, "tamagotchi") is None
        # Guild-Plugin-Rows weg.
        rows = (
            await s.execute(
                select(GuildPlugin).where(
                    GuildPlugin.plugin_name == "tamagotchi"
                )
            )
        ).scalars().all()
        assert rows == []


@pytest.mark.asyncio
async def test_delete_plugin_idempotent_when_not_in_allowlist(
    client, admin_token
):
    """DELETE auf ein Plugin, das nicht in der Allowlist ist, gibt 204
    (idempotent — DELETE-Konvention). Cascade auf ``guild_plugins``
    läuft trotzdem, sodass orphan Toggle-Rows weggehen, falls sie
    irgendwie ohne Allowlist-Eintrag bestehen."""
    token, _ = admin_token
    r = await client.delete(
        "/admin/plugins/tamagotchi", headers=_auth(token)
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_delete_plugin_403_for_non_admin(client, access_token):
    token, _ = access_token
    r = await client.delete("/admin/plugins/tamagotchi", headers=_auth(token))
    assert r.status_code == 403
