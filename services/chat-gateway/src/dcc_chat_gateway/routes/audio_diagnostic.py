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

from typing import Any

import structlog
from fastapi import APIRouter

from dcc_chat_gateway.security import CurrentUser

router = APIRouter()
log = structlog.get_logger(__name__)


@router.post("/audio-diagnostic")
async def receive_audio_diagnostic(
    payload: dict[str, Any],
    current: CurrentUser,
) -> dict[str, str]:
    """Nimmt einen nativen Audio-Routing-Snapshot entgegen, loggt ihn mit der
    User-ID des Aufrufers. Dump trägt keinen Audio-Inhalt."""
    log.info("audio_diagnostic", user_id=str(current.id), dump=payload)
    return {"status": "ok"}
