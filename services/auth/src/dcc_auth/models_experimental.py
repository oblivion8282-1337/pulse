"""SQLAlchemy-Model für Diagnose-Log-Uploads der experimentellen Rust-Sidecar-
Version.

Separate Datei wegen der Größen-Policy (≤500 Z.). Alembic-Discovery läuft via
``from dcc_auth import models`` → Re-Export dort (siehe models.py).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from dcc_auth.db import Base, snowflake_pk

# JSONB auf Postgres, plain JSON auf SQLite (Tests).
_JsonbOrJson = JSONB().with_variant(JSON(), "sqlite")


class ExperimentalLog(Base):
    """Ein Diagnose-Log-Upload vom experimentellen Rust-Linux-HQ-Sidecar.

    Wird NUR gesendet, wenn der User die experimentelle Sidecar-Version
    aktiviert hat (expliziter Opt-in über die Experimental-Tab-Checkbox).
    Anonym + rate-limited wie die Abuse-Reports. Enthält KEINE Stream-Tokens:
    der Sidecar redacted vor dem Loggen, der Client redacted nochmals.
    """

    __tablename__ = "experimental_logs"

    id: Mapped[int] = snowflake_pk()
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Warum der Upload ausgelöst wurde: "stream_end" | "error".
    reason: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="stream_end"
    )
    sidecar_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    # os / GPU-Vendor / Treiber / Distro / PipeWire — vom Client gesammelt.
    system_info: Mapped[dict | None] = mapped_column(_JsonbOrJson, nullable=True)
    # Der (bereits token-redacted) sidecar.log-Ausschnitt.
    log_text: Mapped[str] = mapped_column(Text, nullable=False)
    # Best-effort Client-IP (X-Forwarded-For) für Rate-/Missbrauchsanalyse.
    client_ip: Mapped[str | None] = mapped_column(Text, nullable=True)
