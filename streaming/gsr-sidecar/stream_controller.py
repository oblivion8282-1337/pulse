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

import ctypes
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from typing import IO

from profiles import ServerProfile, StreamProfile, build_audio_arg
from redact import redact_token_string

FPS_RE = re.compile(r"update fps:\s*(\d+)")


def _hide_argv_from_proc() -> None:
    """Set PR_SET_DUMPABLE=0 so /proc/<pid>/cmdline is unreadable by other users.

    This hides the stream token embedded in the GSR -o URL from world-readable
    /proc entries. Linux-only; silently skipped on other platforms.
    """
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(4, 0)  # PR_SET_DUMPABLE = 4, value = 0
    except Exception:  # noqa: BLE001
        pass


# Auflösungs-Ziele (GSR `-s WxH`). "Native" ist nicht hier — dann wird `-s`
# weggelassen und GSR nimmt die Monitor-Auflösung.
_RESOLUTION_MAP = {
    "4K":    "3840x2160",
    "1440p": "2560x1440",
    "1080p": "1920x1080",
    "720p":  "1280x720",
    "480p":  "854x480",
}


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
        self._last_exit_code: int | None = None
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
        # Snapshot once: _wait_loop may set _start_time = None concurrently, so
        # reading it twice (check then subtract) could hit ``monotonic() - None``.
        # No lock here — uptime_seconds is read from the on_state/on_fps callbacks
        # which run *under* self._lock (non-reentrant), so taking it would deadlock.
        start = self._start_time
        if start is None:
            return 0
        return int(time.monotonic() - start)

    @property
    def last_fps(self) -> int | None:
        return self._last_fps

    @property
    def last_argv(self) -> list[str] | None:
        return self._last_argv

    @property
    def last_exit_code(self) -> int | None:
        """Exit-Code des letzten GSR-Subprocess (None falls noch nicht gelaufen)."""
        return self._last_exit_code

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
        show_cursor: bool = True,
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

        # GSR default ist `-cursor yes`; nur explizit setzen wenn der User
        # den Cursor ausblenden will, damit das normale argv schlank bleibt.
        if not show_cursor:
            args += ["-cursor", "no"]

        args += ["-o", push_url]
        return args

    @staticmethod
    def build_push_url(server: ServerProfile, key: str | None) -> str:
        """Baut die Push-URL — bzw. nutzt `server.push_url` verbatim, wenn gesetzt
        (Pulse-Channel-Pfad: media-svc liefert die fertige rtmps://… / srt://…-URL
        inkl. Token, kein Neuzusammenbauen)."""
        if server.push_url:
            return server.push_url
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
        show_cursor: bool = True,
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
                show_cursor=show_cursor,
            )
            argv = [self._gsr_binary, *args]
            self._last_argv = argv
            self._last_fps = None
            self._set_state("starting")
            self._start_time = time.monotonic()

            # GSR must NOT inherit PULSE_PROP. The Electron app sets
            # PULSE_PROP=node.name=Pulse so its OWN audio streams are named
            # "Pulse" (so desktop capture can drop them via app-inverse:Pulse →
            # kills the voice echo). But GSR is a grandchild and would inherit it
            # too — renaming GSR's own libpulse capture node ("gsr-combined-*")
            # to "Pulse", which breaks GSR's internal self-linking and produces a
            # SILENT stream. Strip it so GSR's capture node keeps its name.
            gsr_env = {k: v for k, v in os.environ.items() if k != "PULSE_PROP"}
            try:
                self._proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,  # merged channels — wie QProcess.MergedChannels
                    bufsize=0,                  # unbuffered (binary mode → line-buffering nicht supported)
                    start_new_session=True,     # eigene Prozess-Gruppe → sauber stoppbar
                    preexec_fn=_hide_argv_from_proc,  # hide argv from /proc for other users
                    env=gsr_env,
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
        """Liest stdout (=merged stderr) zeilenweise, parst FPS und forwarded.

        Die FPS-Status-Zeile (``update fps: N, damage fps: N``) kommt 1×/s und
        spammt sonst das UI-Log voll — der Wert geht ohnehin strukturiert via
        ``on_fps`` raus. Daher: bei FPS-Match nur das Event feuern, die Zeile
        selbst nicht ans Log-Pane weiterreichen. Alle anderen Zeilen (Errors,
        PipeWire-State-Transitions, Exit-Notices) gehen durch.
        """
        try:
            for raw in iter(stream.readline, b""):
                if not raw:
                    break
                line = raw.decode(errors="replace").rstrip("\r\n")
                m = FPS_RE.search(line)
                if m:
                    fps = int(m.group(1))
                    self._last_fps = fps
                    # State-Entscheidung unter dem Lock: ist der Prozess schon
                    # terminal (stopped/error, vom _wait_loop gesetzt), darf ein
                    # gepuffertes FPS-Tick KEIN on_fps mehr feuern — sonst landet
                    # nach `ev:stopped` noch ein `ev:fps` in der Queue (Reihenfolge
                    # stopped→fps). Nur die Entscheidung steht unter dem Lock; der
                    # Callback selbst läuft danach lock-frei (schreibt nur in eine
                    # queue.Queue, aber wir halten externe Callbacks konsequent
                    # außerhalb des Lock-Blocks).
                    with self._lock:
                        if self._state == "starting":
                            self._set_state("live")
                        emit_fps = self._state in ("starting", "live")
                    if emit_fps and self._on_fps:
                        self._on_fps(fps)
                elif self._on_log:
                    # GSR prints the full push URL (incl. `?pass=<token>` /
                    # `streamid=…:<token>`) on connect. Redact before forwarding.
                    self._on_log(redact_token_string(line))
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
        # Exit-Code merken *bevor* das stopped-Event feuert, damit control.py
        # ihn in das IPC-Event packen kann (Protokoll-Vertrag aus streaming/README.md).
        self._last_exit_code = exit_code
        # Zustandsübergang + Cleanup unter demselben Lock wie start() / stop(),
        # damit ein paralleles stop() keine Race auf _state/_proc/_start_time hat.
        # _set_state ruft keinen Lock → kein Deadlock. Callbacks werden erst
        # *nach* dem Lock-Release gefeuert (on_log unten), da externe Callbacks
        # nie unter Lock laufen sollen. on_state ist die Ausnahme: es wird in
        # _set_state inline gerufen, aber _set_state selbst nimmt keinen Lock,
        # sodass auch on_state→stop() keine Re-Entrancy auslöst (stop() greift
        # nur lesend auf _proc ohne Lock).
        with self._lock:
            # Direkt auf "stopped" — KEIN Zwischen-"idle". Sonst sieht der Renderer
            # state=idle → state=stopped, und UI die auf "idle" den Start-Button
            # wieder freigibt würde kurz flackern. "error" überschreiben wir nicht.
            if self._state != "error":
                self._set_state("stopped")
            self._proc = None
            self._start_time = None
        if self._on_log:
            self._on_log(f"[gsr] exited with code {exit_code}")

    # ── Helpers ────────────────────────────────────────────────────
    def _emit_error(self, message: str) -> None:
        if self._on_error:
            self._on_error(message)
