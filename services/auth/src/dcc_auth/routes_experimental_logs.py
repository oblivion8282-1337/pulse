"""Diagnose-Log-Upload der experimentellen Rust-Sidecar-Version.

POST /experimental-logs — öffentlich, rate-limited (30/Stunde pro IP).

Nur der Electron-Client der experimentellen Rust-Linux-Sidecar-Version ruft
das auf, und auch nur, wenn der User die Experimental-Checkbox aktiviert hat
(Opt-in). Speichert einen bereits token-redacted sidecar.log-Ausschnitt +
Systeminfo in Postgres zur Fehlerdiagnose. Vorlage: routes_complaints.py.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field

from dcc_auth.db import SessionDep
from dcc_auth.models_experimental import ExperimentalLog
from dcc_auth.routes import _check_rate
from dcc_auth.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()

# Obergrenze für den Log-Text (Postgres Text kann mehr, aber der Upload wird
# begrenzt, damit ein Client uns nicht zumüllt). Der Client schickt ohnehin
# nur den Schwanz der sidecar.log.
MAX_LOG_CHARS = 512 * 1024  # 512 KiB


class ExperimentalLogCreate(BaseModel):
    reason: Annotated[str, Field(max_length=32)] = "stream_end"
    sidecar_version: Annotated[str | None, Field(default=None, max_length=64)] = None
    system_info: dict[str, Any] | None = None
    log_text: Annotated[str, Field(min_length=1, max_length=MAX_LOG_CHARS)]


@router.post("/experimental-logs", status_code=status.HTTP_201_CREATED)
async def submit_experimental_log(
    payload: ExperimentalLogCreate,
    request: Request,
    session: SessionDep,
):
    """Nimmt einen Diagnose-Log-Upload entgegen. Rate-limited: 30/Stunde pro IP.
    Keine Auth nötig — nur die experimentelle Sidecar-Version sendet, opt-in."""
    await _check_rate(request, "experimental_log_submit", "30/hour")

    fwd = request.headers.get("x-forwarded-for", "")
    client_ip = fwd.split(",")[0].strip() or (
        request.client.host if request.client else None
    )

    entry = ExperimentalLog(
        id=next_id(),
        reason=payload.reason,
        sidecar_version=payload.sidecar_version,
        system_info=payload.system_info,
        log_text=payload.log_text,
        client_ip=client_ip,
    )
    session.add(entry)
    await session.commit()

    return {"id": str(entry.id), "status": "received"}
