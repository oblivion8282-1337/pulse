"""Pro-Guild Plugin-Toggles.

Guild-Admin-API (Permission ``MANAGE_GUILD``). Toggelt **pro Server**,
ob ein bereits Allowlist-erlaubtes Plugin auf dieser Guild verwendet
werden darf. WS-Op-Dispatcher (siehe ``routes/ws_op_send.py`` und
``routes/ws_ops.py``) prüft diesen Toggle, bevor ein Plugin-Op an den
Handler weitergereicht wird.

Endpunkte
---------
* ``GET /guilds/{guild_id}/plugins`` — Liste ``[{plugin_name, enabled}]``
  für alle Allowlist-Plugins, plus ``hello`` immer als ``enabled=true``.
  Caller muss Mitglied der Guild sein (sonst 403 von ``check_permission``).
* ``PUT /guilds/{guild_id}/plugins/{name}`` — Toggle. Body
  ``{"enabled": bool}``. Plugin muss in Allowlist sein (sonst 404),
  Caller braucht ``MANAGE_GUILD``. ``hello`` ist nicht togglebar → 409.

``hello`` als Sonderfall
~~~~~~~~~~~~~~~~~~~~~~~~
Das Hello-Plugin gilt instanzweit als immer aktiv (Loader-Smoketest).
* GET zeigt es immer mit ``enabled=true`` (auch wenn keine Row existiert).
* PUT lehnt es mit 409 ab. Das vereinfacht das Frontend (kein Toggle-
  Knopf für hello rendern) und verhindert, dass der Smoketest aus
  Versehen abgeschaltet wird.
"""

from __future__ import annotations

import re

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import GuildPlugin
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
)
from dcc_chat_gateway.plugins.state_store import get_state

# Plugin-Constants sind side-effect-frei und dürfen Top-Level rein
# (vgl. admin_plugins.py — die Funktionen ``list_allowed_names`` etc.
# importieren wir innerhalb der Routes wegen App-Boot-Zirkularität).
from dcc_chat_gateway.plugins.allowlist import HELLO_PLUGIN_NAME
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(prefix="/guilds/{guild_id}/plugins")


_PLUGIN_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")


def _validate_plugin_name(name: str) -> str:
    if not _PLUGIN_NAME_RE.match(name):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="invalid_plugin_name"
        )
    return name


class GuildPluginEntry(BaseModel):
    plugin_name: str
    enabled: bool


class GuildPluginTogglePayload(BaseModel):
    enabled: bool


@router.get("", response_model=list[GuildPluginEntry])
async def list_guild_plugins(
    guild_id: int, session: SessionDep, current: CurrentUser
):
    """Pro-Guild-View: jeder Allowlist-Eintrag plus sein Toggle-Status.

    Caller muss Mitglied der Guild sein — wir nutzen
    ``check_permission(VIEW_CHANNEL=… NEIN)``: Mitgliedschaft reicht.
    Stattdessen ``check_permission(VIEW_CHANNEL)`` würde gegen die
    Idee laufen (Plugin-Liste ist nicht channel-spezifisch). Wir
    nutzen den Permission-Resolver nur als 403-on-non-member über
    ``Permissions.VIEW_CHANNEL`` mit channel_id=None — was effektiv
    Guild-Membership-Check + everyone-Permission ist. Sauberer: direkter
    Membership-Check.
    """
    from dcc_chat_gateway.plugins.allowlist import list_allowed_names
    from dcc_chat_gateway.routes._deps import require_member

    await require_member(session, guild_id, current.id)

    allowed = await list_allowed_names(session)
    rows = (
        await session.execute(
            select(GuildPlugin).where(GuildPlugin.guild_id == guild_id)
        )
    ).scalars().all()
    enabled_by_name = {row.plugin_name: row.enabled for row in rows}

    entries: list[GuildPluginEntry] = []
    # Allowlist-Reihenfolge sortiert, ``hello`` zuerst (UI-Hint: das ist
    # der instanzweite Default).
    names = sorted(allowed)
    if HELLO_PLUGIN_NAME in names:
        names = [HELLO_PLUGIN_NAME] + [n for n in names if n != HELLO_PLUGIN_NAME]
    for name in names:
        if name == HELLO_PLUGIN_NAME:
            # hello ist instanzweit aktiv, kein Toggle.
            entries.append(GuildPluginEntry(plugin_name=name, enabled=True))
            continue
        entries.append(
            GuildPluginEntry(
                plugin_name=name,
                enabled=enabled_by_name.get(name, False),
            )
        )
    return entries


@router.put("/{name}", response_model=GuildPluginEntry)
async def toggle_guild_plugin(
    guild_id: int,
    name: str,
    payload: GuildPluginTogglePayload,
    session: SessionDep,
    current: CurrentUser,
):
    """Toggelt ``enabled`` für (guild_id, plugin_name).

    * Plugin muss in der Allowlist sein, sonst 404 ``plugin_not_allowed``.
    * ``hello`` ist nicht togglebar → 409.
    * MANAGE_GUILD-Gate.
    * Nach erfolgreichem Write wird der WS-Op-Gate-Cache für
      `(guild_id, name)` im selben Prozess invalidiert, sodass eine
      UI-Aktion ohne 60 s TTL-Lag wirkt. Multi-Pod-Setup → Redis-
      Pub/Sub-basierte Invalidation (PR2).
    """
    from dcc_chat_gateway.plugins.allowlist import list_allowed_names
    from dcc_chat_gateway.plugins.ws_op_gate import invalidate_guild_plugin_cache

    _validate_plugin_name(name)
    if name == HELLO_PLUGIN_NAME:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="hello_plugin_not_toggleable"
        )

    await check_permission(
        session, current, guild_id, Permissions.MANAGE_GUILD
    )

    allowed = await list_allowed_names(session)
    if name not in allowed:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="plugin_not_allowed"
        )

    row = await session.get(GuildPlugin, (guild_id, name))
    if row is None:
        row = GuildPlugin(
            guild_id=guild_id,
            plugin_name=name,
            enabled=payload.enabled,
            enabled_by_user_id=current.id,
        )
        session.add(row)
    else:
        row.enabled = payload.enabled
        row.enabled_by_user_id = current.id
    await session.commit()
    invalidate_guild_plugin_cache(guild_id, name)
    return GuildPluginEntry(plugin_name=name, enabled=row.enabled)


class TamagotchiState(BaseModel):
    """Server-shared Tamagotchi-Pet (Plugin-System PR3).

    Schema gespiegelt zwischen Backend (``plugins/tamagotchi/backend.py``
    ``DEFAULT_STATE``) und Frontend (``plugins/tamagotchi/store.ts``).
    Stats sind 0–100, ``lastUpdatedAt`` ist ISO-8601.
    """

    name: str
    hunger: int
    happiness: int
    energy: int
    lastUpdatedAt: str


# Default-State für den HTTP-Endpoint, wenn noch keine DB-Row existiert.
# Bewusst NICHT in der DB persistieren (kein Insert beim GET) — die Row
# entsteht erst beim ersten Mutate-Op. So leakt ein nur-Reader-User keine
# leere Row pro Guild in die Tabelle.
_DEFAULT_TAMAGOTCHI = {
    "name": "Tamagotchi",
    "hunger": 80,
    "happiness": 80,
    "energy": 80,
    "lastUpdatedAt": "1970-01-01T00:00:00+00:00",
}


def _coerce_tamagotchi_state(raw: dict[str, Any]) -> TamagotchiState:
    """Verschmelze Persisted-State mit Defaults + clampt Stats auf 0–100.

    Schutz gegen Schema-Drift bei alten Rows; gleicher Pfad wie der
    ``_merge_defaults`` im Backend-Handler, hier nochmal für den
    Read-Pfad (HTTP-GET geht NICHT durch den Mutator).
    """
    merged: dict[str, Any] = dict(_DEFAULT_TAMAGOTCHI)
    merged.update(raw or {})
    for k in ("hunger", "happiness", "energy"):
        try:
            v = int(merged.get(k, 80))
        except (TypeError, ValueError):
            v = 80
        merged[k] = max(0, min(100, v))
    if not isinstance(merged.get("name"), str) or not merged["name"]:
        merged["name"] = _DEFAULT_TAMAGOTCHI["name"]
    if not isinstance(merged.get("lastUpdatedAt"), str):
        merged["lastUpdatedAt"] = _DEFAULT_TAMAGOTCHI["lastUpdatedAt"]
    return TamagotchiState(
        name=merged["name"],
        hunger=merged["hunger"],
        happiness=merged["happiness"],
        energy=merged["energy"],
        lastUpdatedAt=merged["lastUpdatedAt"],
    )


@router.get("/tamagotchi/state", response_model=TamagotchiState)
async def get_tamagotchi_state(
    guild_id: int, session: SessionDep, current: CurrentUser
):
    """Aktueller Tamagotchi-State der Guild (PR3 "Server-shared Pet").

    Lesen reicht Guild-Mitgliedschaft (kein MANAGE_GUILD). Wenn noch kein
    Pet existiert (nie ein Op auf der Guild), gibt der Endpoint den
    Default-State zurück — **ohne** DB-Insert. Die Row entsteht erst
    beim ersten Mutate-Op (``tamagotchi:{feed,play,sleep,reset}``).
    """
    from dcc_chat_gateway.routes._deps import require_member

    await require_member(session, guild_id, current.id)
    raw = await get_state(session, guild_id, "tamagotchi")
    if raw is None:
        return TamagotchiState(**_DEFAULT_TAMAGOTCHI)
    return _coerce_tamagotchi_state(raw)


__all__ = ["router"]
