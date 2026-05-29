"""S3 (MinIO) helpers — split between an *internal* client for server-side
ops (delete, head, bucket admin) and a *public* client whose presigned URLs
the browser uses.

The split matters in prod: chat-gateway talks to MinIO over the docker
network (``http://minio:9000``) but the browser can only reach it via
nginx (``https://howispulse.com/s3/…``). Signatures embed the host,
so signing has to happen with the public endpoint, while plain ops bypass
nginx for latency. MinIO is configured with ``MINIO_SERVER_URL`` matching
``s3_public_endpoint`` so its server-side signature check passes.

In dev both endpoints collapse to ``http://localhost:9000`` — same client
shape, different endpoints. The helpers below close over the configured
endpoint via ``_make_client_kwargs``.

**Lifecycle:** aiobotocore clients are expensive to create (~5–30 ms each:
they load service-model JSON, open a connection pool). The previous design
spun one up per ``presigned_get_url`` call via an ``asynccontextmanager``,
which dominated the latency of any endpoint that signed N URLs (Ready,
list_messages, attachment-heavy channel-opens). We now hold one
process-wide client per endpoint, lazily initialised on first use and torn
down by the FastAPI lifespan via ``shutdown_clients``. Lazy-init is
serialized through ``_init_lock`` so a burst of concurrent first requests
doesn't race to create N clients.
"""

from __future__ import annotations

import asyncio
from typing import Literal

import aiobotocore.session
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.credentials import Credentials

from dcc_chat_gateway.config import get_settings

_Operation = Literal["put_object", "get_object"]


def _make_client_kwargs(endpoint: str) -> dict:
    s = get_settings()
    return {
        "service_name": "s3",
        "endpoint_url": endpoint,
        "region_name": s.s3_region,
        "aws_access_key_id": s.s3_access_key,
        "aws_secret_access_key": s.s3_secret_key,
        # path-style addressing is what MinIO + nginx-proxy expects
        # (virtual-host style would need wildcard DNS, which we don't have).
        "config": Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    }


# Cached clients + their context managers (we hold the CM so we can call
# __aexit__ at shutdown). None until first use.
_session = aiobotocore.session.get_session()
_internal_cm = None
_internal_client = None
_public_cm = None
_public_client = None
_init_lock = asyncio.Lock()


async def _ensure_internal_client():
    """Return the singleton aiobotocore client for server→MinIO ops."""
    global _internal_cm, _internal_client
    if _internal_client is not None:
        return _internal_client
    async with _init_lock:
        if _internal_client is None:
            s = get_settings()
            _internal_cm = _session.create_client(
                **_make_client_kwargs(s.s3_internal_endpoint)
            )
            _internal_client = await _internal_cm.__aenter__()
    return _internal_client


async def _ensure_public_client():
    """Return the singleton aiobotocore client used to sign browser-bound URLs."""
    global _public_cm, _public_client
    if _public_client is not None:
        return _public_client
    async with _init_lock:
        if _public_client is None:
            s = get_settings()
            _public_cm = _session.create_client(
                **_make_client_kwargs(s.s3_public_endpoint)
            )
            _public_client = await _public_cm.__aenter__()
    return _public_client


async def shutdown_clients() -> None:
    """Close cached aiobotocore clients. Called from the FastAPI lifespan's
    ``finally`` branch. Safe to call when nothing was ever initialised."""
    global _internal_cm, _internal_client, _public_cm, _public_client
    for cm_name, client_name in (
        ("_internal_cm", "_internal_client"),
        ("_public_cm", "_public_client"),
    ):
        cm = globals()[cm_name]
        if cm is None:
            continue
        try:
            await cm.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001 — best-effort shutdown
            pass
        globals()[cm_name] = None
        globals()[client_name] = None


async def presigned_put_url(
    key: str,
    *,
    content_type: str | None = None,
    content_length: int | None = None,
) -> str:
    """Sign a PUT URL the browser uses to upload an object directly to MinIO.

    Pinning ``content_type`` makes MinIO reject mismatches at upload time —
    a client claiming ``image/png`` but PUTting JSON gets 403. ``content_length``
    similarly enforces the declared size.
    """
    s = get_settings()
    params: dict = {"Bucket": s.s3_bucket, "Key": key}
    if content_type is not None:
        params["ContentType"] = content_type
    if content_length is not None:
        params["ContentLength"] = content_length
    client = await _ensure_public_client()
    return await client.generate_presigned_url(
        ClientMethod="put_object",
        Params=params,
        ExpiresIn=s.s3_presigned_ttl_seconds,
    )


async def presigned_get_url(
    key: str, *, filename: str | None = None, inline: bool = True
) -> str:
    """Sign a GET URL for the browser. If ``inline`` is false, the
    ``Content-Disposition: attachment; filename=…`` header triggers a download
    instead of an inline view — used for non-renderable types (zip, exe, …)."""
    s = get_settings()
    params: dict = {"Bucket": s.s3_bucket, "Key": key}
    if not inline and filename:
        # MinIO honours these response-override parameters in the signed URL.
        # Sanitize the filename to prevent header injection: strip characters
        # that could break out of the quoted-string (double-quote, backslash,
        # CR, LF).  A clean quoted-string form is sufficient for all common
        # file names; non-ASCII is preserved as-is (most S3/browsers handle it).
        safe_filename = (
            filename.replace("\\", "")
                    .replace('"', "")
                    .replace("\r", "")
                    .replace("\n", "")
        )
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{safe_filename}"'
        )
    client = await _ensure_public_client()
    return await client.generate_presigned_url(
        ClientMethod="get_object",
        Params=params,
        ExpiresIn=s.s3_presigned_ttl_seconds,
    )


async def put_object(key: str, *, body: bytes, content_type: str) -> None:
    """Direct server-side upload — used for small admin-driven blobs
    (per-guild sound overrides, ≤ 5 MB). Attachments take the presigned-PUT
    route instead so the client streams straight to MinIO; for these
    micro-uploads the extra round-trip would dominate latency."""
    s = get_settings()
    client = await _ensure_internal_client()
    await client.put_object(
        Bucket=s.s3_bucket,
        Key=key,
        Body=body,
        ContentType=content_type,
    )


async def delete_object(key: str) -> None:
    """Hard-delete an object. Used by the message-delete + attachment-edit
    paths to free MinIO storage immediately (per Phase-1 spec: no soft-keep)."""
    s = get_settings()
    client = await _ensure_internal_client()
    await client.delete_object(Bucket=s.s3_bucket, Key=key)


async def total_bucket_bytes() -> int | None:
    """Sum the Size of every object in the attachments bucket.

    Used by the admin Übersicht-Tab. Returns ``None`` if MinIO is
    unreachable so the UI can fall back to the "not active" placeholder
    instead of erroring the whole stats panel. Cheap at our scale (paginated
    LIST is O(n_objects) and we expect hundreds, not millions).
    """
    s = get_settings()
    total = 0
    try:
        client = await _ensure_internal_client()
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=s.s3_bucket):
            for obj in page.get("Contents", []):
                total += obj.get("Size", 0)
        return total
    except Exception:  # noqa: BLE001
        return None


async def cluster_disk_info() -> tuple[int, int] | None:
    """Query MinIO's admin API for total + available disk space, summed across
    drives. Returns ``(total_bytes, free_bytes)`` or ``None`` if the call fails.

    Used by the admin Übersicht-Tab to render "X of Y GB used" instead of just
    bucket-usage in isolation. MinIO's ``/minio/admin/v3/storageinfo`` is a
    plain sigv4-signed GET (service name ``s3``), so we sign with botocore and
    fire with httpx — no extra dep. Single-node FS backend has one drive;
    multi-drive setups are summed.
    """
    s = get_settings()
    url = f"{s.s3_internal_endpoint}/minio/admin/v3/storageinfo"
    creds = Credentials(s.s3_access_key, s.s3_secret_key)
    req = AWSRequest(method="GET", url=url, data=b"")
    # Unsigned payload — admin GET has no body. Without this header sigv4 would
    # try to sha256 a None body and fail.
    req.headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD"
    SigV4Auth(creds, "s3", s.s3_region).add_auth(req)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, headers=dict(req.headers))
            resp.raise_for_status()
            data = resp.json()
    except Exception:  # noqa: BLE001
        return None
    # MinIO ships the disks list as `Disks` (uppercase D). totalspace /
    # availspace are lowercase. Verified against MinIO 2024.x; if a future
    # release renames the keys this returns None and the UI degrades cleanly.
    disks = data.get("Disks") or data.get("disks") or []
    total = sum(int(d.get("totalspace", 0) or 0) for d in disks)
    free = sum(int(d.get("availspace", 0) or 0) for d in disks)
    if total <= 0:
        return None
    return total, free
