"""Tests for session_tokens.py (DE 9 Block 1.G).

Coverage:
1. Issue + validate roundtrip → SessionClaims returned
2. Expired token → None
3. Tampered token (payload modified) → None
4. Wrong algorithm token → None
6. Different users get different tokens
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from dcc_chat_gateway.session_tokens import (
    SESSION_TTL_SECONDS,
    SessionClaims,
    issue_session_token,
    reset_session_signer,
    validate_session_token,
)


@pytest.fixture(autouse=True)
def _tmp_key(tmp_path):
    """Each test gets a fresh ephemeral key in a temp dir."""
    reset_session_signer()
    key_path = str(tmp_path / "session_signing.pem")
    yield key_path
    reset_session_signer()


# ---------------------------------------------------------------------------
# Roundtrip
# ---------------------------------------------------------------------------


def test_issue_and_validate_roundtrip(_tmp_key):
    """issue → validate returns correct SessionClaims."""
    token = issue_session_token("pairwise-sub-abc", "cert-uuid-123", key_path=_tmp_key)
    claims = validate_session_token(token, key_path=_tmp_key)
    assert isinstance(claims, SessionClaims)
    assert claims.user_identifier == "pairwise-sub-abc"
    assert claims.cert_id == "cert-uuid-123"
    assert claims.exp > int(time.time())
    assert claims.exp <= int(time.time()) + SESSION_TTL_SECONDS + 2


# ---------------------------------------------------------------------------
# Rejection cases
# ---------------------------------------------------------------------------


def test_expired_token_returns_none(_tmp_key):
    """Token with exp in the past → None."""
    # Issue a token then monkey-patch its exp by re-encoding with past exp
    from cryptography.hazmat.primitives import serialization
    from pathlib import Path
    import jwt as _jwt

    token = issue_session_token("user-x", "cert-y", key_path=_tmp_key)
    # Decode without verification to get the payload
    unverified = _jwt.decode(token, options={"verify_signature": False})
    unverified["exp"] = int(time.time()) - 10  # already expired

    # Re-sign with the same key
    pem = Path(_tmp_key).read_bytes()
    priv = serialization.load_pem_private_key(pem, password=None)
    expired_token = _jwt.encode(unverified, priv, algorithm="EdDSA")

    result = validate_session_token(expired_token, key_path=_tmp_key)
    assert result is None


def test_tampered_token_returns_none(_tmp_key):
    """Token with altered payload (breaks signature) → None."""
    token = issue_session_token("user-x", "cert-y", key_path=_tmp_key)
    # Flip a character in the payload segment
    header, payload, sig = token.split(".")
    tampered_payload = payload[:-4] + "XXXX"
    tampered_token = f"{header}.{tampered_payload}.{sig}"
    result = validate_session_token(tampered_token, key_path=_tmp_key)
    assert result is None


def test_wrong_algorithm_token_returns_none(_tmp_key):
    """Token signed with a different algorithm → None."""
    import jwt as _jwt
    import hashlib, hmac as _hmac

    # HS256 token with matching claims structure
    payload = {
        "iss": "pulse-self-host",
        "aud": "pulse-session",
        "sub": "attacker",
        "cert_id": "evil",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "typ": "session",
    }
    hs_token = _jwt.encode(payload, "not-the-right-key", algorithm="HS256")
    result = validate_session_token(hs_token, key_path=_tmp_key)
    assert result is None


# ---------------------------------------------------------------------------
# Redis storage
# ---------------------------------------------------------------------------


def test_different_users_get_different_tokens(_tmp_key):
    """Tokens for different users are not identical."""
    t_a = issue_session_token("user-a", "cert-1", key_path=_tmp_key)
    t_b = issue_session_token("user-b", "cert-1", key_path=_tmp_key)
    assert t_a != t_b


def test_ttl_ist_ueberschreibbar_und_bleibt_sonst_bei_fuenf_minuten(tmp_path):
    """Zwei Anmeldewege, zwei Fristen, eine Funktion.

    Die fuenf Minuten waren die Antwort auf die Zertifikats-Sperrliste: Ein
    widerrufenes Zertifikat sollte schnell wirken, also durfte keine Sitzung
    lange gelten. Der Cert-Weg behaelt sie, solange es ihn gibt. Der Ticket-Weg
    hat diese Sperrliste nicht mehr und setzt eine Stunde - sonst bliebe der
    stille Wiederanmelde-Sturm alle vier Minuten bestehen, der den ganzen Umbau
    ausgeloest hat.
    """
    from dcc_shared.session_tokens import (
        SESSION_TTL_SECONDS,
        issue_session_token,
        validate_session_token,
    )

    pfad = str(tmp_path / "session_signing.pem")
    kurz = issue_session_token("nutzer", "kein-cert", key_path=pfad)
    lang = issue_session_token("nutzer", "kein-cert", key_path=pfad, ttl_seconds=3600)

    k = validate_session_token(kurz, key_path=pfad)
    lg = validate_session_token(lang, key_path=pfad)
    assert k.exp - k.iat == SESSION_TTL_SECONDS
    assert lg.exp - lg.iat == 3600


# ---------------------------------------------------------------------------
# Bughunt 2026-09-20: Erststart-Rennen um den Signing-Key


def test_erststart_rennen_nimmt_gewinner_schluessel(_tmp_key, monkeypatch):
    """Zwei Services starten gleichzeitig ohne Schlüssel auf der Platte: der
    eine legt ihn an (O_EXCL gewinnt), der andere muss NACHladen — sonst
    signiert jeder Prozess mit seinem eigenen Schlüssel und jede Validierung
    läuft in 401. Hier gewinnt der "andere Prozess": er schreibt den
    gemeinsamen Schlüssel, während der lokale Pfad schon generiert hat."""
    from pathlib import Path

    from cryptography.hazmat.primitives import serialization

    import dcc_shared.session_tokens as st

    winner_pem = st._generate_ed25519_pem()
    original_generate = st._generate_ed25519_pem

    def generate_and_simulate_winner():
        # Der "andere Prozess" legt den gemeinsamen Schlüssel ab, bevor der
        # lokale Pfad sein eigenes O_EXCL-Create versucht → FileExistsError.
        Path(_tmp_key).write_bytes(winner_pem)
        return original_generate()

    monkeypatch.setattr(st, "_generate_ed25519_pem", generate_and_simulate_winner)
    reset_session_signer()
    try:
        key = st._load_or_generate_key(_tmp_key)
    finally:
        reset_session_signer()
    winner = serialization.load_pem_private_key(winner_pem, password=None)
    assert (
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        == winner.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
