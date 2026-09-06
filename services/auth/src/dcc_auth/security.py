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

# Pre-computed Argon2id hash of a throwaway password, used to equalize login
# timing for non-existent users. Verifying against it costs the same as a real
# verify, so the response time does not reveal whether an account exists.
_DUMMY_HASH = _hasher.hash("pulse-login-timing-equalizer")


def hash_password(plaintext: str) -> str:
    return _hasher.hash(plaintext)


def verify_password(plaintext: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plaintext)
    except (VerifyMismatchError, InvalidHashError):
        return False


def verify_dummy_password(plaintext: str) -> None:
    """Verify against a throwaway hash to equalize login timing.

    Called on the non-existent-user path so an attacker cannot distinguish
    "account does not exist" (fast) from "account exists" (slow Argon2 verify)
    by response time. The result is intentionally discarded.
    """
    try:
        _hasher.verify(_DUMMY_HASH, plaintext)
    except (VerifyMismatchError, InvalidHashError):
        pass


def needs_rehash(hashed: str) -> bool:
    return _hasher.check_needs_rehash(hashed)


def _b64url_uint(value: int) -> str:
    byte_len = (value.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(value.to_bytes(byte_len, "big")).rstrip(b"=").decode()


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
        # Registry-Token-Auth: self-signed x509-Cert (PEM), das dasselbe
        # RSA-Keypair wrapt. ``_cert_b64`` (Standard-base64 des DER-Certs)
        # landet als ``x5c``-Header in Registry-Tokens; None (Cert fehlt) →
        # issue_registry_token() lehnt ab. Lazy + fehlertolerant: nur die Cloud
        # (mit provisioniertem Cert) mintet Registry-Tokens, der Endpoint ist
        # ohnehin _require_cloud-gated.
        self._cert_b64: str | None = None
        cert_path = s.jwt_cert_file
        if cert_path.exists():
            from cryptography import x509

            cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
            self._cert_b64 = base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()

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

    def _sign(
        self, payload: dict[str, Any], *, extra_headers: dict[str, Any] | None = None
    ) -> str:
        headers: dict[str, Any] = {"kid": self._settings.jwt_key_id}
        if extra_headers:
            headers.update(extra_headers)
        return jwt.encode(
            payload,
            self._private_key,
            algorithm="RS256",
            headers=headers,
        )

    def issue_access(
        self,
        user_id: int,
        username: str,
        *,
        is_admin: bool = False,
        is_owner: bool = False,
        email_blocked: bool = False,
    ) -> str:
        now = int(time.time())
        payload: dict[str, Any] = {
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.jwt_audience,
            "sub": str(user_id),
            "username": username,
            "iat": now,
            "exp": now + self._settings.jwt_access_ttl_seconds,
            "typ": "access",
        }
        # Only stamp the admin claim when it's true — keeps tokens smaller for
        # the 99% case and makes the absence semantically equivalent to false.
        if is_admin:
            payload["admin"] = True
        # ``owner`` = the single Cloud operator (auth-svc ``is_owner``). Stamped
        # only when true (absence == false, like ``admin``) so chat-gateway can
        # gate owner-only routes (cloud-wide community oversight, emergency
        # reported-content access) without calling back into auth-svc.
        if is_owner:
            payload["owner"] = True
        # ``email_blocked`` carries the *resolved* email-verification gate
        # decision (SMTP configured AND the account still unverified). Stamped
        # only when the user is blocked, so absence == allowed. chat-gateway
        # and voice-signaling reject tokens that carry it — they never need to
        # know about SMTP state themselves.
        if email_blocked:
            payload["email_blocked"] = True
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

    def reissue_refresh(self, user_id: int, jti: uuid.UUID, exp: int) -> str:
        """Einen BEREITS ausgestellten Refresh-Token noch einmal ausgeben.

        Gebraucht von ``/refresh``, wenn die Antwort einer Rotation den Klienten
        nie erreicht hat: er legt dann seinen alten Token erneut vor, und die
        richtige Antwort ist derselbe Nachfolger, den er schon haette haben
        sollen — nicht ein zweiter daneben, der die Kette gabeln wuerde.

        ``jti`` und ``exp`` kommen aus der Datenbankzeile, sind also unveraendert;
        der Token ist damit derselbe Ausweis, nicht bloss ein aehnlicher.
        Neu signiert werden muss er trotzdem, weil hier niemand den JWT-Text
        aufbewahrt — gespeichert ist nur, DASS es ihn gibt (``jti``), nie sein
        Inhalt. Einzig ``iat`` faellt dadurch spaeter aus als beim ersten Mal;
        die Zahl wird nirgends geprueft (``decode`` verlangt ``exp``/``aud``/
        ``iss``/``typ``), und die Lebensdauer haengt allein am uebergebenen
        ``exp``, laesst sich also nicht verlaengern.
        """
        payload = {
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.jwt_audience,
            "sub": str(user_id),
            "iat": int(time.time()),
            "exp": exp,
            "jti": str(jti),
            "typ": "refresh",
        }
        return self._sign(payload)

    def issue_gast(
        self,
        *,
        gast_id: str,
        guild_id: str,
        channel_id: str,
        name: str,
        ttl_s: int,
    ) -> str:
        """Gast-Ticket für einen Sprachkanal (``typ="gast"``).

        Ein Gast hat KEIN Konto. Das Ticket ist seine ganze Identität und
        gilt für **genau einen Kanal** — jede Route, die es annimmt,
        vergleicht ``channel_id`` gegen den angefragten Kanal.

        Warum auth-svc das ausstellt, obwohl es von Kanälen nichts weiß:
        es ist der einzige Dienst mit dem RS256-Schlüssel, und dessen
        JWKS ist das einzige Vertrauensverhältnis, das chat-gateway,
        voice-signaling UND media-svc in BEIDEN Betriebsarten (Cloud wie
        Self-Host) schon haben. Der Ed25519-Sitzungsschlüssel schiede aus:
        in der Cloud liegt er allein im chat-gateway-Volume.

        ``aud`` ist derselbe wie beim Access-Token — die Empfänger sind
        dieselben Dienste. Getrennt werden die beiden über ``typ``, und
        zwar fail-closed: der normale Weg (``decode(expected_type=
        "access")``) weist ein Gast-Ticket ab, ohne dass hier etwas
        dazugetan werden muss.
        """
        now = int(time.time())
        payload: dict[str, Any] = {
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.jwt_audience,
            "sub": gast_id,
            "guild_id": guild_id,
            "channel_id": channel_id,
            "name": name,
            "iat": now,
            "exp": now + ttl_s,
            "jti": str(uuid.uuid4()),
            "typ": "gast",
        }
        return self._sign(payload)

    def issue_registry_token(
        self,
        *,
        sub: str,
        actions: list[str],
        repo: str = "pulse-allinone",
        ttl: int = 300,
    ) -> str:
        """Docker-Registry-v2-Token (RS256) für die Self-Host-allinone-Registry.

        ``aud`` ist bewusst ``registry_service`` (NICHT der access-default
        ``dcc``), damit registry:2 den Token akzeptiert (aud == service). Das
        self-signed-Cert wandert als ``x5c``-Header in den Token — registry:2
        verifiziert die Signatur darüber (rootcertbundle parst nur
        CERTIFICATE-Blöcke, ein roher PUBLIC KEY wird still ignoriert).
        ``access`` folgt der Distribution-Spec: ``[{type, name, actions}]``.
        """
        if self._cert_b64 is None:
            raise RuntimeError(
                "jwt_cert_file fehlt/unlesbar — Registry-Token-Issuance deaktiviert "
                "(ops muss das self-signed Cert neben den JWT-Keys provisionieren)"
            )
        now = int(time.time())
        payload: dict[str, Any] = {
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.registry_service,
            "sub": sub,
            "iat": now,
            "nbf": now,
            "exp": now + ttl,
            "jti": str(uuid.uuid4()),
            "access": [{"type": "repository", "name": repo, "actions": actions}],
        }
        return self._sign(payload, extra_headers={"x5c": [self._cert_b64]})

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
