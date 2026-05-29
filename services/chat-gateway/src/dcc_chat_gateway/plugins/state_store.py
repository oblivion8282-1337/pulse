"""Generic per-guild plugin-state storage helpers (Plugin-System PR3).

Plugins, die einen **guild-scoped, server-shared** State brauchen
(z.B. ``tamagotchi``: ein Pet pro Guild, von allen Mitgliedern
gefüttert), lesen + mutieren ihre Row in ``chat.guild_plugin_state``
über die Funktionen hier. Per-User-State läuft weiterhin über
``user_preferences`` (Schritt 3b) — die beiden Stores sind komplementär,
nicht überlappend.

Atomicity
---------
``apply_atomic_update`` ist das Hauptwerkzeug. Es nimmt eine Pure-Python-
``mutate``-Funktion ``(old_state) -> new_state`` und führt sie in einer
einzelnen Transaktion mit row-level ``SELECT … FOR UPDATE`` aus
(Postgres) bzw. mit dem SQLite-Default-Lock. Race-safe für N parallele
Aufrufe: alle laufen sequentiell durch und sehen den jeweils vorherigen
End-State.

Warum ``SELECT … FOR UPDATE`` und nicht ``jsonb_set``? ``jsonb_set``
wäre atomar auf einem einzelnen Pfad (z.B. ``hunger += 20``), aber
``tamagotchi:play`` mutiert zwei Felder gleichzeitig (``happiness +
20``, ``energy − 10``) und müsste verschachtelt werden. Row-Lock-Pfad
ist einheitlich, lesbar, und dialect-agnostisch — Trade-off ist ein
extra Round-Trip pro Op, was bei der erwarteten Last (UI-Klicks, kein
Bot-Spam) irrelevant ist.

Upsert-Default
--------------
Wenn die Row noch nicht existiert (erster Op auf der Guild), wird sie
mit ``default_state`` angelegt — dann läuft die ``mutate``-Funktion
einmal darauf. Race-safe via ``INSERT … ON CONFLICT`` (Postgres) bzw.
``INSERT OR IGNORE`` (SQLite); danach folgt der Row-Lock-Pfad.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import GuildPluginState

log = logging.getLogger(__name__)

StateMutator = Callable[[dict[str, Any]], dict[str, Any]]


async def get_state(
    session: AsyncSession,
    guild_id: int,
    plugin_name: str,
) -> dict[str, Any] | None:
    """Lese den aktuellen State. ``None`` wenn noch keine Row existiert.

    Verwendet ``session.get`` (Primary-Key-Lookup) — keine Lock-Semantik;
    Read-only-Pfad für den HTTP-State-Endpoint. Mutationen gehen über
    :func:`apply_atomic_update`.
    """
    row = await session.get(GuildPluginState, (guild_id, plugin_name))
    if row is None:
        return None
    # Defensive Copy — der Aufrufer soll nicht aus Versehen am ORM-Objekt
    # rumeditieren und beim nächsten Commit ungewollt persistieren.
    return dict(row.state or {})


async def _ensure_row(
    session: AsyncSession,
    guild_id: int,
    plugin_name: str,
    default_state: dict[str, Any],
    actor_user_id: int | None,
) -> None:
    """Idempotent-Insert der State-Row mit ``default_state``.

    Race-safe: zwei parallele Erstaufrufe konkurrieren via
    ``ON CONFLICT DO NOTHING`` (Postgres) bzw. ``INSERT OR IGNORE``
    (SQLite); der Verlierer findet die Row beim nächsten ``session.get``.
    """
    bind = session.get_bind()
    dialect_name = bind.dialect.name
    if dialect_name == "postgresql":
        stmt = (
            pg_insert(GuildPluginState)
            .values(
                guild_id=guild_id,
                plugin_name=plugin_name,
                state=default_state,
                updated_by_user_id=actor_user_id,
            )
            .on_conflict_do_nothing(
                index_elements=["guild_id", "plugin_name"]
            )
        )
        await session.execute(stmt)
        return
    # SQLite + Fallback: prefix_with('OR IGNORE') — gleicher Effekt wie
    # ON CONFLICT DO NOTHING, ohne Dialekt-spezifisches Bauen.
    stmt_generic = insert(GuildPluginState).values(
        guild_id=guild_id,
        plugin_name=plugin_name,
        state=default_state,
        updated_by_user_id=actor_user_id,
    )
    stmt_generic = stmt_generic.prefix_with("OR IGNORE")
    await session.execute(stmt_generic)


async def apply_atomic_update(
    session: AsyncSession,
    *,
    guild_id: int,
    plugin_name: str,
    default_state: dict[str, Any],
    mutate: StateMutator,
    actor_user_id: int | None,
) -> dict[str, Any]:
    """Lese → mutiere → schreibe State, alles in EINER Transaktion mit
    row-lock. Returnt den final-persistierten State.

    Pfad:
    1. ``INSERT … ON CONFLICT DO NOTHING`` mit ``default_state`` — falls
       Row schon da, no-op; sonst wird der Default angelegt.
    2. ``SELECT … FOR UPDATE`` (Postgres) bzw. plain SELECT (SQLite —
       Datei-DB serialisiert Writes ohnehin) — Lock auf die Row.
    3. ``mutate(old) → new`` — pure Python-Funktion, vom Aufrufer.
    4. ``UPDATE state = :new, updated_at = now(), updated_by =
       :actor``.
    5. ``commit`` — Lock fällt frei.

    Concurrency-Garantie: N parallele Aufrufe sehen den jeweils vorherigen
    End-State (sequenzialisiert über den Row-Lock). Tests in
    ``test_tamagotchi_state.py::test_concurrent_feeds_are_serialised``
    locken das ein.
    """
    # Schritt 1: Default-Row sicherstellen.
    await _ensure_row(
        session, guild_id, plugin_name, default_state, actor_user_id
    )
    # Kein commit() hier — INSERT und SELECT FOR UPDATE laufen in EINER
    # Transaktion. Ein Commit zwischen beiden würde die Atomizität brechen:
    # ein concurrent guild-DELETE könnte die Row zwischen den beiden
    # Statements entfernen.

    # Schritt 2: Lock + Read. ``with_for_update`` ist no-op auf SQLite
    # (lokale Datei-DB serialisiert Schreibtransaktionen ohnehin), aber
    # auf Postgres ist es zwingend für die Race-Safety.
    bind = session.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    stmt = select(GuildPluginState).where(
        GuildPluginState.guild_id == guild_id,
        GuildPluginState.plugin_name == plugin_name,
    )
    if is_pg:
        stmt = stmt.with_for_update()
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        # Sehr selten: concurrent guild-DELETE hat die Row zwischen
        # dem INSERT und dem SELECT entfernt. Transaktion rollbacken
        # und mit einem leeren Dict returnen — der Aufrufer bekommt
        # kein crash, der State gilt als gelöscht.
        await session.rollback()
        log.warning(
            "apply_atomic_update: row vanished (guild_id=%s plugin=%s) "
            "— likely concurrent guild deletion; returning default",
            guild_id,
            plugin_name,
        )
        return dict(default_state)

    # Schritt 3-4: Mutate + Write.
    old_state = dict(row.state or {})
    new_state = mutate(old_state)
    if not isinstance(new_state, dict):
        raise TypeError(
            "mutate() must return dict; got %r" % (type(new_state).__name__,)
        )
    row.state = new_state
    row.updated_by_user_id = actor_user_id

    await session.commit()
    return new_state


__all__ = [
    "StateMutator",
    "apply_atomic_update",
    "get_state",
]
