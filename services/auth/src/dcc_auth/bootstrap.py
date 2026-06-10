"""Helfer für One-Time-Bootstrap-Tokens des Self-Host-Installers.

Geteilt zwischen Mint-Endpoint (``routes_instance_applications``) und
Redeem-Endpoint (``routes_selfhost_bootstrap``), damit Token-Format und
Hash-Verfahren nicht auseinanderdriften.

Der Token ist hochentropisch (256 bit) → ein schneller SHA-256-Hash genügt
(kein Argon2 wie bei Passwörtern); verglichen wird konstanter-Zeit über den
Hex-Digest. Klartext wird nie persistiert.
"""

from __future__ import annotations

import hashlib
import secrets

# Erkennbares Präfix — taucht im Installer-Befehl + Shell-History auf, hilft
# beim Zuordnen/Grep, ist aber kein Geheimnis-Bestandteil.
TOKEN_PREFIX = "plse_boot_"


def generate_bootstrap_token() -> str:
    """Frischer One-Time-Token: ``plse_boot_<43 url-safe chars>``."""
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_bootstrap_token(token: str) -> str:
    """SHA-256-Hex des Tokens — genau das wird in der DB gespeichert/verglichen."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
