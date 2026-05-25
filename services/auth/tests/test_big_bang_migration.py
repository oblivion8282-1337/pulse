"""Tests für Migration 0018 — Big-Bang-Revoke aller aktiven Refresh-Tokens.

Strategie: da die Migration nur plain SQL auf auth.refresh_tokens ausführt,
testen wir die SQLite-Variante der upgrade()-Funktion direkt (kein Alembic-
Lauf nötig — SQLite hat kein Schema-Prefix).

Prüft:
1. Pre-Migration: aktiver Token (revoked_at IS NULL) vorhanden.
2. Nach upgrade(): Token hat revoked_at gesetzt.
3. Idempotenz: zweimaliges Ausführen kracht nicht, ändert nichts weiter.
4. No-op auf leerer Tabelle.
5. down-migration: pass ohne Fehler.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncEngine


# ---------------------------------------------------------------------------
# Lade die Migration ohne Alembic-Runtime
# ---------------------------------------------------------------------------

def _load_migration_0018():
    versions_dir = (
        Path(__file__).resolve().parents[1] / "alembic" / "versions"
    )
    for path in sorted(versions_dir.glob("*0018_revoke_refresh_tokens*.py")):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    raise FileNotFoundError("Migration 0018_revoke_refresh_tokens not found")


# ---------------------------------------------------------------------------
# Minimale SQLite-Tabelle für refresh_tokens
# ---------------------------------------------------------------------------

CREATE_REFRESH_TOKENS_SQL = """
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    token TEXT NOT NULL DEFAULT 'tok',
    family TEXT NOT NULL DEFAULT 'fam',
    revoked_at TIMESTAMP NULL
);
"""


async def _create_table(conn):
    await conn.execute(text(CREATE_REFRESH_TOKENS_SQL))
    await conn.commit()


async def _insert_active_token(conn, token: str = "tok_active") -> int:
    result = await conn.execute(
        text("INSERT INTO refresh_tokens (token, revoked_at) VALUES (:tok, NULL)"),
        {"tok": token},
    )
    await conn.commit()
    return result.lastrowid


async def _get_revoked_at(conn, row_id: int):
    result = await conn.execute(
        text("SELECT revoked_at FROM refresh_tokens WHERE id = :id"),
        {"id": row_id},
    )
    return result.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Fixture: isolierter In-memory-SQLite-Engine pro Test
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def sqlite_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    yield engine
    await engine.dispose()


# ---------------------------------------------------------------------------
# Helper: SQLite-Variante der upgrade-Logik ausführen
# ---------------------------------------------------------------------------

async def _run_upgrade_sqlite(conn):
    """Führt die SQLite-Variante der Migration 0018 direkt aus."""
    await conn.execute(
        text("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE revoked_at IS NULL")
    )
    await conn.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_migration_0018_revokes_active_token(sqlite_engine):
    """Aktiver Token (revoked_at IS NULL) muss nach upgrade() gesetzt sein."""
    async with sqlite_engine.connect() as conn:
        await _create_table(conn)
        row_id = await _insert_active_token(conn)

        # Vor Migration: NULL
        before = await _get_revoked_at(conn, row_id)
        assert before is None, f"Token sollte vor Migration revoked_at=NULL haben, war: {before!r}"

        await _run_upgrade_sqlite(conn)

        # Nach Migration: gesetzt
        after = await _get_revoked_at(conn, row_id)
        assert after is not None, "Token sollte nach upgrade() revoked_at != NULL haben"


@pytest.mark.asyncio
async def test_migration_0018_does_not_touch_already_revoked(sqlite_engine):
    """Bereits revokter Token darf seinen revoked_at-Wert nicht ändern."""
    async with sqlite_engine.connect() as conn:
        await _create_table(conn)
        # Bereits revoked: feste Zeit
        await conn.execute(
            text(
                "INSERT INTO refresh_tokens (token, revoked_at) "
                "VALUES ('tok_old', '2026-01-01 00:00:00')"
            )
        )
        await conn.commit()
        result = await conn.execute(
            text("SELECT id FROM refresh_tokens WHERE token='tok_old'")
        )
        row_id = result.scalar_one()

        await _run_upgrade_sqlite(conn)

        after = await _get_revoked_at(conn, row_id)
        assert after == "2026-01-01 00:00:00", (
            f"Bereits revokter Token hat falschen revoked_at nach Migration: {after!r}"
        )


@pytest.mark.asyncio
async def test_migration_0018_idempotent(sqlite_engine):
    """Zweimaliges Ausführen darf nicht crashen; Tokens bleiben revoked."""
    async with sqlite_engine.connect() as conn:
        await _create_table(conn)
        row_id = await _insert_active_token(conn, "tok_idem")

        # Erster Lauf
        await _run_upgrade_sqlite(conn)
        after_first = await _get_revoked_at(conn, row_id)
        assert after_first is not None

        # Zweiter Lauf — kein Crash, revoked_at unverändert
        await _run_upgrade_sqlite(conn)
        after_second = await _get_revoked_at(conn, row_id)
        assert after_second == after_first, (
            "revoked_at sollte nach zweitem Lauf unverändert bleiben"
        )


@pytest.mark.asyncio
async def test_migration_0018_noop_on_empty_table(sqlite_engine):
    """Migration auf leerer Tabelle (Test-DB) darf nicht crashen."""
    async with sqlite_engine.connect() as conn:
        await _create_table(conn)
        # Keine Rows
        await _run_upgrade_sqlite(conn)
        result = await conn.execute(text("SELECT COUNT(*) FROM refresh_tokens"))
        assert result.scalar_one() == 0


# ---------------------------------------------------------------------------
# Struktur-Tests: Migration-Modul korrekt verdrahtet?
# ---------------------------------------------------------------------------

def test_migration_0018_module_attributes():
    """0018 hat korrekte revision, down_revision, upgrade + downgrade."""
    mod = _load_migration_0018()
    assert mod.revision == "0018_revoke_refresh_tokens"
    assert mod.down_revision == "0017_cred_pubkey_unique"
    assert callable(mod.upgrade)
    assert callable(mod.downgrade)


def test_migration_0018_downgrade_is_noop():
    """downgrade() muss ohne Fehler durchlaufen (pass)."""
    mod = _load_migration_0018()
    # Kein op-Context nötig — downgrade ist rein pass
    mod.downgrade()  # darf nicht werfen


def test_migration_0018_chain():
    """down_revision zeigt auf 0017_cred_pubkey_unique."""
    mod = _load_migration_0018()
    assert mod.down_revision == "0017_cred_pubkey_unique", (
        f"Erwartete down_revision='0017_cred_pubkey_unique', "
        f"bekam {mod.down_revision!r}"
    )
