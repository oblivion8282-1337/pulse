"""Relay-Provisionierung (②a): Slug-Subdomain + Tunnel-Token-Helfer.

Der Tunnel-Token wird NUR als SHA-256-Hash gespeichert; der Klartext geht
einmalig über die Bootstrap-Antwort an den Host. Validierung gegen den Hash
über ``routes_selfhost_relay``.
"""

from __future__ import annotations

import hashlib
import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models_instances import RegisteredInstance

RELAY_TOKEN_PREFIX = "plse_relay_"

# Kurze, neutrale Wortlisten — lesbarer, privacy-wahrender Slug (keine ID-Leaks).
_ADJ = (
    "brave", "calm", "clever", "eager", "gentle", "happy", "keen", "lively",
    "merry", "nimble", "polite", "quiet", "rapid", "shiny", "swift", "witty",
)
_NOUN = (
    "otter", "falcon", "maple", "river", "cedar", "harbor", "meadow", "comet",
    "pebble", "willow", "lantern", "garnet", "sparrow", "thistle", "beacon", "cobalt",
)


def generate_relay_slug() -> str:
    """``<adjektiv>-<nomen>-<4 hex>`` — z.B. ``brave-otter-4f2a``."""
    return f"{secrets.choice(_ADJ)}-{secrets.choice(_NOUN)}-{secrets.token_hex(2)}"


async def allocate_relay_subdomain(db: AsyncSession, base_domain: str) -> str:
    """Erzeugt eine freie volle Subdomain ``<slug>.<base_domain>``.

    Prüft gegen ``registered_instances.relay_subdomain``. Bis zu 10 Versuche;
    danach ``RuntimeError`` (praktisch unerreichbar bei 16*16*65536 Slugs).
    """
    for _ in range(10):
        candidate = f"{generate_relay_slug()}.{base_domain}"
        exists = (
            await db.execute(
                select(RegisteredInstance.id).where(
                    RegisteredInstance.relay_subdomain == candidate
                )
            )
        ).first()
        if exists is None:
            return candidate
    raise RuntimeError("could not allocate a free relay subdomain")


def generate_relay_token() -> str:
    """Frischer Tunnel-Token: ``plse_relay_<43 url-safe chars>``."""
    return RELAY_TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_relay_token(token: str) -> str:
    """SHA-256-Hex des Tokens — genau das wird gespeichert/verglichen."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
