"""S3 (MinIO) helpers — split between an *internal* client for server-side
ops (delete, head, bucket admin) and a *public* client whose presigned URLs
the browser uses.

The split matters in prod: chat-gateway talks to MinIO over the docker
network (``http://minio:9000``) but the browser can only reach it via
nginx (``https://pulse.unicutmedia.com/s3/…``). Signatures embed the host,
so signing has to happen with the public endpoint, while plain ops bypass
nginx for latency. MinIO is configured with ``MINIO_SERVER_URL`` matching
``s3_public_endpoint`` so its server-side signature check passes.

In dev both endpoints collapse to ``http://localhost:9000`` — same client
shape, different endpoints. The helpers below close over the configured
endpoint via ``_make_client``.
"""

from __future__ import annotations

import contextlib
from typing import AsyncIterator, Literal

import aiobotocore.session
from botocore.config import Config

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


@contextlib.asynccontextmanager
async def _internal_client() -> AsyncIterator:
    """aiobotocore client pointing at the docker-DNS MinIO endpoint."""
    s = get_settings()
    session = aiobotocore.session.get_session()
    async with session.create_client(
        **_make_client_kwargs(s.s3_internal_endpoint)
    ) as client:
        yield client


@contextlib.asynccontextmanager
async def _public_client() -> AsyncIterator:
    """aiobotocore client whose presigned URLs are stamped with the public host."""
    s = get_settings()
    session = aiobotocore.session.get_session()
    async with session.create_client(
        **_make_client_kwargs(s.s3_public_endpoint)
    ) as client:
        yield client


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
    async with _public_client() as client:
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
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{filename}"'
        )
    async with _public_client() as client:
        return await client.generate_presigned_url(
            ClientMethod="get_object",
            Params=params,
            ExpiresIn=s.s3_presigned_ttl_seconds,
        )


async def delete_object(key: str) -> None:
    """Hard-delete an object. Used by the message-delete + attachment-edit
    paths to free MinIO storage immediately (per Phase-1 spec: no soft-keep)."""
    s = get_settings()
    async with _internal_client() as client:
        await client.delete_object(Bucket=s.s3_bucket, Key=key)


async def object_exists(key: str) -> bool:
    """Used to verify an upload landed before associating the attachment with
    a message (Two-Phase commit on the message-send path)."""
    s = get_settings()
    async with _internal_client() as client:
        try:
            await client.head_object(Bucket=s.s3_bucket, Key=key)
            return True
        except client.exceptions.ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise
