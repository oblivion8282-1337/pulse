"""Das Konto-Laufwerk widerrufen — ``DELETE /ablage/archiv/laufwerk``.

**Die Fehlerklasse, gegen die diese Datei steht, ist wieder der stille
Fehlschlag**, diesmal in seiner unangenehmsten Form: ein Trennen, das nur
lokal wirkt. Der Zwei-Browser-Nachweis
(``web/tests/e2e/e2e-anhang-archiv-hetzner.spec.ts``) hat am 2026-09-01
gemessen, dass das Gegenueber nach dem Trennen weiter einen Anhang-Knopf
sah: die Adresse blieb serverseitig stehen, die Bereitschafts-Auskunft
meldete weiter „kann empfangen", und die Verteilung haette in einen Ordner
geschrieben, den der Nutzer abgehaengt hat.

Der letzte Test hier ist deshalb der wichtigste — er prueft nicht den
Statuscode der Loeschroute, sondern die Auskunft, die daran haengt.
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway.models import AblageKontoLaufwerk

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


async def _zeile(session_factory, user_id: int) -> AblageKontoLaufwerk | None:
    async with session_factory() as s:
        return await s.get(AblageKontoLaufwerk, user_id)


@pytest.mark.asyncio
async def test_loeschen_nimmt_die_adresse_weg(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")
    assert await _zeile(session_factory, uid) is not None

    antwort = await client.delete("/ablage/archiv/laufwerk", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text
    assert await _zeile(session_factory, uid) is None


@pytest.mark.asyncio
async def test_ohne_hinterlegte_adresse_ist_das_loeschen_erfolgreich(client, _auth_signer):
    """Idempotent — s. Docstring der Route.

    Der Klient bricht sein Trennen ab, wenn der Server nicht quittiert. Ein
    404 fuer „war ohnehin schon weg" liesse ihn genau dort haengen, ohne
    dass es etwas zu heilen gaebe.
    """
    token, _uid = await _register(_auth_signer)

    antwort = await client.delete("/ablage/archiv/laufwerk", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text


@pytest.mark.asyncio
async def test_danach_gibt_es_nichts_mehr_abzurufen(client, _auth_signer):
    """Die Folgeroute faellt auf 404 zurueck — nicht auf einen 502 gegen die
    inzwischen widerrufene Freigabe."""
    token, _uid = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")
    await client.delete("/ablage/archiv/laufwerk", headers=_auth(token))

    antwort = await client.get("/ablage/archiv/liste", headers=_auth(token))

    assert antwort.status_code == 404, antwort.text


@pytest.mark.asyncio
async def test_es_trifft_nur_das_eigene_konto(client, session_factory, _auth_signer):
    """Der Primaerschluessel ist die eigene Nutzer-Id — geprueft, nicht
    angenommen: eine Loeschung ohne ``WHERE`` faellt nur hier auf."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await _laufwerk_setzen(client, token_a, "https://wolke.example/a")
    await _laufwerk_setzen(client, token_b, "https://wolke.example/b")

    await client.delete("/ablage/archiv/laufwerk", headers=_auth(token_a))

    assert await _zeile(session_factory, uid_a) is None
    assert await _zeile(session_factory, uid_b) is not None


@pytest.mark.asyncio
async def test_ohne_anmeldung_wird_nichts_geloescht(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")

    antwort = await client.delete("/ablage/archiv/laufwerk")

    assert antwort.status_code == 401, antwort.text
    assert await _zeile(session_factory, uid) is not None


@pytest.mark.asyncio
async def test_die_bereitschaft_faellt_mit(client, _auth_signer, friend_pair):
    """**Der eigentliche Befund.**

    Nach dem Trennen muss das Gespraech als „kann keine Anhaenge tragen"
    gelten, und die Auskunft muss den Verursacher benennen — sonst zeigt die
    Gegenseite weiter einen Anhang-Knopf, dessen Verteilung (Alles-oder-
    nichts) am ersten Ziel scheitert.
    """
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    for token in (token_a, token_b):
        await _laufwerk_setzen(client, token, "https://wolke.example/x")

    erstellt = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert erstellt.status_code == 201, erstellt.text
    kanal = erstellt.json()["id"]

    vorher = await client.get(
        "/postfach/anhaenge/bereitschaft",
        params={"channel_id": kanal},
        headers=_auth(token_a),
    )
    assert vorher.status_code == 200, vorher.text
    assert vorher.json()["moeglich"] is True

    await client.delete("/ablage/archiv/laufwerk", headers=_auth(token_b))

    nachher = await client.get(
        "/postfach/anhaenge/bereitschaft",
        params={"channel_id": kanal},
        headers=_auth(token_a),
    )
    assert nachher.status_code == 200, nachher.text
    assert nachher.json()["moeglich"] is False
    assert nachher.json()["ohne_laufwerk"] == [str(uid_b)]
