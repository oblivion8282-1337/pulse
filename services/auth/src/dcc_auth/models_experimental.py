"""SQLAlchemy-Model für Diagnose-Berichte zum HQ-Streaming.

Separate Datei wegen der Größen-Policy (≤500 Z.). Alembic-Discovery läuft via
``from dcc_auth import models`` → Re-Export dort (siehe models.py).

**Seit 2026-08-06 trägt die Tabelle zwei Arten von Meldung** (Migration 0047):

``log_text``
    Der alte Weg — bis zu 512 KiB Rohtext aus der ``sidecar.log``. Schlecht
    auswertbar (niemand liest 512 KiB je Vorfall) und nur von der SENDER-Seite.
``report``
    Der neue Weg — ein strukturierter Bericht von wenigen Kilobyte: Kopf,
    Bilanz, verdichtete Ereignisliste, Abschlussgrund. Vom Sender UND vom
    Zuschauer.

Beide Spalten sind nullable, und genau eine davon zu füllen ist der Normalfall.
Der Rohtext bleibt, weil er bei einem Absturz Dinge enthält, die kein
strukturierter Bericht vorhersehen kann (FFmpegs eigene Fehlerzeilen etwa) —
er ist das Auffangnetz, nicht mehr der Hauptweg.
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
    """Ein Diagnose-Bericht zu einer HQ-Stream-Sitzung.

    Wird nur gesendet, solange der Nutzer den Schalter im „Experimental"-Tab
    nicht abgewählt hat (seit 2026-08-06 standardmäßig an, siehe
    ``desktop/electron/experimental-log-upload.ts``). Anonym + rate-limited wie
    die Abuse-Reports. Enthält KEINE Stream-Tokens: der Sidecar redacted vor
    dem Loggen, der Client redacted nochmals.
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

    # Welche Seite der Leitung berichtet: "sender" | "viewer".
    #
    # Bis 2026-08-06 gab es die Frage gar nicht, weil ausschliesslich die
    # Senderseite meldete — und damit fehlte die halbe Diagnose. Wer nicht
    # weiss, ob "kein Bild" beim Encoder oder beim Zuschauer entstand, kann
    # den Vorfall nicht einordnen.
    #
    # Nullable, weil Bestandseintraege aus der Zeit davor keinen Wert haben.
    # Sie sind implizit "sender"; das nachtraeglich einzutragen waere eine
    # Behauptung ueber Daten, die wir nicht mehr pruefen koennen.
    role: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Der Kanal, dessen Stream berichtet wird. Eigene Spalte statt nur im JSON,
    # weil genau danach gesucht wird und eine JSON-Spalte dafür einen Full-Scan
    # bedeutete.
    #
    # Das ist der Schlüssel zur Serversicht: der Pfad im MediaMTX-Log heißt
    # `channel-<kanal>-<sender>-<nonce>` (`scripts/fec-tor-kennzahlen.py` gibt
    # ihn je Sitzung aus), die Kanalkennung ist also das gemeinsame Stück.
    # Zusammen mit `created_at` grenzt das die Sitzung ein.
    #
    # **Warum nicht die MediaMTX-Sitzungskennung**, die viel genauer wäre: der
    # Client kann sie nicht erfahren. Das Log-Präfix ist `hex(uuid[:4])`, der
    # `Location`-Header der WHEP-Antwort trägt `secret` — eine andere UUID.
    # Ausführlich in `web/src/lib/stream/diagnose-bericht.ts`.
    channel_id: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)

    # Der strukturierte Bericht (Kopf / Bilanz / Ereignisse / Abschluss).
    # Aufbau und Grenzen: `routes_experimental_logs.py::Bericht`.
    report: Mapped[dict | None] = mapped_column(_JsonbOrJson, nullable=True)

    # Der (bereits token-redacted) sidecar.log-Ausschnitt. Seit Migration 0047
    # nullable: ein Zuschauerbericht hat keine sidecar.log, er entsteht im
    # Browser.
    log_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Best-effort Client-IP (X-Forwarded-For) für Rate-/Missbrauchsanalyse.
    client_ip: Mapped[str | None] = mapped_column(Text, nullable=True)
