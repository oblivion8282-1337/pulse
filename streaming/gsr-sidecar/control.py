"""Sidecar-Entry-Point — newline-JSON über stdio.

Ersetzt ``main.py``/``stream_window.py`` aus dem GSR-``ui/``-Ordner.
Eine JSON-Zeile pro Request auf ``stdin``, eine JSON-Zeile pro Response
oder Event auf ``stdout``. Trennung:

- **Response** trägt ``"id"`` (vom Request gespiegelt) und ``"ok"`` (bool).
- **Event** trägt ``"ev"`` (string), kein ``"id"``, kein ``"ok"``.

Wenn der Request keine ``"id"`` mitsendet, hat die Response ``"id": null``.

Operationen (siehe ``streaming/README.md`` für die volle Tabelle):

- ``{"op": "health"}``
- ``{"op": "gpu_info"}``
- ``{"op": "list_profiles"}``
- ``{"op": "list_application_audio"}``
- ``{"op": "build_argv", "profile": ..., "channel": {...}, "capture": ...,
       "audio": {...}, "overrides": {...}?}``
- ``{"op": "start", ...}`` (gleicher Body wie ``build_argv``)
- ``{"op": "stop"}``
- ``{"op": "state"}``

Events:

- ``{"ev": "state", "state": "live"|"starting"|"idle"|"error"|"stopped",
     "running": bool, "uptime_s": int}``
- ``{"ev": "fps", "fps": 59, "uptime_s": 12}``
- ``{"ev": "log", "line": "..."}``
- ``{"ev": "error", "message": "..."}``
- ``{"ev": "stopped", "code": int?}`` (kommt aus dem ``state==stopped``-Übergang)

Robustheit:

- Ungültiges JSON / unbekannte Op → Error-Response, kein Crash.
- ``stdin``-EOF → laufender GSR wird gestoppt, Loop terminiert.
- ``SIGTERM`` / ``SIGINT`` → dito.
"""
from __future__ import annotations
import json
import queue
import signal
import sys
import threading
from typing import Any

import gsr_binary
from profiles import (
    PROFILES,
    AUDIO_MODES,
    APP_LABEL_PREFIX,
    ServerProfile,
    StreamProfile,
    list_audio_applications,
    profile_by_name,
)
from redact import redact_argv
from stream_controller import StreamController


# ── Output-Queue (sequenzieller stdout-Writer) ─────────────────────


_output_queue: "queue.Queue[dict[str, Any] | None]" = queue.Queue()


def _writer_loop() -> None:
    """Ein einziger Thread serialisiert alle stdout-Writes.

    Wichtig: Callbacks aus dem GSR-Reader-Thread und Responses aus dem
    Request-Thread sollen sich nicht im stdout-Stream überlappen.
    """
    while True:
        item = _output_queue.get()
        if item is None:
            return
        try:
            line = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (OSError, BrokenPipeError):
            return


def _emit(payload: dict[str, Any]) -> None:
    _output_queue.put(payload)


# ── Profil-Serialisierung ──────────────────────────────────────────


def _profile_to_dict(p: StreamProfile) -> dict[str, Any]:
    return {
        "name": p.name,
        "codec": p.codec,
        "audio_codec": p.audio_codec,
        "container": p.container,
        "bitrate_kbps": p.bitrate_kbps,
        "fps": p.fps,
        "needs_custom_build": p.needs_custom_build,
        "notes": p.notes,
    }


# ── Body-Parsing für start / build_argv ────────────────────────────


def _resolve_server(body: dict[str, Any]) -> tuple[ServerProfile, str | None]:
    """Liefert (server, stream_key) aus dem ``channel``-Block.

    Pulse streamt immer in einen Voice-Channel — ``ServerProfile.from_channel``
    baut das Server-Profil aus ``{id, token, push_url?, mediamtx_endpoint?,
    push_protocol?}``. ``push_url`` (von media-svc) ist autoritativ wenn gesetzt;
    sonst werden Endpoint/Protokoll als Fallback genutzt.
    """
    channel = body.get("channel")
    if not channel:
        raise ValueError("channel ist Pflicht (Pulse streamt immer in einen Voice-Channel)")
    channel_id = str(channel.get("id") or channel.get("channel_id") or "")
    token = str(channel.get("token", ""))
    endpoint = str(channel.get("mediamtx_endpoint", "howispulse.com"))
    push_protocol = str(channel.get("push_protocol", "rtmp"))
    push_url = channel.get("push_url")
    push_url = str(push_url) if push_url else None
    if not channel_id:
        raise ValueError("channel.id (oder channel_id) ist Pflicht")
    sp = ServerProfile.from_channel(
        channel_id=channel_id,
        token=token,
        mediamtx_endpoint=endpoint,
        push_protocol=push_protocol,
        push_url=push_url,
    )
    return sp, token


def _resolve_profile(body: dict[str, Any]) -> StreamProfile:
    name = body.get("profile")
    if not name:
        raise ValueError("profile (Name) ist Pflicht")
    return profile_by_name(str(name))


def _parse_audio(body: dict[str, Any]) -> tuple[str, list[str]]:
    """Erwartet ``audio: {"mode": "Desktop", "excluded_apps": [...]}``.

    Liefert (mode, excluded_apps). Default ``mode = "Aus"``.
    """
    audio = body.get("audio") or {}
    mode = str(audio.get("mode", "Aus"))
    excluded = audio.get("excluded_apps") or []
    if not isinstance(excluded, list):
        raise ValueError("audio.excluded_apps muss eine Liste sein")
    return mode, [str(x) for x in excluded]


def _parse_overrides(
    body: dict[str, Any],
) -> tuple[str | None, int | None, int | None, str | None]:
    """Liefert (codec, bitrate_kbps, fps, resolution)."""
    o = body.get("overrides") or {}
    codec = o.get("codec")
    bitrate = o.get("bitrate_kbps")
    fps = o.get("fps")
    resolution = o.get("resolution")
    return (
        str(codec) if codec else None,
        int(bitrate) if bitrate is not None else None,
        int(fps) if fps is not None else None,
        str(resolution) if resolution else None,
    )


# ── Op-Handler ─────────────────────────────────────────────────────


class Sidecar:
    """Zustandsbehafteter Handler: GSR-Binary-Resolution + Controller."""

    def __init__(self) -> None:
        self._binary = gsr_binary.resolve()
        # ``probe_info`` shells out to ``gpu-screen-recorder --info`` plus
        # ``--version`` plus ``strings``. On a cold start (no compositor up
        # yet, slow NVIDIA init) that whole chain can block up to ~20s — and
        # the Electron sidecar's first ``health`` call has only a 10s timeout.
        # Probe lazily on the first health/gpu_info request instead.
        self._info: gsr_binary.GsrInfo | None = None
        self._info_probed = False
        self.controller = StreamController(
            gsr_binary=self._binary.path,
            on_state=self._on_state,
            on_fps=self._on_fps,
            on_log=self._on_log,
            on_error=self._on_error,
        )

    def _ensure_info(self) -> gsr_binary.GsrInfo | None:
        if self._info is None and self._binary.available and not self._info_probed:
            self._info = gsr_binary.probe_info(self._binary)
            if self._info is not None:
                self._info_probed = True
        return self._info

    # ── Callbacks aus dem Controller → Events ─────────────────────
    def _on_state(self, state: str) -> None:
        _emit({
            "ev": "state",
            "state": state,
            "running": state in ("starting", "live"),
            "uptime_s": self.controller.uptime_seconds,
        })
        if state == "stopped":
            # Protocol contract (streaming/README.md): stopped events MAY carry
            # an ``code`` field with the subprocess exit code. The controller
            # writes ``last_exit_code`` before transitioning, so we can read it
            # here. None when the process never ran.
            code = self.controller.last_exit_code
            event: dict[str, Any] = {"ev": "stopped"}
            if code is not None:
                event["code"] = code
            _emit(event)

    def _on_fps(self, fps: int) -> None:
        _emit({"ev": "fps", "fps": fps, "uptime_s": self.controller.uptime_seconds})

    def _on_log(self, line: str) -> None:
        _emit({"ev": "log", "line": line})

    def _on_error(self, message: str) -> None:
        _emit({"ev": "error", "message": message})

    # ── Ops ───────────────────────────────────────────────────────
    def op_health(self, _body: dict[str, Any]) -> dict[str, Any]:
        info = self._ensure_info()
        gsr: dict[str, Any] = {
            "available": self._binary.available,
            "source": self._binary.source,
            "is_flatpak": self._binary.is_flatpak,
        }
        if self._binary.path:
            gsr["path"] = self._binary.path
        if info is not None:
            gsr.update({
                "version": info.version,
                "vendor": info.vendor,
                "display_server": info.display_server,
                "video_codecs": info.video_codecs,
                "capture_options": info.capture_options,
                "has_flv_patch": info.has_flv_opus_patch,
            })
        return {"ok": True, "gsr": gsr}

    def op_gpu_info(self, _body: dict[str, Any]) -> dict[str, Any]:
        if not self._binary.available:
            return {"ok": False, "error": "gpu-screen-recorder binary not available"}
        # Re-probe falls beim ersten Aufruf (z.B. ohne laufenden compositor) gescheitert.
        info = self._ensure_info()
        if info is None:
            info = gsr_binary.probe_info(self._binary)
            if info is not None:
                self._info = info
        if info is None:
            return {"ok": False, "error": "gpu-screen-recorder --info failed"}
        return {
            "ok": True,
            "vendor": info.vendor,
            "card_path": info.card_path,
            "display_server": info.display_server,
            "video_codecs": info.video_codecs,
        }

    def op_list_profiles(self, _body: dict[str, Any]) -> dict[str, Any]:
        # `servers` stays in the response (empty now) for shape-compat with the
        # frontend's `GsrListProfiles` — Pulse only ever streams into a voice
        # channel, so there's no server catalog any more.
        return {
            "ok": True,
            "profiles": [_profile_to_dict(p) for p in PROFILES],
            "servers": [],
            "audio_modes": list(AUDIO_MODES.keys()),
            "app_label_prefix": APP_LABEL_PREFIX,
        }

    def op_list_application_audio(self, _body: dict[str, Any]) -> dict[str, Any]:
        binary = self._binary.path or "gpu-screen-recorder"
        return {"ok": True, "applications": list_audio_applications(binary)}

    def op_build_argv(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            profile = _resolve_profile(body)
            server, key = _resolve_server(body)
            capture = str(body.get("capture", "portal"))
            audio_mode, excluded = _parse_audio(body)
            codec, bitrate, fps, resolution = _parse_overrides(body)
            show_cursor = bool(body.get("show_cursor", True))
        except (KeyError, ValueError, TypeError) as e:
            return {"ok": False, "error": str(e)}

        argv = self.controller.build_argv(
            profile=profile, server=server,
            capture_source=capture, audio_mode=audio_mode, stream_key=key,
            excluded_apps=excluded,
            codec_override=codec, bitrate_override=bitrate,
            fps_override=fps, resolution_override=resolution,
            show_cursor=show_cursor,
        )
        # argv[0]-Platz: Binary-Pfad (kann None sein); für Diagnose ausgeben.
        # Token in der `-o`-URL wird redaktiert — die Response geht via IPC
        # in den Renderer und darf den Stream-Key nicht durchreichen.
        binary_path = self._binary.path or "gpu-screen-recorder"
        return {
            "ok": True,
            "binary": binary_path,
            "argv": redact_argv([binary_path, *argv]),
        }

    def op_start(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            profile = _resolve_profile(body)
            server, key = _resolve_server(body)
            capture = str(body.get("capture", "portal"))
            audio_mode, excluded = _parse_audio(body)
            codec, bitrate, fps, resolution = _parse_overrides(body)
            show_cursor = bool(body.get("show_cursor", True))
        except (KeyError, ValueError, TypeError) as e:
            return {"ok": False, "error": str(e)}

        if not self._binary.available:
            return {"ok": False, "error": "gpu-screen-recorder binary not available"}

        ok = self.controller.start(
            profile=profile, server=server,
            capture_source=capture, audio_mode=audio_mode, stream_key=key,
            excluded_apps=excluded,
            codec_override=codec, bitrate_override=bitrate,
            fps_override=fps, resolution_override=resolution,
            show_cursor=show_cursor,
        )
        if not ok:
            return {"ok": False, "error": "Start fehlgeschlagen — siehe error-Event."}
        argv = self.controller.last_argv or []
        return {"ok": True, "argv": redact_argv(argv)}

    def op_stop(self, _body: dict[str, Any]) -> dict[str, Any]:
        if not self.controller.running:
            return {"ok": True, "running": False, "note": "kein laufender Stream"}
        self.controller.stop()
        return {"ok": True}

    def op_state(self, _body: dict[str, Any]) -> dict[str, Any]:
        argv = self.controller.last_argv
        return {
            "ok": True,
            "running": self.controller.running,
            "state": self.controller.state,
            "fps": self.controller.last_fps,
            "uptime_s": self.controller.uptime_seconds,
            "argv": redact_argv(argv) if argv is not None else None,
        }

    def shutdown(self) -> None:
        if self.controller.running:
            self.controller.stop()


# ── Dispatch ───────────────────────────────────────────────────────


_OP_TABLE = {
    "health": "op_health",
    "gpu_info": "op_gpu_info",
    "list_profiles": "op_list_profiles",
    "list_application_audio": "op_list_application_audio",
    "build_argv": "op_build_argv",
    "start": "op_start",
    "stop": "op_stop",
    "state": "op_state",
}


def _handle_request(sc: Sidecar, request: dict[str, Any]) -> dict[str, Any]:
    req_id = request.get("id")
    op = request.get("op")
    if not isinstance(op, str):
        return {"id": req_id, "ok": False, "error": "missing or invalid 'op'"}
    handler_name = _OP_TABLE.get(op)
    if handler_name is None:
        return {"id": req_id, "ok": False, "error": f"unknown op: {op}"}
    handler = getattr(sc, handler_name)
    try:
        response = handler(request)
    except Exception as e:  # noqa: BLE001 — Sidecar darf nicht crashen
        return {"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}
    response = dict(response)  # copy
    response["id"] = req_id
    return response


def run() -> int:
    """Main-Loop. Liefert Exit-Code."""
    # Writer-Thread starten
    writer = threading.Thread(target=_writer_loop, name="stdout-writer", daemon=True)
    writer.start()

    sc = Sidecar()

    # Beim Beenden: laufenden GSR stoppen.
    def _on_signal(signum: int, _frame: object) -> None:
        sc.shutdown()
        # Kein sys.exit hier — der stdin-Loop reagiert auf EOF und beendet sich.
        # Falls Signal vor EOF kommt, schließen wir stdin. Python kann ValueError
        # werfen wenn stdin gerade in readline blockiert (je nach Plattform).
        try:
            sys.stdin.close()
        except (OSError, ValueError):
            pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _on_signal)
        except (OSError, ValueError):
            pass  # main-thread-only — auf manchen Plattformen ok zu ignorieren

    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("request must be a JSON object")
            except (json.JSONDecodeError, ValueError) as e:
                _emit({"id": None, "ok": False, "error": f"invalid JSON: {e}"})
                continue
            response = _handle_request(sc, request)
            _emit(response)
    finally:
        sc.shutdown()
        _output_queue.put(None)  # writer beenden
        writer.join(timeout=1.0)

    return 0


if __name__ == "__main__":
    raise SystemExit(run())
