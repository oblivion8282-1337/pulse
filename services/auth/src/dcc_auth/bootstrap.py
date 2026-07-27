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

from sqlalchemy import delete, select

from dcc_auth.models_instances import InstanceBootstrapToken

# Erkennbares Präfix — taucht im Installer-Befehl + Shell-History auf, hilft
# beim Zuordnen/Grep, ist aber kein Geheimnis-Bestandteil.
TOKEN_PREFIX = "plse_boot_"


def generate_bootstrap_token() -> str:
    """Frischer One-Time-Token: ``plse_boot_<43 url-safe chars>``."""
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_bootstrap_token(token: str) -> str:
    """SHA-256-Hex des Tokens — genau das wird in der DB gespeichert/verglichen."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def bootstrap_redeemed(db, instance_id: int) -> bool:
    """Wurde fuer diese Instanz je ein Bootstrap-Token eingeloest?

    Das ist die Frage „ist dieser Server schon einmal versorgt worden" — und
    sie muss BEIDE Wege kennen. Der Schnellinstaller und der ``.env``-Download
    liefern dieselben Cloud-Credentials und rotieren beim Ausstellen dasselbe
    ``client_secret``; wer den zweiten Weg nimmt, macht den ersten tot.
    Bis 2026-07-27 wussten die beiden nichts voneinander: brach der Installer
    NACH dem Einloesen ab (Container startet nicht, TLS scheitert), lagen die
    gueltigen Zugangsdaten laengst auf dem Server — und ein anschliessender
    ``.env``-Download rotierte sie wortlos weg. Aus einem halb geglueckten
    Setup wurde so ein sicher kaputtes.
    """
    row = await db.execute(
        select(InstanceBootstrapToken.id)
        .where(
            InstanceBootstrapToken.instance_id == instance_id,
            InstanceBootstrapToken.consumed_at.is_not(None),
        )
        .limit(1)
    )
    return row.scalar_one_or_none() is not None


async def drop_unredeemed_tokens(db, instance_id: int) -> None:
    """Uneingeloeste Tokens dieser Instanz entwerten.

    Wird von JEDER Credential-Ausgabe aufgerufen — Mint wie ``.env``-Download.
    Sonst bleibt nach einem abgebrochenen Installer-Lauf ein gueltiges Token
    bis zu seiner Ablaufzeit liegen; wird es spaeter doch noch eingeloest
    (zweiter Versuch, zweites Terminal, Scrollback), rotiert es das Secret
    erneut und erschlaegt die inzwischen verteilte ``.env``.
    """
    await db.execute(
        delete(InstanceBootstrapToken).where(
            InstanceBootstrapToken.instance_id == instance_id,
            InstanceBootstrapToken.consumed_at.is_(None),
        )
    )
