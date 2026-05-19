"""Symmetric encryption for at-rest secrets the admin enters via the UI.

Currently used for the SMTP password in ``smtp_settings``. Fernet
(AES-128-CBC + HMAC-SHA256, timestamped) is fine for this use case — the
threat model is "DB dump should not leak the SMTP password", not "defend
against a state-level adversary with side-channel access".

The Fernet key is **derived** from the JWT private key via HKDF-SHA256.
That means:

* No new secret to manage / rotate — piggybacks on the operator's existing
  key-management story for the JWT signer.
* Rotating the JWT keypair (which an operator might do during incident
  response) renders the stored ciphertext unreadable; the admin then
  re-enters the SMTP password through the UI. This is acceptable: rotating
  signing material on a security incident invalidating session-state-like
  secrets is the *expected* behaviour, not a regression.
* The ``info=`` separator prevents accidental key-reuse if we add more
  encryption contexts later — each one binds its own HKDF info string.

Never log or surface the derived key; ``cryptography``'s objects already
opaque-print, but be careful with debug breakpoints.
"""

from __future__ import annotations

import base64
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from dcc_auth.config import get_settings

_HKDF_INFO = b"dcc-auth smtp-password v1"
_HKDF_SALT = b"dcc-auth fernet-derive"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    """Build the Fernet instance once per process.

    Cached because HKDF + PEM-parse cost adds up if we did it per-message,
    and the key never changes within a process lifetime (the JWT private
    key is loaded once at startup).
    """
    settings = get_settings()
    ikm = settings.load_private_key().encode("utf-8")
    raw = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=_HKDF_INFO,
    ).derive(ikm)
    return Fernet(base64.urlsafe_b64encode(raw))


def encrypt_secret(plaintext: str) -> str:
    """Encrypt UTF-8 ``plaintext`` to a base64-Fernet token (str).

    Empty input → empty output, so callers can store "no password set"
    without a sentinel.
    """
    if plaintext == "":
        return ""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    """Decrypt a Fernet token back to a UTF-8 string.

    Returns ``""`` for ``""`` input. Raises ``cryptography.fernet.InvalidToken``
    if the JWT key was rotated (or the ciphertext was tampered with) — the
    caller should treat that as "SMTP not configured" and surface a clear
    admin-facing message.
    """
    if token == "":
        return ""
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")


__all__ = ["decrypt_secret", "encrypt_secret", "InvalidToken"]
