"""``POST /me/server-ticket`` — den Ausweis für EINEN Self-Host holen.

Die Route entscheidet ausdrücklich NICHT, ob der Nutzer auf diesen Server darf.
Das bleibt die Sache des Betreibers (Beitritts-Gate im chat-gateway). Das Ticket
sagt „das ist dieser Mensch", nicht „lass ihn rein" — dieselbe Trennung wie beim
bisherigen Zertifikat.

Warum das Ratenlimit hier sitzt und nicht beim Empfänger: Der auth-svc hat einen
Begrenzer (``_check_rate``), der chat-gateway nicht. Der bisherige Cert-Login
musste sich dort deshalb einen eigenen In-Prozess-Zähler samt
Verdrängungsstrategie halten. Mit dem Ticket-Weg wandert der Schutz an die
Stelle, die ihn ohnehin führt.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.server_ticket import TICKET_FRIST_S, baue_ticket

router = APIRouter(tags=["self-host"])


class TicketEin(BaseModel):
    instance_id: str = Field(..., min_length=1, max_length=32)


class TicketAus(BaseModel):
    ticket: str
    expires_in: int


@router.post("/me/server-ticket", response_model=TicketAus)
async def server_ticket(
    payload: TicketEin, request: Request, db: SessionDep
) -> TicketAus:
    from dcc_auth.routes import _check_rate
    from dcc_auth.routes_instance_applications import _require_user

    user = await _require_user(request, db)
    settings = get_settings()
    await _check_rate(
        request, "server_ticket", settings.rate_limit_server_ticket, account=str(user.id)
    )

    try:
        iid = int(payload.instance_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found") from exc

    inst = await db.get(RegisteredInstance, iid)
    # 404 sowohl für „gibt es nicht" als auch für „nicht aktiv": Ein Fremder soll
    # aus der Antwort nicht ablesen können, welche Instanz-Kennungen vergeben
    # sind. Dieselbe Linie wie in ``routes_selfhost_diagnose`` („wirft 404, nie 403").
    if inst is None or inst.status != "active":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    gesperrt = (
        await db.execute(
            select(SuspendedInstance.instance_id).where(
                SuspendedInstance.instance_id == iid
            )
        )
    ).scalar_one_or_none()
    if gesperrt is not None:
        # Hier und nicht erst beim Einlösen: Sonst reiste ein gültiges Ticket zu
        # einem Server, der es ohnehin ablehnt, und der Nutzer sähe einen Fehler
        # des Servers statt der wahren Ursache.
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance_suspended")

    return TicketAus(
        ticket=baue_ticket(
            user_id=str(user.id),
            instance_id=iid,
            name=user.username,
            # ``avatar_hash``, nicht ``avatar_url``: Ein Self-Host holt
            # Cloud-Avatare inhaltsadressiert über den Hash, damit die Cloud
            # nicht erfährt, wer bei wem zuschaut.
            avatar=user.avatar_hash,
            amr=["pwd"],
            acr="0",
        ),
        expires_in=TICKET_FRIST_S,
    )
