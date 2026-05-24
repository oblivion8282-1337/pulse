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
Allowlist-Mutationen brauchen einen Service-Restart, bevor sie in den
laufenden Loader greifen. Der WS-Op-Dispatcher liest aus
``app.state.plugin_allowlist`` (Snapshot zur Lifespan-Zeit) — neue
Plugin-Ops würden ohne Restart vom Gate geblockt. Dokumentiert in
``plugins/loader.py`` + ``docs/PLUGIN_ROADMAP.md``.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import GuildPlugin

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
    """Antwort auf einen erfolgreichen PUT."""

    plugin_name: str
    in_allowlist: bool = True
    requires_restart: bool = True


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
    name: str, session: SessionDep, actor: AdminUser
):
    """In die Allowlist eintragen. Idempotent.

    Plugin muss in der Discovery existieren — sonst 404. Verhindert
    Tippfehler, die "leere" Allowlist-Einträge produzieren würden.
    """
    from dcc_chat_gateway.plugins.allowlist import add_to_allowlist
    from dcc_chat_gateway.plugins.loader import discover_manifests

    _validate_plugin_name(name)
    discovered = {m.name for m in discover_manifests()}
    if name not in discovered:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="plugin_not_discovered"
        )
    await add_to_allowlist(session, name, added_by_user_id=actor.id)
    return PluginAllowlistPutOut(plugin_name=name)


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_plugin_from_allowlist(
    name: str, session: SessionDep, _actor: AdminUser
):
    """Aus der Allowlist entfernen + alle Guild-Toggles cascade-löschen.

    ``hello`` ist nicht entfernbar (Loader-Smoketest + Frontend-Default)
    — 409.
    """
    from dcc_chat_gateway.plugins.allowlist import remove_from_allowlist

    _validate_plugin_name(name)
    if name == HELLO_PLUGIN_NAME:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="hello_plugin_not_removable"
        )
    # Manueller Cascade über die zwei Tabellen — es gibt keinen DB-FK
    # zwischen instance_plugin_allowlist und guild_plugins (die haben
    # nur das ``plugin_name``-Feld als logische Brücke). Erst die
    # Toggle-Rows weg, dann die Allowlist-Row — falls der zweite Schritt
    # failt, hinterlassen wir keinen orphan Toggle-Set.
    await session.execute(
        delete(GuildPlugin).where(GuildPlugin.plugin_name == name)
    )
    removed = await remove_from_allowlist(session, name)
    if not removed:
        # War nicht in der Allowlist — idempotent: keine Daten geändert,
        # trotzdem 204 (DELETE-Konvention).
        await session.commit()
    # Hot-Reload-Hinweis: wir setzen den Snapshot auf ``app.state``
    # bewusst NICHT um. Plugin-Ops auf entferntem Plugin werden bis
    # zum Restart noch durchgelassen, aber der Loader-State (registry)
    # ist gleich — Worst Case ist eine Op, die im Backend nichts macht.
    # Doku in ``plugins/loader.py``.
    _drop_manager_record(name)
    return None


def _drop_manager_record(name: str) -> None:
    """Beim Allowlist-Remove den :class:`PluginManager`-Record wegnehmen.

    Der Loader hat das Plugin beim Startup eingetragen (auch wenn es
    nicht aktiviert wurde — Admin-UI braucht es als sichtbaren Eintrag).
    Beim Allowlist-Remove wäre die Reaktivierung nach erneutem Add ein
    Hot-Reload-Pfad, der heute bewusst NICHT unterstützt wird. Lieber
    Record stillschweigend droppen — beim nächsten Startup baut der
    Loader ihn ohnehin neu auf, falls das Plugin wieder allowed wird.
    """
    from dcc_chat_gateway.plugins.registry import get_manager

    mgr = get_manager()
    rec = mgr.get(name)
    if rec is None:
        return
    if rec.activated:
        try:
            mgr.deactivate(name)
        except Exception:  # noqa: BLE001
            # deactivate ist best-effort; ein Hook-Fehler darf den
            # DELETE-Endpoint nicht failen lassen.
            pass
    # PluginManager hat keinen public ``forget()`` — wir greifen
    # direkt ins ``_records``-Dict. Alternative wäre ein neues API in
    # registry.py, aber das ist ein Single-Site-Hack für einen
    # Stufe-A-Pfad.
    mgr._records.pop(name, None)  # noqa: SLF001
    # Kein Re-Import nötig — beim Restart läuft load_all_with_allowlist
    # erneut und das Plugin landet wieder im Manager, falls erlaubt.


__all__ = ["router"]
