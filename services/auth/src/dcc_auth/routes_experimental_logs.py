"""Diagnose-Log-Upload der Desktop-App.

POST /experimental-logs — öffentlich, rate-limited (30/Stunde pro IP).

Die Desktop-App ruft das bei Stream-Ende und Stream-Fehler auf, und nur, wenn
der Nutzer die Diagnose-Checkbox aktiviert hat (Opt-in, Vorgabe aus; Tab
„Diagnose"). Speichert einen bereits token-redacted `sidecar.log`-Ausschnitt +
Systeminfo in Postgres zur Fehlerdiagnose. Vorlage: routes_complaints.py.

**Hier stand bis 2026-08-06 „der experimentellen Rust-Sidecar-Version".** Das
war zweifach überholt: der Rust-Sidecar ist auf Linux längst der Standard, und
seit derselben Änderung sendet auch Windows/macOS — vorher war der Tab mit der
Einwilligung auf Linux beschränkt, sodass von dort NIE ein Bericht ankam.

Der Endpoint-Name bleibt `/experimental-logs`: Bestandsclients rufen ihn so
auf, und ein Umbenennen träfe genau die Nutzer, deren Berichte wir wollen.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

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

# Aufbewahrungsfrist. Bis 2026-08-06 gab es KEINE — die Tabelle wuchs
# unbegrenzt, bei 512 KiB je Eintrag. Diagnose-Logs sind nur solange etwas
# wert, wie jemand dem Vorfall noch nachgeht; was vier Wochen alt ist, hat
# niemand mehr angesehen.
RETENTION_DAYS = 28

# Zweite, harte Grenze: selbst innerhalb der Frist nie mehr als so viele
# Einträge behalten. Fängt den Fall ab, den die Frist allein nicht abfängt —
# viele Clients in kurzer Zeit (das IP-Rate-Limit greift je IP, nicht global).
MAX_ROWS = 5_000


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
    await session.flush()
    await _aufraeumen(session)
    await session.commit()

    return {"id": str(entry.id), "status": "received"}


async def _aufraeumen(session: SessionDep) -> None:
    """Alte Berichte wegräumen — beim Schreiben, nicht per Zeitgeber.

    **Warum am Schreibpfad und nicht als Hintergrundaufgabe:** die Tabelle
    wächst NUR hier. Ein eigener Poller (wie `crl_poller` & Co.) wäre ein
    zweiter Ort, der leise ausfallen kann — und genau so ein leiser Ausfall
    ist der Grund, warum es diese Funktion überhaupt braucht: die
    Aufbewahrung war bis 2026-08-06 schlicht nirgends umgesetzt. Was am
    Schreibpfad hängt, kann nicht vergessen werden.

    Zwei Grenzen, weil eine allein nicht reicht: die Frist räumt Altes weg,
    die Zeilenzahl fängt einen Ansturm ab, der innerhalb der Frist bleibt.

    Fehler hier dürfen den Upload NICHT scheitern lassen — ein voller
    Papierkorb ist kein Grund, den Bericht zu verwerfen, den wir gerade
    wollten. Deshalb laufen die beiden Deletes in einem eigenen SAVEPOINT
    (wie in `instance_provisioning.py::provision_app_host_instance`): auf
    Postgres vergiftet ein fehlgeschlagenes Statement sonst die GANZE
    Transaktion („current transaction is aborted") — der `except` würde den
    Fehler zwar loggen, aber das `session.commit()` im Aufrufer risse dann
    den bereits geflushten, eigentlich unbeteiligten Log-Eintrag mit in den
    Fehlschlag. Das SAVEPOINT rollt bei Fehlern nur das Aufräumen zurück,
    nicht den Upload.
    """
    grenze = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    # `synchronize_session=False`: ohne das versucht das ORM, die Bedingung
    # zusaetzlich im Python gegen die geladenen Objekte auszuwerten — und
    # bricht dabei ab, weil `created_at` aus SQLite ohne Zeitzone kommt, die
    # Grenze hier aber mit ("can't compare offset-naive and offset-aware
    # datetimes"). Fuer ein Aufraeumen ist der Abgleich ohnehin unnoetig: wir
    # arbeiten mit keinem der geloeschten Objekte weiter.
    ohne_abgleich = {"synchronize_session": False}
    try:
        async with session.begin_nested():  # SAVEPOINT
            await session.execute(
                delete(ExperimentalLog).where(ExperimentalLog.created_at < grenze),
                execution_options=ohne_abgleich,
            )
            # Alles ausserhalb der jüngsten MAX_ROWS Einträge. Unterabfrage statt
            # OFFSET-Löschung, weil SQLite kein `DELETE ... LIMIT` kennt und die
            # Tests darauf laufen.
            #
            # Sortiert wird nach der ID, NICHT nach `created_at`: die Snowflake
            # trägt die Zeit in sich und ist dabei eindeutig. `created_at` kommt
            # aus `func.now()` und ist für mehrere Einträge derselben Transaktion
            # bzw. Sekunde identisch — die Reihenfolge wäre dann beliebig, und
            # "die jüngsten N behalten" träfe irgendwelche N. Genau das hat der
            # Test beim ersten Lauf aufgedeckt.
            behalten = select(ExperimentalLog.id).order_by(
                ExperimentalLog.id.desc()
            ).limit(MAX_ROWS)
            await session.execute(
                delete(ExperimentalLog).where(
                    ExperimentalLog.id.not_in(behalten.scalar_subquery())
                ),
                execution_options=ohne_abgleich,
            )
    except Exception:
        log.warning("experimental_log_cleanup_failed", exc_info=True)
