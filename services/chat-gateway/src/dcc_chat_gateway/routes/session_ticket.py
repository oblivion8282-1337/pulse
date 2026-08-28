"""``POST /session`` — ein Cloud-Ticket gegen eine Sitzung dieses Servers tauschen.

Die Reihenfolge der Prüfungen ist nicht beliebig: Sperre der Instanz, Ticket,
Bann des Nutzers, Beitritt. Zuerst das, was den ganzen Server betrifft, dann das
Papier, dann die Person. Wer sie umstellt, verrät einem Fremden Dinge, die ihn
nichts angehen — etwa dass er auf diesem Server gebannt ist, obwohl sein Ticket
gar nicht gilt.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

# Modul-Zugriff statt ``from … import get_settings``: Der Name waere sonst zur
# Importzeit an die LRU-gecachte Originalfunktion gebunden, und ein Austausch
# des Anbieters (Tests) ginge daran vorbei. Dieselbe Falle steht in
# ``owner_check.py`` und ``capabilities.py`` beschrieben — ich bin trotzdem
# hineingelaufen, und drei Tests haben es gefangen.
from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.routes.gates import enforce_ban_gate, enforce_join_gate
from dcc_chat_gateway.session_tokens import issue_session_token
from dcc_chat_gateway.suspend_poller import raise_if_suspended
from dcc_chat_gateway.ticket_pruefung import TicketFehler, pruefe_ticket

router = APIRouter(tags=["self-host"])

#: Eine Stunde.
#:
#: Nicht länger, weil das Bann-Gate beim Ausstellen greift: Ein gebannter Nutzer
#: käme sonst so lange weiter durch die REST-Schnittstelle. Für die lebende
#: Verbindung gibt es diesen Nachlauf gar nicht — ein Bann schliesst den Socket
#: sofort.
#:
#: Nicht kürzer, weil die früheren fünf Minuten den stillen Wiederanmelde-Sturm
#: erzeugten (alle vier Minuten ein voller Cert-Login je Tab), der diesen Umbau
#: ausgelöst hat.
#:
#: Der Socket kann ein frisches Token entgegennehmen (``ws_token_renewal``), aber
#: er STELLT keines aus — der Klient holt es hier, mit einem Ticket. Ein
#: Cloud-Ausfall beendet deshalb jede Sitzung binnen einer Stunde. Das ist
#: hingenommen (Entscheidung 2 der Spec) und ausdrücklich KEIN Stück
#: Cloud-Unabhängigkeit; ein früherer Kommentar behauptete das und lag falsch.
SITZUNGSDAUER_S = 3600



class SitzungEin(BaseModel):
    ticket: str = Field(..., min_length=1, max_length=8192)
    #: Optionale Zugänge für den ERSTEN Besuch. Ein Ticket beweist, wer jemand
    #: ist — nicht, dass er hier hereindarf. Wer noch kein Mitglied ist, legt
    #: hier seine Erlaubnis vor: einen Community-Einladungscode oder die
    #: öffentliche Adresse einer Community auf diesem Server. Beide werden
    #: NICHT verbraucht; die Einlösung geschieht später beim Beitritt zur
    #: Community selbst.
    community_grant_code: str | None = Field(default=None, max_length=128)
    public_join_handle: str | None = Field(default=None, max_length=64)


class SitzungAus(BaseModel):
    session_token: str
    expires_in: int


@router.post("/session", response_model=SitzungAus)
async def sitzung_aus_ticket(
    payload: SitzungEin, request: Request, session: SessionDep
) -> SitzungAus:
    settings = chat_config.get_settings()
    redis = request.app.state.redis

    await raise_if_suspended(redis)

    try:
        daten = await pruefe_ticket(
            payload.ticket,
            instanz_id=settings.pulse_instance_id,
            cloud_issuer=settings.pulse_oidc_issuer,
            redis=redis,
        )
    except TicketFehler as exc:
        # Der Code wandert unveraendert in die Antwort. Er ist der Unterschied
        # zwischen „hier ist der Handgriff" und der Sammelmeldung, die am
        # 2026-08-28 zwei Stunden Fehlersuche an einem gesunden Server kostete.
        raise HTTPException(status_code=403, detail=exc.code) from exc

    kennung = daten.sub
    ist_betreiber = bool(settings.pulse_instance_owner_id) and (
        kennung == str(settings.pulse_instance_owner_id)
    )

    await enforce_ban_gate(session, kennung, ist_betreiber)
    if settings.pulse_instance_mode == "self-host":
        await enforce_join_gate(
            session,
            kennung,
            ist_betreiber,
            payload.community_grant_code,
            payload.public_join_handle,
        )

    return SitzungAus(
        session_token=issue_session_token(
            kennung,
            daten.jti,
            key_path=settings.session_signing_key_file,
            admin=ist_betreiber,
            ttl_seconds=SITZUNGSDAUER_S,
        ),
        expires_in=SITZUNGSDAUER_S,
    )
