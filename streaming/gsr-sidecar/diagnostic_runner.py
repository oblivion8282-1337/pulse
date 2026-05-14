"""Glue between control.py's diagnostic op and the rest of the sidecar.

Records ~N seconds of AV1 to a local temp file (same encoder settings as a
regular HQ stream — by setting the `ServerProfile.push_url` to a `tcp://`
loopback URL, GSR's `is_livestream_path` flips on and the same
low-latency-encoder flags get applied as for an RTMPS push, so the
bitstream we capture matches what would go over the wire). After the
recording finishes, POSTs the file to the Pulse chat-gateway's
diagnostics endpoint and emits a `diagnostic_done` event so the renderer
can show a toast.

Why bother with the TCP loopback instead of just `-o /tmp/foo.flv`: a
regular file path makes `is_livestream=false`, which disables
`AV_CODEC_FLAG_CLOSED_GOP | AV_CODEC_FLAG_LOW_DELAY | AV_CODEC_FLAG2_FAST`.
Those flags are part of what makes the AMD-AV1 bitstream the WHEP
receiver actually gets, so we want them present in the test recording
too. A localhost TCP listener accepts the bytes from GSR and writes them
to disk verbatim, byte-identical to what FLV-over-RTMP would carry.
"""

from __future__ import annotations

import os
import socket
import tempfile
import threading
import time
from collections.abc import Callable
from typing import Any

from diagnostic_upload import upload
from profiles import ServerProfile, profile_by_name
from stream_controller import StreamController

# Conservative limits — guard against a user-script that asks for a
# silly duration or never-stop scenarios.
_MIN_DURATION_S = 3.0
_MAX_DURATION_S = 30.0
# How long to wait, after stop, for GSR to actually flush + exit. GSR's
# normal SIGINT shutdown takes ~1s; 10s is plenty.
_STOP_TIMEOUT_S = 10.0
# How long to wait for the TCP listener to receive its first byte after
# GSR is told to start. If the listener doesn't see a connection within
# this window we assume GSR failed to open the output.
_CONNECT_TIMEOUT_S = 8.0


def _start_tcp_sink(out_path: str) -> tuple[int, threading.Event]:
    """Bind a 127.0.0.1 listener, write incoming bytes to ``out_path``.

    Returns (port, done_event). The done_event is set once the writer
    thread completes (connection closed cleanly or socket error).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    sock.settimeout(_CONNECT_TIMEOUT_S)
    port = sock.getsockname()[1]
    done = threading.Event()

    def _loop() -> None:
        conn: socket.socket | None = None
        try:
            conn, _ = sock.accept()
            conn.settimeout(_STOP_TIMEOUT_S + _MAX_DURATION_S + 10)
            with open(out_path, "wb") as f:
                while True:
                    try:
                        chunk = conn.recv(64 * 1024)
                    except (TimeoutError, OSError):
                        break
                    if not chunk:
                        break
                    f.write(chunk)
        except (TimeoutError, OSError):
            # GSR never connected (start failed) or peer closed unexpectedly.
            pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except OSError:
                    pass
            try:
                sock.close()
            except OSError:
                pass
            done.set()

    threading.Thread(target=_loop, name="diag-tcp-sink", daemon=True).start()
    return port, done


def _wait_for_stop(controller: StreamController, timeout_s: float) -> None:
    """Poll until the controller's GSR process has actually exited."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not controller.running:
            return
        time.sleep(0.1)


def run_diagnostic(
    controller: StreamController,
    emit: Callable[[dict[str, Any]], None],
    body: dict[str, Any],
) -> dict[str, Any]:
    """Kick off a diagnostic recording. Returns immediately.

    The actual record-stop-upload cycle runs in a background thread; on
    completion it emits ``{"ev": "diagnostic_done", "ok": …, ...}``.
    """
    if controller.running:
        return {"ok": False, "error": "stream is already running"}

    try:
        duration_s = float(body.get("duration_s", 10.0))
    except (TypeError, ValueError):
        return {"ok": False, "error": "duration_s must be a number"}
    if not (_MIN_DURATION_S <= duration_s <= _MAX_DURATION_S):
        return {"ok": False, "error": f"duration_s must be {_MIN_DURATION_S}..{_MAX_DURATION_S}"}

    upload_url = body.get("upload_url")
    access_token = body.get("access_token")
    if not isinstance(upload_url, str) or not upload_url:
        return {"ok": False, "error": "upload_url required"}
    if not isinstance(access_token, str) or not access_token:
        return {"ok": False, "error": "access_token required"}

    metadata_in = body.get("metadata")
    metadata: dict[str, Any] = metadata_in if isinstance(metadata_in, dict) else {}

    # Codec override is the actually interesting variable for the
    # AMD-AV1-freeze investigation — let the client pin it. Default to
    # av1 since that's the failure case.
    codec_override = body.get("codec") if isinstance(body.get("codec"), str) else "av1"

    # Pick the AV1 profile by default; the codec override above lets the
    # caller force h264 / hevc.
    try:
        profile = profile_by_name("AV1 Effizient")
    except KeyError as e:
        return {"ok": False, "error": str(e)}

    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_path = os.path.join(tempfile.gettempdir(), f"pulse-diag-{ts}.flv")
    port, sink_done = _start_tcp_sink(out_path)

    # TCP loopback — GSR's is_livestream_path matches tcp:// and applies
    # the same low-latency encoder flags as for RTMPS.
    server = ServerProfile(
        name="diagnostic",
        push_protocol="rtmp",  # unused — push_url short-circuits build_push_url()
        push_host="127.0.0.1",
        push_port=port,
        push_url=f"tcp://127.0.0.1:{port}",
    )

    ok = controller.start(
        profile=profile,
        server=server,
        capture_source="portal",
        audio_mode="Aus",
        stream_key=None,
        excluded_apps=[],
        codec_override=codec_override,
        bitrate_override=4000,
        fps_override=60,
        resolution_override=None,
    )
    if not ok:
        return {"ok": False, "error": "controller.start failed (siehe error-event)"}

    def _run() -> None:
        result: dict[str, Any] = {"ev": "diagnostic_done", "ok": False}
        try:
            time.sleep(duration_s)
            controller.stop()
            _wait_for_stop(controller, _STOP_TIMEOUT_S)
            # The TCP sink writer closes once GSR's socket closes.
            sink_done.wait(timeout=3.0)

            if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
                raise RuntimeError(
                    "no bytes captured — did the portal dialog get cancelled?"
                )
            size_bytes = os.path.getsize(out_path)
            resp = upload(
                file_path=out_path,
                upload_url=upload_url,
                access_token=access_token,
                metadata={
                    **metadata,
                    "duration_s": duration_s,
                    "codec": codec_override,
                    "container": profile.container,
                    "bitrate_kbps": 4000,
                    "fps": 60,
                    "captured_bytes": size_bytes,
                },
            )
            result = {
                "ev": "diagnostic_done",
                "ok": True,
                "size_bytes": size_bytes,
                "filename": resp.get("filename"),
                "user_id": resp.get("user_id"),
            }
        except Exception as e:  # noqa: BLE001 — sidecar must not crash
            result = {
                "ev": "diagnostic_done",
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
            }
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass
            emit(result)

    threading.Thread(target=_run, name="diag-runner", daemon=True).start()

    return {
        "ok": True,
        "duration_s": duration_s,
        "codec": codec_override,
        "port": port,
    }
