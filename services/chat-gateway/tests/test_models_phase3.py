"""Tests for Phase 3.1 models: CachedUserProfile, Report, ModAuditLog.

Strategy (mirrors services/auth/tests/test_migrations.py):
- SQLAlchemy metadata introspection for table/column existence.
- ORM INSERT round-trips to verify default values and nullability.
- Migration-module downgrade completeness check (source inspection).

The conftest creates all tables via ``Base.metadata.create_all`` — no
Alembic required in unit tests.  The live Alembic up/down/up cycle is
run manually against Postgres per the task spec.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import inspect as sa_inspect


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_migration(revision_prefix: str):
    versions_dir = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    for path in versions_dir.glob("*.py"):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if getattr(mod, "revision", "").startswith(revision_prefix):
            return mod
    raise FileNotFoundError(f"No migration for prefix {revision_prefix!r}")


# ---------------------------------------------------------------------------
# Table-existence tests (SQLAlchemy metadata introspection)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cached_user_profiles_table_exists(engine):
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_table_names()
        )
    assert "cached_user_profiles" in tables, "cached_user_profiles table not found"


@pytest.mark.asyncio
async def test_cached_user_profiles_columns(engine):
    expected = {
        "user_identifier", "username", "display_name", "avatar_hash",
        "profile_color", "last_statement_iat", "updated_at", "stale",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("cached_user_profiles")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"cached_user_profiles missing columns: {missing}"


@pytest.mark.asyncio
async def test_reports_table_exists(engine):
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_table_names()
        )
    assert "reports" in tables, "reports table not found"


@pytest.mark.asyncio
async def test_reports_columns(engine):
    expected = {
        "id", "reporter_user_id", "target_message_id", "target_user_id",
        "target_channel_id", "reason_code", "body", "created_at", "status",
        "resolver_user_id", "resolved_at", "resolution_note",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("reports")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"reports missing columns: {missing}"


@pytest.mark.asyncio
async def test_mod_audit_log_table_exists(engine):
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_table_names()
        )
    assert "mod_audit_log" in tables, "mod_audit_log table not found"


@pytest.mark.asyncio
async def test_mod_audit_log_columns(engine):
    expected = {
        "id", "guild_id", "actor_user_id", "action_type",
        "target_kind", "target_id", "payload", "created_at",
    }
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: sa_inspect(sync_conn).get_columns("mod_audit_log")
        )
    names = {c["name"] for c in cols}
    missing = expected - names
    assert not missing, f"mod_audit_log missing columns: {missing}"


# ---------------------------------------------------------------------------
# ORM INSERT round-trips (default values + nullability)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cached_user_profile_insert(session_factory):
    from dcc_chat_gateway.models.moderation import CachedUserProfile

    now = datetime.now(tz=timezone.utc)
    async with session_factory() as session:
        profile = CachedUserProfile(
            user_identifier="user-abc-123",
            username="testuser",
            display_name="Test User",
            last_statement_iat=now,
        )
        session.add(profile)
        await session.commit()
        await session.refresh(profile)

    assert profile.user_identifier == "user-abc-123"
    assert profile.stale is False
    assert profile.avatar_hash is None
    assert profile.profile_color is None
    assert profile.updated_at is not None


@pytest.mark.asyncio
async def test_report_insert_defaults(session_factory):
    from dcc_chat_gateway.models.moderation import Report

    async with session_factory() as session:
        report = Report(
            id=10_000_000_001,
            reporter_user_id=42,
            reason_code="spam",
            body="This is spam",
        )
        session.add(report)
        await session.commit()
        await session.refresh(report)

    assert report.status == "new"
    assert report.created_at is not None
    assert report.resolver_user_id is None
    assert report.resolved_at is None
    assert report.resolution_note is None
    assert report.target_message_id is None


@pytest.mark.asyncio
async def test_mod_audit_log_insert(session_factory):
    from dcc_chat_gateway.models.moderation import ModAuditLog

    async with session_factory() as session:
        entry = ModAuditLog(
            id=20_000_000_001,
            guild_id=9_001,
            actor_user_id=42,
            action_type="ban",
            target_kind="user",
            target_id=99,
            payload={"reason": "rule violation"},
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)

    assert entry.action_type == "ban"
    assert entry.created_at is not None
    assert entry.payload == {"reason": "rule violation"}


@pytest.mark.asyncio
async def test_mod_audit_log_nullable_fields(session_factory):
    """target_kind, target_id, and payload are all nullable."""
    from dcc_chat_gateway.models.moderation import ModAuditLog

    async with session_factory() as session:
        entry = ModAuditLog(
            id=20_000_000_002,
            guild_id=9_001,
            actor_user_id=42,
            action_type="permission_change",
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)

    assert entry.target_kind is None
    assert entry.target_id is None
    assert entry.payload is None


# ---------------------------------------------------------------------------
# Migration module structure check
# ---------------------------------------------------------------------------

def test_migration_0022_has_downgrade():
    """0022 downgrade() must drop all 3 Phase 3.1 tables."""
    import inspect
    mod = _load_migration("0022")
    src = inspect.getsource(mod.downgrade)
    assert "cached_user_profiles" in src
    assert "reports" in src
    assert "mod_audit_log" in src


def test_migration_0022_chain():
    """0022 must point down to 0021_guild_plugin_state."""
    mod = _load_migration("0022")
    assert mod.down_revision == "0021_guild_plugin_state", (
        f"Expected down_revision='0021_guild_plugin_state', got {mod.down_revision!r}"
    )
