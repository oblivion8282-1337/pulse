"""Audio-diagnostic dump receiver (Android-Audio-Routing-Snapshot).

Empfängt einen Audio-Routing-Snapshot von der Android-APK (KEIN Audio-Inhalt —
nur Routing-Metadaten: Audio-Mode, Ausgabegerät+Typ, Stream-Lautstärken,
Android-Version, BT-Profil, sowie den web-seitigen setVoiceActive-Status) zur
Fern-Diagnose des „Bluetooth/Car zu leise"-Bugs.

Die Pipeline ist angebunden: Beim Voice-Join feuert das Web nach ~2,5 s
``maybeSendAudioDiagnostic()`` (in ``livekit.svelte.ts``), das den Snapshot nur
verschickt, wenn ein Bluetooth-Ausgabegerät verbunden ist (das „im Auto zu
leise"-Szenario). Trägt zusätzlich ``setVoiceActiveError``, falls der native
Routing-Aufruf auf der Web-Seite scheiterte (Plugin nicht geladen etc.).

Speicherung als structured Logs (keine DB, keine Migration — geringes Volumen,
nur Dev-Zugriff):
    docker logs pulse_chat_gateway 2>&1 | grep audio_diagnostic
"""

from __future__ import annotations


import structlog
from fastapi import APIRouter

from pydantic import BaseModel, Field

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()
log = structlog.get_logger(__name__)


class GeraetIn(BaseModel):
    """Security-Audit 2026-09-16: begrenzte Formen statt offenem dict —
    vorher konnte ein eingeloggter Nutzer beliebige Megabytes in die
    INFO-Logs pumpen (Log-Flooding/Padding). Spiegelt den Client-Typ
    ``AudioDiagnostic`` (web/src/lib/platform/audioRoute.ts)."""

    model_config = {"extra": "ignore"}

    type: str = Field(max_length=128)
    name: str | None = Field(default=None, max_length=256)


class StreamLauteIn(BaseModel):
    model_config = {"extra": "ignore"}

    volume: float = 0.0
    max: float = 0.0


class StreamsIn(BaseModel):
    model_config = {"extra": "ignore"}

    voiceCall: StreamLauteIn = StreamLauteIn()
    music: StreamLauteIn = StreamLauteIn()


class AudioDiagnosticIn(BaseModel):
    model_config = {"extra": "ignore"}

    androidSdk: int = Field(ge=0, le=100)
    androidRelease: str = Field(default="", max_length=32)
    mode: str = Field(default="", max_length=64)
    route: str = Field(default="", max_length=64)
    bluetoothScoOn: bool = False
    communicationDevice: GeraetIn | None = None
    streams: StreamsIn = StreamsIn()
    outputDevices: list[GeraetIn] = Field(default_factory=list, max_length=32)
    setVoiceActiveError: str | None = Field(default=None, max_length=512)


@router.post("/audio-diagnostic")
async def receive_audio_diagnostic(
    payload: AudioDiagnosticIn,
    current: CurrentUser,
) -> dict[str, str]:
    """Nimmt einen nativen Audio-Routing-Snapshot entgegen, loggt ihn mit der
    User-ID des Aufrufers. Dump trägt keinen Audio-Inhalt."""
    if not ratelimit.check("audio_diagnostic", current.id):
        from fastapi import HTTPException, status  # noqa: PLC0415

        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")
    log.info("audio_diagnostic", user_id=str(current.id), dump=payload.model_dump())
    return {"status": "ok"}
