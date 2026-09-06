"""Geraete-Kopplung und Verlaufsumzug (Etappe F).

Die drei verbindlichen Gegenproben des Auftrags stehen hier namentlich:

* ``test_code_laesst_sich_nicht_zweimal_einloesen``
* ``test_abgelaufener_code_wird_abgewiesen``
* ``test_abgebrochener_umzug_setzt_fort``

Geraete-Helfer wie in ``test_postfach.py``: eine blosse Kennung, die vor dem
Gebrauch veroeffentlicht sein muss (Spec §3b) — kein Patchen von
``pruefe_geraet``, sonst prueft der Test die eigene Attrappe statt der
Rechte.

**Die eine Ausnahme steht in ``_einloesen``**: ``POST /kopplung/einloesen``
laesst ein noch unbekanntes Geraet zu, weil der Klient in genau dieser
Reihenfolge arbeitet — erst einloesen, dann veroeffentlichen
(``web/src/lib/kopplung/empfangen.ts``). Der Helfer bildet das nach.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import itertools
import random
from datetime import UTC, datetime, timedelta

import pytest

pytestmark = pytest.mark.usefixtures("cloud_mode")

_geraete_zaehler = itertools.count()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64_unpadded(data: bytes) -> str:
    """Wie der Klient kodiert — OHNE Fuellzeichen (s. ``test_postfach.py``)."""
    return base64.b64encode(data).rstrip(b"=").decode()


def _make_device() -> str:
    """Eine frische Geraetekennung — seit Spec §3b eine blosse Zeichenkette."""
    return f"geraet-{next(_geraete_zaehler):036d}"


def _code_hash(code: str) -> str:
    """Wie der Klient rechnet (``web/src/lib/kopplung/codeHash.ts``)."""
    return _b64url(hashlib.sha256(b"pulse-kopplung-v1\x00" + code.encode()).digest())


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class Geraet:
    """Ein Testgeraet — seit Spec §3b nichts weiter als eine Kennung.

    Zu einem Geraet DIESES Kontos wird sie erst durch ``veroeffentlichen``;
    ohne das weist ``pruefe_geraet`` jede Route mit scharfer Bedingung ab
    (alle ausser ``/kopplung/einloesen``)."""

    def __init__(self, uid: int):
        self.uid = uid
        self.pubkey = _make_device()

    def rumpf(self, **felder) -> dict:
        return {"device_pubkey": self.pubkey, **felder}

    async def veroeffentlichen(self, client, token: str) -> None:
        r = await client.put(
            "/keys/bundle",
            json={"device_pubkey": self.pubkey, "curve25519": "curve-" + self.pubkey},
            headers=_auth(token),
        )
        assert r.status_code == 204, r.text


async def _anlegen(client, geraet: Geraet, token: str, code: str):
    # Das anlegende Geraet ist per Definition eingerichtet — es hat also
    # veroeffentlicht, bevor es einen Code zeigt.
    await geraet.veroeffentlichen(client, token)
    ch = _code_hash(code)
    return await client.post(
        "/kopplung", json=geraet.rumpf(code_hash=ch), headers=_auth(token)
    )


async def _einloesen(client, geraet: Geraet, token: str, code: str):
    ch = _code_hash(code)
    r = await client.post(
        "/kopplung/einloesen",
        json=geraet.rumpf(code_hash=ch),
        headers=_auth(token),
    )
    if r.status_code == 200:
        # Genau die Reihenfolge des Klienten: erst einloesen, dann
        # veroeffentlichen (s. Modul-Docstring). Ohne diesen zweiten Schritt
        # scheiterte jede spaetere Route dieses Geraets an ``pruefe_geraet``.
        await geraet.veroeffentlichen(client, token)
    return r


async def _stand(client, geraet: Geraet, token: str, kid: str):
    return await client.post(
        "/kopplung/stand",
        json=geraet.rumpf(kopplung_id=str(kid)),
        headers=_auth(token),
    )


def _kennung_fuer(daten: str) -> str:
    """Test-Attrappe der Inhalts-Kennung — der Server prueft ihren Inhalt
    nicht (er kann es nicht, s. Modulkopf ``routes/kopplung.py``), nur ihre
    Laenge. Deterministisch aus ``daten`` abgeleitet, damit
    ``test_wiederholtes_stueck...`` weiterhin zwei VERSCHIEDENE Kennungen
    fuer zwei verschiedene Uploads derselben Position bekommt."""
    return _b64url(hashlib.sha256(b"test-kennung\x00" + daten.encode()).digest())


async def _stueck(
    client, geraet: Geraet, token: str, kid: str, folge: int, daten: str,
    kennung: str | None = None,
):
    k = kennung if kennung is not None else _kennung_fuer(daten)
    return await client.post(
        "/kopplung/stueck",
        json=geraet.rumpf(
            kopplung_id=str(kid), folge=folge, daten=daten, kennung=k,
        ),
        headers=_auth(token),
    )


async def _stueck_holen(client, geraet: Geraet, token: str, kid: str, folge: int):
    return await client.post(
        "/kopplung/stueck/holen",
        json=geraet.rumpf(kopplung_id=str(kid), folge=folge),
        headers=_auth(token),
    )


async def _fertig(client, geraet: Geraet, token: str, kid: str, gesamt: int):
    return await client.post(
        "/kopplung/fertig",
        json=geraet.rumpf(kopplung_id=str(kid), gesamt_stuecke=gesamt),
        headers=_auth(token),
    )


async def _abschliessen(client, geraet: Geraet, token: str, kid: str):
    return await client.post(
        "/kopplung/abschliessen",
        json=geraet.rumpf(kopplung_id=str(kid)),
        headers=_auth(token),
    )


async def _gekoppelt(client, _auth_signer) -> tuple[str, int, Geraet, Geraet, str]:
    """Konto mit zwei Geraeten und einer eingeloesten Kopplung."""
    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    neu = Geraet(uid)
    r = await _anlegen(client, alt, token, "ABCDE-FGHJK-MNPQR-STVWX")
    assert r.status_code == 200, r.text
    kid = r.json()["id"]
    r = await _einloesen(client, neu, token, "ABCDE-FGHJK-MNPQR-STVWX")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == kid
    return token, uid, alt, neu, kid


# ---------------------------------------------------------------------------
# Kopplung
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kopplung_anlegen_und_einloesen(client, _auth_signer):
    token, _uid, alt, neu, kid = await _gekoppelt(client, _auth_signer)
    r = await _stand(client, alt, token, kid)
    assert r.status_code == 200, r.text
    assert r.json()["eingeloest"] is True
    assert r.json()["neu_device_pubkey"] == neu.pubkey


@pytest.mark.asyncio
async def test_code_laesst_sich_nicht_zweimal_einloesen(client, _auth_signer):
    """Gegenprobe 1 des Auftrags. Ohne den ``eingeloest_am IS NULL``-Guard im
    UPDATE bekaeme das dritte Geraet ebenfalls 200 und duerfte danach die
    Stuecke abholen — ein Kopplungscode waere ein Mehrfachschluessel."""
    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    neu = Geraet(uid)
    dritt = Geraet(uid)
    code = "11111-22222-33333-44444"

    assert (await _anlegen(client, alt, token, code)).status_code == 200
    assert (await _einloesen(client, neu, token, code)).status_code == 200

    r = await _einloesen(client, dritt, token, code)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "kopplung_schon_eingeloest"


@pytest.mark.asyncio
async def test_abgelaufener_code_wird_abgewiesen(
    client, app, session_factory, _auth_signer, monkeypatch
):
    """Gegenprobe 2 des Auftrags. Ohne die Frist-Bedingung im UPDATE waere ein
    einmal gezeigter Code unbegrenzt gueltig — ein Generalschluessel zum
    Konto (s. Modulkopf ``routes/kopplung.py``)."""
    from dcc_chat_gateway import config as chat_config

    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    neu = Geraet(uid)
    code = "AAAAA-BBBBB-CCCCC-DDDDD"

    settings = chat_config.get_settings()
    monkeypatch.setattr(settings, "kopplung_code_gueltig_minuten", 0)
    r = await _anlegen(client, alt, token, code)
    assert r.status_code == 200, r.text

    # Der Code lief in derselben Sekunde ab; um nicht auf die Uhr zu warten,
    # wird die Zeile zusaetzlich in die Vergangenheit gesetzt.
    from dcc_chat_gateway.models import Kopplung
    from sqlalchemy import update as sa_update

    async with session_factory() as s:
        await s.execute(
            sa_update(Kopplung)
            .where(Kopplung.id == int(r.json()["id"]))
            .values(verfaellt_am=datetime.now(UTC) - timedelta(minutes=1))
        )
        await s.commit()

    r2 = await _einloesen(client, neu, token, code)
    assert r2.status_code == 410, r2.text
    assert r2.json()["detail"] == "kopplung_abgelaufen"


@pytest.mark.asyncio
async def test_selbes_geraet_kann_sich_nicht_koppeln(client, app, _auth_signer):
    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    code = "ZZZZZ-YYYYY-XXXXX-WWWWW"
    assert (await _anlegen(client, alt, token, code)).status_code == 200
    r = await _einloesen(client, alt, token, code)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "kopplung_selbes_geraet"


@pytest.mark.asyncio
async def test_fremdes_konto_sieht_den_code_nicht(client, app, _auth_signer):
    """Ein Code eines anderen Kontos ist ununterscheidbar von einem erfundenen
    — sonst waere die Fehlermeldung ein Orakel."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    code = "QQQQQ-QQQQQ-QQQQQ-QQQQQ"
    assert (await _anlegen(client, Geraet(uid_a), token_a, code)).status_code == 200

    r = await _einloesen(client, Geraet(uid_b), token_b, code)
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "kopplung_unbekannt"


@pytest.mark.asyncio
async def test_zu_viele_offene_kopplungen(client, app, _auth_signer, monkeypatch):
    from dcc_chat_gateway import config as chat_config

    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    monkeypatch.setattr(chat_config.get_settings(), "kopplung_max_offen_je_konto", 1)

    assert (await _anlegen(client, alt, token, "AAAAA")).status_code == 200
    r = await _anlegen(client, alt, token, "BBBBB")
    assert r.status_code == 429, r.text


@pytest.mark.asyncio
async def test_offene_kopplungen_haelt_die_grenze_auch_im_wettlauf(
    client, app, _auth_signer, monkeypatch
):
    """Gegenprobe Befund 5 (Bughunt): Zaehlen (``SELECT count``) und Schreiben
    (``INSERT``) lagen als zwei getrennte Anfragen hintereinander — dazwischen
    ein Await-Punkt, an dem eine zweite, fast gleichzeitige Anlage denselben
    (noch ungezaehlten) Stand sah und ebenfalls durchkam. Nachgestellt an der
    Randlage, an der es zaehlt: zwei offene Kopplungen bei Grenze drei, dann
    zwei fast gleichzeitige dritte Anlagen. Ohne die feste Anweisung landen
    beide bei 200 (vier offene Kopplungen statt maximal drei); mit ihr genau
    eine bei 200, die andere bei 429."""
    from dcc_chat_gateway import config as chat_config

    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    monkeypatch.setattr(chat_config.get_settings(), "kopplung_max_offen_je_konto", 3)

    assert (await _anlegen(client, alt, token, "AAAAA")).status_code == 200
    assert (await _anlegen(client, alt, token, "BBBBB")).status_code == 200

    ergebnisse = await asyncio.gather(
        _anlegen(client, alt, token, "CCCCC"),
        _anlegen(client, alt, token, "DDDDD"),
    )
    stati = sorted(r.status_code for r in ergebnisse)
    assert stati == [200, 429], [r.text for r in ergebnisse]


# ---------------------------------------------------------------------------
# Umzug
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stueck_schieben_und_holen(client, app, _auth_signer):
    token, _uid, alt, neu, kid = await _gekoppelt(client, _auth_signer)
    daten = _b64_unpadded(b"verschluesseltes-stueck-0")

    assert (await _stueck(client, alt, token, kid, 0, daten)).status_code == 204
    assert (await _fertig(client, alt, token, kid, 1)).status_code == 204

    r = await _stueck_holen(client, neu, token, kid, 0)
    assert r.status_code == 200, r.text
    assert r.json()["daten"] == daten

    r = await _stand(client, neu, token, kid)
    assert r.json()["gesamt_stuecke"] == 1
    assert r.json()["vorhandene_stuecke"] == [0]


@pytest.mark.asyncio
async def test_abgebrochener_umzug_setzt_fort(client, app, _auth_signer):
    """Gegenprobe 3 des Auftrags.

    Nachgestellt wird ein Abriss nach dem dritten von fuenf Stuecken. Der
    Sender fragt danach den Stand ab und schiebt GENAU die fehlenden — ohne
    ``vorhandene_stuecke`` in der Stand-Antwort haette er keine Grundlage
    dafuer und muesste bei 0 beginnen.
    """
    token, _uid, alt, neu, kid = await _gekoppelt(client, _auth_signer)
    stuecke = [_b64_unpadded(f"stueck-{i}".encode()) for i in range(5)]

    for folge in range(3):
        assert (
            await _stueck(client, alt, token, kid, folge, stuecke[folge])
        ).status_code == 204

    stand = (await _stand(client, alt, token, kid)).json()
    assert stand["vorhandene_stuecke"] == [0, 1, 2]

    fehlend = [i for i in range(5) if i not in stand["vorhandene_stuecke"]]
    assert fehlend == [3, 4]
    for folge in fehlend:
        assert (
            await _stueck(client, alt, token, kid, folge, stuecke[folge])
        ).status_code == 204
    assert (await _fertig(client, alt, token, kid, 5)).status_code == 204

    geholt = []
    for folge in range(5):
        r = await _stueck_holen(client, neu, token, kid, folge)
        assert r.status_code == 200, r.text
        geholt.append(r.json()["daten"])
    assert geholt == stuecke


@pytest.mark.asyncio
async def test_wiederholtes_stueck_ersetzt_statt_zu_verdoppeln(client, app, _auth_signer):
    """Der Sender darf blind wiederholen — auch eine Position, die doch schon
    liegt (die Antwort auf den ersten Versuch ging verloren). Die
    Inhalts-Kennung wird dabei MIT ersetzt, nicht bloss die Nutzlast — sonst
    zeigte ``stand`` nach dem Ersetzen weiter auf die Kennung des ersten
    Versuchs, und ein Sender, der spaeter genau diesen Inhalt wieder
    berechnet, haette keine Chance, ihn wiederzuerkennen (Bughunt
    2026-08-29, Befund 1)."""
    token, _uid, alt, neu, kid = await _gekoppelt(client, _auth_signer)
    erst = _b64_unpadded(b"erster-versuch")
    zweit = _b64_unpadded(b"zweiter-versuch")

    assert (await _stueck(client, alt, token, kid, 7, erst)).status_code == 204
    stand_1 = (await _stand(client, alt, token, kid)).json()
    kennung_erst = stand_1["vorhandene_kennungen"]["7"]

    assert (await _stueck(client, alt, token, kid, 7, zweit)).status_code == 204
    stand_2 = (await _stand(client, alt, token, kid)).json()
    assert stand_2["vorhandene_stuecke"] == [7]
    assert stand_2["vorhandene_kennungen"]["7"] != kennung_erst

    r = await _stueck_holen(client, neu, token, kid, 7)
    assert r.json()["daten"] == zweit


@pytest.mark.asyncio
async def test_stand_liefert_inhalts_kennungen(client, app, _auth_signer):
    """Gegenprobe zu Befund 1 des Bughunts: ``vorhandene_kennungen`` traegt
    genau die Kennungen, die beim Hochladen mitgeschickt wurden — nur darauf
    kann der Sender einen inhaltlichen Abgleich beim Fortsetzen stuetzen
    (``web/src/lib/kopplung/senden.ts``). Eine Position ohne Upload taucht in
    der Abbildung nicht auf."""
    token, _uid, alt, _neu, kid = await _gekoppelt(client, _auth_signer)
    daten_0 = _b64_unpadded(b"stueck-0")
    kennung_0 = _kennung_fuer(daten_0)
    assert (await _stueck(client, alt, token, kid, 0, daten_0, kennung_0)).status_code == 204

    stand = (await _stand(client, alt, token, kid)).json()
    assert stand["vorhandene_kennungen"] == {"0": kennung_0}


@pytest.mark.asyncio
async def test_drittes_geraet_darf_nicht_holen(client, app, _auth_signer):
    """Die Rollenpruefung (``kopplung_zugriff.py``) ist der Punkt, den man
    beim Nachbauen vergisst: ohne sie duerfte JEDES Geraet des Kontos die
    Stuecke abholen."""
    token, uid, alt, _neu, kid = await _gekoppelt(client, _auth_signer)
    # Ein DRITTES eingerichtetes Geraet desselben Kontos: es besteht
    # ``pruefe_geraet`` (deshalb veroeffentlicht es), scheitert aber an der
    # Rollenpruefung — genau die Trennung, die dieser Test sichert.
    dritt = Geraet(uid)
    await dritt.veroeffentlichen(client, token)
    daten = _b64_unpadded(b"geheim")
    assert (await _stueck(client, alt, token, kid, 0, daten)).status_code == 204

    r = await _stueck_holen(client, dritt, token, kid, 0)
    assert r.status_code == 404, r.text
    r = await _stueck(client, dritt, token, kid, 1, daten)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_neues_geraet_darf_nicht_schieben(client, app, _auth_signer):
    """Auch die Gegenrichtung ist gesperrt: ``neu`` holt, schiebt aber nicht."""
    token, _uid, _alt, neu, kid = await _gekoppelt(client, _auth_signer)
    r = await _stueck(client, neu, token, kid, 0, _b64_unpadded(b"x"))
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_drittes_geraet_kommt_an_keine_route(client, app, _auth_signer):
    """Gegenprobe zum Auftrag (§3b): ein DRITTES eingerichtetes Geraet
    DESSELBEN Kontos — weder ``alt`` noch ``neu`` dieser Kopplung — kommt an
    keine der sieben Routen. ``test_drittes_geraet_darf_nicht_holen`` deckt
    bereits ``stueck``/``stueck/holen``; hier die restlichen vier."""
    token, uid, alt, _neu, kid = await _gekoppelt(client, _auth_signer)
    dritt = Geraet(uid)
    await dritt.veroeffentlichen(client, token)

    # ``stand`` laesst nur ``alt``/``neu`` durch (``_als_alt_oder_neu``).
    r = await _stand(client, dritt, token, kid)
    assert r.status_code == 404, r.text

    # ``fertig`` verlangt die Rolle ``alt`` ueber ``kopplung_laden``.
    r = await _fertig(client, dritt, token, kid, 1)
    assert r.status_code == 404, r.text

    # ``anlegen`` mit dem Code eines fremden Geraets steht dem Dritten offen
    # (jedes eingerichtete Geraet darf EIGENE Kopplungen anlegen) — das ist
    # kein Zugriff auf DIESE Kopplung und deshalb kein Gegenbeweis hier.

    # ``abschliessen`` prueft die Rolle direkt in der WHERE-Klausel (keine
    # Ausnahme fuer verfallene Zeilen wie bei den anderen Routen). Ein
    # Aufruf mit dem dritten Geraet trifft keine Zeile — er meldet trotzdem
    # 204 (dieselbe Antwort wie ein wiederholtes Abschliessen, s. Docstring
    # der Route), OHNE die Kopplung tatsaechlich zu loeschen. Das zeigt sich
    # daran, dass ``alt`` danach immer noch Stuecke schieben kann.
    r = await _abschliessen(client, dritt, token, kid)
    assert r.status_code == 204, r.text
    r = await _stueck(client, alt, token, kid, 0, _b64_unpadded(b"noch-da"))
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_fremdes_konto_kann_stuecke_nicht_holen(client, app, _auth_signer):
    """Gegenprobe zum Auftrag (§3b): ein fremdes Konto kommt an eine laufende
    Kopplung nicht heran — ``test_fremdes_konto_sieht_den_code_nicht`` deckt
    das Einloesen, hier das Abholen der Stuecke und den Stand. Beide Routen
    filtern in ``kopplung_laden``/``_als_alt_oder_neu`` auf ``user_id``, ein
    fremdes Konto trifft also nie eine Zeile — unabhaengig davon, ob es die
    ``kopplung_id`` erraet."""
    token_a, uid_a, alt, _neu, kid = await _gekoppelt(client, _auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    fremd = Geraet(uid_b)
    await fremd.veroeffentlichen(client, token_b)

    assert (
        await _stueck(client, alt, token_a, kid, 0, _b64_unpadded(b"geheim"))
    ).status_code == 204

    r = await _stueck_holen(client, fremd, token_b, kid, 0)
    assert r.status_code == 404, r.text
    r = await _stand(client, fremd, token_b, kid)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_stueck_zu_gross(client, app, _auth_signer, monkeypatch):
    from dcc_chat_gateway import config as chat_config

    token, _uid, alt, _neu, kid = await _gekoppelt(client, _auth_signer)
    monkeypatch.setattr(chat_config.get_settings(), "umzug_max_stueck_bytes", 8)
    r = await _stueck(client, alt, token, kid, 0, _b64_unpadded(b"x" * 64))
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "stueck_zu_gross"


@pytest.mark.asyncio
async def test_abschliessen_raeumt_stuecke_weg(client, app, session_factory, _auth_signer):
    from dcc_chat_gateway.models import Kopplung, UmzugStueck
    from sqlalchemy import func, select

    token, _uid, alt, neu, kid = await _gekoppelt(client, _auth_signer)
    assert (
        await _stueck(client, alt, token, kid, 0, _b64_unpadded(b"a"))
    ).status_code == 204

    assert (await _abschliessen(client, neu, token, kid)).status_code == 204

    async with session_factory() as s:
        assert (
            await s.execute(
                select(func.count()).select_from(Kopplung).where(Kopplung.id == int(kid))
            )
        ).scalar_one() == 0
        assert (
            await s.execute(
                select(func.count())
                .select_from(UmzugStueck)
                .where(UmzugStueck.kopplung_id == int(kid))
            )
        ).scalar_one() == 0

    # Wiederholtes Abschliessen kostet nichts — s. Docstring der Route.
    assert (await _abschliessen(client, neu, token, kid)).status_code == 204


@pytest.mark.asyncio
async def test_verfallslauf_raeumt_kopplung_und_stuecke(
    client, app, session_factory, _auth_signer
):
    from dcc_chat_gateway.kopplung_pflege import sweep_verfallene_kopplungen
    from dcc_chat_gateway.models import Kopplung, UmzugStueck
    from sqlalchemy import func, select
    from sqlalchemy import update as sa_update

    token, _uid, alt, _neu, kid = await _gekoppelt(client, _auth_signer)
    assert (
        await _stueck(client, alt, token, kid, 0, _b64_unpadded(b"a"))
    ).status_code == 204

    async with session_factory() as s:
        await s.execute(
            sa_update(Kopplung)
            .where(Kopplung.id == int(kid))
            .values(verfaellt_am=datetime.now(UTC) - timedelta(hours=1))
        )
        await s.commit()

    async with session_factory() as s:
        assert await sweep_verfallene_kopplungen(s) == 1

    async with session_factory() as s:
        # CASCADE: das Stueck faellt mit der Kopplung, nicht in einem
        # zweiten Lauf (s. ``kopplung_pflege.py``).
        assert (
            await s.execute(
                select(func.count())
                .select_from(UmzugStueck)
                .where(UmzugStueck.kopplung_id == int(kid))
            )
        ).scalar_one() == 0


@pytest.mark.asyncio
async def test_kopplung_hebt_einen_verfall_auf(client, app, session_factory, _auth_signer):
    """Der Weg zurueck (Spec §3a): der Grabstein eines verfallenen Browsers
    klebt — nur eine NEUE Kopplung loest ihn.

    Ohne diese Aufhebung waere ein einmal abgelaufener Browser dauerhaft
    unbrauchbar: er duerfte sich neu koppeln, bliebe aber fuer ``claim``
    unsichtbar und wuerde bei jedem Start erneut seinen (dann leeren) Verlauf
    loeschen."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import select

    token, uid = await _register(_auth_signer)
    alt = Geraet(uid)
    neu = Geraet(uid)

    # Der Browser hat frueher schon einmal veroeffentlicht und ist verfallen.
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=next_id(),
                user_id=uid,
                device_pubkey=neu.pubkey,
                curve25519="curve-alt",
                dauerhaft=False,
                zuletzt_benutzt=datetime.now(UTC) - timedelta(days=20),
                verfallen_am=datetime.now(UTC) - timedelta(days=5),
            )
        )
        await s.commit()

    code = "55555-66666-77777-88888"
    assert (await _anlegen(client, alt, token, code)).status_code == 200
    assert (await _einloesen(client, neu, token, code)).status_code == 200

    async with session_factory() as s:
        zeile = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == neu.pubkey)
            )
        ).scalar_one()
    assert zeile.verfallen_am is None
    assert zeile.gekoppelt_am is not None
