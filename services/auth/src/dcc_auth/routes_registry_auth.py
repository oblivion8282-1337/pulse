"""Docker-Registry-v2-Token-Auth-Realm für die Self-Host-allinone-Registry.

``GET /registry/token`` — die Registry (``registry.howispulse.com``) leitet den
Docker-Daemon hierher (``auth.token.realm``), wenn ein Pull/Push unauthentifiziert
ankommt. Der Daemon schickt Basic-Credentials:

* **Instanz-Pfad:** ``client_id:client_secret`` der Instanz (Argon2id verifiziert
  gegen ``RegisteredInstance``) + ``status=="active"`` → **Pull**-scoped JWT.
  Suspended/deleted → 403.
* **CI-Pfad:** ``pulse-ci:<REGISTRY_PUSH_TOKEN>`` (Service-Secret) → **Pull+Push**-
  scoped JWT (damit ``allinone.yml`` publishen kann).

Sicherheitsmodell
-----------------
* ``repo`` wird serverseitig IMMER auf ``pulse-allinone`` gezwungen
  (Single-Image-Registry, defense-in-depth).
* Instanzen bekommen **nie** ``push``, selbst wenn angefordert.
* Rate-limited per IP. Creds/Token werden NIE geloggt (gleiche Disziplin wie
  Bootstrap).
* Phase-3-Hook: der ``status=="active"``-Check wird später zu
  ``status=="active" and subscription_valid()`` (Stripe). Die Stelle ist
  markiert.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes import _check_rate
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.security import get_signer, verify_dummy_password, verify_password

# Realm-Endpoint ist cloud-only: nur die Cloud hält registered_instances und
# provisioniert das Signier-Cert. Auf Self-Host-Deploys 403 (Defense-in-Depth).
router = APIRouter(tags=["registry"], dependencies=[Depends(_require_cloud)])

CI_USERNAME = "pulse-ci"
REGISTRY_REPO = "pulse-allinone"  # Single-Image-Registry; Repo serverseitig erzwungen.
TOKEN_TTL_SECONDS = 300


class RegistryTokenOut(BaseModel):
    token: str
    access_token: str
    expires_in: int
    issued_at: str


def _parse_basic(authorization: str | None) -> tuple[str, str] | None:
    """Liefert (username, password) aus einem ``Basic``-Header oder None."""
    if not authorization or not authorization.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(authorization[6:].strip()).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    if ":" not in decoded:  # Passwort darf leer sein, der Trenner muss da sein.
        return None
    user, _, password = decoded.partition(":")
    return user, password


def _ci_actions(scope: str | None) -> list[str]:
    """Scope für CI auf pull/push gefiltert; Default pull+push."""
    requested = {"pull", "push"}
    if scope:
        parts = scope.split(":")
        if len(parts) == 3:
            requested = {a for a in parts[2].split(",") if a in ("pull", "push")} or {"pull", "push"}
    # Reihenfolge deterministisch halten (pull vor push).
    return [a for a in ("pull", "push") if a in requested]


@router.get("/registry/token", response_model=RegistryTokenOut)
async def registry_token(
    request: Request,
    db: SessionDep,
    authorization: Annotated[str | None, Header()] = None,
    service: Annotated[str | None, Query()] = None,  # noqa: ARG001 — Aud im Token ist maßgeblich.
    scope: Annotated[str | None, Query()] = None,
) -> RegistryTokenOut:
    settings = get_settings()
    await _check_rate(request, "registry_token", settings.rate_limit_registry_token)

    creds = _parse_basic(authorization)
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing credentials")
    username, password = creds

    signer = get_signer()

    if username == CI_USERNAME:
        # CI-Push-Pfad: Service-Secret → pull+push.
        push_token = settings.registry_push_token
        if not push_token or not hmac.compare_digest(password, push_token):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
        actions = _ci_actions(scope)
        jwt_token = signer.issue_registry_token(
            sub=CI_USERNAME, actions=actions, repo=REGISTRY_REPO, ttl=TOKEN_TTL_SECONDS
        )
    else:
        # Instanz-Pfad: client_id + client_secret (Argon2id) + status active.
        row = (
            await db.execute(
                select(RegisteredInstance).where(RegisteredInstance.client_id == username)
            )
        ).scalar_one_or_none()
        if row is None:
            # Timing-Equalizer: Dummy-Verify, sonst ist „client_id existiert"
            # über die Antwortzeit unterscheidbar (schnell vs. langsamer Argon2).
            verify_dummy_password(password)
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
        # Argon2id ist teuer → in den Threadpool, damit der Event-Loop frei bleibt.
        valid = await asyncio.to_thread(verify_password, password, row.client_secret)
        if not valid:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
        # Phase-3-Hook: hier später ``and subscription_valid()`` ergänzen (Stripe).
        if row.status != "active":  # suspended ODER deleted
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance is not available")
        # Instanzen bekommen NUR pull, niemals push — angefordertes Scope wird
        # ignoriert (defense-in-depth gegen verteilte Push-Rechte).
        jwt_token = signer.issue_registry_token(
            sub=str(row.id), actions=["pull"], repo=REGISTRY_REPO, ttl=TOKEN_TTL_SECONDS
        )

    return RegistryTokenOut(
        token=jwt_token,
        access_token=jwt_token,
        expires_in=TOKEN_TTL_SECONDS,
        issued_at=datetime.now(UTC).isoformat(),
    )
