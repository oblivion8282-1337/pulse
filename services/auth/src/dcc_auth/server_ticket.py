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

import base64
import hashlib
import hmac
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


def legacy_uid(user_id: str, instance_id: int, pairwise_salt: bytes) -> int:
    """Die synthetische Nutzer-ID, die dieser Nutzer auf DIESER Instanz bisher hatte.

    Ein Self-Host führt in seinen Spalten nicht die Cloud-Kennung, sondern
    ``SHA256(pairwise_sub)[:8]``. Er kann sie nicht zurückrechnen — die Cloud
    aber vorwärts, weil sie den Salt hat. Nur dadurch ist die Umschreibung der
    Bestandszeilen überhaupt möglich (``dcc_chat_gateway.identitaet_umschreiben``).

    Die Rechnung ist hier bewusst nachgebaut statt importiert: ``dcc_auth`` hängt
    nicht von ``dcc_chat_gateway`` ab, und ein Import quer über die Dienstgrenze
    wäre eine Abhängigkeit, die es sonst nirgends im Baum gibt. Dass beide
    Fassungen dasselbe liefern, hält ein Test fest
    (``test_legacy_uid_stimmt_mit_der_selfhost_rechnung_ueberein``) — ohne ihn
    fiele eine Abweichung erst auf, wenn Bestandsdaten verwaist sind.
    """
    nachricht = f"{user_id}:{instance_id}".encode()
    abdruck = hmac.new(pairwise_salt, nachricht, hashlib.sha256).digest()
    pairwise_sub = base64.urlsafe_b64encode(abdruck).rstrip(b"=").decode()[:16]
    digest = hashlib.sha256(pairwise_sub.encode()).digest()
    # Oberste 8 Bytes, Vorzeichenbit gelöscht → positive 63-bit-Zahl (passt in
    # BIGINT signed). Identisch zu ``synthesize_self_host_user_id``.
    return int.from_bytes(digest[:8], "big") & 0x7FFF_FFFF_FFFF_FFFF


def baue_ticket(
    *,
    user_id: str,
    instance_id: int,
    name: str,
    avatar: str | None,
    amr: list[str],
    acr: str,
    pairwise_salt: bytes,
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
        # Nur für die Übergangszeit. Fällt mit Phase 3, wenn kein Self-Host mehr
        # Bestandszeilen unter der synthetischen ID führt.
        "legacy_uid": legacy_uid(user_id, instance_id, pairwise_salt),
        "iat": jetzt,
        "exp": jetzt + TICKET_FRIST_S,
    }
    return jwt.encode(
        nutzlast,
        get_signer()._private_key,
        algorithm="RS256",
        headers={"kid": settings.jwt_key_id},
    )
