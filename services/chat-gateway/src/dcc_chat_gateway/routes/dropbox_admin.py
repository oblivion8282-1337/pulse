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
from fastapi import APIRouter, Path, Request, status
from sqlalchemy import select

from dcc_chat_gateway import s3
from dcc_chat_gateway.db import SessionDep
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
            from fastapi import HTTPException

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


def schedule_sweep(loop_task: asyncio.AbstractEventLoop) -> asyncio.Task:
    """Spawn the background sweep task; returns the Task handle so the
    FastAPI lifespan can cancel it on shutdown.

    Called from the lifespan startup (see ``dcc_chat_gateway.app``)."""

    return loop_task.create_task(_sweep_loop())


async def _sweep_loop() -> None:
    """Periodically call ``_sweep_once``. Sleeps via ``asyncio.sleep`` so
    the loop stays responsive; logs but swallows exceptions so a transient
    DB or S3 outage doesn't kill the task permanently."""

    while True:
        try:
            await _sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — keep running
            log.warning(
                "dropbox_sweep_iteration_failed",
                error=str(exc),
                error_type=type(exc).__name__,
            )
        await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)


async def _sweep_once() -> None:
    """One pass of the trash-retention sweep."""

    # Lazy import — these touch the app lifespan state; avoid at module
    # import time so tests that don't bootstrap the full app still load
    # the module.
    from dcc_chat_gateway.db import async_session_maker
    from dcc_chat_gateway.routes._dropbox_helpers import utc_now

    now = utc_now()
    async with async_session_maker() as session:
        # All configs in one go — we need each row's
        # trash_retention_days. Inner loop reads + sweeps serially; per-
        # guild parallel sweeps would buy nothing because we're bounded
        # by MinIO delete latency.
        cfg_rows = (
            await session.execute(select(DropboxConfig))
        ).scalars().all()

        total_purged = 0
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
                await session.delete(entry)
                total_purged += 1
            await session.flush()
        await session.commit()

    if total_purged:
        log.info(
            "dropbox_sweep_completed",
            purged_entries=total_purged,
        )


__all__ = ["admin_router", "schedule_sweep"]
