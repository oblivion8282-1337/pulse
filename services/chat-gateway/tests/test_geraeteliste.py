"""Die eigene Geraeteliste und der Widerruf (Spec §3b, Punkt 4).

Jede Pruefung hier ist gegen den Zustand VOR dieser Aenderung rot: bis zum
2026-08-30 gab es weder ``GET /keys/geraete`` (404) noch ``DELETE
/keys/geraete`` (405), und es existierte ueberhaupt kein Weg, ein einzelnes
Geraet auszusperren — die Sperrliste des Zertifikats war mit Migration 0079
gefallen, ihr Ersatz noch nicht gebaut.
"""

from __future__ import annotations

import itertools
import random
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio

pytestmark = pytest.mark.usefixtures("cloud_mode")

_geraete_zaehler = itertools.count()


def _make_device() -> str:
    """Eine frische Geraetekennung — seit Spec §3b eine blosse Zeichenkette
    (mindestens 16 Zeichen, s. ``schemas.GeraeteKennung``)."""
    return f"geraet-{next(_geraete_zaehler):036d}"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """Wie in ``test_schluessel.py``: SQLite ignoriert ``ON DELETE CASCADE``
    ohne dieses PRAGMA je Verbindung."""
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


async def _buendel_seeden(
    session_factory,
    *,
    user_id: int,
    device_pubkey: str,
    dauerhaft: bool = True,
    einmalschluessel: tuple[str, ...] = (),
    zuletzt_benutzt: datetime | None = None,
) -> int:
    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id

    bid = next_id()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=bid,
                user_id=user_id,
                device_pubkey=device_pubkey,
                curve25519="curve-" + device_pubkey,
                rueckfallschluessel="rueckfall-" + device_pubkey,
                dauerhaft=dauerhaft,
                zuletzt_benutzt=zuletzt_benutzt or datetime.now(UTC),
            )
        )
        for schl in einmalschluessel:
            s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel=schl))
        await s.commit()
    return bid


async def _entfernen(client, token: str, device_pubkey: str):
    return await client.delete(
        "/keys/geraete", params={"device_pubkey": device_pubkey}, headers=_auth(token)
    )


# ---------------------------------------------------------------------------
# Gegenprobe 1 — ein entferntes Geraet kommt aus ``claim`` nicht mehr heraus.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_entferntes_geraet_kommt_nicht_mehr_aus_claim(
    client, session_factory, _auth_signer, friend_pair
):
    """DIE Gegenprobe des Vorhabens. Kaeme das Buendel weiter aus ``claim``,
    verschluesselte jeder Absender weiter an ein Geraet, das der Besitzer
    ausdruecklich hinausgeworfen hat — der Widerruf waere eine leere Geste.

    Der erste Abruf ist ausdruecklich mit dabei: er belegt, dass die Zeile
    davor lieferbar WAR, das Ausbleiben danach also am Entfernen liegt und
    nicht daran, dass sie nie gezaehlt haette."""
    sender_token, sender_uid = _register(_auth_signer)
    besitzer_token, besitzer_uid = _register(_auth_signer)
    await friend_pair(sender_uid, besitzer_uid)
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=besitzer_uid, device_pubkey=pubkey)

    r = await client.post(
        "/keys/claim", json={"user_ids": [str(besitzer_uid)]}, headers=_auth(sender_token)
    )
    assert r.status_code == 200, r.text
    assert [b["device_pubkey"] for b in r.json()[str(besitzer_uid)]] == [pubkey]

    r = await _entfernen(client, besitzer_token, pubkey)
    assert r.status_code == 204, r.text

    r = await client.post(
        "/keys/claim", json={"user_ids": [str(besitzer_uid)]}, headers=_auth(sender_token)
    )
    assert r.status_code == 200, r.text
    assert r.json()[str(besitzer_uid)] == []

    # Und die verbrauchsfreie Auskunft sagt dasselbe — sie darf nie mehr
    # zusagen, als der Sendeweg einloest.
    r = await client.get(
        f"/keys/verschluesselbar/{besitzer_uid}", headers=_auth(sender_token)
    )
    assert r.json() == {"verschluesselbar": False}


# ---------------------------------------------------------------------------
# Gegenprobe 2 — ein entferntes Geraet holt keine Zustellung mehr ab.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_entferntes_geraet_holt_keine_zustellung_mehr_ab(
    client, session_factory, access_token
):
    """Das Postfach ist die zweite Haelfte des Widerrufs. Ein entferntes
    Geraet darf offene Umschlaege weder lesen noch wegquittieren — sonst
    koennte ein uebernommenes Geraet dem rechtmaessigen weiterhin die Post
    wegnehmen (``schluessel_nachweis.py::pruefe_geraet``)."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    token, uid = access_token
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=pubkey)

    nutzlast_id = next_id()
    zustellung_id = next_id()
    async with session_factory() as s:
        s.add(
            DmNutzlast(
                id=nutzlast_id,
                channel_id=next_id(),
                absender_device_pubkey="geraet-des-absenders-0000",
                art=0,
                daten="dW1zY2hsYWc",
                groesse=8,
            )
        )
        s.add(
            DmZustellung(
                id=zustellung_id,
                nutzlast_id=nutzlast_id,
                empfaenger_device_pubkey=pubkey,
                empfaenger_user_id=uid,
                verfaellt_am=datetime.now(UTC) + timedelta(days=7),
            )
        )
        await s.commit()

    r = await client.post(
        "/postfach/abholen", json={"device_pubkey": pubkey}, headers=_auth(token)
    )
    assert r.status_code == 200, r.text
    assert [z["id"] for z in r.json()] == [str(zustellung_id)]

    r = await _entfernen(client, token, pubkey)
    assert r.status_code == 204, r.text

    r = await client.post(
        "/postfach/abholen", json={"device_pubkey": pubkey}, headers=_auth(token)
    )
    assert r.status_code == 403, r.text

    # Auch nicht wegquittieren — der Umschlag bleibt fuer die uebrigen
    # Geraete des Kontos liegen, bis die Frist ihn raeumt.
    r = await client.post(
        "/postfach/quittung",
        json={"device_pubkey": pubkey, "zustellung_ids": [str(zustellung_id)]},
        headers=_auth(token),
    )
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# Gegenprobe 3 — ein fremdes Konto kann nichts entfernen, was ihm nicht
# gehoert.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fremdes_konto_kann_kein_fremdes_geraet_entfernen(
    client, session_factory, _auth_signer, friend_pair
):
    """Die Geraetekennung ist im Freundeskreis oeffentlich abholbar (``POST
    /keys/claim``). Genau deshalb muss das Entfernen am Konto haengen und
    nicht an der Kenntnis der Kennung — sonst koennte jeder Kontakt einen
    anderen aus dessen eigenen Gespraechen aussperren."""
    angreifer_token, angreifer_uid = _register(_auth_signer)
    opfer_token, opfer_uid = _register(_auth_signer)
    await friend_pair(angreifer_uid, opfer_uid)
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=opfer_uid, device_pubkey=pubkey)

    # Der Angreifer kennt die Kennung — er hat sie regulaer abgeholt.
    r = await client.post(
        "/keys/claim", json={"user_ids": [str(opfer_uid)]}, headers=_auth(angreifer_token)
    )
    assert [b["device_pubkey"] for b in r.json()[str(opfer_uid)]] == [pubkey]

    r = await _entfernen(client, angreifer_token, pubkey)
    assert r.status_code == 404, r.text

    # Und das Geraet steht unversehrt da: der Besitzer sieht es weiter, und
    # es bleibt Empfaenger.
    r = await client.get("/keys/geraete", headers=_auth(opfer_token))
    assert [g["device_pubkey"] for g in r.json()] == [pubkey]
    r = await client.post(
        "/keys/claim", json={"user_ids": [str(opfer_uid)]}, headers=_auth(angreifer_token)
    )
    assert [b["device_pubkey"] for b in r.json()[str(opfer_uid)]] == [pubkey]


# ---------------------------------------------------------------------------
# Gegenprobe 4 — die Liste zeigt nur die eigenen Geraete.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_liste_zeigt_nur_die_eigenen_geraete(
    client, session_factory, _auth_signer, friend_pair
):
    """Die Liste beantwortet „wer liest bei MIR mit". Fremde Zeilen darin
    waeren nicht bloss unnuetz, sondern Metadaten ueber andere Konten — und
    ein Entfernen-Knopf daneben eine Einladung."""
    ich_token, ich_uid = _register(_auth_signer)
    _, anderer_uid = _register(_auth_signer)
    await friend_pair(ich_uid, anderer_uid)

    meins_alt = _make_device()
    meins_neu = _make_device()
    fremdes = _make_device()
    await _buendel_seeden(
        session_factory,
        user_id=ich_uid,
        device_pubkey=meins_alt,
        zuletzt_benutzt=datetime.now(UTC) - timedelta(days=3),
    )
    await _buendel_seeden(session_factory, user_id=ich_uid, device_pubkey=meins_neu)
    await _buendel_seeden(session_factory, user_id=anderer_uid, device_pubkey=fremdes)

    r = await client.get("/keys/geraete", headers=_auth(ich_token))
    assert r.status_code == 200, r.text
    # Zuletzt benutztes zuerst.
    assert [g["device_pubkey"] for g in r.json()] == [meins_neu, meins_alt]


# ---------------------------------------------------------------------------
# Das Ringsherum
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_entferntes_geraet_steht_nicht_mehr_in_der_liste(
    client, session_factory, access_token
):
    """Die Liste ist eine Bestandsaufnahme, keine Chronik — ein Grabstein
    darin machte die eine Frage, fuer die es sie gibt, schwerer."""
    token, uid = access_token
    bleibt = _make_device()
    geht = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=bleibt)
    bid_geht = await _buendel_seeden(
        session_factory,
        user_id=uid,
        device_pubkey=geht,
        einmalschluessel=("otk-1", "otk-2"),
    )

    r = await _entfernen(client, token, geht)
    assert r.status_code == 204, r.text

    r = await client.get("/keys/geraete", headers=_auth(token))
    assert [g["device_pubkey"] for g in r.json()] == [bleibt]

    # Der Vorrat des entfernten Geraets ist weg — die waechst, die
    # Grabsteinzeile nicht (dieselbe Aufteilung wie beim Verfall).
    from dcc_chat_gateway.models import DeviceOneTimeKey
    from sqlalchemy import func, select

    async with session_factory() as s:
        uebrig = (
            await s.execute(
                select(func.count())
                .select_from(DeviceOneTimeKey)
                .where(DeviceOneTimeKey.bundle_id == bid_geht)
            )
        ).scalar_one()
    assert uebrig == 0


@pytest.mark.asyncio
async def test_geraetestand_meldet_entfernt_als_eigenen_wert(
    client, session_factory, access_token
):
    """Der Klient loescht seinen lokalen Verlauf auf dieses Wort hin. Es
    muss deshalb vom Verfall unterscheidbar sein — nicht fuer die Folge (die
    ist dieselbe), sondern fuer den Hinweis an den Nutzer."""
    token, uid = access_token
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=pubkey)

    r = await client.get(
        "/keys/geraetestand", params={"device_pubkey": pubkey}, headers=_auth(token)
    )
    assert r.json() == {"stand": "gueltig"}

    assert (await _entfernen(client, token, pubkey)).status_code == 204

    r = await client.get(
        "/keys/geraetestand", params={"device_pubkey": pubkey}, headers=_auth(token)
    )
    assert r.json() == {"stand": "entfernt"}


@pytest.mark.asyncio
async def test_veroeffentlichen_hebt_den_ausschluss_nicht_auf(
    client, session_factory, access_token
):
    """Der Grabstein klebt. Ein entferntes Geraet laeuft weiter und
    veroeffentlicht beim naechsten Start sein Buendel — hoebe das den
    Ausschluss auf, waere der Widerruf eine Pause von Minuten."""
    token, uid = access_token
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=pubkey)
    assert (await _entfernen(client, token, pubkey)).status_code == 204

    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-neu", "dauerhaft": True},
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text

    r = await client.get(
        "/keys/geraetestand", params={"device_pubkey": pubkey}, headers=_auth(token)
    )
    assert r.json() == {"stand": "entfernt"}
    r = await client.get("/keys/geraete", headers=_auth(token))
    assert r.json() == []


@pytest.mark.asyncio
async def test_kopplung_holt_ein_entferntes_geraet_zurueck(
    client, session_factory, access_token
):
    """Der einzige Weg zurueck, und derselbe wie beim Verfall: ein
    Kopplungscode, angezeigt auf einem zweiten Geraet desselben Kontos. Ohne
    ihn waere ein versehentlich entferntes Geraet fuer immer tot — seine
    Kennung liegt stabil in seiner IndexedDB."""
    token, uid = access_token
    alt = _make_device()
    neu = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=alt)
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=neu)
    assert (await _entfernen(client, token, neu)).status_code == 204

    # Den Hash bildet der Klient aus dem Code; der Server sieht nur ihn (s.
    # Modulkopf von ``routes/kopplung.py``). Fuer diesen Test genuegt deshalb
    # irgendein fester Wert — geprueft wird, was die Einloesung am Buendel
    # bewirkt, nicht die Code-Rechnung.
    code_hash = "hash-des-kopplungscodes-0001"
    r = await client.post(
        "/kopplung",
        json={"device_pubkey": alt, "code_hash": code_hash},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        "/kopplung/einloesen",
        json={"device_pubkey": neu, "code_hash": code_hash},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text

    r = await client.get(
        "/keys/geraetestand", params={"device_pubkey": neu}, headers=_auth(token)
    )
    assert r.json() == {"stand": "gueltig"}


@pytest.mark.asyncio
async def test_eigenes_geraet_darf_sich_selbst_entfernen(
    client, session_factory, access_token
):
    """Ausdruecklich erlaubt, auch als letztes Geraet des Kontos — sonst
    stuende genau derjenige ohne Handgriff da, fuer den die Funktion gebaut
    ist (der Besitzer eines verlorenen Telefons, das die einzige Zeile ist).
    Ein Verbot waere ohnehin nicht durchsetzbar: der Server weiss nicht, wer
    ruft, sondern nur, welches Konto."""
    token, uid = access_token
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=pubkey)

    assert (await _entfernen(client, token, pubkey)).status_code == 204
    r = await client.get("/keys/geraete", headers=_auth(token))
    assert r.json() == []


@pytest.mark.asyncio
async def test_zweimal_entfernen_ist_kein_fehler(client, session_factory, access_token):
    """Die Zeile ist danach in genau dem Zustand, den der Aufrufer wollte —
    ein 404 beim zweiten Klick waere eine Fehlermeldung fuer einen Erfolg.
    Ein wirklich unbekanntes Geraet bekommt dagegen 404."""
    token, uid = access_token
    pubkey = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=pubkey)

    assert (await _entfernen(client, token, pubkey)).status_code == 204
    assert (await _entfernen(client, token, pubkey)).status_code == 204
    assert (await _entfernen(client, token, _make_device())).status_code == 404


@pytest.mark.asyncio
async def test_liste_meldet_verfall_ohne_ihn_zu_verschweigen(
    client, session_factory, access_token
):
    """Verfallene Geraete bleiben in der Liste, mit Marke: sie kommen ueber
    eine neue Kopplung zurueck, ohne dass eine neue Zeile entstuende, und
    gehoeren deshalb noch zum Bestand. Die Marke rechnet der Server aus
    derselben SQL-Regel wie ``geraetestand`` — der Klient soll die
    Verfallsrechnung nicht nachbauen."""
    token, uid = access_token
    frisch = _make_device()
    alt = _make_device()
    await _buendel_seeden(session_factory, user_id=uid, device_pubkey=frisch)
    await _buendel_seeden(
        session_factory,
        user_id=uid,
        device_pubkey=alt,
        dauerhaft=False,
        zuletzt_benutzt=datetime.now(UTC) - timedelta(days=40),
    )

    r = await client.get("/keys/geraete", headers=_auth(token))
    zeilen = {g["device_pubkey"]: g for g in r.json()}
    assert zeilen[frisch]["verfallen"] is False
    assert zeilen[alt]["verfallen"] is True


@pytest.mark.asyncio
async def test_zu_kurze_kennung_wird_abgewiesen(client, access_token):
    """Die Laengengrenzen aus ``schemas.GeraeteKennung`` gelten auch fuer den
    Abfrage-Parameter — sie sind der Riegel dagegen, dass Unsinn ueberhaupt
    in eine Abfrage geraet. Ein 404 statt 422 waere hier kein Beinbruch, aber
    der Test haelt fest, dass die Grenze nicht stillschweigend verlorenging,
    als der Parameter von ``Query(...)`` auf ``Annotated`` umgestellt wurde."""
    token, _ = access_token
    r = await client.delete(
        "/keys/geraete", params={"device_pubkey": "kurz"}, headers=_auth(token)
    )
    assert r.status_code == 422, r.text
