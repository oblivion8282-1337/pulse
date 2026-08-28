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

from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.server_ticket import TICKET_FRIST_S, baue_ticket

router = APIRouter(tags=["self-host"])


class TicketEin(BaseModel):
    """Der **Hostname**, nicht die Instanz-Kennung.

    Das ist eine Sicherheitseigenschaft, kein Stilfrage. Fragte der Klient nach
    einer Kennung, müsste er sie vorher irgendwo herbekommen — und die einzige
    Quelle wäre der Server selbst (``/.well-known/pulse-server-info``, ohne
    Beglaubigung). Ein bösartiger Host könnte dort die Kennung eines FREMDEN
    Servers melden, bekäme ein auf diesen ausgestelltes Ticket ausgehändigt und
    löste es dort binnen der Gültigkeit ein — volle Sitzung als der Nutzer.

    Die Zuordnung Hostname → Instanz kennt die Cloud. Sie hier aufzulösen heisst:
    Ein Host kann nur je ein Ticket für sich selbst erhalten.
    """

    hostname: str = Field(..., min_length=1, max_length=253)


class TicketAus(BaseModel):
    ticket: str
    expires_in: int
    #: Die aufgelöste Instanz-Kennung. Sie kommt aus der Cloud, nicht vom Server
    #: selbst — der Klient braucht sie für die Mitgliedschaftsliste und darf sie
    #: sich gerade NICHT beim fremden Host holen (s. ``TicketEin``).
    instance_id: str


@router.post("/me/server-ticket", response_model=TicketAus)
async def server_ticket(
    payload: TicketEin, request: Request, db: SessionDep
) -> TicketAus:
    from dcc_auth.routes import _check_rate
    from dcc_auth.routes_instance_applications import _require_user_mit_sitzung

    user, sitzung = await _require_user_mit_sitzung(request, db)
    settings = get_settings()
    await _check_rate(
        request, "server_ticket", settings.rate_limit_server_ticket, account=str(user.id)
    )

    # Hostname genauso normalisieren wie bei der Registrierung, sonst scheitert
    # der Vergleich an einem Schema, einem Port oder einem Grossbuchstaben. Das
    # ``//``-Präfix nur setzen, wo keines da ist — sonst liest ``urlsplit`` bei
    # einem vollen URL das Schema als Host.
    roh = payload.hostname.strip().lower()
    host = urlsplit(roh if "//" in roh else f"//{roh}").hostname or ""
    inst = (
        await db.execute(
            select(RegisteredInstance).where(RegisteredInstance.hostname == host)
        )
    ).scalars().first()
    # 404 sowohl für „gibt es nicht" als auch für „nicht aktiv": Ein Fremder soll
    # aus der Antwort nicht ablesen können, welche Instanz-Kennungen vergeben
    # sind. Dieselbe Linie wie in ``routes_selfhost_diagnose`` („wirft 404, nie 403").
    if inst is None or inst.status != "active":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    gesperrt = (
        await db.execute(
            select(SuspendedInstance.instance_id).where(
                SuspendedInstance.instance_id == inst.id
            )
        )
    ).scalar_one_or_none()
    if gesperrt is not None:
        # Hier und nicht erst beim Einlösen: Sonst reiste ein gültiges Ticket zu
        # einem Server, der es ohnehin ablehnt, und der Nutzer sähe einen Fehler
        # des Servers statt der wahren Ursache.
        #
        # Bewusst 403 statt 404, obwohl darüber „nie 403" steht: Wer bis hierher
        # kommt, hat den Hostnamen bereits genannt — er erfährt nichts, was er
        # nicht schon wusste. Und der Nutzer braucht den Unterschied zwischen
        # „kenne ich nicht" und „gesperrt".
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance_suspended")

    return TicketAus(
        ticket=baue_ticket(
            user_id=str(user.id),
            instance_id=inst.id,
            name=user.username,
            # ``avatar_hash``, nicht ``avatar_url``: Ein Self-Host holt
            # Cloud-Avatare inhaltsadressiert über den Hash, damit die Cloud
            # nicht erfährt, wer bei wem zuschaut.
            avatar=user.avatar_hash,
            # Aus der SITZUNG, nicht festverdrahtet: Daran hängt, ob ein
            # Self-Host für heikle Aktionen einen zweiten Faktor verlangen
            # kann. Fest auf ``["pwd"]``/``"0"`` gesetzt, sähe jeder Server
            # jeden Nutzer als „nur Passwort" — auch den, der sich gerade mit
            # Passkey angemeldet hat. Die Datenschutzerklärung (§20) sagt
            # Nutzern zu, dass diese Angabe mitreist.
            amr=list(sitzung.amr or []),
            acr=sitzung.acr or "0",
        ),
        expires_in=TICKET_FRIST_S,
        instance_id=str(inst.id),
    )
