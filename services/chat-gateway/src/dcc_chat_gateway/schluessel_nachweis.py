"""Beweist, dass ein Geraet fuer SICH SELBST veroeffentlicht.

Der naheliegende Weg — den Absender aus der Verbindung ablesen — traegt nicht:
auf einem Self-Host meldet sich der Klient per Cert-Login und der Gateway
kennt das Geraet, auf der Cloud kommt ein Access-Token ohne jede
Geraeteangabe. Ein Verzeichnis, das nur auf Self-Hosts befuellbar waere, ist
nutzlos.

Das Geraet legt den Nachweis deshalb selbst bei: sein Identitaets-Zertifikat
(cloud-signiert, gegen JWKS und Sperrliste geprueft) und eine Unterschrift
ueber die Nutzlast, geprueft gegen den Pubkey AUS diesem Zertifikat.

**Diese Datei ist die EINZIGE Stelle, an der geprueft wird, ob ein Geraet fuer
ein Konto veroeffentlichen darf.** Alle vier Bedingungen sind fail-closed: jeder
Fehlschlag wirft 403, mit einer Meldung, die sagt WAS fehlgeschlagen ist, nie
WELCHER Schluessel oder WELCHE Unterschrift beteiligt war (kein Schluesselmaterial
in Fehlermeldungen oder Logs).
"""

from __future__ import annotations

import base64

from fastapi import HTTPException

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.credential_validator import (
    CertClaims,
    resolve_user_identifier,
    validate_cert,
    verify_challenge_signature,
)
from dcc_chat_gateway.security import AuthenticatedUser

#: Trennt die Nutzlast dieses Verfahrens von jedem anderen im Projekt, das
#: ebenfalls generische Ed25519-Unterschriften prueft (z. B. die
#: Cert-Login-Challenge) — ohne eigenen Kontext waere eine dort geleistete
#: Unterschrift potenziell auch hier gueltig.
_KONTEXT = b"pulse-schluessel-nachweis-v1"


def baue_nutzlast(zweck: str, *teile: str) -> bytes:
    """Baut die Bytes, ueber die das Geraet mit seinem Ed25519-Anmeldeschluessel
    unterschreibt — GENAU diese Bytes, byte fuer byte, muss der Klient
    nachbauen, um dieselbe Unterschrift zu erzeugen.

    Bauvorschrift: ``KONTEXT + 0x00 + Zweck + 0x00 + Teil_1 + 0x00 + Teil_2 + ...``
    Kontext und Zweck sind feste ASCII-Bytes, jeder Teil einzeln UTF-8-kodiert;
    alle Stuecke durch genau EIN Nullbyte getrennt (ein Zeichen, das in keinem
    Base64-Alphabet vorkommt, also kollisionsfrei — zwei verschiedene
    Teil-Listen koennen nie dieselben Bytes ergeben).

    Der Zweck steht IMMER an zweiter Stelle, direkt nach dem Kontext. Ohne ihn
    liesse sich eine fuer den einen Weg geleistete Unterschrift auf einem
    anderen wiederverwenden, sobald die uebrigen Teile zufaellig
    uebereinstimmen — der Zweck macht die Verfahren gegenseitig blind
    fuereinander.

    Vergebene Zwecke (Stand 2026-08-28, **beim Hinzufuegen hier ergaenzen**):
    ``buendel`` und ``einmalschluessel`` (``routes/schluessel.py``),
    ``postfach`` (``routes/postfach.py``), ``postfach-abholen`` und
    ``postfach-quittung`` (``routes/postfach_abholen.py``). Die Liste stand
    hier eine Zeit lang auf zwei, waehrend es schon fuenf waren — die
    Sicherheitsaussage stimmte weiter, die Aufzaehlung nicht.
    """
    stuecke = [_KONTEXT, zweck.encode("utf-8")]
    stuecke.extend(teil.encode("utf-8") for teil in teile)
    return b"\x00".join(stuecke)


def _b64url_decode(wert: str) -> bytes:
    return base64.urlsafe_b64decode(wert + "==")


async def pruefe_geraet(
    cert_jwt: str,
    nutzlast: bytes,
    signatur_b64: str,
    user: AuthenticatedUser,
    redis,
) -> CertClaims:
    """Prueft die vier Bedingungen, unter denen ein Geraet veroeffentlichen darf.

    1. Das Zertifikat ist gueltig (Signatur, Ablauf, nicht widerrufen) —
       ``validate_cert`` deckt das bereits vollstaendig ab.
    2. Das Zertifikat gehoert zum ANGEMELDETEN Konto. Verglichen wird ueber
       ``resolve_user_identifier(claims, …) == user.user_identifier`` —
       NIEMALS ``claims.user_id == user.id``: auf einem Self-Host ist
       ``user.id`` eine synthetische ID, ein direkter Vergleich liesse dort
       jedes Zertifikat fuer jedes Konto durch.
    3. Die Unterschrift ueber die Nutzlast stimmt, geprueft gegen
       ``claims.device_pubkey`` — den Pubkey AUS dem Zertifikat, nie aus dem
       Anfrage-Rumpf.
    4. (implizit) Die Unterschrift ist syntaktisch gueltiges Base64 —
       andernfalls dieselbe 403 wie eine falsche Unterschrift, kein 400 (das
       wuerde verraten, woran genau die Pruefung scheiterte).

    Der Aufrufer schreibt ``device_pubkey`` und ``cert_id`` fuer die
    gespeicherte Zeile aus den hier zurueckgegebenen ``claims`` — NIE aus dem
    Anfrage-Rumpf, sonst koennte jeder fuer ein fremdes Geraet einen
    Schluessel hinterlegen.
    """
    claims = await validate_cert(cert_jwt, redis)
    if claims is None:
        raise HTTPException(status_code=403, detail="Zertifikat ungueltig oder gesperrt")

    settings = get_settings()
    identifier = resolve_user_identifier(
        claims,
        instance_mode=settings.pulse_instance_mode,
        instance_id=settings.pulse_instance_id,
    )
    if identifier != user.user_identifier:
        raise HTTPException(
            status_code=403, detail="Zertifikat gehoert nicht zum angemeldeten Konto"
        )

    try:
        signatur = _b64url_decode(signatur_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=403, detail="Unterschrift ungueltig") from exc

    if not verify_challenge_signature(nutzlast, signatur, claims.device_pubkey):
        raise HTTPException(status_code=403, detail="Unterschrift ungueltig")

    return claims
