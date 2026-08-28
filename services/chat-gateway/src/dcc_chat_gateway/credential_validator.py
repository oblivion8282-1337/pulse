"""Die Cloud-Schlüssel und die alte Pseudonym-Rechnung.

Bis zum 2026-08-28 hiess dieses Modul mit Recht ``credential_validator``: Es
prüfte Gerätezertifikate — Signatur, Sperrliste, Ablauf — und stellte die
Challenge-Mechanik für die Anmeldung bereit. Das ist alles entfallen.

Übrig sind zwei Dinge:

* **``_get_jwks_keys``** — die öffentlichen Schlüssel der Cloud, mit denen ein
  Self-Host Serverticket und Betreiber-Check prüft. Warmgehalten vom
  ``jwks_poller``.
* **``compute_pairwise_sub``** — die Rechnung, aus der die alte, serverabhängige
  Kennung entstand. Sie wird nicht mehr für neue Anmeldungen gebraucht, aber die
  Cloud muss sie kennen, um Bestandszeilen zuzuordnen (``server_ticket.legacy_uid``
  und ``identitaet_umschreiben``). Sie fällt mit der letzten Umschreibung.

``REDIS_REVOKED_SET`` steht noch hier, weil ein Bestands-Redis den Schlüssel
tragen kann; gelesen wird er nirgends mehr.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from dcc_chat_gateway.config import get_settings
from jwt.algorithms import RSAAlgorithm
from pydantic import BaseModel

# Redis key constants (mirrors auth-svc + jwks_poller)
REDIS_JWKS_KEY = "auth:jwks:cached"
# Self-host validates Cloud-SIGNED certs whose kid lives in the *Cloud's* JWKS,
# not the local auth-svc JWKS. The jwks_poller warms this key from
# ``{pulse_cloud_origin}/.well-known/jwks.json``. Cloud mode validates its own
# certs and uses REDIS_JWKS_KEY (which IS the Cloud's on a Cloud deployment).
REDIS_CLOUD_JWKS_KEY = "auth:cloud_jwks:cached"
REDIS_REVOKED_SET = "auth:revoked:certs"

# Challenge size in bytes (DE 11 A.7)
CHALLENGE_BYTES = 32


def _build_pubkey_from_jwks(jwks_json: str) -> dict[str, Any]:
    """Parse a JWKS JSON string into a kid→RSAPublicKey mapping."""
    keys: dict[str, Any] = {}
    jwks = json.loads(jwks_json)
    for key_dict in jwks.get("keys", []):
        kid = key_dict.get("kid")
        if not kid:
            continue
        keys[kid] = RSAAlgorithm.from_jwk(key_dict)
    return keys


async def _get_jwks_keys(redis: Any) -> dict[str, Any]:
    """Fetch the cert-signing JWKS from the Redis cache (JSON string).

    Self-host reads the Cloud JWKS (``auth:cloud_jwks:cached``, warmed by the
    jwks_poller from the Cloud) because certs are Cloud-signed; Cloud mode reads
    the local cache (``auth:jwks:cached``), which IS the Cloud's own JWKS there.

    Returns an empty dict when the cache is cold — validator will return None
    (fail-closed) rather than fetch from the network itself.
    """
    cache_key = (
        REDIS_CLOUD_JWKS_KEY
        if get_settings().pulse_instance_mode == "self-host"
        else REDIS_JWKS_KEY
    )
    raw = await redis.get(cache_key)
    if not raw:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode()
    try:
        return _build_pubkey_from_jwks(raw)
    except Exception:  # noqa: BLE001
        return {}


def compute_pairwise_sub(user_id: str, instance_id: int, pairwise_seed: str) -> str:
    """Compute the pairwise subject for a self-host instance (DE 11 A.4).

    pairwise_sub = base64url(HMAC-SHA256(user_id || ":" || instance_id,
                                          pairwise_seed_bytes))[:16]

    ``pairwise_seed`` is the Base64url-encoded per-user seed from the Cert.
    Result is 16 hex chars of the HMAC, stable across devices (same user_id,
    same instance_id, same pairwise_seed → same sub).
    """
    try:
        key = base64.urlsafe_b64decode(pairwise_seed + "==")
    except Exception:  # noqa: BLE001
        # Non-base64 seed — treat as raw UTF-8 bytes
        key = pairwise_seed.encode()
    msg = f"{user_id}:{instance_id}".encode()
    digest = hmac.new(key, msg, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()[:16]


