"""Self-Host-Backup-Status (F11b).

Listet die pg_dump-Snapshots, die der allinone-``backup``-s6-Service nach
``$PULSE_DATA_PATH/backups`` schreibt (siehe
``infra/self-host/s6/etc/s6-overlay/s6-rc.d/backup``). Nur auf einer Self-Host-
Instanz sinnvoll; auf der Cloud läuft chat-gateway in einem separaten Container
ohne dieses Volume → ``enabled=false`` (das Frontend zeigt den Bereich ohnehin
nur auf Self-Host, ``isCloud=false``).

Read-only. Gated via ``AdminUser`` — der EdDSA-Session-Token-``admin``-Claim
(Cert-Login-Owner) reicht, kein auth-svc-Token nötig.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from dcc_chat_gateway.security import AdminUser

router = APIRouter(prefix="/admin/self-host")


class BackupEntry(BaseModel):
    filename: str
    size_bytes: int
    created_at: datetime


class BackupStatusOut(BaseModel):
    # enabled=False → kein Backup-Verzeichnis (Cloud oder PULSE_BACKUP_DISABLED).
    enabled: bool
    directory: str
    backups: list[BackupEntry]
    last_backup_at: datetime | None
    total_bytes: int


def _backup_dir() -> Path:
    return Path(os.environ.get("PULSE_DATA_PATH", "/data")) / "backups"


@router.get("/backups", response_model=BackupStatusOut)
async def list_backups(_actor: AdminUser) -> BackupStatusOut:
    directory = _backup_dir()
    if not directory.is_dir():
        return BackupStatusOut(
            enabled=False, directory=str(directory), backups=[], last_backup_at=None, total_bytes=0
        )

    entries: list[BackupEntry] = []
    total = 0
    # Neueste zuerst (Dateiname trägt UTC-Zeitstempel, lexikografisch sortierbar).
    for path in sorted(directory.glob("pulse-*.dump"), reverse=True):
        try:
            st = path.stat()
        except OSError:
            continue
        total += st.st_size
        entries.append(
            BackupEntry(
                filename=path.name,
                size_bytes=st.st_size,
                created_at=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
            )
        )

    return BackupStatusOut(
        enabled=True,
        directory=str(directory),
        backups=entries,
        last_backup_at=entries[0].created_at if entries else None,
        total_bytes=total,
    )
