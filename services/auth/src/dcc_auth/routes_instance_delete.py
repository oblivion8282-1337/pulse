"""Owner-facing Self-Host-Instanz-Löschung.

DELETE /me/instances/{id} — Soft-Delete durch den Instanz-Besitzer.

Eigenes Modul (statt routes_instance_applications.py zu erweitern) wegen der
Größen-Policy; teilt sich den ``_require_user``-Helper mit den Nachbar-Routen.

Warum Soft-Delete statt Hard-Delete: Die Worker-IDs (chat/voice/media) werden
per max+1 vergeben (``_allocate_worker_ids``) — eine hart gelöschte Zeile würde
ihre IDs für die nächste Approval freigeben, und die neue Instanz würde
Snowflakes minten, die mit bereits existierenden IDs der gelöschten Instanz
kollidieren. Die Zeile bleibt deshalb bestehen (``status='deleted'``), nur der
Hostname wird auf einen Platzhalter unter ``.invalid`` (RFC 2606) umbenannt,
damit er für Neuanträge wieder frei ist.

Zusätzlich wird ein ``suspended_instances``-Eintrag angelegt: Ein noch
laufender Container findet sich damit auf der öffentlichen
``/.well-known/pulse-suspended-instances``-Liste und stellt den Betrieb ein —
der Kill-Switch greift also auch, wenn der Owner das Docker-Volume nie anfasst
(z.B. nach Server-Verkauf oder bei gestohlenen Pairing-Credentials).
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, update

from dcc_auth.db import SessionDep
from dcc_auth.models_instances import (
    InstanceApplication,
    InstanceBootstrapToken,
    InstanceDirectEndpoint,
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_suspended_instances import _get_redis, suspended_list_add

router = APIRouter(tags=["self-host"])

_DELETE_REASON = "Vom Besitzer gelöscht"


@router.delete("/me/instances/{instance_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_instance(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Eigene Instanz löschen (Soft-Delete, irreversibel für den Owner).

    Nur der Besitzer; 404 statt 403 gegen Existence-Leak (wie die
    Nachbar-Routen). Eine bereits gelöschte Instanz ist für den Owner
    unsichtbar → ebenfalls 404. Auch eine admin-suspendierte Instanz darf der
    Owner löschen (der Suspend-Eintrag und damit der Kill-Switch bleiben).
    """
    user = await _require_user(request, db)

    try:
        iid = int(instance_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden"
        ) from exc

    inst = await db.get(RegisteredInstance, iid, with_for_update=True)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    was_suspended = inst.status == "suspended"
    inst.status = "deleted"
    # Hostname freigeben — Unique-Constraint bleibt erfüllt, Kollision mit
    # echten Hostnames unmöglich (.invalid ist reserviert, RFC 2606).
    inst.hostname = f"deleted-{iid}.invalid"

    # Offene Bootstrap-Tokens entwerten — es darf kein Installer-Lauf mehr
    # gegen die gelöschte Instanz einlösen.
    await db.execute(
        delete(InstanceBootstrapToken).where(InstanceBootstrapToken.instance_id == iid)
    )

    # Mitgliedschaften ALLER User + Telefonbuch-Eintrag mitnehmen: die Instanz
    # existiert für niemanden mehr. Ohne das behalten Mitglieder eine Server-
    # Kachel ohne Server, und das Telefonbuch nennt eine Adresse, hinter der
    # nichts mehr antwortet.
    await db.execute(
        delete(UserInstanceMembership).where(UserInstanceMembership.instance_id == iid)
    )
    await db.execute(
        delete(InstanceDirectEndpoint).where(InstanceDirectEndpoint.instance_id == iid)
    )

    # Ursprungs-Antrag schließen: 'approved' zählt clientseitig als "wartet
    # auf Einrichtung" (roter Punkt am UserFooter, myInstanceApplications).
    # Ohne den Endstatus lebte der Punkt auf jedem neuen Gerät weiter, obwohl
    # die Instanz weg ist. 'closed' ist bewusst KEIN 'rejected' — sonst
    # bekäme der Owner nachträglich einen Ablehnungs-Toast.
    await db.execute(
        update(InstanceApplication)
        .where(
            InstanceApplication.approved_instance_id == iid,
            InstanceApplication.status == "approved",
        )
        .values(status="closed")
    )

    if not was_suspended:
        db.add(
            SuspendedInstance(
                instance_id=iid,
                suspended_at=datetime.now(UTC),
                reason=_DELETE_REASON,
            )
        )

    await db.commit()

    # Cache der öffentlichen Suspend-Liste invalidieren, damit ein noch
    # laufender Container den Kill-Switch beim nächsten Poll sieht.
    redis = await _get_redis(request)
    if redis is not None:
        await suspended_list_add(redis, iid, _DELETE_REASON)
