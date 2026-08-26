"""Die DM-Nachrichtensuche (``GET /dm-channels-search``).

Drei Dinge werden hier festgehalten, und alle drei sind schon einmal
danebengegangen:

* **Die Kennungen gehen als ZEICHENKETTE über die Leitung.** Die Route gab
  anfangs ein rohes ``dict`` zurück, also JSON-Zahlen; ``JS Number`` kann eine
  64-bit-Snowflake nicht exakt halten. Der Klient verglich danach ``number``
  mit ``string`` (immer falsch) und öffnete beim Antippen eines Treffers eine
  Kanal-Kennung, die ihre unteren Stellen verloren hatte.
* **Fremde Gespräche bleiben draussen.** Die Mitgliedschaft steckt allein in
  der Kanalmenge; wer sie beim Umbau der Abfrage verliert, merkt nichts,
  solange er allein testet.
* **Die Eingabe ist ein Wort, kein Muster.** Ein getipptes ``%`` darf nicht
  jede Nachricht treffen.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _user(_auth_signer) -> tuple[str, int]:
    import random

    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _dm_mit_nachricht(client, token: str, ziel_uid: int, text: str) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(ziel_uid)}, headers=auth(token)
    )
    assert r.status_code == 201
    kanal = r.json()["id"]
    r = await client.post(
        f"/channels/{kanal}/messages", json={"content": text}, headers=auth(token)
    )
    assert r.status_code == 201
    return kanal


@pytest.mark.asyncio
async def test_findet_eigene_nachricht(client, _auth_signer, friend_pair):
    t_a, uid_a = await _user(_auth_signer)
    _, uid_b = await _user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    kanal = await _dm_mit_nachricht(client, t_a, uid_b, "Treffen am Donnerstag")

    r = await client.get("/dm-channels-search", params={"q": "Donnerstag"}, headers=auth(t_a))
    assert r.status_code == 200
    treffer = r.json()
    assert len(treffer) == 1
    assert treffer[0]["dm_channel_id"] == kanal
    assert treffer[0]["content"] == "Treffen am Donnerstag"


@pytest.mark.asyncio
async def test_alle_kennungen_sind_zeichenketten(client, _auth_signer, friend_pair):
    """Der Kern des Fehlers: JSON-Zahlen verlieren die unteren Stellen."""
    t_a, uid_a = await _user(_auth_signer)
    _, uid_b = await _user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _dm_mit_nachricht(client, t_a, uid_b, "Kennungen bitte als Text")

    r = await client.get("/dm-channels-search", params={"q": "Kennungen"}, headers=auth(t_a))
    hit = r.json()[0]
    for feld in ("message_id", "dm_channel_id", "other_user_id", "author_id"):
        assert isinstance(hit[feld], str), f"{feld} ist keine Zeichenkette"
    # Und die Werte stimmen inhaltlich — nicht bloss der Typ.
    assert hit["other_user_id"] == str(uid_b)
    assert hit["author_id"] == str(uid_a)


@pytest.mark.asyncio
async def test_gegenueber_ist_der_ANDERE(client, _auth_signer, friend_pair):
    """``other_user_id`` ist aus Sicht des Fragenden zu füllen, nicht fest."""
    t_a, uid_a = await _user(_auth_signer)
    t_b, uid_b = await _user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _dm_mit_nachricht(client, t_a, uid_b, "Gegenprobe beidseitig")

    r_a = await client.get("/dm-channels-search", params={"q": "Gegenprobe"}, headers=auth(t_a))
    r_b = await client.get("/dm-channels-search", params={"q": "Gegenprobe"}, headers=auth(t_b))
    assert r_a.json()[0]["other_user_id"] == str(uid_b)
    assert r_b.json()[0]["other_user_id"] == str(uid_a)


@pytest.mark.asyncio
async def test_fremde_gespraeche_bleiben_draussen(client, _auth_signer, friend_pair):
    t_a, uid_a = await _user(_auth_signer)
    _, uid_b = await _user(_auth_signer)
    t_c, uid_c = await _user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _dm_mit_nachricht(client, t_a, uid_b, "Geheimwort Nashorn")

    # C ist an diesem Gespräch nicht beteiligt und darf es nicht finden.
    r = await client.get("/dm-channels-search", params={"q": "Nashorn"}, headers=auth(t_c))
    assert r.status_code == 200
    assert r.json() == []
    assert uid_c  # Kennung benutzt, damit sie nicht als unbenutzt gilt


@pytest.mark.asyncio
async def test_geloeschte_nachrichten_bleiben_draussen(client, _auth_signer, friend_pair):
    t_a, uid_a = await _user(_auth_signer)
    _, uid_b = await _user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    kanal = await _dm_mit_nachricht(client, t_a, uid_b, "Loeschkandidat Zebra")
    liste = await client.get(f"/channels/{kanal}/messages", headers=auth(t_a))
    nachricht_id = liste.json()[0]["id"]
    r = await client.delete(f"/messages/{nachricht_id}", headers=auth(t_a))
    assert r.status_code in (200, 204)

    r = await client.get("/dm-channels-search", params={"q": "Zebra"}, headers=auth(t_a))
    assert r.json() == []


@pytest.mark.asyncio
async def test_prozentzeichen_ist_ein_zeichen_kein_muster(client, _auth_signer, friend_pair):
    """Ohne Maskierung träfe ein getipptes ``%`` jede Nachricht der Instanz."""
    t_a, uid_a = await _user(_auth_signer)
    _, uid_b = await _user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _dm_mit_nachricht(client, t_a, uid_b, "ganz ohne Sonderzeichen")
    await _dm_mit_nachricht(client, t_a, uid_b, "Rabatt 50% auf alles")

    r = await client.get("/dm-channels-search", params={"q": "50%"}, headers=auth(t_a))
    treffer = r.json()
    assert len(treffer) == 1
    assert "50%" in treffer[0]["content"]

    # Der Unterstrich ebenso — er stünde sonst für „ein beliebiges Zeichen".
    r = await client.get("/dm-channels-search", params={"q": "a_z"}, headers=auth(t_a))
    assert r.json() == []


@pytest.mark.asyncio
async def test_zu_kurze_und_zu_lange_eingabe(client, _auth_signer):
    t_a, _ = await _user(_auth_signer)
    # Ein einzelnes Zeichen läse praktisch die ganze Tabelle — 422 statt Last.
    r = await client.get("/dm-channels-search", params={"q": "a"}, headers=auth(t_a))
    assert r.status_code == 422
    r = await client.get("/dm-channels-search", params={"q": "x" * 101}, headers=auth(t_a))
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_ohne_anmeldung_kein_zugriff(client):
    r = await client.get("/dm-channels-search", params={"q": "irgendwas"})
    assert r.status_code in (401, 403)
