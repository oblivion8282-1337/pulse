"""Serverticket — der Ausweis, mit dem ein Nutzer sich bei EINEM Self-Host meldet.

Warum es das gibt
-----------------
Bis August 2026 trug der Browser ein Gerätezertifikat mit einem Jahr Laufzeit und
ein Ed25519-Schlüsselpaar in der IndexedDB. Beides konnte verlorengehen, und die
Zuordnung „welches Gerät" hing an einem Etikett (``<Browser> · <OS>``), das keine
Identität war. Das Ticket dreht die Richtung um: Nichts Langlebiges liegt beim
Nutzer, die Cloud stellt bei jeder Anmeldung einen frischen, auf genau einen
Empfänger ausgestellten Ausweis aus.

Warum die Frist so kurz ist
---------------------------
Ein Ticket ist unterwegs ein Inhaberpapier — wer es abfängt, kann es einlösen.
Dagegen wirken drei Dinge zusammen, keines davon allein: die Frist, die Bindung
an ein ``aud`` und die Einmal-Einlösung über ``jti`` beim Empfänger
(``dcc_chat_gateway.ticket_pruefung``). Ein abgefangenes Ticket taugt damit
weder für einen anderen Server noch ein zweites Mal noch nach einer Minute.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

import jwt

from dcc_auth.config import get_settings
from dcc_auth.security import get_signer

#: Muss mit ``dcc_chat_gateway.ticket_pruefung.ZWECK`` übereinstimmen. Ein
#: Cloud-Token gilt nur für den Zweck, für den es ausgestellt wurde — sonst
#: genügte ein einziges abgefangenes Token für jeden Zweck, den die Cloud kennt
#: (heute ausserdem ``owner-check`` und ``watchtower-update``).
ZWECK = "server-session"

#: Lebensdauer des Tickets in Sekunden. Es reist zu einem fremden Server und ist
#: dort so lange ein Nachschlüssel. Gleicher Wert wie beim Betreiber-Check
#: (``selfhost_probe_betreiber.TOKEN_FRIST_S``).
TICKET_FRIST_S = 60


def baue_ticket(
    *,
    user_id: str,
    instance_id: int,
    name: str,
    avatar: str | None,
    amr: list[str],
    acr: str,
) -> str:
    """Signiert ein Serverticket für genau eine Instanz."""
    settings = get_settings()
    jetzt = int(time.time())
    nutzlast: dict[str, Any] = {
        "iss": settings.pulse_oidc_issuer,
        "aud": str(instance_id),
        "sub": user_id,
        "purpose": ZWECK,
        "jti": str(uuid.uuid4()),
        "name": name,
        "avatar": avatar,
        # Übernommen aus dem bisherigen Zertifikat: daran hängt, ob ein Server
        # für heikle Aktionen einen zweiten Faktor verlangen kann. Ohne sie wäre
        # diese Möglichkeit stillschweigend weggefallen.
        "amr": amr,
        "acr": acr,
        "iat": jetzt,
        "exp": jetzt + TICKET_FRIST_S,
    }
    return jwt.encode(
        nutzlast,
        get_signer()._private_key,
        algorithm="RS256",
        headers={"kid": settings.jwt_key_id},
    )
