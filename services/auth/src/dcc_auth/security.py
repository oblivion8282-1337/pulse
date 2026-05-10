"""JWT signing/verification and password hashing helpers."""

from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey

from dcc_auth.config import get_settings

# Argon2id parameters (Discord-clone defaults; PLAN.md Section 11):
#   t=3 iterations, m=64 MiB, p=4 parallelism.
_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4)


def hash_password(plaintext: str) -> str:
    return _hasher.hash(plaintext)


def verify_password(plaintext: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plaintext)
    except (VerifyMismatchError, InvalidHashError):
        return False


def needs_rehash(hashed: str) -> bool:
    return _hasher.check_needs_rehash(hashed)


def _b64url_uint(value: int) -> str:
    byte_len = (value.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(value.to_bytes(byte_len, "big")).rstrip(b"=").decode()


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    refresh_jti: uuid.UUID
    refresh_expires_at: int  # unix ts


class JwtSigner:
    """Wraps an RS256 private key and signs Discord-clone JWTs."""

    def __init__(self) -> None:
        s = get_settings()
        self._settings = s
        self._private_pem = s.load_private_key().encode()
        self._public_pem = s.load_public_key().encode()
        self._private_key: RSAPrivateKey = serialization.load_pem_private_key(
            self._private_pem, password=None
        )
        self._public_key: RSAPublicKey = serialization.load_pem_public_key(self._public_pem)

    @property
    def public_pem(self) -> bytes:
        return self._public_pem

    @property
    def public_key(self) -> RSAPublicKey:
        return self._public_key

    def jwks(self) -> dict[str, Any]:
        numbers = self._public_key.public_numbers()
        return {
            "keys": [
                {
                    "kty": "RSA",
                    "use": "sig",
                    "alg": "RS256",
                    "kid": self._settings.jwt_key_id,
                    "n": _b64url_uint(numbers.n),
                    "e": _b64url_uint(numbers.e),
                }
            ]
        }

    def _sign(self, payload: dict[str, Any]) -> str:
        return jwt.encode(
            payload,
            self._private_key,
            algorithm="RS256",
            headers={"kid": self._settings.jwt_key_id},
        )

    def issue_access(self, user_id: int, username: str) -> str:
        now = int(time.time())
        payload = {
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.jwt_audience,
            "sub": str(user_id),
            "username": username,
            "iat": now,
            "exp": now + self._settings.jwt_access_ttl_seconds,
            "typ": "access",
        }
        return self._sign(payload)

    def issue_refresh(self, user_id: int) -> tuple[str, uuid.UUID, int]:
        now = int(time.time())
        jti = uuid.uuid4()
        exp = now + self._settings.jwt_refresh_ttl_seconds
        payload = {
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.jwt_audience,
            "sub": str(user_id),
            "iat": now,
            "exp": exp,
            "jti": str(jti),
            "typ": "refresh",
        }
        return self._sign(payload), jti, exp

    def decode(self, token: str, *, expected_type: str | None = None) -> dict[str, Any]:
        payload = jwt.decode(
            token,
            self._public_key,
            algorithms=["RS256"],
            audience=self._settings.jwt_audience,
            issuer=self._settings.jwt_issuer,
        )
        if expected_type and payload.get("typ") != expected_type:
            raise jwt.InvalidTokenError(f"unexpected token type: {payload.get('typ')}")
        return payload


_signer: JwtSigner | None = None


def get_signer() -> JwtSigner:
    global _signer
    if _signer is None:
        _signer = JwtSigner()
    return _signer


def reset_signer() -> None:
    """Reset cached signer (used in tests when keys change)."""
    global _signer
    _signer = None
