"""``GET /.well-known/pulse-owner-check`` — erkennt dieser Server dich als Betreiber?

Warum es das gibt
-----------------
Auf einem Self-Host entsteht Admin an genau einer Stelle: ``cert_login.py``
vergleicht die Kennung aus dem vorgelegten Identitäts-Cert mit
``PULSE_INSTANCE_OWNER_ID`` aus der ``.env``. Diese Zeile ist eine **Kopie** —
beim Bootstrap einmal aus der Cloud gezogen und danach nie wieder abgeglichen.
Läuft sie vom Original auseinander (recycelte ``.env`` des Vorgängerservers,
Tippfehler beim Aufsetzen von Hand), startet der Server völlig normal, und der
Betreiber ist auf seinem eigenen Server ein gewöhnlicher Nutzer.

Am 2026-08-27 ist genau das passiert, und es kostete einen Abend: Von aussen
war die Ursache mit keinem Mittel feststellbar. Die konfigurierte Kennung stand
allein in der ``.env`` und in einer ``info``-Zeile des Servers — beides
erreichbar nur für jemanden mit Zugriff auf die Maschine. Die
Erreichbarkeitsprüfung lief bis dahin durch alle sieben Glieder und meldete
„alles in Ordnung", während der Betreiber ausgesperrt war.

Warum die Antwort drei Bits hat
-------------------------------
``is_owner_admin`` hängt an drei Bedingungen (``cert_login.py``): Betriebsart,
gesetzte Kennung, Übereinstimmung. Ein einzelnes Ja/Nein liesse den Betreiber
raten, welche davon reisst — und die drei brauchen drei verschiedene
Handgriffe.

Warum die erwartete Kennung IM TOKEN steht
------------------------------------------
Sie kommt nicht als Parameter, sondern als Claim in einem von der Cloud
signierten Token. Damit ist sie nicht fälschbar, und der Endpunkt ist kein
Orakel: Ohne gültige Cloud-Signatur antwortet er niemandem. Stünde die Kennung
im Aufruf und die Signatur fehlte, könnte jeder im Netz durchprobieren, welches
Konto welchen Server betreibt — der chat-gateway hat dafür nicht einmal einen
Ratenbegrenzer (``slowapi`` läuft nur im auth-svc).

Die eigene Kennung wird **nie** ausgeliefert, auch nicht an eine gültig
signierte Anfrage. Die Cloud kennt sie ohnehin; sie zurückzugeben hiesse nur,
sie einem künftigen Fehler auszusetzen.

Der Pfad braucht eine Zeile im ``Caddyfile.template``. Ohne sie greift der
SPA-Rückfall und liefert HTML statt JSON — dieselbe Falle, die die Cloud-Poller
schon einmal erwischt hat (s. ``CLAUDE.md``, well-known-Endpoints).
"""

from __future__ import annotations

from typing import Any

import jwt
from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel

# Modul-Zugriff statt ``from … import get_settings``: der Name waere zur
# Importzeit an die LRU-gecachte Originalfunktion gebunden, und ein Austausch
# des Anbieters (Tests) ginge daran vorbei. Muster wie in ``capabilities.py``.
from dcc_chat_gateway import config as chat_config

# Bewusst die Funktion des Cert-Prüfers statt einer eigenen Kopie: sie weiss
# schon, dass ein Self-Host die CLOUD-JWKS lesen muss (``auth:cloud_jwks:cached``,
# vom crl_poller warmgehalten) und nicht die lokale. Zwei Fassungen dieser
# Auswahl wären zwei Stellen, die auseinanderlaufen können.
from dcc_chat_gateway.credential_validator import _get_jwks_keys

router = APIRouter()

#: Ein Cloud-Token gilt nur für den Zweck, für den es ausgestellt wurde. Sonst
#: genügte ein einziges abgefangenes Token für jeden Zweck, den die Cloud kennt
#: (heute ausserdem ``watchtower-update``).
ZWECK = "owner-check"

#: Zugestandener Uhrenversatz gegenueber der Cloud, in Sekunden. Gleich der
#: Lebensdauer des Tokens (``selfhost_probe_betreiber.TOKEN_FRIST_S``): mehr
#: waere geschenkte Gueltigkeit, weniger liesse einen leicht falsch gehenden
#: Server durchfallen, obwohl an seiner Konfiguration nichts fehlt.
ZEITTOLERANZ_S = 60


class OwnerCheckAus(BaseModel):
    """Drei Ja/Nein-Bits — genau die drei Bedingungen aus ``cert_login.py``."""

    modus_self_host: bool
    owner_konfiguriert: bool
    stimmt_ueberein: bool


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    return authorization.split(" ", 1)[1].strip()


async def _cloud_claims(token: str, redis: Any, eigene_instanz: int) -> dict[str, Any]:
    """Die Claims eines von der Cloud signierten Tokens — oder 401.

    Jeder Fehlschlag endet in derselben Antwort. Welcher Riegel gegriffen hat,
    ist eine Auskunft, die nur einem Angreifer nützt; dem berechtigten
    Aufrufer sagt sein eigener Aufruf, was er geschickt hat.
    """
    abgelehnt = HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unauthorized")

    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError:
        raise abgelehnt from None
    if not kid:
        # Ohne kid müsste gegen jeden bekannten Schlüssel geprüft werden — das
        # ist der Hebel für eine JWKS-Flut. Derselbe Riegel wie im Cert-Prüfer.
        raise abgelehnt

    schluessel = (await _get_jwks_keys(redis)).get(kid)
    if schluessel is None:
        # Auch der kalte Cache landet hier: keine JWKS, keine Prüfung, keine
        # Auskunft. Fail-closed — anders als beim Sperr-Poller, wo ein
        # Cloud-Ausfall niemanden aussperren darf, kostet ein Fehlschlag hier
        # nur eine Diagnose.
        raise abgelehnt

    try:
        claims = jwt.decode(
            token,
            schluessel,
            algorithms=["RS256"],  # nie aus dem Token-Kopf ableiten
            # Uhrenversatz zwischen Cloud und Instanz ist hier ein realer Fall,
            # kein theoretischer: ``user_profile_cache.py`` behandelt ihn an
            # derselben Grenze schon. Das Token lebt nur eine Minute — ginge die
            # Uhr dieses Servers eine Minute vor, waere das Glied dauerhaft tot,
            # und der Befund zeigte auf eine falsche Ursache.
            #
            # ``verify_iat=False``: ein ``iat`` in der (lokalen) Zukunft ist
            # Versatz, kein Angriff. ``leeway`` deckt dieselbe Spanne auf der
            # ``exp``-Seite ab. Zusammen: bis ZEITTOLERANZ_S Versatz in beide
            # Richtungen wird geprueft wie gewollt, darueber hinaus abgelehnt —
            # und dafuer nennt der Befundtext die Uhr ausdruecklich.
            leeway=ZEITTOLERANZ_S,
            options={"verify_aud": False, "verify_iat": False},
        )
    except jwt.PyJWTError:
        raise abgelehnt from None

    if claims.get("purpose") != ZWECK:
        raise abgelehnt
    # An DIESE Instanz gebunden. Ohne den Vergleich liesse sich ein Token, das
    # die Cloud für Server A ausgestellt hat, gegen Server B richten — und
    # dessen Betreiber erführe, ob ein fremdes Konto seinen Nachbarn betreibt.
    if str(claims.get("instance_id") or "") != str(eigene_instanz):
        raise abgelehnt
    return claims


@router.get("/.well-known/pulse-owner-check", response_model=OwnerCheckAus)
async def owner_check(
    request: Request,
    authorization: str | None = Header(default=None),
) -> OwnerCheckAus:
    settings = chat_config.get_settings()
    claims = await _cloud_claims(
        _bearer(authorization),
        getattr(request.app.state, "redis", None),
        settings.pulse_instance_id,
    )

    konfiguriert = bool(settings.pulse_instance_owner_id)
    erwartet = str(claims.get("owner_user_id") or "")
    return OwnerCheckAus(
        modus_self_host=settings.pulse_instance_mode == "self-host",
        owner_konfiguriert=konfiguriert,
        # Textvergleich, wie überall bei Snowflakes: sie reisen als Zeichenkette,
        # und ``int()`` auf fremde Eingaben wäre eine Fehlerquelle ohne Gewinn.
        stimmt_ueberein=konfiguriert and erwartet == str(settings.pulse_instance_owner_id),
    )
