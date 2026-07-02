"""App-Host-Instanz-Provisionierung.

Erzeugt eine Relay-Instanz (``RegisteredInstance`` + Owner-``UserInstance
Membership``) bei der App-Host-Genehmigung — damit der User sofort aus der App
hosten kann, ohne separaten VPS-Antrag.

Unterschied zum VPS-Flow (``routes_admin_instances``): hier gibt es **keinen**
vom User gewählten Hostname und **kein** dem User gezeigtes ``client_secret``.
App-Hosting läuft über den Relay — die echte öffentliche Adresse
(``relay_subdomain``) wird erst beim Pairing/Bootstrap-Redeem alloziert. Der
``hostname`` ist daher synthetisch (``app-<snowflake>.<relay_base>``) und nur
eine eindeutige Pflicht-Kennung.
"""

from __future__ import annotations

import asyncio
import secrets

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.routes_admin_instances import _allocate_worker_ids
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id


async def user_has_active_owner_instance(session: AsyncSession, user_id: int) -> bool:
    """True, wenn der User bereits eine aktive App-Host-Instanz besitzt.

    Idempotenz-Sperre des Approve-Pfads (zusätzlich zum Pending-Status-Guard).
    VPS-Instanzen zählen seit Migration 0040 NICHT mehr: die App-Hosting-Karte
    bietet nur ``origin == 'app_host'`` an (Pairing rotiert das client_secret —
    das darf eine laufende VPS-Instanz nie treffen), also braucht ein
    VPS-Besitzer mit App-Host-Genehmigung eine eigene App-Host-Instanz."""
    row = (
        await session.execute(
            select(RegisteredInstance.id)
            .join(
                UserInstanceMembership,
                UserInstanceMembership.instance_id == RegisteredInstance.id,
            )
            .where(
                UserInstanceMembership.user_id == user_id,
                UserInstanceMembership.role == "owner",
                RegisteredInstance.status == "active",
                RegisteredInstance.origin == "app_host",
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return row is not None


async def provision_app_host_instance(session: AsyncSession, owner_user_id: int) -> int:
    """Legt eine Relay-Instanz für App-Hosting an und gibt die Instanz-ID zurück.

    Läuft INNERHALB der Transaktion des Callers. Worker-ID-/client_id-Kollisionen
    werden per SAVEPOINT-Retry gefangen, ohne die äußere Transaktion (z.B. den
    App-Status + ``self_host_enabled``) zurückzurollen — der Caller committet
    am Ende alles gemeinsam.

    Der Caller MUSS vorher idempotent prüfen
    (:func:`user_has_active_owner_instance`), dass noch keine Instanz existiert."""
    settings = get_settings()
    secret_hash = await asyncio.to_thread(hash_password, secrets.token_urlsafe(32))
    for _attempt in range(5):
        try:
            async with session.begin_nested():  # SAVEPOINT
                wid_chat, wid_voice, wid_media = await _allocate_worker_ids(session)
                instance_id = next_id()
                session.add(
                    RegisteredInstance(
                        id=instance_id,
                        hostname=f"app-{instance_id}.{settings.pulse_relay_base_domain}",
                        client_id=secrets.token_urlsafe(16),
                        client_secret=secret_hash,
                        worker_id_chat=wid_chat,
                        worker_id_voice=wid_voice,
                        worker_id_media=wid_media,
                        status="active",
                        origin="app_host",
                        registered_by=owner_user_id,
                    )
                )
                # Owner-Membership SOFORT (wie der VPS-Flow), sonst ist die
                # Instanz in ``GET /me/instances`` unsichtbar (Henne-Ei).
                session.add(
                    UserInstanceMembership(
                        user_id=owner_user_id,
                        instance_id=instance_id,
                        role="owner",
                    )
                )
                await session.flush()
            return instance_id
        except IntegrityError:
            # SAVEPOINT zurückgerollt (Worker-ID-/client_id-Kollision) → neuer
            # Versuch mit frischen IDs. Die äußere Transaktion bleibt intakt.
            continue
    raise HTTPException(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="worker-id allocation conflict, try again",
    )
