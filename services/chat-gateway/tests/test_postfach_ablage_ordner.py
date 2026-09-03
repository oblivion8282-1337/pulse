"""Einliefern legt ab, Pflege holt nach (Entwurf 2026-09-02, §2-3, Task 4).

``POST /postfach`` ruft nach dem Commit den Ableger (Task 3) fuer jede
Nutzlast mit ``archiv: true`` — nur, wenn der Kanal ueberhaupt eine
``AblageKanalOrdner``-Zeile hat, entscheidet ``ablegen_im_ordner`` selbst
(``False`` bei einem gewoehnlichen Kanal). Scheitert das Ablegen (Nextcloud
kurz nicht erreichbar), bleibt die Antwort ein Erfolg — der Umschlag ist
zugestellt, nur die Festigung fehlt noch, und dafuer entsteht ein Nachtrag.

Helfer bewusst aus ``test_postfach_anhaenge_laufwerk.py`` kopiert statt
importiert — Testmodule laufen unter ``--import-mode=importlib`` und sind
untereinander nicht verlaesslich importierbar (dieselbe Begruendung wie
dort).
"""

from __future__ import annotations

import base64
import itertools
import random
from types import SimpleNamespace

import pytest
from dcc_chat_gateway import ablage_kanal_nachtrag as nachtrag_mod
from dcc_chat_gateway import ablage_kanal_ordner as ordner_mod
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
)
from dcc_chat_gateway.routes import postfach as postfach_mod
from sqlalchemy import select

pytestmark = pytest.mark.usefixtures("cloud_mode")

_geraete_zaehler = itertools.count()


def _make_device() -> str:
    return f"geraet-{next(_geraete_zaehler):036d}"


def _b64_unpadded(data: bytes) -> str:
    return base64.b64encode(data).rstrip(b"=").decode()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _dm_erstellen(client, token_a: str, uid_b: int) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _sendegeraet(client, token: str) -> str:
    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-" + pubkey},
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text
    return pubkey


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


async def _ordner_eintragen(session_factory, *, channel_id, ersteller_id: int) -> None:
    """Ordner-Zeile UND Konto-Laufwerk des Erstellers.

    Beides zusammen, weil es nur zusammen vorkommt: die Ordner-Zeile entsteht
    ausschliesslich ueber ``PUT .../ablage/ordner``, und die Route verlangt
    dafuer ein Konto-Laufwerk (412 sonst). Ohne das Laufwerk gilt ein Nachtrag
    zu diesem Kanal seit I6 als aufgegeben statt als wiederholbar — ein
    Zustand, den es in der Wirklichkeit nur gibt, wenn der Ersteller sein
    Laufwerk NACHTRAEGLICH abgehaengt hat.
    """
    async with session_factory() as s:
        s.add(AblageKanalOrdner(channel_id=int(channel_id), ersteller_id=ersteller_id))
        s.add(
            AblageKontoLaufwerk(
                user_id=ersteller_id, freigabe_adresse="https://wolke.example/ersteller"
            )
        )
        await s.commit()


async def _einliefern(client, *, token: str, channel_id, empfaenger, archiv: bool):
    return await client.post(
        "/postfach",
        json={
            "channel_id": str(channel_id),
            "device_pubkey": await _sendegeraet(client, token),
            "nutzlasten": [
                {
                    "art": 1,
                    "daten": _b64_unpadded(b"olm"),
                    "empfaenger": empfaenger,
                    "archiv": archiv,
                }
            ],
        },
        headers=_auth(token),
    )


async def _aufbau(client, session_factory, _auth_signer, friend_pair, *, mit_ordner: bool):
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub_b = await _bundel_seeden(session_factory, user_id=uid_b)
    if mit_ordner:
        await _ordner_eintragen(session_factory, channel_id=dm_id, ersteller_id=uid_a)
    return token_a, uid_a, token_b, uid_b, dm_id, pub_b


class _AblegerMock:
    """Der Ableger, den ``routes/postfach.py`` als Hintergrundaufgabe ruft.

    Aufgezeichnet wird eine KOPIE der drei interessanten Felder, nicht die
    ORM-Zeile selbst: die Hintergrundaufgabe schliesst ihre Session, sobald
    sie fertig ist, und im Fehlerpfad setzt sie sie ausserdem zurueck — ein
    festgehaltenes ORM-Objekt waere danach abgehaengt und jeder Feldzugriff
    im Test ein ``DetachedInstanceError``.
    """

    def __init__(self, *, fehler: BaseException | None = None) -> None:
        self.aufrufe: list[SimpleNamespace] = []
        self.fehler = fehler

    async def __call__(self, session, nutzlast):
        self.aufrufe.append(
            SimpleNamespace(
                id=nutzlast.id,
                channel_id=nutzlast.channel_id,
                absender_user_id=nutzlast.absender_user_id,
            )
        )
        if self.fehler is not None:
            raise self.fehler
        return True


@pytest.mark.asyncio
async def test_archiv_true_ruft_den_ableger_einmal_auf(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    mock = _AblegerMock()
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)
    token_a, uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=True
    )
    assert r.status_code == 200, r.text

    assert len(mock.aufrufe) == 1
    assert mock.aufrufe[0].channel_id == int(dm_id)
    assert mock.aufrufe[0].absender_user_id == uid_a


@pytest.mark.asyncio
async def test_ohne_archiv_wird_der_ableger_nicht_gerufen(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    mock = _AblegerMock()
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)
    token_a, _uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=False
    )
    assert r.status_code == 200, r.text
    assert mock.aufrufe == []


@pytest.mark.asyncio
async def test_ablage_fehler_bleibt_200_und_hinterlaesst_einen_nachtrag(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    mock = _AblegerMock(fehler=AblageAbrufFehler("upstream_nicht_erreichbar"))
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)
    token_a, _uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=True
    )
    assert r.status_code == 200, r.text
    assert len(mock.aufrufe) == 1

    nutzlast_id = mock.aufrufe[0].id
    async with session_factory() as s:
        nachtrag = await s.get(AblageKanalNachtrag, nutzlast_id)
    assert nachtrag is not None
    assert nachtrag.channel_id == int(dm_id)


@pytest.mark.asyncio
async def test_sweep_raeumt_den_nachtrag_wenn_es_danach_klappt(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    kaputt = _AblegerMock(fehler=AblageAbrufFehler("upstream_nicht_erreichbar"))
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", kaputt)
    token_a, _uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=True
    )
    assert r.status_code == 200, r.text
    nutzlast_id = kaputt.aufrufe[0].id

    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast_id) is not None

    heil = _AblegerMock()
    monkeypatch.setattr(ordner_mod, "ablegen", heil)
    async with session_factory() as s:
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)
    assert (erledigt, aufgegeben) == (1, 0)
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast_id) is None


@pytest.mark.asyncio
async def test_programmfehler_im_ableger_bleibt_200_und_hinterlaesst_einen_nachtrag(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """I7: die Festigung faengt JEDEN Fehler, nicht nur ``AblageAbrufFehler``.

    Ein ``TypeError`` im Ableger ist der Fall, der frueher durchschlug: die
    Hintergrundaufgabe laeuft in Starlette NACH der bereits gesendeten
    Antwort, ein Wurf dort faellt aus dem ASGI-Aufruf heraus. Der Umschlag
    ist zu diesem Zeitpunkt zugestellt — es gibt nichts zu melden ausser der
    fehlenden Festigung, und genau die traegt der Nachtrag.
    """
    mock = _AblegerMock(fehler=TypeError("kaputter Ableger"))
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)
    token_a, _uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=True
    )

    assert r.status_code == 200, r.text
    assert len(mock.aufrufe) == 1
    async with session_factory() as s:
        nachtrag = await s.get(AblageKanalNachtrag, mock.aufrufe[0].id)
    assert nachtrag is not None
    assert nachtrag.channel_id == int(dm_id)


# ---------------------------------------------------------------------------
# R1 — der Marker steht schon im Einliefer-Commit
# ---------------------------------------------------------------------------


async def _abholen_und_quittieren(client, *, token: str, geraet: str) -> None:
    offen = await client.post(
        "/postfach/abholen", json={"device_pubkey": geraet}, headers=_auth(token)
    )
    assert offen.status_code == 200, offen.text
    ids = [z["id"] for z in offen.json()]
    quittung = await client.post(
        "/postfach/quittung",
        json={"device_pubkey": geraet, "zustellung_ids": ids},
        headers=_auth(token),
    )
    assert quittung.status_code == 204, quittung.text


@pytest.mark.asyncio
async def test_schnelle_quittung_vor_der_ablage_verliert_die_datei_nicht(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """R1, der wichtigste Punkt: die Festigung laeuft NACH der Antwort, ein
    zuegig quittierendes Geraet war regelmaessig frueher dran — und loeschte
    die Nutzlast, bevor sie jemand ablegen konnte.

    Der Wettlauf wird gestellt, indem die Hintergrundaufgabe hier gar nicht
    laeuft (sie ist ersetzt): danach quittiert der Empfaenger, und erst
    danach holt der Nachtrag-Sweep die Ablage nach. Ohne den Marker im
    Einliefer-Commit waere die Nutzlast an dieser Stelle laengst weg.
    """
    gerufen: list[list[int]] = []

    async def _nichts_tun(nutzlast_ids, *, ableger):
        gerufen.append(list(nutzlast_ids))

    monkeypatch.setattr(postfach_mod, "festigung_nachlaufen", _nichts_tun)
    token_a, _uid_a, token_b, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=True
    )
    assert r.status_code == 200, r.text
    nutzlast_id = gerufen[0][0]
    async with session_factory() as s:
        # Der Marker steht schon jetzt — vor jedem Hintergrundlauf.
        assert await s.get(AblageKanalNachtrag, nutzlast_id) is not None

    await _abholen_und_quittieren(client, token=token_b, geraet=pub_b)

    from dcc_chat_gateway.models import DmNutzlast

    async with session_factory() as s:
        assert await s.get(DmNutzlast, nutzlast_id) is not None

    geschrieben: list[str] = []

    async def _mkcol(*, basis, pfad, **_rest):
        return None

    async def _schreibe(*, basis, pfad, inhalt, **_rest):
        geschrieben.append(pfad)

    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", _mkcol)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", _schreibe)
    ordner_mod.ordner_zwischenspeicher_leeren()
    async with session_factory() as s:
        assert await nachtrag_mod.nachtrag_sweep(s) == (1, 0)

    assert geschrieben == [f"kanaele/{dm_id}/{nutzlast_id}.puls"]
    # Und danach faellt die Nutzlast wie jede andere quittierte.
    from dcc_chat_gateway.postfach_pflege import sweep_verwaiste_nutzlasten

    async with session_factory() as s:
        await sweep_verwaiste_nutzlasten(s)
    async with session_factory() as s:
        assert await s.get(DmNutzlast, nutzlast_id) is None


@pytest.mark.asyncio
async def test_archiv_nutzlast_ohne_empfaengergeraet_wird_trotzdem_abgelegt(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """R1, zweiter Teil: ein Ordner-Kanal, in dem gerade kein Empfaengergeraet
    erreichbar ist, hat trotzdem einen dauerhaften Bestand — genau er ist der
    Zweck des Kanals. Vorher zaehlte der Server so einen Umschlag als
    ``verworfene_nutzlasten`` und legte nichts an."""
    mock = _AblegerMock()
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)
    token_a, _uid_a, _tb, _uid_b, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )

    r = await _einliefern(
        client,
        token=token_a,
        channel_id=dm_id,
        empfaenger=[_make_device()],  # kennt der Server nicht -> uebersprungen
        archiv=True,
    )

    assert r.status_code == 200, r.text
    rumpf = r.json()
    assert rumpf["zustellungen_angelegt"] == 0
    assert rumpf["verworfene_nutzlasten"] == 0
    assert len(mock.aufrufe) == 1


@pytest.mark.asyncio
async def test_ohne_ordner_kanal_entsteht_kein_marker_und_nichts_bleibt_liegen(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """Gegenprobe zu R1: ein gewoehnlicher Kanal bekommt keinen Marker —
    sonst haette der Sweep Zeilen, die er nur aufgeben kann, und die
    Quittung liesse Nutzlasten stehen, die niemand mehr braucht."""
    mock = _AblegerMock()
    monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)
    token_a, _uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=False
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[pub_b], archiv=True
    )

    assert r.status_code == 200, r.text
    assert len(mock.aufrufe) == 1  # der Ableger entscheidet weiterhin selbst
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, mock.aufrufe[0].id) is None


# ---------------------------------------------------------------------------
# R6 — zwei Bloecke mit gleichem Inhalt, eine Datei
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_zwei_bloecke_mit_gleichem_inhalt_ergeben_eine_ablage(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """R6: der Klient markiert seit der Fixwelle ALLE Empfaenger-Bloecke einer
    Gruppennachricht mit ``archiv`` — sonst haenge die Festigung daran, dass
    ausgerechnet der erste Block Empfaenger findet. Abgelegt werden darf
    trotzdem nur EINE Datei: der Dateiname ist die Nutzlast-ID, zwei Dateien
    liessen sich hinterher durch nichts mehr zusammenfuehren."""
    gerufen: list[list[int]] = []

    async def _nichts_tun(nutzlast_ids, *, ableger):
        gerufen.append(list(nutzlast_ids))

    monkeypatch.setattr(postfach_mod, "festigung_nachlaufen", _nichts_tun)
    token_a, _uid_a, _tb, uid_b, dm_id, pub_b1 = await _aufbau(
        client, session_factory, _auth_signer, friend_pair, mit_ordner=True
    )
    pub_b2 = await _bundel_seeden(session_factory, user_id=uid_b)
    daten = _b64_unpadded(b"olm")

    r = await client.post(
        "/postfach",
        json={
            "channel_id": str(dm_id),
            "device_pubkey": await _sendegeraet(client, token_a),
            "nutzlasten": [
                {"art": 1, "daten": daten, "empfaenger": [pub_b1], "archiv": True},
                {"art": 1, "daten": daten, "empfaenger": [pub_b2], "archiv": True},
            ],
        },
        headers=_auth(token_a),
    )

    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 2
    # Beide Zustellungen entstehen — gefestigt wird nur EIN Umschlag, und
    # genau er traegt den Marker.
    assert len(gerufen[0]) == 1
    async with session_factory() as s:
        marker = (
            await s.execute(
                select(AblageKanalNachtrag).where(
                    AblageKanalNachtrag.channel_id == int(dm_id)
                )
            )
        ).scalars().all()
    assert [m.nutzlast_id for m in marker] == gerufen[0]
