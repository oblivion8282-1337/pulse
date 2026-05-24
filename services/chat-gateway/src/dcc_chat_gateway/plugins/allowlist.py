"""DB-Zugriff für die Plugin-Allowlist (Instanz-Ebene).

Schmaler Wrapper um die :class:`InstancePluginAllowlist`-Tabelle, damit
der Loader (sync) + die Admin-API (async-FastAPI) + der WS-Op-Gate
(async, hot path) **eine** Stelle haben, an der die Allowlist gelesen
und mutiert wird.

Das Hello-Plugin ist ein Sonderfall: es muss **immer** in der Allowlist
stehen (Smoketest des Loaders + Default-Verhalten "alles minimal-aktiv
auch nach manuellem Wegwischen"). :func:`ensure_hello_in_allowlist`
macht den Idempotent-Insert; der Loader ruft es beim Startup auf, die
Migration seedt es initial.

Hot-Path-Snapshot
-----------------
Der Loader nimmt beim Startup einen In-Memory-Snapshot der Allowlist
und legt ihn auf ``app.state.plugin_allowlist`` (frozenset) ab; der
WS-Op-Dispatcher liest aus dem Snapshot, nicht aus der DB. Spart einen
DB-Hit pro WS-Op — Mutationen an der Allowlist müssen den Snapshot
unter Lock aktualisieren, sonst wäre eine via Admin-API neu erlaubte
Plugin-Op-Verarbeitung bis zum nächsten Restart geblockt
(:func:`update_plugin_allowlist_snapshot`).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models.plugin_activation import InstancePluginAllowlist

if TYPE_CHECKING:
    from fastapi import FastAPI

log = logging.getLogger(__name__)

# Plugin-Name, der nicht aus der Allowlist entfernbar ist und auch
# nicht per Guild togglebar ist — der Loader-Smoketest verlässt sich
# darauf.
HELLO_PLUGIN_NAME = "hello"


async def list_allowed_names(session: AsyncSession) -> set[str]:
    """Lese die Allowlist als reines String-Set (was darf laufen?)."""
    rows = (
        await session.execute(select(InstancePluginAllowlist.plugin_name))
    ).scalars()
    return set(rows)


async def add_to_allowlist(
    session: AsyncSession,
    plugin_name: str,
    *,
    added_by_user_id: int | None,
) -> bool:
    """Trage ``plugin_name`` in die Allowlist ein. Idempotent.

    Returns ``True`` wenn ein neuer Eintrag entstanden ist, ``False``
    wenn das Plugin schon drin war. Der Insert ist dialect-aware:
    Postgres bekommt einen ``ON CONFLICT DO NOTHING``, SQLite (Tests)
    fällt auf einen Read-then-Write-Pfad zurück.
    """
    bind = session.get_bind()
    dialect_name = bind.dialect.name

    if dialect_name == "postgresql":
        stmt = (
            pg_insert(InstancePluginAllowlist)
            .values(
                plugin_name=plugin_name, added_by_user_id=added_by_user_id
            )
            .on_conflict_do_nothing(index_elements=["plugin_name"])
        )
        result = await session.execute(stmt)
        await session.commit()
        # ``rowcount`` is 1 on insert, 0 on conflict.
        return (result.rowcount or 0) > 0

    # SQLite (Tests) + sonstige Dialekte: Lookup, dann Insert.
    existing = await session.get(InstancePluginAllowlist, plugin_name)
    if existing is not None:
        return False
    session.add(
        InstancePluginAllowlist(
            plugin_name=plugin_name,
            added_by_user_id=added_by_user_id,
        )
    )
    await session.commit()
    return True


async def remove_from_allowlist(
    session: AsyncSession, plugin_name: str
) -> bool:
    """Entferne ``plugin_name`` aus der Allowlist.

    ``hello`` ist hart-gesperrt — der Aufrufer (Admin-API) prüft das
    selbst und gibt 409 raus. Hier wäre der Schutz ein Code-Smell:
    die Funktion soll mit dem Loader-Self-Heal-Pfad zusammenarbeiten,
    der auch bei aus Versehen entfernten ``hello``-Einträgen wieder
    eintragen können muss.
    """
    row = await session.get(InstancePluginAllowlist, plugin_name)
    if row is None:
        return False
    await session.delete(row)
    await session.commit()
    return True


async def ensure_hello_in_allowlist(session: AsyncSession) -> None:
    """Garantiere, dass das ``hello``-Plugin in der Allowlist steht.

    Backup zur Migrations-Seed: falls jemand den Seed-Row manuell
    gelöscht hat, kommt er beim nächsten Startup über den Loader
    wieder zurück. Idempotent — ``added_by_user_id=NULL`` markiert
    System-Inserts.
    """
    added = await add_to_allowlist(
        session, HELLO_PLUGIN_NAME, added_by_user_id=None
    )
    if added:
        log.info(
            "plugin-allowlist self-heal: re-added %r", HELLO_PLUGIN_NAME
        )


def filter_to_allowed(
    plugin_names: Iterable[str], allowed: set[str]
) -> list[str]:
    """Hilfsfunktion: bewahre Reihenfolge, behalte nur erlaubte Namen."""
    return [n for n in plugin_names if n in allowed]


# ---------------------------------------------------------------------------
# Hot-Reload-Helper für den ``app.state.plugin_allowlist``-Snapshot.
#
# Single-Pod-Strategie: der Admin-PUT/DELETE-Handler ruft direkt nach dem
# DB-Commit hier rein, um den frozenset-Snapshot ohne Service-Restart in
# Sync mit der DB zu bringen. asyncio.Lock genügt, weil FastAPI/uvicorn
# alle Requests im selben Event-Loop verarbeitet (kein threading-Race).
# Multi-Pod-Setup wird zusätzlich über den Redis-Pub/Sub-Notify-Pfad
# ``plugin:allowlist:changed`` informiert (Publish only — Subscribe-Side
# ist Vorbereitung für Stufe B, siehe ``routes/admin_plugins.py``).
# ---------------------------------------------------------------------------

# Modul-globaler Lock. Wir wollen kein Lock pro App-Instanz (sonst müssten
# Tests den App-State neu basteln) — der Lock schützt nur das Frozenset-
# Rebuild, nicht die DB-Schreiben (die haben ihr eigenes Transaktions-Locking).
_allowlist_snapshot_lock = asyncio.Lock()


async def update_plugin_allowlist_snapshot(
    app: FastAPI,
    *,
    add: str | None = None,
    remove: str | None = None,
) -> frozenset[str]:
    """Mutiere ``app.state.plugin_allowlist`` (frozenset) atomic.

    Mindestens eines von ``add``/``remove`` muss gesetzt sein (beide
    geht auch — wird in der Reihenfolge add-then-remove angewandt).
    Returnt das neue Snapshot-Set. Idempotent: ein doppelter ``add``
    von ``"x"`` ergibt dasselbe Set.

    Warum kein DB-Read?
    -------------------
    Der Aufrufer hat die DB-Mutation gerade selbst gemacht und kennt
    Add/Remove genau — ein Refresh-from-DB wäre teurer (Round-Trip) und
    würde Race-Conditions zwischen parallelen PUTs nicht sauber lösen
    (last-writer-wins-on-DB ≠ last-writer-wins-on-Snapshot). Punktuelle
    Mutation unter Lock ist konsistent mit dem DB-Insert-Order.
    """
    if add is None and remove is None:
        raise ValueError("update_plugin_allowlist_snapshot needs add or remove")
    async with _allowlist_snapshot_lock:
        current = getattr(app.state, "plugin_allowlist", frozenset())
        as_set = set(current)
        if add is not None:
            as_set.add(add)
        if remove is not None:
            as_set.discard(remove)
        new_snapshot = frozenset(as_set)
        app.state.plugin_allowlist = new_snapshot
    return new_snapshot


__all__ = [
    "HELLO_PLUGIN_NAME",
    "add_to_allowlist",
    "ensure_hello_in_allowlist",
    "filter_to_allowed",
    "list_allowed_names",
    "remove_from_allowlist",
    "update_plugin_allowlist_snapshot",
]
