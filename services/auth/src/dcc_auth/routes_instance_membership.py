"""Mitgliedschaft und Präferenzen des eingeloggten Cloud-Users auf einer
Self-Host-Instanz.

POST   /me/instances/{id}/membership    -- beitreten (idempotent)
DELETE /me/instances/{id}/membership    -- austreten
PATCH  /me/instances/{id}/preferences   -- Anzeigename + Notification-Modus

Eigenes Modul (statt ``routes_instance_applications.py`` zu erweitern) wegen
der Größen-Policy — dieselbe Begründung wie bei ``routes_instance_delete.py``.
Die Routen hängen an keiner der Verwaltungs-Vorrechte des Besitzers, sie
gehören dem Mitglied.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.routes_instance_applications import _require_user

router = APIRouter(tags=["self-host"])


class InstancePreferencesIn(BaseModel):
    """Partielles Update der geräteübergreifenden Server-Präferenzen. Nur
    gesetzte Felder werden geändert (``model_fields_set``); ``label=None``
    setzt den Anzeigenamen explizit zurück (= Hostname anzeigen)."""

    label: str | None = Field(default=None, max_length=100)
    notification_mode: Literal["all", "mentions", "none"] | None = None

@router.post(
    "/me/instances/{instance_id}/membership",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def join_instance_membership(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Den eingeloggten Cloud-User als Mitglied einer Self-Host-Instanz
    eintragen — so erscheint ein per Einladung beigetretener Server auch auf
    anderen Geräten (Account-basierte Server-Liste, ``GET /me/instances``).

    Bisher legte nur der Owner-Pfad (Approval/Bootstrap-Redeem) eine Membership
    an; ein eingeladener Nicht-Owner hatte nur den gerätelokalen
    ``pulse.servers``-Eintrag → im Browser unsichtbar. Dieser Endpoint schließt
    die Lücke (die in ``UserInstanceMembership`` vorbereitete Phase-4-6-Rolle).

    Idempotent. Eine bestehende ``owner``-Rolle wird NICHT herabgestuft. Die
    Cloud verifiziert die Self-Host-seitige Mitgliedschaft bewusst NICHT
    (Cert-Modell: Self-Hosts sind isolierte DB-Welten) — die Server-Liste war
    immer nur eine schwache Tracking-Dimension, kein Zugriffsbeweis. Ohne echten
    Cert-Grant kommt der User auf dem Self-Host trotzdem nicht rein; der Client
    ruft den Endpoint ohnehin erst nach erfolgreichem Cert-Login auf.
    """
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        # ``from None`` an allen diesen Stellen: eine nicht-numerische ID ist
        # erwartetes Verhalten, kein Fehlerfall — ein angehaengter Traceback
        # waere nur Log-Laerm.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None
    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    if await db.get(UserInstanceMembership, (user.id, iid)) is None:
        db.add(
            UserInstanceMembership(user_id=user.id, instance_id=iid, role="member")
        )
        await db.commit()


@router.delete(
    "/me/instances/{instance_id}/membership",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def leave_instance_membership(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Cloud-seitige Membership entfernen, wenn der User einen Self-Host-Server
    entfernt (= austritt). Gegenstück zu :func:`join_instance_membership` —
    ohne das würde der Server beim nächsten ``GET /me/instances`` auf anderen
    Geräten wieder auftauchen.

    Der Owner kann seine Membership so NICHT wegwerfen (er bleibt Owner; zum
    Loswerden dient ``DELETE /me/instances/{id}`` = Instanz löschen) → 403.
    Idempotent: keine Membership → 204.
    """
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None
    existing = await db.get(UserInstanceMembership, (user.id, iid))
    if existing is None:
        return
    if existing.role == "owner":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="owner_cannot_leave_instance"
        )
    await db.delete(existing)
    await db.commit()


@router.patch(
    "/me/instances/{instance_id}/preferences",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def update_instance_preferences(
    instance_id: str,
    payload: InstancePreferencesIn,
    request: Request,
    db: SessionDep,
) -> None:
    """Geräteübergreifende Server-Präferenzen (Anzeigename + Notification-Modus)
    setzen. Damit gelten Umbenennung und Stummschaltung eines Self-Host-Servers
    auf allen Geräten, nicht nur lokal. Partiell: nur gesetzte Felder ändern.
    404, wenn der User keine Membership auf der Instanz hat."""
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from None
    membership = await db.get(UserInstanceMembership, (user.id, iid))
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    fields = payload.model_fields_set
    if "label" in fields:
        membership.user_label = payload.label
    if "notification_mode" in fields and payload.notification_mode is not None:
        membership.notification_mode = payload.notification_mode
    await db.commit()
