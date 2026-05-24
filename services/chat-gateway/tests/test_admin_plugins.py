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
    # ``requires_restart`` ist seit dem Hot-Reload-Patch ``False`` —
    # PUT/DELETE wirken live, das Feld bleibt im Response-Schema als
    # Multi-Pod-Stufe-B-Vorbereitung.
    assert body == {
        "plugin_name": "hello",
        "in_allowlist": True,
        "requires_restart": False,
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


# ---------------------------------------------------------------------------
# Hot-Reload-Tests (Snapshot + Activate ohne Service-Restart)
#
# PR1 hatte die Allowlist als Lifespan-Snapshot — ein PUT brauchte einen
# chat-gateway-Restart bevor das WS-Op-Gate Plugin-Ops durchließ. Dieser
# Patch ruft beim PUT direkt ``activate_plugin`` + Snapshot-Update; beim
# DELETE direkt Snapshot-Remove + Manager-Forget.
# ---------------------------------------------------------------------------


@pytest.fixture
def _isolate_plugin_manager():
    """Plugin-Manager + Op-/Channel-Registries vor + nach jedem Test
    säubern, sonst kollidiert die Hot-Reload-Aktivierung mit Records,
    die andere Tests im Modul-globalen Singleton hinterlassen haben.
    """
    from dcc_chat_gateway.plugins.registry import (
        _reset_for_tests as _reset_manager,
    )
    from dcc_chat_gateway.pubsub_channel_registry import (
        _clear_for_tests as _clear_channels,
    )
    from dcc_chat_gateway.pubsub_channel_registry import (
        get_channel_handler,
        register_channel_handler,
        registered_channels,
    )
    from dcc_chat_gateway.routes.ws_ops_registry import (
        _clear_for_tests as _clear_ops,
    )
    from dcc_chat_gateway.routes.ws_ops_registry import (
        get_handler,
        register_ws_op,
        registered_ops,
    )

    saved_ops = {op: get_handler(op) for op in registered_ops()}
    saved_channels = {
        ch: get_channel_handler(ch) for ch in registered_channels()
    }
    _reset_manager()
    _clear_ops()
    _clear_channels()
    # Built-in-Ops zurücksetzen (alle ohne ":"); Plugin-Ops weglassen.
    for op, handler in saved_ops.items():
        if handler is not None and ":" not in op:
            register_ws_op(op, handler)
    for ch, handler in saved_channels.items():
        if handler is not None:
            register_channel_handler(ch, handler)
    yield
    _reset_manager()
    _clear_ops()
    _clear_channels()
    for op, handler in saved_ops.items():
        if handler is not None:
            register_ws_op(op, handler)
    for ch, handler in saved_channels.items():
        if handler is not None:
            register_channel_handler(ch, handler)


@pytest.mark.asyncio
async def test_put_plugin_hot_reload_activates_and_updates_snapshot(
    client, admin_token, app, _isolate_plugin_manager
):
    """PUT muss live wirken: ``app.state.plugin_allowlist`` enthält den
    Namen, der WS-Op-Handler (``tamagotchi:feed``) ist registriert, der
    Permission-Gate würde Ops durchlassen — kein Restart nötig.
    """
    from dcc_chat_gateway.routes.ws_ops_registry import get_handler

    token, _ = admin_token
    # Vorbedingung: Allowlist ist leer, kein tamagotchi-Op registriert.
    assert "tamagotchi" not in app.state.plugin_allowlist
    assert get_handler("tamagotchi:feed") is None

    r = await client.put("/admin/plugins/tamagotchi", headers=_auth(token))
    assert r.status_code == 200

    # Snapshot enthält das Plugin → WS-Op-Gate würde durchlassen.
    assert "tamagotchi" in app.state.plugin_allowlist
    # Op-Handler ist registriert (``activate_plugin`` rief ``register()``).
    assert get_handler("tamagotchi:feed") is not None


@pytest.mark.asyncio
async def test_put_plugin_hot_reload_is_idempotent(
    client, admin_token, app, _isolate_plugin_manager
):
    """Zwei aufeinanderfolgende PUTs lassen den Op-Handler stehen + den
    Snapshot stabil. Wichtig: ``activate_plugin`` darf ``register()``
    nicht doppelt rufen (sonst wären die Handler doppelt registriert
    bzw. der Permission-Gate würde knallen)."""
    from dcc_chat_gateway.plugins.registry import get_manager
    from dcc_chat_gateway.routes.ws_ops_registry import get_handler

    token, _ = admin_token
    r1 = await client.put("/admin/plugins/tamagotchi", headers=_auth(token))
    assert r1.status_code == 200
    handler_a = get_handler("tamagotchi:feed")
    rec = get_manager().get("tamagotchi")
    assert rec is not None and rec.activated

    r2 = await client.put("/admin/plugins/tamagotchi", headers=_auth(token))
    assert r2.status_code == 200
    # Op-Handler unverändert (Identität — kein doppeltes register()).
    assert get_handler("tamagotchi:feed") is handler_a
    assert "tamagotchi" in app.state.plugin_allowlist


@pytest.mark.asyncio
async def test_put_plugin_404_does_not_touch_snapshot(
    client, admin_token, app, _isolate_plugin_manager
):
    """Ein PUT auf ein nicht entdecktes Plugin lässt den Snapshot in
    Ruhe (keine Hot-Reload-Side-Effects bei 404)."""
    token, _ = admin_token
    snapshot_before = app.state.plugin_allowlist
    r = await client.put(
        "/admin/plugins/this_does_not_exist", headers=_auth(token)
    )
    assert r.status_code == 404
    assert app.state.plugin_allowlist is snapshot_before


@pytest.mark.asyncio
async def test_delete_plugin_hot_reload_removes_from_snapshot(
    client, admin_token, app, _isolate_plugin_manager
):
    """DELETE muss live wirken: Snapshot wird leer, Manager vergisst den
    Record. Der WS-Op-Gate würde danach 4040 zurückgeben — Plugin-Ops
    werden ab dem nächsten Frame inert.
    """
    from dcc_chat_gateway.plugins.registry import get_manager

    token, _ = admin_token
    # Erst aktivieren, damit DELETE etwas zum Aufräumen hat.
    await client.put("/admin/plugins/tamagotchi", headers=_auth(token))
    assert "tamagotchi" in app.state.plugin_allowlist
    assert get_manager().get("tamagotchi") is not None

    r = await client.delete(
        "/admin/plugins/tamagotchi", headers=_auth(token)
    )
    assert r.status_code == 204

    # Snapshot ohne tamagotchi.
    assert "tamagotchi" not in app.state.plugin_allowlist
    # Manager hat den Record vergessen (``forget``-Pfad).
    assert get_manager().get("tamagotchi") is None


@pytest.mark.asyncio
async def test_delete_plugin_invalidates_op_gate_cache(
    client, admin_token, app, _isolate_plugin_manager
):
    """Beim DELETE muss der WS-Op-Gate-Cache für das Plugin entleert
    werden — sonst würde eine Toggle-Lookup bis zu 60 s nachhinken
    (Cache-TTL)."""
    from dcc_chat_gateway.plugins.ws_op_gate import _cache, _cache_put

    token, _ = admin_token
    await client.put("/admin/plugins/tamagotchi", headers=_auth(token))
    # Cache mit Test-Daten füllen.
    _cache_put(42, "tamagotchi", True)
    _cache_put(43, "tamagotchi", False)
    _cache_put(42, "hello", True)  # andere Plugin-Zelle, bleibt
    assert (42, "tamagotchi") in _cache

    r = await client.delete(
        "/admin/plugins/tamagotchi", headers=_auth(token)
    )
    assert r.status_code == 204
    # tamagotchi-Slots weg, hello-Slot bleibt.
    assert (42, "tamagotchi") not in _cache
    assert (43, "tamagotchi") not in _cache
    assert (42, "hello") in _cache
