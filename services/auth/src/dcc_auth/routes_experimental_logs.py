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

from fastapi import APIRouter, HTTPException, Request, status
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


# Obergrenze für die Ereignisliste EINES Berichts. Der Client verdichtet und
# deckelt bereits (`web/src/lib/stream/diagnose-bericht.ts`); diese Zahl ist
# die zweite Verteidigungslinie, denn der Endpoint ist offen und darf sich
# nicht darauf verlassen, dass der Absender unser Client ist.
#
# Sie liegt bewusst ETWAS über dem Client-Deckel: läge sie gleichauf, würde ein
# Bericht, der genau am Deckel liegt, an einem Rundungsunterschied scheitern —
# und ein 422 verwirft den ganzen Bericht, nicht nur das überzählige Ereignis.
MAX_EVENTS = 250


class Ereignis(BaseModel):
    """Ein verdichteter Vorfall innerhalb einer Sitzung.

    „Verdichtet" heißt: gleichartige Vorfälle innerhalb eines Zeitfensters sind
    im Client bereits zu EINEM Eintrag mit `anzahl` zusammengefasst. Ohne das
    schriebe eine einzige schlechte Minute mehrere hundert Zeilen, die alle
    dasselbe sagen.
    """

    model_config = {"extra": "ignore"}

    # Sekunden seit Sitzungsbeginn. Relativ, nicht absolut — eine Uhrzeit vom
    # Client wäre ohne Zeitzone und Uhrenstand wertlos, und die Sitzungsdauer
    # ist genau die Bezugsgröße, in der man einen Vorfall einordnet.
    s: float
    art: Annotated[str, Field(max_length=48)]
    anzahl: Annotated[int, Field(ge=1)] = 1
    # Freie Zahlen zum Vorfall (z.B. `{"dauer_ms": 480}`). Bewusst offen: was
    # zu einem Einfrieren gehört, ist etwas anderes als das, was zu einem
    # Verbindungswechsel gehört.
    werte: dict[str, Any] | None = None


class Bericht(BaseModel):
    """Der strukturierte Sitzungsbericht — der Ersatz für 512 KiB Rohtext.

    **`extra="ignore"` ist hier die wichtigste Zeile.** Der Endpoint bedient
    Bestandsclients, die sich nur über den Auto-Updater erneuern; ein neuerer
    Client, der ein Feld mehr schickt, darf nicht mit 422 abgewiesen werden,
    und ein älterer, der eines weglässt, ebensowenig. Deshalb ist alles
    optional und Unbekanntes fliegt still raus, statt den ganzen Bericht zu
    verwerfen. Der Preis: ein Tippfehler im Feldnamen fällt nicht auf — dafür
    gibt es die Tests.
    """

    model_config = {"extra": "ignore"}

    # Kopf: unter welchen Umständen die Sitzung lief.
    kopf: dict[str, Any] | None = None
    # Bilanz: die Summen über die ganze Sitzung.
    bilanz: dict[str, Any] | None = None
    ereignisse: Annotated[list[Ereignis], Field(default_factory=list, max_length=MAX_EVENTS)]
    # Wieviele Ereignisse der Client wegen seines eigenen Deckels NICHT
    # geschickt hat.
    #
    # **Das muss im Bericht stehen und darf nicht stillschweigend passieren.**
    # Eine gekappte Liste liest sich später wie „danach war nichts mehr" —
    # also wie eine beruhigte Verbindung, obwohl das Gegenteil der Fall war.
    # Genau in dem Moment, in dem am meisten schiefging, wäre die Diagnose am
    # irreführendsten.
    ereignisse_verworfen: Annotated[int, Field(ge=0)] = 0
    # Abschluss: warum die Sitzung endete.
    abschluss: dict[str, Any] | None = None


class ExperimentalLogCreate(BaseModel):
    reason: Annotated[str, Field(max_length=32)] = "stream_end"
    sidecar_version: Annotated[str | None, Field(default=None, max_length=64)] = None
    system_info: dict[str, Any] | None = None
    role: Annotated[str | None, Field(default=None, max_length=16)] = None
    channel_id: Annotated[str | None, Field(default=None, max_length=64)] = None
    report: Bericht | None = None
    # Seit 2026-08-06 optional: ein Zuschauerbericht entsteht im Browser und
    # hat keine `sidecar.log`. Dass wenigstens EINES von beidem da sein muss,
    # prüft der Handler `submit_experimental_log` weiter unten — hier ginge es
    # nicht, weil ein Feld-Validator immer nur sein eigenes Feld sieht und die
    # Bedingung über beide Felder zusammen läuft.
    log_text: Annotated[str | None, Field(default=None, min_length=1, max_length=MAX_LOG_CHARS)] = (
        None
    )


@router.post("/experimental-logs", status_code=status.HTTP_201_CREATED)
async def submit_experimental_log(
    payload: ExperimentalLogCreate,
    request: Request,
    session: SessionDep,
):
    """Nimmt einen Diagnose-Bericht entgegen. Rate-limited: 30/Stunde pro IP.
    Keine Auth nötig — es sendet nur, wer den Schalter nicht abgewählt hat."""
    await _check_rate(request, "experimental_log_submit", "30/hour")

    # Ein Aufruf ohne jeden Inhalt kostet eine Zeile und trägt nichts bei. Der
    # Fall entsteht nicht theoretisch: seit `log_text` optional ist, ist
    # `{"reason": "stream_end"}` ein syntaktisch gültiger Aufruf.
    if payload.report is None and not payload.log_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="entweder report oder log_text muss gesetzt sein",
        )

    fwd = request.headers.get("x-forwarded-for", "")
    client_ip = fwd.split(",")[0].strip() or (
        request.client.host if request.client else None
    )

    entry = ExperimentalLog(
        id=next_id(),
        reason=payload.reason,
        sidecar_version=payload.sidecar_version,
        system_info=payload.system_info,
        role=payload.role,
        channel_id=payload.channel_id,
        # `mode="json"` statt `model_dump()`: die Spalte ist JSON(B), und ein
        # rohes dict aus Pydantic kann Werte enthalten, die der JSON-Serializer
        # nicht kennt. Hier sind es heute nur Zahlen und Zeichenketten — aber
        # das gilt nur, solange niemand ein Feld ergänzt.
        report=payload.report.model_dump(mode="json") if payload.report else None,
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
