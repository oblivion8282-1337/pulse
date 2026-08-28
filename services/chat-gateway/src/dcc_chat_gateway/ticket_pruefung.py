"""Serverticket prüfen — die einzige Stelle, an der ein Cloud-Ausweis gilt.

Drei Eigenschaften ersetzen zusammen die frühere Signatur über eine
Server-Nonce; keine davon genügt allein:

* **Frist** (60 s plus Uhrentoleranz) — ein abgefangenes Ticket veraltet schnell.
* **``aud``** — es taugt nur für genau diese Instanz, nicht für eine andere.
* **``jti`` einmalig** — es taugt nur ein einziges Mal.

Dazu die Zweckbindung: Die Cloud signiert auch Token für den Betreiber-Check und
den Update-Anstoss. Ohne ``purpose`` genügte ein abgefangenes davon zum Anmelden.

Das Modul kennt bewusst keine Route und keine Datenbank. Was „gültig" heisst,
gehört nicht in denselben Kasten wie „wer darf hier rein" (Beitritts-Gate) und
„wer ist das" (Sitzung).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import jwt

from dcc_chat_gateway.credential_validator import _get_jwks_keys

#: Muss mit ``dcc_auth.server_ticket.ZWECK`` übereinstimmen.
ZWECK = "server-session"

#: Zugestandener Uhrenversatz gegenüber der Cloud, in Sekunden. Gleich der
#: Lebensdauer des Tickets: mehr wäre geschenkte Gültigkeit, weniger liesse
#: einen leicht falsch gehenden Server durchfallen, obwohl an seiner
#: Konfiguration nichts fehlt. Dieselbe Überlegung wie in ``routes/owner_check``.
ZEITTOLERANZ_S = 60

_VERBRAUCHT_PREFIX = "ticket:verbraucht:"


class TicketFehler(Exception):
    """Ablehnung mit einem Code, der bis in die Oberfläche reist.

    Der Code ist der ganze Zweck dieser Klasse. Der Vorgängerweg kannte seine
    Gründe ebenfalls (``cert-invalid``, ``rate-limited``, ``join-closed``), warf
    sie aber weg und zeigte „Anmeldung abgelaufen oder Server nicht erreichbar" —
    eine Meldung, aus der niemand einen Handgriff ableiten konnte, und die am
    2026-08-28 zwei Stunden Fehlersuche an einem vollkommen gesunden Server
    gekostet hat.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TicketDaten:
    sub: str
    name: str
    avatar: str | None
    amr: list[str]
    acr: str
    legacy_uid: int | None
    jti: str


async def pruefe_ticket(
    roh: str, *, instanz_id: int, cloud_issuer: str, redis: Any
) -> TicketDaten:
    """Prüft ein Serverticket und gibt seinen Inhalt zurück.

    Wirft ``TicketFehler`` mit einem Code, der den Handgriff bestimmt.
    """
    try:
        kopf = jwt.get_unverified_header(roh)
    except jwt.PyJWTError as exc:
        raise TicketFehler("ticket_malformed") from exc

    schluessel = await _get_jwks_keys(redis)
    if not schluessel:
        raise TicketFehler("jwks_cold")
    pubkey = schluessel.get(kopf.get("kid", ""))
    if pubkey is None:
        # Unbekannte Schlüsselkennung: entweder die Cloud hat rotiert und dieser
        # Server hat es noch nicht mitbekommen, oder er hat sie nie erreicht.
        # Beides derselbe Handgriff — den Server ans Netz lassen.
        raise TicketFehler("jwks_cold")

    try:
        c = jwt.decode(
            roh,
            pubkey,
            algorithms=["RS256"],
            audience=str(instanz_id),
            issuer=cloud_issuer,
            leeway=ZEITTOLERANZ_S,
        )
    except jwt.ExpiredSignatureError as exc:
        raise TicketFehler("ticket_expired") from exc
    except jwt.InvalidAudienceError as exc:
        raise TicketFehler("ticket_wrong_audience") from exc
    except jwt.InvalidIssuerError as exc:
        raise TicketFehler("ticket_wrong_issuer") from exc
    except jwt.PyJWTError as exc:
        raise TicketFehler("ticket_invalid") from exc

    if c.get("purpose") != ZWECK:
        raise TicketFehler("ticket_wrong_purpose")

    jti = str(c.get("jti") or "")
    if not jti:
        raise TicketFehler("ticket_invalid")
    # Einmal-Einlösung. Die Marke lebt länger als die Ticketfrist, damit sie ein
    # Ticket überdauert, das mit voller Uhrentoleranz ankommt — sonst wäre
    # ausgerechnet das grenzwertig alte Ticket wieder einlösbar.
    frisch = await redis.set(
        f"{_VERBRAUCHT_PREFIX}{jti}", "1", nx=True, ex=ZEITTOLERANZ_S * 4
    )
    if not frisch:
        raise TicketFehler("ticket_replayed")

    legacy = c.get("legacy_uid")
    return TicketDaten(
        sub=str(c["sub"]),
        name=str(c.get("name") or ""),
        avatar=c.get("avatar"),
        amr=list(c.get("amr") or []),
        acr=str(c.get("acr") or "0"),
        legacy_uid=int(legacy) if isinstance(legacy, int) else None,
        jti=jti,
    )
