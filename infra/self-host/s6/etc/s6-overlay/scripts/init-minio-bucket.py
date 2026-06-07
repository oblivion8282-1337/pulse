#!/usr/bin/env python3
"""Ensure the attachments bucket exists once MinIO is reachable.

Run as the ``minio-init`` s6 oneshot (ordered after the ``minio`` longrun).
This is the single-container equivalent of the prod ``minio-init`` sidecar
(infra/prod/docker-compose.yml), but without bundling MinIO's ``mc`` client:
the all-in-one venv already ships ``botocore`` + ``httpx`` (chat-gateway deps),
so we sign a plain SigV4 ``PUT /<bucket>`` ourselves — the same technique
``dcc_chat_gateway.s3.cluster_disk_info`` uses for the admin storageinfo call.

Idempotent and best-effort: HEADs the bucket first, treats an existing bucket
(200 / 409 BucketAlreadyOwnedByYou) as success, and on persistent failure logs
a warning and exits 0 rather than blocking the container — the bucket gets
re-ensured on every boot, so transient MinIO-not-up-yet states self-heal.
"""

from __future__ import annotations

import os
import sys
import time

import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

ENDPOINT = os.environ.get("S3_INTERNAL_ENDPOINT", "http://127.0.0.1:9000").rstrip("/")
BUCKET = os.environ.get("S3_BUCKET", "pulse-attachments")
REGION = os.environ.get("S3_REGION", "us-east-1")
ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")

DEADLINE_SECONDS = 90
URL = f"{ENDPOINT}/{BUCKET}"


def _signed_headers(method: str) -> dict:
    """SigV4-sign an empty-body request to the bucket URL (service ``s3``)."""
    creds = Credentials(ACCESS_KEY, SECRET_KEY)
    req = AWSRequest(method=method, url=URL, data=b"")
    # Empty body — admin/bucket ops carry none. Without this sigv4 would try to
    # sha256 a None body and fail.
    req.headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD"
    SigV4Auth(creds, "s3", REGION).add_auth(req)
    return dict(req.headers)


def _ensure_once(client: httpx.Client) -> bool:
    """One attempt. Returns True if the bucket exists/was created."""
    head = client.request("HEAD", URL, headers=_signed_headers("HEAD"))
    if head.status_code == 200:
        print(f"[minio-init] bucket '{BUCKET}' already exists")
        return True
    # us-east-1 needs no CreateBucketConfiguration body → empty PUT is valid.
    put = client.request("PUT", URL, headers=_signed_headers("PUT"))
    if put.status_code in (200, 204):
        print(f"[minio-init] bucket '{BUCKET}' created")
        return True
    if put.status_code == 409:  # BucketAlreadyOwnedByYou / BucketAlreadyExists
        print(f"[minio-init] bucket '{BUCKET}' already present (409)")
        return True
    print(f"[minio-init] unexpected PUT status {put.status_code}: {put.text[:200]}")
    return False


def main() -> int:
    if not ACCESS_KEY or not SECRET_KEY:
        print("[minio-init] WARN: S3_ACCESS_KEY/S3_SECRET_KEY unset — skipping")
        return 0
    deadline = time.monotonic() + DEADLINE_SECONDS
    with httpx.Client(timeout=5.0) as client:
        while True:
            try:
                if _ensure_once(client):
                    return 0
            except Exception as exc:  # noqa: BLE001 — MinIO not up yet, retry
                print(f"[minio-init] waiting for MinIO: {exc}")
            if time.monotonic() > deadline:
                print(
                    "[minio-init] WARN: bucket not ensured within "
                    f"{DEADLINE_SECONDS}s — will retry on next boot"
                )
                return 0  # best-effort: don't block the container
            time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
