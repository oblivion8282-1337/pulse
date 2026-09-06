"""Eine Datei aus dem Konto-Archiv entfernen — ``DELETE /ablage/archiv/datei``.

Die Sicherung laeuft seit dem 2026-09-02 fuer Nextcloud ueber diese Adresse
(``web/src/lib/sicherung/ziele.ts``) und braucht das Loeschen fuer zwei
Faelle: die Anhang-Datei einer geloeschten Nachricht und den Ordner eines
entfernten Gespraechs. Vorher gab es die Route nicht — die Datei blieb im
Laufwerk liegen, lesbar, ohne dass irgendwo etwas rot wurde.
"""

from __future__ import annotations

import random

import httpx
import pytest

from dcc_chat_gateway import ablage_schreiben
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.routes import ablage_konto_laufwerk as route_mod

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _laufwerk_setzen(client, token: str, adresse: str) -> None:
    antwort = await client.put(
        "/ablage/archiv/laufwerk",
        json={"freigabe_adresse": adresse},
        headers=_auth(token),
    )
    assert antwort.status_code == 204, antwort.text


class _LoeschMock:
    """Faengt ``loesche`` ab und merkt sich Basis und Pfad."""

    def __init__(self, *, fehler: str | None = None) -> None:
        self.aufrufe: list[tuple[str, str]] = []
        self.fehler = fehler

    async def loesche(self, *, basis, pfad, **_rest):
        self.aufrufe.append((basis, pfad))
        if self.fehler is not None:
            raise AblageAbrufFehler(self.fehler)


@pytest.fixture
def mock_loeschen(monkeypatch):
    m = _LoeschMock()
    monkeypatch.setattr(route_mod, "loesche_vom_laufwerk", m.loesche)
    return m


# --- Route ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_loescht_am_hinterlegten_laufwerk(client, _auth_signer, mock_loeschen):
    token, _ = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/public.php/dav/files/abc")

    antwort = await client.delete(
        "/ablage/archiv/datei", params={"pfad": "k1~seg-1.puls"}, headers=_auth(token)
    )

    assert antwort.status_code == 204, antwort.text
    assert mock_loeschen.aufrufe == [
        ("https://wolke.example/public.php/dav/files/abc", "k1~seg-1.puls")
    ]


@pytest.mark.asyncio
async def test_ohne_laufwerk_gibt_es_nichts_zu_loeschen(client, _auth_signer, mock_loeschen):
    token, _ = await _register(_auth_signer)

    antwort = await client.delete(
        "/ablage/archiv/datei", params={"pfad": "x.puls"}, headers=_auth(token)
    )

    assert antwort.status_code == 404
    assert mock_loeschen.aufrufe == []


@pytest.mark.asyncio
async def test_ohne_anmeldung_wird_nichts_geloescht(client, mock_loeschen):
    antwort = await client.delete("/ablage/archiv/datei", params={"pfad": "x.puls"})

    assert antwort.status_code == 401
    assert mock_loeschen.aufrufe == []


@pytest.mark.asyncio
async def test_upstream_fehler_wird_zum_502(client, _auth_signer, monkeypatch):
    token, _ = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")
    kaputt = _LoeschMock(fehler="upstream_fehler")
    monkeypatch.setattr(route_mod, "loesche_vom_laufwerk", kaputt.loesche)

    antwort = await client.delete(
        "/ablage/archiv/datei", params={"pfad": "x.puls"}, headers=_auth(token)
    )

    assert antwort.status_code == 502


# --- Der Weiterreicher selbst ---------------------------------------------


async def _oeffentlich(_host: str) -> list[str]:
    return ["203.0.113.7"]


def _client_mit(status: int, gesehen: list[httpx.Request]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(status)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_loesche_schickt_ein_dav_delete_auf_den_pfad():
    gesehen: list[httpx.Request] = []
    async with _client_mit(204, gesehen) as http:
        await ablage_schreiben.loesche(
            basis="https://wolke.example/public.php/dav/files/abc",
            pfad="k1~seg-1.puls",
            resolver=_oeffentlich,
            http=http,
        )
    assert len(gesehen) == 1
    assert gesehen[0].method == "DELETE"
    assert gesehen[0].url.path == "/public.php/dav/files/abc/k1~seg-1.puls"
    assert gesehen[0].headers["host"] == "wolke.example"


@pytest.mark.asyncio
async def test_ein_404_gilt_als_erfolg():
    gesehen: list[httpx.Request] = []
    async with _client_mit(404, gesehen) as http:
        await ablage_schreiben.loesche(
            basis="https://wolke.example/abc", pfad="weg.puls", resolver=_oeffentlich, http=http
        )
    assert len(gesehen) == 1


@pytest.mark.asyncio
async def test_andere_fehler_werfen():
    gesehen: list[httpx.Request] = []
    async with _client_mit(403, gesehen) as http:
        with pytest.raises(AblageAbrufFehler):
            await ablage_schreiben.loesche(
                basis="https://wolke.example/abc", pfad="x.puls", resolver=_oeffentlich, http=http
            )


@pytest.mark.asyncio
async def test_umleitung_wird_nicht_verfolgt():
    gesehen: list[httpx.Request] = []
    async with _client_mit(302, gesehen) as http:
        with pytest.raises(AblageAbrufFehler):
            await ablage_schreiben.loesche(
                basis="https://wolke.example/abc", pfad="x.puls", resolver=_oeffentlich, http=http
            )
    assert len(gesehen) == 1


@pytest.mark.asyncio
async def test_pfad_mit_aufstieg_wird_abgewiesen():
    gesehen: list[httpx.Request] = []
    async with _client_mit(204, gesehen) as http:
        with pytest.raises(AblageAbrufFehler):
            await ablage_schreiben.loesche(
                basis="https://wolke.example/abc", pfad="../key.puls", resolver=_oeffentlich, http=http
            )
    assert gesehen == []
