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
und übergibt ihn der :class:`~.registry.PluginManager`-Aktivierung;
WS-Op-Dispatcher liest aus dem Snapshot, nicht aus der DB. Das spart
einen DB-Hit pro WS-Op — Trade-off ist, dass eine
Allowlist-Änderung erst nach einem Service-Restart greift (dokumentiert
in :mod:`.loader`).
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models.plugin_activation import InstancePluginAllowlist

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


__all__ = [
    "HELLO_PLUGIN_NAME",
    "add_to_allowlist",
    "ensure_hello_in_allowlist",
    "filter_to_allowed",
    "list_allowed_names",
    "remove_from_allowlist",
]
