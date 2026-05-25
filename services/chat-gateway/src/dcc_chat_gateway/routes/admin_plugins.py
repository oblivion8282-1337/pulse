"""Admin-API für die instanzweite Plugin-Allowlist.

Bootstrap-Admin-only (``admin: true`` im JWT). Die Allowlist entscheidet,
welche Plugins der chat-gateway-Loader beim Startup überhaupt aktiviert
und welche Plugin-Ops der WS-Op-Dispatcher durchlässt.

Endpunkte
---------
* ``GET    /admin/plugins`` — Liste aller entdeckten Plugins **plus**
  Allowlist-Einträge, deren Plugin-Verzeichnis verschwunden ist. Pro
  Eintrag: ``{plugin_name, in_allowlist, in_discovery, version,
  description}``.
* ``PUT    /admin/plugins/{name}`` — In die Allowlist eintragen
  (idempotent). 404 wenn das Plugin nicht in der Discovery existiert
  — wir wollen keine "leeren" Allowlist-Einträge für Plugins, die es
  gar nicht gibt.
* ``DELETE /admin/plugins/{name}`` — Aus der Allowlist entfernen + alle
  zugehörigen ``guild_plugins``-Rows mit raus (Cascade von Hand, weil
  kein DB-FK existiert — die zwei Tabellen sind cross-cutting).
  ``hello`` ist nicht entfernbar → 409.

Activation-Hot-Reload
~~~~~~~~~~~~~~~~~~~~~
PUT/DELETE wirken **live**: der PUT-Handler ruft den Plugin-Loader
(``activate_plugin``), abonniert die im Manifest deklarierten Pub/Sub-
Channels nach und aktualisiert den ``app.state.plugin_allowlist``-
Snapshot unter Lock. DELETE entfernt den Plugin-Namen aus dem Snapshot
(WS-Op-Gate rejected ab dann sofort) und putzt den Per-Guild-Toggle-
Cache. Die im Loader-Lauf registrierten Op-/Channel-Handler bleiben
inert im Dispatch-Dict — siehe ``plugins/loader.deactivate_plugin`` für
die Trade-off-Begründung.

Multi-Pod-Setup bekommt zusätzlich einen Redis-Pub/Sub-Notify
``plugin:allowlist:changed`` mit ``{op, name, actor_id}``-Payload
publisht; der Subscribe-Pfad (jeder Pod refresht seinen Snapshot) ist
Vorbereitung für Stufe B und heute **nicht** verdrahtet — Single-Pod-
Prod-Setup braucht ihn nicht. Der Publish ist trivial und schadet auch
in Single-Pod nicht (keine Subscriber).
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import GuildPlugin
from dcc_chat_gateway.routes.admin_plugins_publish import (
    ALLOWLIST_CHANGED_CHANNEL,
    publish_allowlist_changed,
    publish_guild_plugins_disabled,
)

# Plugin-Module werden **innerhalb** der Route-Funktionen importiert,
# weil ``dcc_chat_gateway.plugins.registry`` während des App-Bootstraps
# ``routes.ws_ops_registry`` lädt — was den ``routes``-Package-Init
# triggert. Würden wir die Plugin-Imports auf Top-Level halten, hätten
# wir einen Loop (routes/__init__ → admin_plugins → plugins/loader →
# plugins/registry → routes/ws_ops_registry → routes/__init__ in mid-
# init). Die Lazy-Variante ist hier sauberer als ein TYPE_CHECKING-Hack.
# Constant darf vor dem App-Boot importierbar sein — ist eine Pure-
# String-Konstante ohne Side-Effects.
from dcc_chat_gateway.plugins.allowlist import HELLO_PLUGIN_NAME
from dcc_chat_gateway.security import AdminUser

log = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/plugins")


# Plugin-Name-Charset spiegelt das Manifest (``^[a-z][a-z0-9_-]{1,31}$``).
# Wir validieren auf Route-Ebene, damit ein POST mit "../etc/passwd" als
# Plugin-Name nicht erst in der DB ankommt.
_PLUGIN_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")


class PluginAllowlistEntry(BaseModel):
    """Eine Plugin-Zeile für die Admin-UI."""

    plugin_name: str
    in_allowlist: bool
    in_discovery: bool
    version: str | None = None
    description: str | None = None


class PluginAllowlistPutOut(BaseModel):
    """Antwort auf einen erfolgreichen PUT.

    ``requires_restart`` steht seit dem Hot-Reload-Patch (Single-Pod) auf
    ``False`` — Plugin-Ops sind sofort nach dem PUT zugelassen. Das Feld
    bleibt im Response-Schema, damit die Admin-UI für Multi-Pod-Setups
    (Stufe B) später ein klares "noch nicht überall ausgerollt"-Signal
    hat. Heute hardcoded auf ``False``.
    """

    plugin_name: str
    in_allowlist: bool = True
    requires_restart: bool = False


def _validate_plugin_name(name: str) -> str:
    if not _PLUGIN_NAME_RE.match(name):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="invalid_plugin_name"
        )
    return name


@router.get("", response_model=list[PluginAllowlistEntry])
async def list_plugins(session: SessionDep, _actor: AdminUser):
    """Vereinigte Sicht: Discovery ∪ Allowlist.

    * Plugin in Discovery + in Allowlist → ``in_discovery=True, in_allowlist=True``
    * Plugin in Discovery, nicht in Allowlist → ``in_discovery=True, in_allowlist=False``
    * Plugin in Allowlist, nicht (mehr) in Discovery → ``in_discovery=False, in_allowlist=True``
      (z.B. Plugin-Ordner wurde gelöscht — Admin sollte den Eintrag wegputzen können)
    """
    from dcc_chat_gateway.plugins.allowlist import list_allowed_names
    from dcc_chat_gateway.plugins.loader import discover_manifests

    manifests = {m.name: m for m in discover_manifests()}
    allowed = await list_allowed_names(session)

    entries: list[PluginAllowlistEntry] = []
    seen: set[str] = set()
    for name in sorted(set(manifests) | allowed):
        if name in seen:
            continue
        seen.add(name)
        manifest = manifests.get(name)
        entries.append(
            PluginAllowlistEntry(
                plugin_name=name,
                in_allowlist=(name in allowed),
                in_discovery=(manifest is not None),
                version=manifest.version if manifest is not None else None,
                description=(
                    manifest.description if manifest is not None else None
                ),
            )
        )
    return entries


@router.put("/{name}", response_model=PluginAllowlistPutOut)
async def add_plugin_to_allowlist(
    name: str, request: Request, session: SessionDep, actor: AdminUser
):
    """In die Allowlist eintragen + live aktivieren. Idempotent.

    Plugin muss in der Discovery existieren — sonst 404. Verhindert
    Tippfehler, die "leere" Allowlist-Einträge produzieren würden.

    Hot-Reload-Schritte (in dieser Reihenfolge, alle nach erfolgreichem
    DB-Commit):

    1. ``activate_plugin(name)`` lädt das Backend-Modul + ruft
       ``register()`` → WS-Op- und Channel-Handler landen in den
       Dispatch-Registries. Idempotent: ein schon aktives Plugin wird
       vom Manager als no-op behandelt.
    2. ``update_plugin_allowlist_snapshot(add=name)`` setzt den
       ``app.state.plugin_allowlist``-Snapshot unter Lock.
    3. Plugin-Channels aus dem Manifest werden bei der
       ConnectionManager-Pub/Sub-Subscription nachgereicht (idempotent
       bei Redis — ein zweiter ``SUBSCRIBE`` ist no-op).
    4. Cross-Pod-Notify auf ``plugin:allowlist:changed``. Failure
       loggen + ignorieren — der lokale Pod ist schon konsistent.
    """
    from dcc_chat_gateway.plugins.allowlist import (
        add_to_allowlist,
        update_plugin_allowlist_snapshot,
    )
    from dcc_chat_gateway.plugins.loader import (
        activate_plugin,
        discover_manifests,
    )

    _validate_plugin_name(name)
    discovered = {m.name for m in discover_manifests()}
    if name not in discovered:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="plugin_not_discovered"
        )
    await add_to_allowlist(session, name, added_by_user_id=actor.id)

    # ---- Hot-Reload ----------------------------------------------------
    manifest = activate_plugin(name)
    if manifest is None:
        # Double-Check: Discovery hatte ihn oben gefunden, aber der
        # Loader-Aktivierungspfad nicht. Sehr selten (z.B. Plugin-Datei
        # wurde zwischen den beiden Calls gelöscht). DB-Insert
        # rückgängig zu machen wäre Overkill — der Admin kann den
        # Eintrag per DELETE wieder rausnehmen.
        log.warning(
            "admin PUT /admin/plugins/%s: activation returned None "
            "(plugin file race?); allowlist row persisted",
            name,
        )
    await update_plugin_allowlist_snapshot(request.app, add=name)

    # Plugin-Channel-Subscribe nachreichen, damit publish→fan-out direkt
    # nach dem PUT funktioniert (sonst würden die ersten Events ins
    # Leere laufen, weil der ConnectionManager den Channel nicht hört).
    if manifest is not None and manifest.uses.channels:
        manager = getattr(request.app.state, "connection_manager", None)
        if manager is not None:
            try:
                await manager.subscribe_plugin_channels(
                    list(manifest.uses.channels)
                )
            except Exception:  # noqa: BLE001
                log.exception(
                    "admin PUT /admin/plugins/%s: plugin-channel "
                    "subscribe failed; broadcasts may not reach clients",
                    name,
                )

    await publish_allowlist_changed(request, op="add", name=name, actor_id=actor.id)
    return PluginAllowlistPutOut(plugin_name=name)


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_plugin_from_allowlist(
    name: str, request: Request, session: SessionDep, actor: AdminUser
):
    """Aus der Allowlist entfernen + alle Guild-Toggles cascade-löschen.

    ``hello`` ist nicht entfernbar (Loader-Smoketest + Frontend-Default)
    — 409.

    Hot-Reload-Schritte (alle nach erfolgreichem DB-Commit):

    1. ``update_plugin_allowlist_snapshot(remove=name)`` zieht den
       Namen aus dem ``app.state.plugin_allowlist``-Snapshot — der
       WS-Op-Gate rejected ab sofort jede Op des Plugins mit Code 4040.
    2. ``PluginManager.forget(name)`` deaktiviert die im Loader-Lauf
       registrierten Handler und wirft den Record weg. Beim nächsten
       PUT würde ``activate_plugin`` über den Filesystem-Rescan einen
       frischen Record bauen.
    3. WS-Op-Gate-Cache wird für dieses Plugin entleert (sonst kann
       eine Toggle-Lookup bis zu 60 s nachhinken).
    4. Cross-Pod-Notify auf ``plugin:allowlist:changed``.
    """
    from dcc_chat_gateway.plugins.allowlist import (
        remove_from_allowlist,
        update_plugin_allowlist_snapshot,
    )

    _validate_plugin_name(name)
    if name == HELLO_PLUGIN_NAME:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="hello_plugin_not_removable"
        )
    # Manueller Cascade über die zwei Tabellen — es gibt keinen DB-FK
    # zwischen instance_plugin_allowlist und guild_plugins (die haben
    # nur das ``plugin_name``-Feld als logische Brücke). Erst die
    # betroffenen Guild-IDs einsammeln (für den WS-Push gleich darunter),
    # dann die Toggle-Rows weg, dann die Allowlist-Row — failt der zweite
    # Schritt, hinterlassen wir keinen orphan Toggle-Set.
    affected_guilds_rows = await session.execute(
        select(GuildPlugin.guild_id).where(
            GuildPlugin.plugin_name == name,
            GuildPlugin.enabled.is_(True),
        )
    )
    affected_guild_ids = [int(g) for g in affected_guilds_rows.scalars().all()]
    await session.execute(
        delete(GuildPlugin).where(GuildPlugin.plugin_name == name)
    )
    removed = await remove_from_allowlist(session, name)
    if not removed:
        # War nicht in der Allowlist — idempotent: keine Daten geändert,
        # trotzdem 204 (DELETE-Konvention).
        await session.commit()

    # ---- Hot-Reload ----------------------------------------------------
    # 1. Snapshot zuerst, damit konkurrente WS-Ops das Plugin schon nach
    #    dem ersten Yield-Punkt nicht mehr durchkommen.
    await update_plugin_allowlist_snapshot(request.app, remove=name)
    # 2. Manager-Record + Registry-Diff entfernen.
    _drop_manager_record(name)
    # 3. WS-Op-Gate-Cache invalidieren — der Cache ist (guild_id, name)-
    #    keyed, und ein DELETE betrifft alle Guilds. Wir nutzen den
    #    schon existierenden Helper, der eine Variante "alle Slots eines
    #    Plugins" hat (über ein zweites Loop über die Keys).
    from dcc_chat_gateway.plugins.ws_op_gate import _cache

    for key in [k for k in _cache if k[1] == name]:
        _cache.pop(key, None)

    # 4. Pro Guild, die das Plugin aktiv hatte, ein
    #    ``guild_plugins_changed``-Event pushen (enabled=False), damit
    #    die Frontend-Caches der jeweiligen Guild-Member sofort den
    #    Plugin-Slot zumachen.
    await publish_guild_plugins_disabled(
        request, guild_ids=affected_guild_ids, plugin_name=name
    )

    await publish_allowlist_changed(
        request, op="remove", name=name, actor_id=actor.id
    )
    return None


def _drop_manager_record(name: str) -> None:
    """Beim Allowlist-Remove den :class:`PluginManager`-Record wegnehmen.

    Der Loader hat das Plugin beim Startup eingetragen (auch wenn es
    nicht aktiviert wurde — Admin-UI braucht es als sichtbaren Eintrag).
    ``forget()`` deaktiviert das Plugin (rollt Op-/Channel-Registries
    zurück) und entfernt den Record. Ein späterer Re-Add holt sich das
    Plugin via ``activate_plugin`` neu aus der Discovery.
    """
    from dcc_chat_gateway.plugins.registry import get_manager

    get_manager().forget(name)


__all__ = ["ALLOWLIST_CHANGED_CHANNEL", "router"]
