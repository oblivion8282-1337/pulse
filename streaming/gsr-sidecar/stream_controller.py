"""Subprocess-Wrapper für GSR. Pure stdlib (kein Qt mehr).

Logik 1:1 aus ``~/Dokumente/GPU_Screen_Recorder/ui/stream_controller.py``,
nur die Prozess-Verwaltung ist anders:

- ``QProcess`` → ``subprocess.Popen`` mit ``start_new_session=True`` für
  saubere Prozess-Gruppe (kein Orphan beim Stop).
- ``readyReadStandardOutput``-Signal → Daemon-Thread, der ``stderr``
  zeilenweise liest und Callbacks ruft (FPS-Parse, Log-Forward, State).
- Qt-Signals → vier Callbacks im Konstruktor: ``on_state``, ``on_fps``,
  ``on_log``, ``on_error``. Die Aufrufer (siehe ``control.py``) leiten
  diese an die stdio-Event-Queue weiter.

**Verhalten der gebauten GSR-Argumentliste ist unverändert** — die
``build_argv()``-Methode kapselt das (war im Original inline in
``start()``); ``start()`` ruft sie auf, plus ``build_argv()`` ist von
``control.py`` als nicht-invasive Test-Operation aufrufbar.
"""
from __future__ import annotations
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import IO

from profiles import ServerProfile, StreamProfile, build_audio_arg

FPS_RE = re.compile(r"update fps:\s*(\d+)")

# Auflösungs-Map (Downscale-Ziele). "1440p" bleibt drin, damit eine alte
# persistierte Auswahl noch funktioniert; die UI bietet es nicht mehr an.
_RESOLUTION_MAP = {
    "1440p": "2560x1440",
    "1080p": "1920x1080",
    "720p":  "1280x720",
    "480p":  "854x480",
}


@dataclass
class StreamConfig:
    """Alle Parameter eines start-Calls. Snapshot des letzten Starts."""
    profile: StreamProfile
    server: ServerProfile
    capture_source: str
    audio_mode: str
    stream_key: str | None
    excluded_apps: list[str]
    codec_override: str | None
    bitrate_override: int | None
    fps_override: int | None
    resolution_override: str | None


class StreamController:
    """Wrappt das GSR-Subprocess; pure-stdlib-Variante (Qt entfernt).

    Callbacks (alle optional):
        on_state(state: str)
            ``"idle" | "starting" | "live" | "error" | "stopped"``.
        on_fps(fps: int)
            Parsed aus ``update fps: N``.
        on_log(line: str)
            Roh-Zeile von GSR-stderr (eine pro Aufruf).
        on_error(message: str)
            Für Dialog/Status-Bar.
    """

    def __init__(
        self,
        gsr_binary: str | None = None,
        *,
        on_state: Callable[[str], None] | None = None,
        on_fps: Callable[[int], None] | None = None,
        on_log: Callable[[str], None] | None = None,
        on_error: Callable[[str], None] | None = None,
    ) -> None:
        self._gsr_binary = gsr_binary
        self._on_state = on_state
        self._on_fps = on_fps
        self._on_log = on_log
        self._on_error = on_error

        self._proc: subprocess.Popen[bytes] | None = None
        self._reader_thread: threading.Thread | None = None
        self._waiter_thread: threading.Thread | None = None
        self._state = "idle"
        self._start_time: float | None = None
        self._last_fps: int | None = None
        self._last_argv: list[str] | None = None
        self._last_config: StreamConfig | None = None
        self._lock = threading.Lock()

    # ── State ──────────────────────────────────────────────────────
    @property
    def state(self) -> str:
        return self._state

    @property
    def running(self) -> bool:
        return self._state in ("starting", "live")

    @property
    def uptime_seconds(self) -> int:
        if self._start_time is None:
            return 0
        return int(time.monotonic() - self._start_time)

    @property
    def last_fps(self) -> int | None:
        return self._last_fps

    @property
    def last_argv(self) -> list[str] | None:
        return self._last_argv

    def set_gsr_binary(self, path: str | None) -> None:
        """Erlaubt dem Sidecar das Binary nach health-Probe zu setzen."""
        self._gsr_binary = path

    def _set_state(self, new: str) -> None:
        if new != self._state:
            self._state = new
            if self._on_state:
                self._on_state(new)

    # ── Argument-Building (verhalten identisch zum Original) ────────
    def build_argv(
        self,
        profile: StreamProfile,
        server: ServerProfile,
        capture_source: str,
        audio_mode: str,
        stream_key: str | None,
        excluded_apps: list[str] | None = None,
        codec_override: str | None = None,
        bitrate_override: int | None = None,
        fps_override: int | None = None,
        resolution_override: str | None = None,
    ) -> list[str]:
        """Baut die ``gpu-screen-recorder``-Argumentliste.

        **OHNE** das Binary selbst — argv[0] ist hier *nicht* enthalten;
        ``start()`` setzt den Binary-Pfad als argv[0] beim ``Popen``.

        Die Reihenfolge und die einzelnen Flags entsprechen 1:1 dem
        Original (``start_stream_server*.fish`` + ``stream_controller``):
        ``-w / -f / -c / -k / -bm / -q / -ac [/ -a] [/ -s] / -o``.
        """
        codec = codec_override if codec_override else profile.codec
        bitrate = bitrate_override if bitrate_override else profile.bitrate_kbps
        fps = fps_override if fps_override else profile.fps

        push_url = self.build_push_url(server, stream_key)

        args: list[str] = [
            "-w", capture_source,
            "-f", str(fps),
            "-c", profile.container,
            "-k", codec,
            "-bm", "cbr",
            "-q", str(bitrate),
            "-ac", profile.audio_codec,
        ]
        # Bei Portal-Capture: kein -restore-portal-session (gleiches Verhalten
        # wie das Original in stream_controller.py — der User wählt explizit
        # "portal" weil er auswählen will).

        audio_arg = build_audio_arg(audio_mode, excluded_apps or [])
        if audio_arg:
            args += ["-a", audio_arg]

        if resolution_override and resolution_override != "Native":
            res = _RESOLUTION_MAP.get(resolution_override)
            if res:
                args += ["-s", res]

        args += ["-o", push_url]
        return args

    @staticmethod
    def build_push_url(server: ServerProfile, key: str | None) -> str:
        """Baut die Push-URL — identisch zum Original-Verhalten."""
        if server.push_protocol == "rtmp":
            base = f"rtmp://{server.push_host}:{server.push_port}/{server.push_path}"
            if server.needs_auth and key:
                return f"{base}?user={server.auth_user}&pass={key}"
            return base
        if server.push_protocol == "srt":
            base = f"srt://{server.push_host}:{server.push_port}"
            if server.needs_auth and key:
                streamid = f"publish:{server.push_path}:{server.auth_user}:{key}"
                return f"{base}?streamid={streamid}&pkt_size=1316"
            return base
        raise ValueError(f"Unknown push_protocol: {server.push_protocol}")

    # ── Lifecycle ──────────────────────────────────────────────────
    def start(
        self,
        profile: StreamProfile,
        server: ServerProfile,
        capture_source: str,
        audio_mode: str,
        stream_key: str | None,
        excluded_apps: list[str] | None = None,
        codec_override: str | None = None,
        bitrate_override: int | None = None,
        fps_override: int | None = None,
        resolution_override: str | None = None,
    ) -> bool:
        """Startet GSR. Liefert ``True`` falls erfolgreich gestartet."""
        with self._lock:
            if self._proc is not None:
                self._emit_error("Stream läuft bereits.")
                return False

            if not self._gsr_binary:
                self._emit_error(
                    "Kein gpu-screen-recorder-Binary gefunden. "
                    "Setze $GSR_BINARY oder installiere gpu-screen-recorder."
                )
                self._set_state("error")
                return False

            args = self.build_argv(
                profile=profile, server=server,
                capture_source=capture_source, audio_mode=audio_mode,
                stream_key=stream_key, excluded_apps=excluded_apps,
                codec_override=codec_override, bitrate_override=bitrate_override,
                fps_override=fps_override, resolution_override=resolution_override,
            )
            argv = [self._gsr_binary, *args]
            self._last_argv = argv
            self._last_config = StreamConfig(
                profile=profile, server=server,
                capture_source=capture_source, audio_mode=audio_mode,
                stream_key=stream_key,
                excluded_apps=list(excluded_apps or []),
                codec_override=codec_override,
                bitrate_override=bitrate_override,
                fps_override=fps_override,
                resolution_override=resolution_override,
            )
            self._last_fps = None
            self._set_state("starting")
            self._start_time = time.monotonic()

            try:
                self._proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,  # merged channels — wie QProcess.MergedChannels
                    bufsize=0,                  # unbuffered (binary mode → line-buffering nicht supported)
                    start_new_session=True,     # eigene Prozess-Gruppe → sauber stoppbar
                )
            except (OSError, FileNotFoundError) as e:
                self._proc = None
                self._start_time = None
                self._emit_error(f"GSR-Start fehlgeschlagen: {e}")
                self._set_state("error")
                return False

        # Reader-Thread für stdout (gemerged inklusive stderr)
        if self._proc.stdout is not None:
            self._reader_thread = threading.Thread(
                target=self._reader_loop,
                args=(self._proc.stdout,),
                name="gsr-stdout-reader",
                daemon=True,
            )
            self._reader_thread.start()

        # Wait-Thread: blockiert auf wait() und signalisiert finished
        self._waiter_thread = threading.Thread(
            target=self._wait_loop,
            args=(self._proc,),
            name="gsr-waiter",
            daemon=True,
        )
        self._waiter_thread.start()
        return True

    def stop(self, timeout: float = 5.0) -> None:
        """Sauberer Stop: SIGINT an die Prozessgruppe, dann SIGTERM Fallback.

        Das Original sendete ``SIGINT`` an den GSR-PID; wir senden an die
        komplette Prozessgruppe (``os.killpg``), weil ``start_new_session=True``
        eine eigene Group bildet — so erwischt der Stop auch eventuelle
        Subprozesse die GSR selbst startet (FFmpeg-Pipeline).
        """
        proc = self._proc
        if proc is None:
            return
        try:
            os.killpg(proc.pid, signal.SIGINT)
        except (ProcessLookupError, PermissionError, OSError) as e:
            self._emit_error(f"Stop (SIGINT) fehlgeschlagen: {e}")
            # Fallback auf direkten PID
            try:
                proc.send_signal(signal.SIGINT)
            except (ProcessLookupError, OSError):
                return

        # Falls SIGINT nicht binnen ``timeout`` greift → SIGTERM Gruppe → SIGKILL.
        def _escalate() -> None:
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                pass
            else:
                return
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                return
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass

        threading.Thread(target=_escalate, name="gsr-stop-escalate", daemon=True).start()

    # ── Reader / Wait Threads ──────────────────────────────────────
    def _reader_loop(self, stream: IO[bytes]) -> None:
        """Liest stdout (=merged stderr) zeilenweise, parst FPS und forwarded."""
        try:
            for raw in iter(stream.readline, b""):
                if not raw:
                    break
                line = raw.decode(errors="replace").rstrip("\r\n")
                if self._on_log:
                    self._on_log(line)
                m = FPS_RE.search(line)
                if m:
                    fps = int(m.group(1))
                    self._last_fps = fps
                    if self._on_fps:
                        self._on_fps(fps)
                    if self._state == "starting":
                        self._set_state("live")
        except (OSError, ValueError):
            # Stream closed during read — normal beim Beenden
            return
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def _wait_loop(self, proc: subprocess.Popen[bytes]) -> None:
        """Blockiert auf ``proc.wait()`` und cleant auf."""
        try:
            exit_code = proc.wait()
        except OSError:
            exit_code = -1
        # State setzen
        if self._state != "error":
            self._set_state("idle")
        self._set_state("stopped")  # extra event-Signal an Aufrufer
        with self._lock:
            self._proc = None
            self._start_time = None
        # Optional: exit_code via on_log emitten
        if self._on_log:
            self._on_log(f"[gsr] exited with code {exit_code}")

    # ── Helpers ────────────────────────────────────────────────────
    def _emit_error(self, message: str) -> None:
        if self._on_error:
            self._on_error(message)

    @property
    def last_config(self) -> StreamConfig | None:
        return self._last_config
