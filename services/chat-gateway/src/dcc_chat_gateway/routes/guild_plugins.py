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

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import GuildPlugin
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
)

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
    """
    from dcc_chat_gateway.plugins.allowlist import list_allowed_names

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
    return GuildPluginEntry(plugin_name=name, enabled=row.enabled)


__all__ = ["router"]
