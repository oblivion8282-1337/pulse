"""``POST /internal/guest-token`` — Gast-Ticket für einen Sprachkanal ausstellen.

Aufrufer ist ausschließlich der chat-gateway (``INTERNAL_SERVICE_SECRET``,
dieselbe Schiene wie ``routes_search``/``routes_account``). auth-svc weiß von
Kanälen und Gast-Links nichts und prüft sie auch nicht — es hält den
Schlüssel, dessen JWKS chat-gateway, voice-signaling und media-svc in beiden
Betriebsarten schon vertrauen (Begründung ausführlich in
``security.py::issue_gast``).

**Diese Route ist bewusst kein allgemeiner Token-Automat.** Sie mintet genau
eine Form — ``typ="gast"`` mit Kanalbindung — und deckelt die Laufzeit hart.
Ein Aufrufer, der beliebige Claims setzen dürfte, machte aus dem internen
Dienst-Geheimnis einen Generalschlüssel für jede Identität.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_shared.gaeste import TICKET_MAX_TTL_S

from dcc_auth import config as _config
from dcc_auth.security import get_signer

router = APIRouter()

# Obergrenze der Ticket-Laufzeit, aus ``dcc_shared`` statt hier gesetzt: die
# Zahl gilt für chat-gateway (das rechnet) und für die Rauswurf-Sperre (die so
# lange leben muss) genauso. Ein Gast-Ticket ist unwiderrufbar bis zum Ablauf
# — es gibt keine Sperrliste, dieselbe Überlegung wie beim Server-Ticket —,
# damit ist die Frist das einzige Sicherheitsmaß, das ohne Zutun wirkt.
MAX_TTL_S = TICKET_MAX_TTL_S


class GastTicketIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gast_id: Annotated[str, Field(min_length=1, max_length=32, pattern=r"^gast-\d+$")]
    guild_id: Annotated[str, Field(min_length=1, max_length=20, pattern=r"^\d+$")]
    channel_id: Annotated[str, Field(min_length=1, max_length=20, pattern=r"^\d+$")]
    name: Annotated[str, Field(min_length=1, max_length=32)]
    ttl_s: Annotated[int, Field(ge=60, le=MAX_TTL_S)]


class GastTicketOut(BaseModel):
    token: str
    expires_in: int


def _check_internal_secret(provided: str | None) -> None:
    """Fail-closed: ohne serverseitiges Geheimnis ist die Route zu."""
    expected = _config.get_settings().internal_service_secret
    if not expected:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret"
        )


@router.post("/internal/guest-token", response_model=GastTicketOut)
async def issue_guest_token(
    payload: GastTicketIn,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> GastTicketOut:
    _check_internal_secret(x_pulse_internal_secret)
    ttl = min(payload.ttl_s, MAX_TTL_S)
    token = get_signer().issue_gast(
        gast_id=payload.gast_id,
        guild_id=payload.guild_id,
        channel_id=payload.channel_id,
        name=payload.name.strip(),
        ttl_s=ttl,
    )
    return GastTicketOut(token=token, expires_in=ttl)
