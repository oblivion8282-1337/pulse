"""Schema-existence tests for migrations 0012–0015 (Cert-Modell-Fundament).

Strategy: the main conftest uses ``Base.metadata.create_all`` against an
in-memory SQLite DB (schema names stripped to ``None``).  Rather than running
Alembic programmatically — which would require SQLite schema-mapping workarounds
— these tests introspect the *SQLAlchemy metadata* and the created tables to
verify that all columns, indexes, and relationships are wired up correctly.

Down-migration correctness is verified by inspecting the declared migration
modules directly (checking that ``downgrade()`` would drop exactly what
``upgrade()`` creates), not by running Alembic — the manual test instructions
in the task spec cover the live Alembic up/down/up cycle against Postgres.
"""

from __future__ import annotations

import importlib
import inspect

import pytest
import pytest_asyncio
from sqlalchemy import inspect as sa_inspect, text


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _column_names(inspector, table: str) -> set[str]:
    return {col["name"] for col in inspector.get_columns(table)}


def _index_names(inspector, table: str) -> set[str]:
    return {idx["name"] for idx in inspector.get_indexes(table)}


# ---------------------------------------------------------------------------
# 0012 — pairwise_salt / revoke_until / is_suspended on auth.users
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_user_has_pairwise_salt_column(engine):
    """migration 0012: users.pairwise_salt column must exist."""
    async with engine.connect() as conn:
        result = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("users")
        )
    names = {col["name"] for col in result}
    assert "pairwise_salt" in names, "pairwise_salt column missing from users"


@pytest.mark.asyncio
async def test_user_has_revoke_until_column(engine):
    """migration 0012: users.revoke_until column must exist and be nullable."""
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("users")
        )
    col_map = {c["name"]: c for c in cols}
    assert "revoke_until" in col_map, "revoke_until column missing from users"
    assert col_map["revoke_until"]["nullable"], "revoke_until should be nullable"


@pytest.mark.asyncio
async def test_user_has_is_suspended_column(engine):
    """migration 0012: users.is_suspended must exist, not null, default false."""
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("users")
        )
    col_map = {c["name"]: c for c in cols}
    assert "is_suspended" in col_map, "is_suspended column missing from users"
    assert not col_map["is_suspended"]["nullable"], "is_suspended should NOT be nullable"


@pytest.mark.asyncio
async def test_new_user_gets_is_suspended_false_default(session_factory):
    """A freshly-registered user must have is_suspended=False by default."""
    from dcc_auth.models import User

    async with session_factory() as session:
        u = User(
            id=1,
            username="testuser",
            email="test@dcc-test.example.com",
            password_hash="x",
        )
        session.add(u)
        await session.commit()
        await session.refresh(u)

    assert u.is_suspended is False


# ---------------------------------------------------------------------------
# 0013 — user_sessions table
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_user_sessions_table_exists(engine):
    """migration 0013: user_sessions table must be created."""
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_table_names()
        )
    assert "user_sessions" in tables, "user_sessions table not found"


@pytest.mark.asyncio
async def test_user_sessions_columns(engine):
    """migration 0013: user_sessions must have all required columns."""
    expected = {
        "session_id", "user_id", "created_at", "last_seen_at",
        "expires_at", "amr", "acr", "user_agent", "ip",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("user_sessions")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"user_sessions missing columns: {missing}"


@pytest.mark.asyncio
async def test_user_sessions_indexes(engine):
    """migration 0013: user_sessions must have indexes on user_id and expires_at."""
    async with engine.connect() as conn:
        idxs = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_indexes("user_sessions")
        )
    idx_names = {i["name"] for i in idxs}
    assert "ix_user_sessions_user_id" in idx_names, "missing ix_user_sessions_user_id"
    assert "ix_user_sessions_expires_at" in idx_names, "missing ix_user_sessions_expires_at"


# ---------------------------------------------------------------------------
# 0014 — issued_credentials table
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_user_cloud_backup_tables_dropped(engine):
    """drop-Migration: encrypted_key_backups + account_keys müssen weg sein."""
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_table_names()
        )
    assert "encrypted_key_backups" not in tables, (
        "encrypted_key_backups should be dropped after 9999_drop_user_cloud_backup"
    )
    assert "account_keys" not in tables, (
        "account_keys should be dropped after 9999_drop_user_cloud_backup"
    )


# ---------------------------------------------------------------------------
# Relationship round-trip
# ---------------------------------------------------------------------------

def _load_migration(revision: str):
    """Import a migration module by its revision ID prefix."""
    import importlib.util
    from pathlib import Path

    versions_dir = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    for path in versions_dir.glob("*.py"):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        if getattr(mod, "revision", "").startswith(revision):
            return mod
    raise FileNotFoundError(f"No migration found for revision prefix {revision!r}")


def test_migration_0012_has_downgrade():
    """0012 downgrade() must drop the three added columns."""
    mod = _load_migration("0012")
    src = inspect.getsource(mod.downgrade)
    assert "pairwise_salt" in src
    assert "revoke_until" in src
    assert "is_suspended" in src


def test_migration_0013_has_downgrade():
    """0013 downgrade() must drop user_sessions table + its indexes."""
    mod = _load_migration("0013")
    src = inspect.getsource(mod.downgrade)
    assert "user_sessions" in src
    assert "ix_user_sessions_user_id" in src
    assert "ix_user_sessions_expires_at" in src


def test_migration_0014_has_downgrade():
    """0014 downgrade() must drop issued_credentials table + its indexes."""
    mod = _load_migration("0014")
    src = inspect.getsource(mod.downgrade)
    assert "issued_credentials" in src
    assert "ix_issued_credentials_expires_at" in src


def test_migration_0015_has_downgrade():
    """0015 downgrade() must drop encrypted_key_backups table."""
    mod = _load_migration("0015")
    src = inspect.getsource(mod.downgrade)
    assert "encrypted_key_backups" in src


def test_migration_chain_is_sequential():
    """Revisions 0012–0015 must form a clean chain: each down_revision points to the prior."""
    chain = [
        ("0012", "0011_users_discoverable"),
        ("0013", "0012_user_pairwise_salt"),
        ("0014", "0013_user_sessions"),
        ("0015", "0014_issued_credentials"),
    ]
    for rev, expected_down in chain:
        mod = _load_migration(rev)
        assert mod.down_revision == expected_down, (
            f"{rev}: expected down_revision={expected_down!r}, "
            f"got {mod.down_revision!r}"
        )


# ---------------------------------------------------------------------------
# 0020 — instance_registry (4 tables)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_registered_instances_columns(engine):
    """migration 0020: registered_instances must have all required columns."""
    expected = {
        "id", "hostname", "client_id", "client_secret", "redirect_uris",
        "worker_id_chat", "worker_id_voice", "worker_id_media",
        "status", "registered_by", "registered_at",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("registered_instances")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"registered_instances missing columns: {missing}"


@pytest.mark.asyncio
async def test_instance_applications_columns(engine):
    """migration 0020: instance_applications must have all required columns."""
    expected = {
        "id", "applicant_user_id", "hostname", "purpose", "expected_users",
        "contact_email", "notes", "status", "reviewed_by", "reviewed_at",
        "rejection_reason", "approved_instance_id", "created_at",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("instance_applications")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"instance_applications missing columns: {missing}"


@pytest.mark.asyncio
async def test_suspended_instances_columns(engine):
    """migration 0020: suspended_instances must have all required columns."""
    expected = {"instance_id", "suspended_at", "reason"}
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("suspended_instances")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"suspended_instances missing columns: {missing}"


@pytest.mark.asyncio
async def test_complaints_columns(engine):
    """migration 0020: complaints must have all required columns."""
    expected = {
        "id", "target_instance_id", "target_user_id", "body", "submitter_email",
        "submitted_at", "status", "resolution_note", "resolved_at",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("complaints")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"complaints missing columns: {missing}"


def test_migration_0020_has_downgrade():
    """0020 downgrade() must drop all 4 instance-registry tables."""
    mod = _load_migration("0020")
    src = inspect.getsource(mod.downgrade)
    assert "registered_instances" in src
    assert "instance_applications" in src
    assert "suspended_instances" in src
    assert "complaints" in src


# Die Tests fuer ``issued_credentials`` und ``revoked_credentials`` standen hier
# bis zum 2026-08-28. Beide Tabellen sind mit dem Geraetezertifikat entfallen
# (Migration 0051); ein Test, der ihr Vorhandensein einfordert, waere jetzt eine
# Behauptung gegen den eigenen Stand.
