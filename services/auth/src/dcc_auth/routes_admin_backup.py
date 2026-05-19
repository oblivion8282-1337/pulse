"""Admin-only route for the backup sidecar status indicator.

Split out from ``routes_admin.py`` to keep the file under the 350-line cap
and parallel the ``routes_admin_smtp`` naming convention.

The sole endpoint here is *read-only*: ``GET /admin/backup-status``. There
is no "trigger backup" or "restore" route — those operations stay
SSH-and-``docker compose exec``-gated by design. Restore is destructive,
trigger would need the backup container's docker socket (which auth-svc
emphatically does not have), and the passphrase lives in operator-side
``.env`` only. See ``infra/prod/backup/restore.md``.

The endpoint stats the marker file written by ``backup.sh::mark_ok`` to
``/repo/.pulse/last-backup-ok`` inside the backup container; the same
file is exposed read-only at ``/backup-state/.pulse/last-backup-ok``
inside this auth container (via the ``pulse_backups`` volume in
``docker-compose.yml``).
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends

from dcc_auth import config as _config
from dcc_auth.models import User
from dcc_auth.routes import _require_admin
from dcc_auth.schemas import BackupStatusOut

router = APIRouter(prefix="/admin")


@router.get("/backup-status", response_model=BackupStatusOut)
async def get_backup_status(
    _actor: Annotated[User, Depends(_require_admin)],
):
    # Module-level access (not ``from .config import get_settings``) so the
    # conftest's monkey-patched provider is picked up in tests — the test
    # rebinds ``dcc_auth.config.get_settings``, and a local symbol import
    # would freeze the original reference at import time.
    settings = _config.get_settings()
    path = settings.backup_marker_path
    threshold = settings.backup_stale_threshold_seconds

    # "Configured" probe = the volume mount-point exists. By convention the
    # marker lives at ``<volume-root>/.pulse/<marker>``, so the volume root
    # is the grandparent. Checking ``.pulse/`` instead would conflate
    # "volume mounted" with "backup.sh ran at least once" — a fresh deploy
    # where the operator wired the mount but the backup container hasn't
    # touched its marker yet would otherwise wrongly report not-configured.
    volume_root = path.parent.parent
    if not volume_root.exists():
        return BackupStatusOut(
            configured=False,
            last_backup_at=None,
            age_seconds=None,
            healthy=False,
            stale_threshold_seconds=threshold,
        )

    if not path.is_file():
        return BackupStatusOut(
            configured=True,
            last_backup_at=None,
            age_seconds=None,
            healthy=False,
            stale_threshold_seconds=threshold,
        )

    mtime = path.stat().st_mtime
    age_seconds = max(0, int(time.time() - mtime))
    last_at = datetime.fromtimestamp(mtime, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return BackupStatusOut(
        configured=True,
        last_backup_at=last_at,
        age_seconds=age_seconds,
        healthy=age_seconds < threshold,
        stale_threshold_seconds=threshold,
    )
