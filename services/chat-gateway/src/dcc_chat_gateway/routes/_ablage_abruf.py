"""Gemeinsames Fehler-Mapping + Antwortbau fuer die Ablage-Weiterreich-Routen.

``ablage_kanal.py::ablage_abruf`` und ``ablage_guild_laufwerk.py::
guild_ablage_abruf`` reichen beide Chiffrat von einer servereigenen
Basis-Adresse durch (``ablage_ssrf.py::hole``) und uebersetzen einen
geworfenen ``AblageAbrufFehler`` in denselben HTTP-Status — hier an EINER
Stelle statt zweimal, damit die Tabelle nicht auseinanderlaufen kann.
"""

from __future__ import annotations

from fastapi import HTTPException, Response, status

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler, hole

# Maschinenlesbarer Fehlercode -> HTTP-Status. Der Code selbst ist unschaedlich
# (verraet nur, WELCHE Regel griff, nie die Adresse/den Pfad) und deshalb
# Teil der Antwort — anders als die Freigabe-Adresse.
STATUS_JE_CODE: dict[str, int] = {
    "pfad_leer": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_kodierung": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_ungueltig": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_schema_wechsel": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_absolut": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_traversal": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ziel_schema": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ziel_ungueltig": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ziel_unaufloesbar": status.HTTP_502_BAD_GATEWAY,
    "ziel_privat": status.HTTP_403_FORBIDDEN,
    "umleitung_ohne_ziel": status.HTTP_502_BAD_GATEWAY,
    "zu_viele_umleitungen": status.HTTP_502_BAD_GATEWAY,
    "upstream_fehler": status.HTTP_502_BAD_GATEWAY,
    "upstream_nicht_erreichbar": status.HTTP_502_BAD_GATEWAY,
    "antwort_zu_gross": status.HTTP_413_CONTENT_TOO_LARGE,
    "zeit_ueberschritten": status.HTTP_504_GATEWAY_TIMEOUT,
}


async def ablage_abruf_antwort(basis: str, pfad: str) -> Response:
    """Holt ``pfad`` relativ zu ``basis`` (``ablage_ssrf.hole``) und baut
    daraus die Route-Antwort — oder wirft die passende ``HTTPException``."""
    settings = chat_config.get_settings()
    try:
        ergebnis = await hole(
            basis=basis,
            pfad=pfad,
            max_bytes=settings.ablage_abruf_max_bytes,
            timeout_s=settings.ablage_abruf_timeout_s,
        )
    except AblageAbrufFehler as exc:
        raise HTTPException(
            STATUS_JE_CODE.get(exc.code, status.HTTP_502_BAD_GATEWAY), detail=exc.code
        ) from exc
    return Response(
        content=ergebnis.inhalt,
        media_type=ergebnis.content_type or "application/octet-stream",
    )


__all__ = ["STATUS_JE_CODE", "ablage_abruf_antwort"]
