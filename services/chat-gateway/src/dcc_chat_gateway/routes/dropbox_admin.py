"""Dropbox admin endpoints + trash-retention sweep.

Admin-only: PATCH /settings on a guild's dropbox. Members don't see it;
the route uses MANAGE_GUILD. Companion module ``routes/dropbox.py``
re-exports ``admin_router`` so callers have a single import.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Annotated

import structlog
from fastapi import APIRouter, HTTPException, Path, Request, status
from sqlalchemy import select

from dcc_chat_gateway import s3
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep, SessionLocal
from dcc_chat_gateway.models import DropboxConfig, DropboxFile
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._dropbox_helpers import (
    normalize_parent_path,
    publish_purge_event,
    publish_quota_event,
)
from dcc_chat_gateway.routes._dropbox_schemas import (
    DropboxConfigOut,
    DropboxConfigPatch,
)
from dcc_chat_gateway.security import CurrentUser

log = structlog.get_logger(__name__)

admin_router = APIRouter(tags=["dropbox-admin"])


@admin_router.patch(
    "/guilds/{guild_id}/dropbox/settings",
    response_model=DropboxConfigOut,
)
async def patch_settings(
    guild_id: Annotated[int, Path(ge=1)],
    payload: DropboxConfigPatch,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxConfigOut:
    """Admin-only settings update.

    Coherence check:
      - if ``total_quota_bytes`` shrinks below ``used_bytes`` we refuse
        rather than silently rejecting every future upload — a quota
        shrink should be a deliberate, visible action (raise it back up
        first, free space, then lower)."""

    await check_permission(
        session, current, guild_id, Permissions.MANAGE_GUILD
    )

    cfg = await session.get(DropboxConfig, guild_id)
    if cfg is None:
        cfg = DropboxConfig(guild_id=guild_id)
        session.add(cfg)
        await session.flush()

    if payload.enabled is not None:
        cfg.enabled = bool(payload.enabled)
    if payload.per_file_max_bytes is not None:
        cfg.per_file_max_bytes = int(payload.per_file_max_bytes)
    if payload.trash_retention_days is not None:
        cfg.trash_retention_days = int(payload.trash_retention_days)
    if payload.total_quota_bytes is not None:
        if int(payload.total_quota_bytes) < cfg.used_bytes:
            raise HTTPException(
                409,
                detail=(
                    f"new total_quota_bytes ({payload.total_quota_bytes}) "
                    f"is smaller than current used_bytes ({cfg.used_bytes}); "
                    "free space first or raise the cap back up"
                ),
            )
        cfg.total_quota_bytes = int(payload.total_quota_bytes)

    await session.commit()
    await session.refresh(cfg)

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await publish_quota_event(mgr, cfg)

    return DropboxConfigOut.model_validate(cfg)


# ---------------------------------------------------------------------------
# Trash retention sweep
# ---------------------------------------------------------------------------
#
# A background task that runs once every hour (interval-adjustable via the
# Pulse admin endpoint, not exposed in this cut) and:
#   1. finds every dropbox_file row whose ``deleted_at`` is older than
#      the guild's ``trash_retention_days``
#   2. deletes the MinIO object (best-effort — a failed purge leaves an
#      orphan that the next sweep picks up; budget keeps things bounded)
#   3. hard-deletes the row
#   4. fires ``dropbox_entry_purged`` so connected clients can drop the
#      entry from their trash UI without a re-fetch
#
# Wired into the FastAPI lifespan in app.py — see the lifespan hook.

_SWEEP_INTERVAL_SECONDS = 60 * 60  # hourly


def schedule_sweep(
    loop_task: asyncio.AbstractEventLoop, connection_manager
) -> asyncio.Task:
    """Spawn the background sweep task; returns the Task handle so the
    FastAPI lifespan can cancel it on shutdown.

    ``connection_manager`` is forwarded into the sweep so we can publish
    ``dropbox_entry_purged`` after the DB commit. None is a no-op for
    the publish path (matches the in-band routes' ``getattr(...,
    None)`` pattern)."""

    return loop_task.create_task(_sweep_loop(connection_manager))


async def _sweep_loop(connection_manager) -> None:
    """Periodically call ``_sweep_once``. Sleeps via ``asyncio.sleep`` so
    the loop stays responsive; logs but swallows exceptions so a transient
    DB or S3 outage doesn't kill the task permanently."""

    while True:
        try:
            await _sweep_once(connection_manager)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — keep running
            log.warning(
                "dropbox_sweep_iteration_failed",
                error=str(exc),
                error_type=type(exc).__name__,
            )
        await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)


async def _sweep_once(connection_manager) -> None:
    """One pass of the trash-retention sweep.

    For each row whose ``deleted_at`` is older than the guild's
    retention window, hard-delete the MinIO object and the DB row, then
    fire ``dropbox_entry_purged`` so connected clients drop the entry
    from their trash view without a re-fetch (the same pattern the
    in-band mutation routes use)."""

    # Lazy import — these touch the app lifespan state; avoid at module
    # import time so tests that don't bootstrap the full app still load
    # the module.
    from dcc_chat_gateway.routes._dropbox_helpers import utc_now

    now = utc_now()
    purged: list[tuple[int, int, int]] = []  # (guild_id, entry_id, kind)
    async with SessionLocal() as session:
        # All configs in one go — we need each row's
        # trash_retention_days. Inner loop reads + sweeps serially; per-
        # guild parallel sweeps would buy nothing because we're bounded
        # by MinIO delete latency.
        cfg_rows = (
            await session.execute(select(DropboxConfig))
        ).scalars().all()

        for cfg in cfg_rows:
            cutoff = now - timedelta(days=int(cfg.trash_retention_days))
            stmt = select(DropboxFile).where(
                DropboxFile.guild_id == cfg.guild_id,
                DropboxFile.deleted_at.is_not(None),
                DropboxFile.deleted_at < cutoff,
            ).limit(500)
            stale = list((await session.execute(stmt)).scalars())
            if not stale:
                continue
            for entry in stale:
                if entry.storage_key:
                    try:
                        await s3.delete_object(entry.storage_key)
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "dropbox_sweep_minio_delete_failed",
                            guild_id=entry.guild_id,
                            entry_id=entry.id,
                            storage_key=entry.storage_key,
                            error=str(exc),
                        )
                        # Leave the row in place — the next pass will
                        # retry the MinIO delete. Bytes may be
                        # temporarily orphaned; bandwidth-safe.
                        continue
                purged.append((entry.guild_id, entry.id, entry.kind))
                await session.delete(entry)
            await session.flush()
        await session.commit()

    if not purged:
        return

    # Publish after commit so listeners only see rows that actually
    # vanished (otherwise a rollback would leak a ghost to the FE).
    if connection_manager is not None:
        for guild_id, entry_id, kind in purged:
            await publish_purge_event(
                connection_manager,
                guild_id=guild_id,
                entry_id=entry_id,
                kind=kind,
            )

    log.info(
        "dropbox_sweep_completed",
        purged_entries=len(purged),
    )


__all__ = ["admin_router", "schedule_sweep", "purge_guild_dropbox_objects"]


async def purge_guild_dropbox_objects(guild_id: int) -> int:
    """Hard-delete every MinIO object under ``dropbox/<guild_id>/``.

    Called from ``routes.guilds.delete_guild`` after the DB cascade
    wipes the dropbox rows. ``ondelete="CASCADE"`` on dropbox_configs
    / dropbox_files cleans the SQL side, but MinIO has no equivalent —
    without this hook the bucket accumulates bytes for every
    deleted guild. Best-effort: a transient MinIO failure here
    leaves orphans; a future sweep iteration cannot recover them
    (the DB rows are gone, so the row-driven sweep has nothing to
    match against) — they sit until a manual admin reaper runs."""

    s = get_settings()
    prefix = f"dropbox/{guild_id}/"
    purged = 0
    try:
        client = await s3._ensure_internal_client()
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=s.s3_bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj.get("Key")
                if not key:
                    continue
                try:
                    await s3.delete_object(key)
                    purged += 1
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "dropbox_guild_purge_minio_delete_failed",
                        guild_id=guild_id,
                        storage_key=key,
                        error=str(exc),
                    )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "dropbox_guild_purge_list_failed",
            guild_id=guild_id,
            error=str(exc),
        )
    log.info(
        "dropbox_guild_purge_completed",
        guild_id=guild_id,
        purged_objects=purged,
    )
    return purged
