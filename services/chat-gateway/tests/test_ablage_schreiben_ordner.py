"""``ordner_anlegen`` (WebDAV-``MKCOL``) und ``liste(..., ordner=...)``.

Kanaele liegen als Ordner ``kanaele/<channel_id>/`` im Konto-Laufwerk ihres
Erstellers (Entwurf 2026-09-02, §2-3). Der Server muss diesen Ordner selbst
anlegen koennen (Nextcloud legt Zwischenordner bei einem ``PUT`` nicht von
allein an) und den Bestand eines Unterordners abfragen koennen — dieselbe
Bestandsaufnahme wie bei ``liste`` auf der Laufwerks-Wurzel, nur eine Ebene
tiefer.
"""

from __future__ import annotations

import httpx
import pytest
from dcc_chat_gateway import ablage_schreiben
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler


async def _oeffentlich(_host: str) -> list[str]:
    return ["203.0.113.7"]


def _client_mit(status: int, gesehen: list[httpx.Request]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(status)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _client_mit_sequenz(status_je_aufruf: list[int], gesehen: list[httpx.Request]) -> httpx.AsyncClient:
    restliche = list(status_je_aufruf)

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        status = restliche.pop(0) if restliche else status_je_aufruf[-1]
        return httpx.Response(status)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --- ordner_anlegen ----------------------------------------------------------


@pytest.mark.asyncio
async def test_ordner_anlegen_schickt_ein_mkcol_je_segment():
    gesehen: list[httpx.Request] = []
    async with _client_mit(201, gesehen) as http:
        await ablage_schreiben.ordner_anlegen(
            basis="https://wolke.example/public.php/dav/files/abc",
            pfad="kanaele/42",
            resolver=_oeffentlich,
            http=http,
        )
    assert len(gesehen) == 2
    assert all(r.method == "MKCOL" for r in gesehen)
    assert gesehen[0].url.path == "/public.php/dav/files/abc/kanaele"
    assert gesehen[1].url.path == "/public.php/dav/files/abc/kanaele/42"


@pytest.mark.asyncio
async def test_ordner_anlegen_405_auf_dem_ersten_bricht_nicht_ab():
    gesehen: list[httpx.Request] = []
    async with _client_mit_sequenz([405, 201], gesehen) as http:
        await ablage_schreiben.ordner_anlegen(
            basis="https://wolke.example/abc",
            pfad="kanaele/42",
            resolver=_oeffentlich,
            http=http,
        )
    assert len(gesehen) == 2


@pytest.mark.asyncio
async def test_ordner_anlegen_403_wirft():
    gesehen: list[httpx.Request] = []
    async with _client_mit(403, gesehen) as http:
        with pytest.raises(AblageAbrufFehler):
            await ablage_schreiben.ordner_anlegen(
                basis="https://wolke.example/abc",
                pfad="kanaele/42",
                resolver=_oeffentlich,
                http=http,
            )


# --- liste(..., ordner=...) --------------------------------------------------

_PROPFIND_ANTWORT = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/public.php/dav/files/abc/kanaele/42/</d:href></d:response>
  <d:response><d:href>/public.php/dav/files/abc/kanaele/42/seg-1.puls</d:href></d:response>
</d:multistatus>
"""


@pytest.mark.asyncio
async def test_liste_mit_ordner_fragt_den_unterordner_ab():
    gesehen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(207, text=_PROPFIND_ANTWORT)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        namen = await ablage_schreiben.liste(
            basis="https://wolke.example/public.php/dav/files/abc",
            ordner="kanaele/42",
            resolver=_oeffentlich,
            http=http,
        )

    assert len(gesehen) == 1
    assert gesehen[0].method == "PROPFIND"
    assert gesehen[0].url.path == "/public.php/dav/files/abc/kanaele/42/"
    assert namen == ["seg-1.puls"]
