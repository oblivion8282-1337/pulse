"""Minimal multipart/form-data POST for the diagnostic-recording upload path.

Pure-stdlib (the sidecar deliberately has no runtime dependencies), so
``urllib.request`` + a hand-rolled multipart body. The destination is the
Pulse chat-gateway's ``POST /api/chat/diagnostics/upload`` route, but the
helper itself is endpoint-agnostic — it takes the URL, the bearer token,
the file path and a metadata dict, and returns the parsed JSON response.

Why hand-rolled multipart instead of `requests`/`urllib3`: keeping the
sidecar dependency-free means it ships into the Flatpak as plain .py
files. Multipart is small enough (~30 lines) to vendor.
"""

from __future__ import annotations

import json
import os
import secrets
import ssl
import urllib.error
import urllib.request


def _build_multipart(
    file_path: str,
    metadata: dict[str, object] | None,
) -> tuple[bytes, str]:
    """Return (body_bytes, content_type). Single file part + optional JSON part."""
    boundary = f"----pulse-diag-{secrets.token_hex(12)}"
    parts: list[bytes] = []

    # File part. application/octet-stream — server doesn't sniff content,
    # it accepts whatever matches the suffix whitelist.
    filename = os.path.basename(file_path)
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    )
    parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
    with open(file_path, "rb") as f:
        parts.append(f.read())
    parts.append(b"\r\n")

    # Metadata part (optional). Sent as a regular form field so FastAPI's
    # Form(...) picks it up; we JSON-parse server-side.
    if metadata:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(b'Content-Disposition: form-data; name="metadata"\r\n\r\n')
        parts.append(json.dumps(metadata, ensure_ascii=False).encode("utf-8"))
        parts.append(b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def upload(
    *,
    file_path: str,
    upload_url: str,
    access_token: str,
    metadata: dict[str, object] | None = None,
    timeout_s: float = 90.0,
) -> dict[str, object]:
    """POST the recording. Raises RuntimeError with a useful message on failure.

    Returns the parsed JSON body of the 201 response — typically
    ``{filename, size_bytes, user_id}``.

    The bearer token (regular Pulse access JWT) is forwarded as
    ``Authorization: Bearer …``. Don't log this token — it's already
    sensitive in transit; persisting it in the sidecar log line would be
    worse.
    """
    if not os.path.isfile(file_path):
        raise RuntimeError(f"diagnostic file vanished before upload: {file_path}")

    body, content_type = _build_multipart(file_path, metadata)

    req = urllib.request.Request(upload_url, data=body, method="POST")
    req.add_header("Content-Type", content_type)
    req.add_header("Content-Length", str(len(body)))
    req.add_header("Authorization", f"Bearer {access_token}")

    # SSL context: use defaults. The Pulse VPS uses a Let's Encrypt cert
    # through Caddy, so cert verification works out of the box. No
    # special handling needed.
    ctx = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        # Pull the response body if any — gives us the chat-gateway
        # error message instead of just the HTTP code.
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")[:500]
        except OSError:
            pass
        raise RuntimeError(f"upload HTTP {e.code}: {detail or e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"upload network error: {e.reason}") from e
    except (TimeoutError, OSError) as e:
        raise RuntimeError(f"upload failed: {e}") from e

    if status < 200 or status >= 300:
        raise RuntimeError(f"upload HTTP {status}")

    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise RuntimeError(f"upload response not JSON: {e}") from e
