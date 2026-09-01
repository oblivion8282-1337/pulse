"""Anhaenge in die Cloud-Laufwerke der Beteiligten (Design §11).

Die Fehlerklasse, gegen die diese Datei steht, ist ausdruecklich nicht
„falsches Ergebnis", sondern **stiller Fehlschlag**: ein Archiv, das nie
schreibt, und ein Abrufweg, der eine formal gueltige Adresse auf geloeschte
Bytes ausstellt. Beide sehen von aussen wie Erfolg aus. Die Tests pruefen
deshalb nicht nur Statuscodes, sondern WAS auf dem Laufwerk landete und was
danach im Objektspeicher noch da ist.

Die Helfer sind bewusst aus ``test_postfach_anhaenge.py`` kopiert, nicht
importiert — Testmodule laufen unter ``--import-mode=importlib`` und sind
untereinander nicht verlaesslich importierbar (dieselbe Begruendung steht
dort im Kopf).
"""

from __future__ import annotations

import base64
import itertools
import random

import pytest
import pytest_asyncio

from dcc_chat_gateway import ablage_anhang_verteilung as verteilung_mod
from dcc_chat_gateway import s3 as s3_mod
from dcc_chat_gateway.models import AblageKontoLaufwerk, MessageAttachment

pytestmark = pytest.mark.usefixtures("cloud_mode")

_geraete_zaehler = itertools.count()


def _b64_unpadded(data: bytes) -> str:
    return base64.b64encode(data).rstrip(b"=").decode()


def _make_device() -> str:
    return f"geraet-{next(_geraete_zaehler):036d}"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


class _S3Mock:
    """Objektspeicher-Attrappe mit ECHTEM Inhalt.

    ``stream_object`` liefert Bytes, die der Test vorher abgelegt hat —
    ohne das koennte kein Test belegen, dass genau der hochgeladene Klumpen
    auf dem Laufwerk landet, und „irgendetwas wurde geschrieben" waere die
    ganze Aussage.
    """

    def __init__(self) -> None:
        self.inhalte: dict[str, bytes] = {}
        self.put_calls: list[dict] = []
        self.deleted: list[str] = []

    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        self.put_calls.append({"key": key, "content_length": content_length})
        self.inhalte.setdefault(key, b"chiffrat-" + key.encode())
        return f"https://mock/{key}?put-sig"

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        return f"https://mock/{key}?get-sig"

    async def delete_object(self, key):
        self.deleted.append(key)
        self.inhalte.pop(key, None)

    async def stream_object(self, key):
        # Zwei Stuecke, damit die Groessenpruefung waehrend des Lesens
        # ueberhaupt einen zweiten Durchlauf sieht.
        roh = self.inhalte[key]
        yield roh[: len(roh) // 2]
        yield roh[len(roh) // 2 :]


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    monkeypatch.setattr(s3_mod, "stream_object", m.stream_object)
    return m


class _LaufwerkMock:
    """Faengt jedes ``schreibe`` ab und merkt sich Basis, Pfad und Bytes."""

    def __init__(self, *, fehler: str | None = None) -> None:
        self.schreibvorgaenge: list[tuple[str, str, bytes]] = []
        self.fehler = fehler

    async def schreibe(self, *, basis, pfad, inhalt, max_bytes=None, **_rest):
        if self.fehler:
            from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler

            raise AblageAbrufFehler(self.fehler)
        assert max_bytes is not None, (
            "Ohne max_bytes greift die 8-MiB-Vorgabe von ablage_schreiben und "
            "die 25-MB-Einstellung waere wirkungslos."
        )
        self.schreibvorgaenge.append((basis, pfad, inhalt))


@pytest.fixture
def mock_laufwerk(monkeypatch):
    m = _LaufwerkMock()
    monkeypatch.setattr(verteilung_mod, "schreibe_aufs_laufwerk", m.schreibe)
    return m


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _dm_erstellen(client, token_a: str, uid_b: int) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _bundel_seeden(session_factory, *, user_id: int) -> str:
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    pubkey = _make_device()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=next_id(), user_id=user_id, device_pubkey=pubkey,
                curve25519="curve-" + pubkey,
            )
        )
        await s.commit()
    return pubkey


async def _laufwerk_eintragen(session_factory, *, user_id: int, adresse: str) -> None:
    async with session_factory() as s:
        s.add(AblageKontoLaufwerk(user_id=user_id, freigabe_adresse=adresse))
        await s.commit()


async def _anhang_hochladen(client, *, token: str, channel_id: str, mit_vorschau=False):
    rumpf: dict = {"channel_id": str(channel_id), "size": 4096}
    if mit_vorschau:
        rumpf |= {"has_thumb": True, "thumb_size": 512}
    return await client.post(
        "/postfach/anhaenge/upload-url", json=rumpf, headers=_auth(token)
    )


async def _sendegeraet(client, token: str) -> str:
    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-" + pubkey},
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text
    return pubkey


async def _einliefern(client, *, token: str, channel_id: str, empfaenger, anhaenge):
    return await client.post(
        "/postfach",
        json={
            "channel_id": str(channel_id),
            "device_pubkey": await _sendegeraet(client, token),
            "nutzlasten": [
                {"art": 1, "daten": _b64_unpadded(b"olm"), "empfaenger": empfaenger}
            ],
            "anhaenge": anhaenge,
        },
        headers=_auth(token),
    )


async def _verteilen(client, *, token: str, anhang_id: str):
    return await client.post(
        f"/postfach/anhaenge/{anhang_id}/verteilen", headers=_auth(token)
    )


async def _aufbau(client, session_factory, _auth_signer, friend_pair, *, laufwerke=True):
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub_b = await _bundel_seeden(session_factory, user_id=uid_b)
    if laufwerke:
        for uid in (uid_a, uid_b):
            await _laufwerk_eintragen(
                session_factory, user_id=uid, adresse=f"https://wolke.example/{uid}"
            )
    return token_a, uid_a, token_b, uid_b, dm_id, pub_b


# ---------------------------------------------------------------------------
# Der Pfad — die einzige Stelle, an der sich Server und Klient einig sein
# muessen, ohne je miteinander zu reden
# ---------------------------------------------------------------------------


def test_archiv_pfad_ist_flach_und_traegt_nur_die_kennung():
    """Kein Unterordner (WebDAV antwortet auf ein PUT in eine fehlende
    Sammlung mit 409), kein Dateiname, kein Typ.

    Das Gegenstueck steht in ``web/src/lib/ablage/anhangArchivPfad.ts`` und
    hat dort denselben Test. Laufen die beiden auseinander, schreibt der
    Server an eine Stelle, an der der Klient nie nachsieht — und niemand
    saehe einen Fehler.
    """
    assert verteilung_mod.archiv_pfad(123456789) == "anh-123456789.puls"
    assert verteilung_mod.archiv_pfad(123456789, vorschau=True) == "anh-123456789-vs.puls"


# ---------------------------------------------------------------------------
# Der gute Fall
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anhang_landet_in_jedem_laufwerk_und_pulse_gibt_frei(
    client, session_factory, _auth_signer, friend_pair, mock_s3, mock_laufwerk
):
    """Beide Beteiligten bekommen dieselben Bytes; danach hat Pulse keine mehr.

    Genau diese Reihenfolge ist die Zusage aus §11.1 — und der Test prueft
    sie an den Bytes, nicht am Statuscode.
    """
    token_a, uid_a, _tb, uid_b, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    antwort = await _anhang_hochladen(
        client, token=token_a, channel_id=dm_id, mit_vorschau=True
    )
    anhang_id = antwort.json()["id"]
    async with session_factory() as s:
        zeile = await s.get(MessageAttachment, int(anhang_id))
        klumpen = mock_s3.inhalte[zeile.storage_key]
        vorschau = mock_s3.inhalte[zeile.thumb_storage_key]

    r = await _verteilen(client, token=token_a, anhang_id=anhang_id)
    assert r.status_code == 204, r.text

    # Zwei Laufwerke, je Klumpen und Vorschau -> vier Schreibvorgaenge.
    assert len(mock_laufwerk.schreibvorgaenge) == 4
    basen = {basis for basis, _, _ in mock_laufwerk.schreibvorgaenge}
    assert basen == {f"https://wolke.example/{uid_a}", f"https://wolke.example/{uid_b}"}
    for basis in basen:
        je_laufwerk = {
            pfad: inhalt
            for b, pfad, inhalt in mock_laufwerk.schreibvorgaenge
            if b == basis
        }
        assert je_laufwerk[f"anh-{anhang_id}.puls"] == klumpen
        assert je_laufwerk[f"anh-{anhang_id}-vs.puls"] == vorschau

    # Und erst DANACH die eigene Kopie — beide Schluessel, nicht nur einer.
    assert len(mock_s3.deleted) == 2
    async with session_factory() as s:
        assert (await s.get(MessageAttachment, int(anhang_id))).laufwerk_verteilt_am


@pytest.mark.asyncio
async def test_zweiter_aufruf_schiebt_nicht_noch_einmal(
    client, session_factory, _auth_signer, friend_pair, mock_s3, mock_laufwerk
):
    """Ein Wiederholungsversuch nach Netzabbruch darf keine zweite Kopie in
    fremde Ordner legen — und darf trotzdem nicht als Fehler aussehen."""
    token_a, *_rest, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]

    assert (await _verteilen(client, token=token_a, anhang_id=anhang_id)).status_code == 204
    vorher = len(mock_laufwerk.schreibvorgaenge)
    assert (await _verteilen(client, token=token_a, anhang_id=anhang_id)).status_code == 204
    assert len(mock_laufwerk.schreibvorgaenge) == vorher


# ---------------------------------------------------------------------------
# Die Fehlschlaege, und dass sie laut sind
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ohne_laufwerk_bleibt_alles_wie_bisher(
    client, session_factory, _auth_signer, friend_pair, mock_s3, mock_laufwerk
):
    """Fehlt einem Beteiligten das Laufwerk, wird NICHTS geschrieben und
    NICHTS geloescht — der Anhang bleibt auf dem heutigen Weg erreichbar.

    Der Anhang-Knopf verhindert diesen Fall in der Oberflaeche (§11.2), aber
    der Server darf sich darauf nicht verlassen.
    """
    token_a, uid_a, *_rest, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, laufwerke=False
    )
    await _laufwerk_eintragen(
        session_factory, user_id=uid_a, adresse="https://wolke.example/nur-a"
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]

    r = await _verteilen(client, token=token_a, anhang_id=anhang_id)
    assert r.status_code == 502
    assert r.json()["detail"] == "kein_laufwerk"
    # Nicht einmal auf das EINE vorhandene Laufwerk — halb verteilt waere
    # schlechter als gar nicht.
    assert mock_laufwerk.schreibvorgaenge == []
    assert mock_s3.deleted == []
    async with session_factory() as s:
        assert (await s.get(MessageAttachment, int(anhang_id))).laufwerk_verteilt_am is None


@pytest.mark.asyncio
async def test_schreibfehler_haelt_die_eigene_kopie(
    client, session_factory, _auth_signer, friend_pair, mock_s3, monkeypatch
):
    """Scheitert das fremde Laufwerk, meldet die Route 502 mit einer Kennung
    — und die Bytes bleiben bei Pulse. Ein stiller Erfolg waere hier der
    endgueltige Verlust der Datei."""
    kaputt = _LaufwerkMock(fehler="upstream_nicht_erreichbar")
    monkeypatch.setattr(verteilung_mod, "schreibe_aufs_laufwerk", kaputt.schreibe)
    token_a, *_rest, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]

    r = await _verteilen(client, token=token_a, anhang_id=anhang_id)
    assert r.status_code == 502
    assert r.json()["detail"] == "laufwerk_upstream_nicht_erreichbar"
    assert mock_s3.deleted == []


@pytest.mark.asyncio
async def test_fremder_anhang_laesst_sich_nicht_verteilen(
    client, session_factory, _auth_signer, friend_pair, mock_s3, mock_laufwerk
):
    """Nur der Hochladende setzt seinen eigenen Upload fort."""
    token_a, _uid_a, token_b, *_rest, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]

    r = await _verteilen(client, token=token_b, anhang_id=anhang_id)
    assert r.status_code == 404
    assert mock_laufwerk.schreibvorgaenge == []


@pytest.mark.asyncio
async def test_abrufadresse_sagt_410_statt_einer_adresse_ins_leere(
    client, session_factory, _auth_signer, friend_pair, mock_s3, mock_laufwerk
):
    """**Der Kern der Sichtbarkeits-Regel.** Nach der Verteilung hat Pulse
    keine Bytes mehr. Ohne die 410 bekaeme der Empfaenger hier eine
    einwandfreie vorsignierte Adresse auf ein geloeschtes Objekt und liefe in
    einen 404 des Objektspeichers, den er von „Anhang verfallen" nicht
    unterscheiden kann — ein toter Weg, an dem nirgends etwas rot wird.
    """
    token_a, _uid_a, token_b, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]
    assert (await _verteilen(client, token=token_a, anhang_id=anhang_id)).status_code == 204
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], anhaenge=[anhang_id]
    )
    assert r.status_code == 200, r.text

    antwort = await client.post(
        f"/postfach/anhaenge/{anhang_id}/abrufadresse",
        json={"device_pubkey": pub_b},
        headers=_auth(token_b),
    )
    assert antwort.status_code == 410
    assert antwort.json()["detail"] == "anhang_im_laufwerk"

    # Und ein Unbeteiligter erfaehrt aus dem Unterschied 410/404 nichts: er
    # bekommt weiterhin 404, nicht die aussagekraeftigere 410.
    token_c, uid_c = await _register(_auth_signer)
    pub_c = await _bundel_seeden(session_factory, user_id=uid_c)
    fremd = await client.post(
        f"/postfach/anhaenge/{anhang_id}/abrufadresse",
        json={"device_pubkey": pub_c},
        headers=_auth(token_c),
    )
    assert fremd.status_code == 404


# ---------------------------------------------------------------------------
# Bereitschaft — die Auskunft, die den Knopf schaltet
# ---------------------------------------------------------------------------


async def _bereitschaft(client, *, token: str, channel_id: str):
    return await client.get(
        "/postfach/anhaenge/bereitschaft",
        params={"channel_id": str(channel_id)},
        headers=_auth(token),
    )


@pytest.mark.asyncio
async def test_bereitschaft_nennt_wer_blockiert(
    client, session_factory, _auth_signer, friend_pair, mock_s3
):
    """§11.2 verlangt, dass die Oberflaeche den Fall BENENNEN kann. Dafuer
    muss die Auskunft die Konten liefern, nicht nur ein Ja/Nein."""
    token_a, uid_a, _tb, uid_b, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, laufwerke=False
    )
    r = await _bereitschaft(client, token=token_a, channel_id=dm_id)
    assert r.status_code == 200, r.text
    assert r.json()["moeglich"] is False
    assert set(r.json()["ohne_laufwerk"]) == {str(uid_a), str(uid_b)}

    await _laufwerk_eintragen(session_factory, user_id=uid_a, adresse="https://w/a")
    r = await _bereitschaft(client, token=token_a, channel_id=dm_id)
    assert r.json()["moeglich"] is False
    assert r.json()["ohne_laufwerk"] == [str(uid_b)]

    await _laufwerk_eintragen(session_factory, user_id=uid_b, adresse="https://w/b")
    r = await _bereitschaft(client, token=token_a, channel_id=dm_id)
    assert r.json()["moeglich"] is True
    assert r.json()["ohne_laufwerk"] == []


@pytest.mark.asyncio
async def test_bereitschaft_gibt_keine_adresse_heraus(
    client, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Die Freigabe-Adresse ist ein Schluessel in Textform (§4.0) und verlaesst
    den Server nie — auch nicht an den Eigentuemer selbst."""
    token_a, *_rest, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    r = await _bereitschaft(client, token=token_a, channel_id=dm_id)
    assert "wolke.example" not in r.text
    assert set(r.json()) == {"moeglich", "ohne_laufwerk", "max_bytes"}


@pytest.mark.asyncio
async def test_bereitschaft_nur_fuer_teilnehmer(
    client, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Dieselbe Kanalpruefung wie beim Einliefern — eine lockerere Regel waere
    eine Konto-Auskunft an Unbeteiligte."""
    _ta, _uid_a, _tb, _uid_b, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    token_c, _uid_c = await _register(_auth_signer)
    r = await _bereitschaft(client, token=token_c, channel_id=dm_id)
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Die Grenze ist eine EINSTELLUNG (§11.3)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_grenze_kommt_aus_der_einstellung_und_wird_gemeldet(
    client, session_factory, _auth_signer, friend_pair, mock_s3, cloud_mode
):
    """Drei Stellen, eine Quelle: die Upload-Route weist ab, ``/capabilities``
    meldet dieselbe Zahl, und die Bereitschafts-Antwort traegt sie mit.

    Ohne diesen Test koennte die Einstellung an einer der drei Stellen
    hartkodiert bleiben, und der Nutzer bekaeme eine Absage NACH dem
    Verschluesseln und Hochladen statt davor.
    """
    cloud_mode.ablage_anhang_max_bytes = 1000
    token_a, *_rest, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )

    zu_gross = await client.post(
        "/postfach/anhaenge/upload-url",
        json={"channel_id": str(dm_id), "size": 1001},
        headers=_auth(token_a),
    )
    assert zu_gross.status_code == 413

    passt = await client.post(
        "/postfach/anhaenge/upload-url",
        json={"channel_id": str(dm_id), "size": 1000},
        headers=_auth(token_a),
    )
    assert passt.status_code == 201, passt.text

    caps = await client.get("/capabilities", headers=_auth(token_a))
    assert caps.json()["ablage_anhang_max_bytes"] == 1000
    bereit = await _bereitschaft(client, token=token_a, channel_id=dm_id)
    assert bereit.json()["max_bytes"] == 1000
