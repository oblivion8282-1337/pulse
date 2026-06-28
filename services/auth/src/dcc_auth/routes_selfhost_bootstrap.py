"""Öffentlicher Redeem-Endpoint für den Ein-Befehl-Self-Host-Installer.

``POST /selfhost/bootstrap`` — das Install-Script auf dem Self-Host-Server löst
hiermit den vom Owner geminteten One-Time-Token ein. Antwort enthält die für
den Container nötigen Pairing-Werte **einmalig**.

Sicherheitsmodell
-----------------
* Token ist single-use + kurzlebig (Mint setzt TTL) → der Redeem markiert ihn
  sofort als ``consumed`` (FOR UPDATE serialisiert Doppel-Einlösungen).
* **Rotate-on-Bootstrap:** Beim Einlösen wird das ``client_secret`` der Instanz
  frisch generiert + nur als Argon2-Hash gespeichert; der Klartext geht
  **ausschließlich** hier in der Antwort raus. So liegt nie ein Klartext-Secret
  in der Cloud, und Re-Installs sind beliebig oft möglich.
* Rate-limited per IP. Token/Secret werden NIE geloggt.
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_auth.bootstrap import TOKEN_PREFIX, hash_bootstrap_token
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceBootstrapToken,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.relay import allocate_relay_subdomain, generate_relay_token, hash_relay_token
from dcc_auth.routes import _check_rate
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.security import hash_password

# Bootstrap-Tokens werden ausschließlich von der Cloud geminted → der Redeem
# ergibt nur auf der Cloud Sinn. Auf Self-Host-Deploys 403 (Defense-in-Depth,
# gleiche Gating-Logik wie die Instanz-Verwaltung).
router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


class BootstrapCredsOut(BaseModel):
    instance_id: str
    owner_user_id: str
    hostname: str
    client_id: str
    client_secret: str
    cloud_origin: str
    admin_email: str | None = None
    relay_subdomain: str | None = None
    relay_server_addr: str | None = None
    relay_tunnel_token: str | None = None


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bootstrap token")
    token = authorization[7:].strip()
    if not token.startswith(TOKEN_PREFIX):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid bootstrap token")
    return token


@router.post("/selfhost/bootstrap", response_model=BootstrapCredsOut)
async def redeem_bootstrap_token(
    request: Request,
    db: SessionDep,
    authorization: Annotated[str | None, Header()] = None,
) -> BootstrapCredsOut:
    """Löst einen One-Time-Bootstrap-Token gegen frische Pairing-Credentials ein."""
    settings = get_settings()
    await _check_rate(request, "bootstrap_redeem", settings.rate_limit_bootstrap_redeem)

    token = _extract_bearer(authorization)
    token_hash = hash_bootstrap_token(token)

    # FOR UPDATE serialisiert parallele Einlösungen desselben Tokens.
    row = (
        await db.execute(
            select(InstanceBootstrapToken)
            .where(InstanceBootstrapToken.token_hash == token_hash)
            .with_for_update()
        )
    ).scalar_one_or_none()

    now = datetime.now(UTC)
    # SQLite (Tests) gibt DateTime(timezone=True) naiv zurück → als UTC behandeln.
    expires_at = row.expires_at if row is not None else None
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if row is None or row.consumed_at is not None or expires_at <= now:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="bootstrap token invalid or expired"
        )

    instance = await db.get(RegisteredInstance, row.instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status != "active":
        # suspended ODER vom Owner gelöscht (routes_instance_delete).
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance is not available")

    # Token verbrennen + Secret rotieren (Klartext nur in der Antwort).
    row.consumed_at = now
    new_secret = secrets.token_urlsafe(32)
    instance.client_secret = await asyncio.to_thread(hash_password, new_secret)

    # ②a Relay-Provisionierung: nur wenn ein Relay-Server konfiguriert ist.
    # Subdomain wird einmalig vergeben (stabil), der Tunnel-Token bei jedem
    # Redeem rotiert (Klartext nur in der Antwort; DB hält nur den Hash).
    relay_subdomain: str | None = None
    relay_token_plain: str | None = None
    if settings.pulse_relay_server_addr:
        if instance.relay_subdomain is None:
            instance.relay_subdomain = await allocate_relay_subdomain(
                db, settings.pulse_relay_base_domain
            )
        relay_subdomain = instance.relay_subdomain
        relay_token_plain = generate_relay_token()
        instance.relay_tunnel_token_hash = hash_relay_token(relay_token_plain)

    owner = await db.get(User, instance.registered_by)
    admin_email = owner.email if owner is not None else None

    # Owner-Membership in der Cloud tracken (= Account-basierte Server-Liste,
    # ersetzt den Zero-Knowledge-Vault). Die Genehmigung legt sie bereits an;
    # bei wiederholtem Redeem (oder einem vor diesem Fix genehmigten Antrag)
    # existiert sie ggf. schon → nur einfügen, wenn noch keine da ist (ein
    # blindes INSERT würde am Composite-PK mit IntegrityError crashen).
    existing_membership = await db.get(
        UserInstanceMembership, (instance.registered_by, instance.id)
    )
    if existing_membership is None:
        db.add(
            UserInstanceMembership(
                user_id=instance.registered_by,
                instance_id=instance.id,
                role="owner",
            )
        )

    await db.commit()

    return BootstrapCredsOut(
        instance_id=str(instance.id),
        owner_user_id=str(instance.registered_by),
        hostname=instance.hostname,
        client_id=instance.client_id,
        client_secret=new_secret,
        cloud_origin=settings.pulse_oidc_issuer,
        admin_email=admin_email,
        relay_subdomain=relay_subdomain,
        relay_server_addr=settings.pulse_relay_server_addr or None,
        relay_tunnel_token=relay_token_plain,
    )
