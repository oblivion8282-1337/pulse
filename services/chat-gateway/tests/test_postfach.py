"""Das Postfach: Nutzlast und Zustellung getrennt."""

from __future__ import annotations

import base64
import itertools
import json
import random

import pytest
import pytest_asyncio
from dcc_chat_gateway.pubsub_channels import CHANNEL_KEY, USER_EVENTS_CHANNEL

pytestmark = pytest.mark.usefixtures("cloud_mode")

# ---------------------------------------------------------------------------
# Geraete-Helfer. Seit dem Wegfall der Zertifikate (Spec §3b) ist eine
# Geraetekennung eine blosse Zeichenkette; geprueft wird nur noch, dass sie zu
# einem Geraet DES ANGEMELDETEN KONTOS gehoert (``schluessel_nachweis.py``).
# Ein Sendegeraet muss deshalb erst veroeffentlichen — genau wie der echte
# Klient, der das beim Start tut (``krypto/veroeffentlichen.ts``).
# ---------------------------------------------------------------------------

_geraete_zaehler = itertools.count()


def _make_device() -> str:
    """Eine frische, eindeutige Geraetekennung (mindestens 16 Zeichen, s.
    ``schemas.GeraeteKennung``)."""
    return f"geraet-{next(_geraete_zaehler):036d}"


def _b64_unpadded(data: bytes) -> str:
    """Wie der Krypto-Kern kodiert (vodozemacs ``STANDARD_NO_PAD``, s.
    Modul-Docstring von ``krypto/pulse-krypto``) — OHNE Fuellzeichen.

    Bughunt 2026-08-28, FIX 2: alle bisherigen ``daten``-Werte dieser Datei
    kamen aus Pythons EIGENEM, gepolstertem ``base64.b64encode`` — und trafen
    dabei zufaellig immer eine Byte-Laenge, die durch drei teilbar ist (bei
    ``b"olm-umschlag"`` und der 36 Byte langen Grossnutzlast), also nie einen
    Fall, in dem Padding ueberhaupt fehlt. Ein Test, der seine Eingabe selbst
    (falsch) erzeugt, prueft nur die eigene Kodierung, nie die der
    Gegenseite — genau diese Kodierung erzeugt jetzt EHRLICH unpolsterte
    Nutzlasten, wie sie der Klient wirklich schickt."""
    return base64.b64encode(data).rstrip(b"=").decode()


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _dm_erstellen(client, token_a: str, uid_b: int) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _bundel_seeden(session_factory, *, user_id: int, device_pubkey: str) -> None:
    """Legt ein Empfaenger-Buendel direkt in die DB — Task 2 prueft das
    EINLIEFERN, nicht das Veroeffentlichen (Task 2 der Etappe B)."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=next_id(), user_id=user_id, device_pubkey=device_pubkey,
                curve25519="curve-" + device_pubkey,
            )
        )
        await s.commit()


async def _sendegeraet(client, token: str) -> str:
    """Veroeffentlicht ein frisches Geraet fuer dieses Konto und gibt seine
    Kennung zurueck.

    **Seit Spec §3b Pflicht vor jedem Einliefern:** ein frei erfundener
    ``device_pubkey`` ergibt 403, weil ``pruefe_geraet`` ihn im Verzeichnis
    dieses Kontos nicht findet. Der echte Klient geht denselben Weg — er
    veroeffentlicht beim Start, lange bevor er sendet
    (``krypto/veroeffentlichen.ts``)."""
    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-" + pubkey},
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text
    return pubkey


async def _einliefern(client, *, token: str, channel_id: str, nutzlasten: list[dict]):
    """Veroeffentlicht ein frisches Sendegeraet und liefert damit ein."""
    return await _einliefern_mit_geraet(
        client, token=token, channel_id=channel_id, nutzlasten=nutzlasten,
        pubkey=await _sendegeraet(client, token),
    )


async def _einliefern_mit_geraet(
    client, *, token: str, channel_id: str, nutzlasten: list[dict], pubkey: str,
):
    """Wie ``_einliefern``, aber mit einem VORGEGEBENEN Sendegeraet statt
    einem frisch veroeffentlichten je Aufruf — noetig, um mehrere
    Einlieferungen DESSELBEN Absendegeraets nachzustellen."""
    return await client.post(
        "/postfach",
        json={
            "channel_id": str(channel_id), "device_pubkey": pubkey,
            "nutzlasten": nutzlasten,
        },
        headers=_auth(token),
    )


async def _abholen(client, *, token: str, pubkey: str):
    """Holt fuer GENAU dieses Empfaengergeraet ab."""
    return await client.post(
        "/postfach/abholen", json={"device_pubkey": pubkey}, headers=_auth(token)
    )


async def _quittieren(client, *, token: str, pubkey: str, zustellung_ids: list[str]):
    return await client.post(
        "/postfach/quittung",
        json={
            "device_pubkey": pubkey,
            "zustellung_ids": [str(i) for i in zustellung_ids],
        },
        headers=_auth(token),
    )


async def _bundel_seeden_geraet(session_factory, *, user_id: int) -> str:
    """Wie ``_bundel_seeden``, aber mit einer frisch erzeugten Kennung, die
    der Aufrufer zurueckbekommt — fuer Tests, die spaeter als dieses Geraet
    abholen oder quittieren."""
    pubkey = _make_device()
    await _bundel_seeden(session_factory, user_id=user_id, device_pubkey=pubkey)
    return pubkey


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung — derselbe Weg wie in ``test_schluessel.py``. Die
    Test-Engine nutzt ``StaticPool`` (eine geteilte In-Memory-Verbindung),
    deshalb genuegt ein einmaliges PRAGMA auf dieser einen Verbindung.
    """
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_eine_nutzlast_traegt_mehrere_zustellungen(session_factory):
    """Der Gruppenfall. Megolm verschluesselt EINMAL fuer alle — ohne diese
    Trennung muesste derselbe Umschlag je Geraet kopiert werden, und bei
    zwanzig Mitgliedern mit je zwei Geraeten waeren das vierzig Kopien
    derselben Bytes.
    """
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import select

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="umschlag", groesse=8,
        ))
        for pubkey in ("G1", "G2", "G3"):
            s.add(DmZustellung(
                id=next_id(), nutzlast_id=nid,
                empfaenger_device_pubkey=pubkey, empfaenger_user_id=2,
            ))
        await s.commit()

    async with session_factory() as s:
        zustellungen = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert len(zustellungen) == 3


@pytest.mark.asyncio
async def test_zustellungen_verschwinden_mit_ihrer_nutzlast(session_factory):
    """Eine Zustellung ohne Nutzlast ist ein Zeiger ins Leere."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import delete, select

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid,
            empfaenger_device_pubkey="G1", empfaenger_user_id=2,
        ))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DmNutzlast).where(DmNutzlast.id == nid))
        await s.commit()

    async with session_factory() as s:
        rest = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert rest == []


# ---------------------------------------------------------------------------
# Task 2 — Einliefern
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_einliefern_legt_je_empfaenger_eine_zustellung_an(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Eine Nutzlast, drei Empfaengergeraete -> drei Zustellungen."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    for i in range(3):
        await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=f"empf-{i}")

    # UNPOLSTERTE Kodierung + eine Byte-Laenge, die NICHT durch drei teilbar
    # ist (13 Bytes) — der einzige Fall, in dem der Nachweis eines fehlenden
    # ``+= "=="`` in ``_envelope_groesse`` ueberhaupt greifen kann (FIX 2).
    daten = _b64_unpadded(b"olm-umschlag1")
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{
            "art": 1, "daten": daten,
            "empfaenger": ["empf-0", "empf-1", "empf-2"],
        }],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 3
    assert body["uebersprungene_empfaenger"] == []
    assert body["verworfene_nutzlasten"] == 0

    async with session_factory() as s:
        nutzlasten = (await s.execute(select(DmNutzlast))).scalars().all()
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(nutzlasten) == 1
        # Die unpolsterte Eingabe muss trotzdem auf die ECHTE Byte-Laenge
        # decodieren — nur so entlarvt dieser Test einen fehlenden
        # Polsterungs-Nachtrag in ``_envelope_groesse`` (FIX 2).
        assert nutzlasten[0].groesse == len(b"olm-umschlag1")
        assert len(zustellungen) == 3
        assert {z.empfaenger_device_pubkey for z in zustellungen} == {
            "empf-0", "empf-1", "empf-2",
        }


@pytest.mark.asyncio
async def test_fremder_kanal_wird_abgewiesen(client, app, _auth_signer):
    """Wer im Kanal nichts zu suchen hat, liefert auch nichts ein.
    Dieselbe Regel wie beim Klartext-Senden — NICHT eine neue erfinden."""
    token_a, uid_a = await _register(_auth_signer)
    fremder_kanal = "999999999999999999"

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=fremder_kanal,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["irgendein-geraet"]}],
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_zu_grosser_umschlag_wird_abgewiesen(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings,
    monkeypatch,
):
    """Ohne Obergrenze ist das Postfach ein kostenloser Dateispeicher, und
    zwar einer, dessen Inhalt niemand pruefen kann."""
    # ``monkeypatch`` statt Direktzuweisung: die Einstellung ist ein
    # Modul-Singleton (``_TEST_SETTINGS``) und wuerde sonst in die naechsten
    # Tests dieser Datei durchsickern.
    monkeypatch.setattr(_isolate_chat_settings, "postfach_max_umschlag_bytes", 4)

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-gross")

    # Unpolstert und eine Byte-Laenge, die NICHT durch drei teilbar ist —
    # dieselbe Begruendung wie beim Accept-Fall oben (FIX 2): nur dann
    # deckt dieser Test einen fehlenden Polsterungs-Nachtrag in
    # ``_envelope_groesse`` ueberhaupt auf.
    daten = _b64_unpadded(b"das ist deutlich mehr als vier bytes!")
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-gross"]}],
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_unbekanntes_empfaengergeraet_wird_uebergangen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Ein Pubkey ohne Buendel im Verzeichnis erzeugt keine Zustellung —
    aber auch keinen Fehler fuer die uebrigen Empfaenger. Ein Geraet kann
    zwischen Abholen der Schluessel und Absenden abgemeldet worden sein;
    das ist Alltag, kein Fehler."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-bekannt")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{
            "art": 1, "daten": daten,
            "empfaenger": ["empf-bekannt", "empf-unbekannt"],
        }],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 1
    assert body["uebersprungene_empfaenger"] == ["empf-unbekannt"]
    assert body["verworfene_nutzlasten"] == 0

    async with session_factory() as s:
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(zustellungen) == 1
        assert zustellungen[0].empfaenger_device_pubkey == "empf-bekannt"


@pytest.mark.asyncio
async def test_einliefern_weckt_die_empfaenger(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Ohne Weckruf merkt ein offener Klient nichts, bis er zufaellig
    nachsieht."""
    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-weckruf")

    pubsub = app.state.redis.pubsub()
    await pubsub.subscribe(CHANNEL_KEY.format(channel_id=dm_id))
    try:
        daten = base64.b64encode(b"olm-umschlag").decode()
        r = await _einliefern(
            client, token=token_a, channel_id=dm_id,
            nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-weckruf"]}],
        )
        assert r.status_code == 200, r.text

        empfangen = None
        for _ in range(20):
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg is not None:
                empfangen = json.loads(msg["data"])
                break
        assert empfangen is not None, "kein Weckruf empfangen"
        assert empfangen["op"] == "postfach_neu"
        assert empfangen["channel_id"] == str(dm_id)
        assert empfangen["anzahl"] == 1
        # Nie einen Umschlag im Weckruf — sonst laege der Inhalt in Redis.
        assert "daten" not in empfangen and "nutzlasten" not in empfangen
    finally:
        await pubsub.unsubscribe(CHANNEL_KEY.format(channel_id=dm_id))
        await pubsub.aclose()


@pytest.mark.asyncio
async def test_einliefern_weckt_das_empfaengerkonto_auch_ohne_offenen_kanal(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Der Kanal-Weckruf erreicht nur Sockets, die den Kanal gerade
    anzeigen. Wer die Unterhaltung nicht offen hat, braucht den Weckruf an
    sein KONTO — sonst gibt es bis zum Reload weder Zaehler noch Ton
    (2026-09-03 so gemeldet: „bekommt der keine Benachrichtigung")."""
    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-konto")

    pubsub = app.state.redis.pubsub()
    await pubsub.subscribe(USER_EVENTS_CHANNEL)
    try:
        daten = base64.b64encode(b"olm-umschlag").decode()
        r = await _einliefern(
            client, token=token_a, channel_id=dm_id,
            nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-konto"]}],
        )
        assert r.status_code == 200, r.text

        an_b = None
        for _ in range(20):
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg is None:
                continue
            rahmen = json.loads(msg["data"])
            if rahmen.get("op") == "postfach_neu" and rahmen.get("_target_user_id") == str(uid_b):
                an_b = rahmen
                break
        assert an_b is not None, "kein Weckruf an das Empfaengerkonto"
        assert an_b["channel_id"] == str(dm_id)
        assert an_b["anzahl"] == 1
        assert "daten" not in an_b and "nutzlasten" not in an_b
    finally:
        await pubsub.unsubscribe(USER_EVENTS_CHANNEL)
        await pubsub.aclose()


@pytest.mark.asyncio
async def test_zustellung_an_ein_kanalfremdes_geraet_wird_abgewiesen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Die Kanalpruefung belegt, WO geschrieben werden darf — nicht, an WEN.

    Die Empfaengerkennungen kommen aus dem Anfrage-Rumpf. Ohne diese Pruefung
    koennte jeder mit einer einzigen legitimen DM Umschlaege in das Postfach
    JEDES Geraets JEDES Nutzers legen — auch von Leuten, die ihn geblockt
    haben — und dabei deren Kontingent vollschreiben. Gemeldet von der
    Sicherheitspruefung am 2026-08-28.

    Kein stilles Ueberspringen wie beim unbekannten Geraet: ein fremdes Geraet
    ist kein Alltagsfall, sondern ein Klientenfehler oder ein Angriff.
    """
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Ein Geraet des Gespraechspartners und eines eines voellig Unbeteiligten.
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-ok")
    await _bundel_seeden(session_factory, user_id=uid_fremd, device_pubkey="empf-fremd")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-ok", "empf-fremd"]}],
    )
    assert r.status_code == 403, r.text
    assert "empfaenger_nicht_im_kanal" in r.text

    # Und nichts davon darf geschrieben worden sein — auch nicht die
    # zulaessige Haelfte derselben Anfrage.
    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []
        assert (await s.execute(select(DmZustellung))).scalars().all() == []


@pytest.mark.asyncio
async def test_alle_empfaenger_uebersprungen_wird_gemeldet_statt_still_204(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings, monkeypatch
):
    """FIX 1. Sind ALLE angefragten Empfaenger einer Nutzlast uebersprungen
    (hier: Kontingent voll), entsteht nirgends eine Zeile — ein unbedingtes
    ``204`` liesse den Absender glauben, die Nachricht sei zugestellt. Die
    Antwort muss das ehrlich melden."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    monkeypatch.setattr(_isolate_chat_settings, "postfach_max_offene_zustellungen_je_geraet", 0)

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-voll")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-voll"]}],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 0
    assert body["uebersprungene_empfaenger"] == ["empf-voll"]
    assert body["verworfene_nutzlasten"] == 1

    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []
        assert (await s.execute(select(DmZustellung))).scalars().all() == []


@pytest.mark.asyncio
async def test_kollidierender_pubkey_unter_fremdem_konto_bricht_die_anfrage_nicht(
    client, app, session_factory, _auth_signer, friend_pair
):
    """FIX 2. Die DB-Eindeutigkeit ist das Paar ``(user_id, device_pubkey)``
    (``UniqueConstraint`` in ``models/geraete_schluessel.py``), NICHT der
    Pubkey allein — zwei Konten koennen theoretisch denselben Pubkey fuehren,
    z. B. ein geloeschtes und neu registriertes Konto mit demselben lokal
    gespeicherten Geraeteschluessel. Eine ungescopte Suche wirft dann
    ``MultipleResultsFound`` und reisst die ganze Anfrage mit sich — auch die
    Zustellung an einen voellig unbeteiligten, echten Empfaenger im selben
    Kanal."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    pubkey = "kollidierend"
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pubkey)
    await _bundel_seeden(session_factory, user_id=uid_fremd, device_pubkey=pubkey)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pubkey]}],
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(zustellungen) == 1
        assert zustellungen[0].empfaenger_user_id == uid_b


@pytest.mark.asyncio
async def test_zu_viele_empfaenger_je_nutzlast_wird_abgelehnt(client, app, _auth_signer):
    """FIX 4, defence in depth. ``empfaenger`` hatte keine Obergrenze —
    anders als ``nutzlasten`` (settings-gepruefte 100 je Anfrage). Analog zu
    ``user_ids`` (``schemas.py``, max_length=64)."""
    token_a, _ = await _register(_auth_signer)
    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await client.post(
        "/postfach",
        json={
            "channel_id": "1", "device_pubkey": _make_device(),
            "nutzlasten": [{
                "art": 1, "daten": daten,
                "empfaenger": [f"pub-{i}" for i in range(65)],
            }],
        },
        headers=_auth(token_a),
    )
    assert r.status_code == 422, r.text


def test_envelope_groesse_verlangt_den_polsterungs_nachtrag() -> None:
    """FIX 2 (Bughunt 2026-08-28). Ein direkter Nachweis auf
    ``_envelope_groesse`` selbst — nicht ueber die Route —, weil genau HIER
    der Fehler sass, den die uebrigen Tests dieser Datei nie sehen konnten:
    sie bauen ihre ``daten`` alle mit Pythons EIGENEM, GEPOLSTERTEM
    ``b64encode`` (statt dem unpolsterten ``STANDARD_NO_PAD`` des
    Krypto-Kerns, s. Modul-Docstring ``krypto/pulse-krypto``) und trafen
    dabei zufaellig immer eine Byte-Laenge, die durch drei teilbar ist —
    also nie einen Fall, in dem ueberhaupt Padding fehlt.

    **Gegenprobe tatsaechlich gefahren:** den Anhang ``+ "=="`` in
    ``_envelope_groesse`` (``routes/postfach.py``) entfernt, nur diesen
    Test laufen lassen -> rot (``binascii.Error: Incorrect padding``);
    Anhang wiederhergestellt -> wieder gruen, und die restlichen 20 Tests
    dieser Datei blieben in BEIDEN Laeufen gruen, wie vom Hunter behauptet.
    """
    from dcc_chat_gateway.routes.postfach import _envelope_groesse

    roh = b"ein umschlag, der nicht durch drei teilbar ist"
    assert len(roh) % 3 != 0  # sonst entstuende gar kein Padding, s. o.
    unpolstert = base64.b64encode(roh).rstrip(b"=").decode()

    assert _envelope_groesse(unpolstert) == len(roh)


# ---------------------------------------------------------------------------
# Bughunt 2026-08-28 (Missbrauch) — Fairness je Absender (FIX 3)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ein_absender_verdraengt_nicht_die_anderen(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings,
):
    """Die Gesamt-Obergrenze je Empfaengergeraet zaehlt ueber ALLE Absender
    hinweg — ein einzelner angenommener Kontakt kann sie mit ein paar
    Anfragen allein fuellen und damit jeden ANDEREN Absender aussperren.
    Hier mit einer kuenstlich kleinen Absender-Grenze von 2 nachgestellt: A
    fuellt sein eigenes Kontingent, B darf trotzdem noch zustellen."""
    settings = _isolate_chat_settings
    settings.postfach_max_offene_zustellungen_je_absender_und_geraet = 2

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    _, uid_c = await _register(_auth_signer)
    await friend_pair(uid_a, uid_c)
    await friend_pair(uid_b, uid_c)
    dm_ac = await _dm_erstellen(client, token_a, uid_c)
    dm_bc = await _dm_erstellen(client, token_b, uid_c)
    await _bundel_seeden(session_factory, user_id=uid_c, device_pubkey="empf-fair")

    # A liefert drei Umschlaege VOM SELBEN GERAET an dasselbe Empfaenger-
    # geraet -- nur zwei duerfen ankommen, der dritte wird uebersprungen
    # (nicht die Anfrage abgewiesen). Dasselbe Sendegeraet ueber alle drei
    # Aufrufe: die Fairness-Grenze haengt am Sendegeraet (``_einliefern``
    # wuerde je Aufruf ein NEUES erzeugen und die Grenze so umgehen).
    pubkey_a = await _sendegeraet(client, token_a)
    for i in range(2):
        daten = _b64_unpadded(f"umschlag-a-{i}-nicht-durch-drei".encode())
        r = await _einliefern_mit_geraet(
            client, token=token_a, channel_id=dm_ac,
            nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-fair"]}],
            pubkey=pubkey_a,
        )
        assert r.status_code == 200, r.text
        assert r.json()["zustellungen_angelegt"] == 1, r.text

    daten_dritter = _b64_unpadded(b"dritter-umschlag-a-nicht-durch-drei")
    r = await _einliefern_mit_geraet(
        client, token=token_a, channel_id=dm_ac,
        nutzlasten=[{"art": 1, "daten": daten_dritter, "empfaenger": ["empf-fair"]}],
        pubkey=pubkey_a,
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 0
    assert r.json()["uebersprungene_empfaenger"] == ["empf-fair"]

    # B ist ein ANDERER Absender an dasselbe Geraet -- A's ausgeschoepftes
    # Kontingent darf B nicht betreffen.
    daten_b = _b64_unpadded(b"umschlag-b-nicht-durch-drei-teilbar")
    r = await _einliefern(
        client, token=token_b, channel_id=dm_bc,
        nutzlasten=[{"art": 1, "daten": daten_b, "empfaenger": ["empf-fair"]}],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 1, r.text


@pytest.mark.asyncio
async def test_ein_konto_verdraengt_nicht_die_anderen_ueber_mehrere_geraete(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings,
):
    """Belegter Fehler (2026-08-29): FIX 3 zaehlte die Absender-Fairness-
    Grenze bisher PRO GERAET (``DmNutzlast.absender_device_pubkey``), ein
    Konto darf aber bis zu ``schluessel_max_buendel_je_konto`` Geraete
    fuehren. Zwei Geraete DESSELBEN Kontos A liefern hier je zwei Umschlaege
    ein (Absender-Grenze = 2, GESAMT-Obergrenze des Opfergeraets = 3) --
    jedes Geraet fuer sich bleibt innerhalb der Absender-Grenze, in Summe
    koennen sie die GESAMT-Obergrenze trotzdem allein fuellen. Der
    unbeteiligte, echte Freund B geht danach leer aus.

    Nach dem Fix (Grenze am KONTO statt am Geraet) bleibt A insgesamt bei
    ZWEI Zustellungen haengen, gleich ueber wie viele Geraete verteilt --
    B kommt durch, weil vom Opfergeraet noch ein Platz frei ist."""
    settings = _isolate_chat_settings
    settings.postfach_max_offene_zustellungen_je_absender_und_geraet = 2
    settings.postfach_max_offene_zustellungen_je_geraet = 3

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    _, uid_opfer = await _register(_auth_signer)
    await friend_pair(uid_a, uid_opfer)
    await friend_pair(uid_b, uid_opfer)
    dm_a = await _dm_erstellen(client, token_a, uid_opfer)
    dm_b = await _dm_erstellen(client, token_b, uid_opfer)
    await _bundel_seeden(session_factory, user_id=uid_opfer, device_pubkey="opfer-geraet")

    # A liefert ueber ZWEI VERSCHIEDENE Geraete je zwei Umschlaege ein --
    # jedes Geraet fuer sich bleibt innerhalb der Absender-Grenze von 2. Wie
    # viele davon tatsaechlich ankommen, ist genau das, was dieser Test
    # klaert -- deshalb hier bewusst KEINE Zwischenannahme je Aufruf.
    a_angelegt = 0
    for geraet_index in range(2):
        pubkey = await _sendegeraet(client, token_a)
        for i in range(2):
            daten = _b64_unpadded(
                f"a-geraet{geraet_index}-{i}-nicht-durch-drei".encode()
            )
            r = await _einliefern_mit_geraet(
                client, token=token_a, channel_id=dm_a,
                nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["opfer-geraet"]}],
                pubkey=pubkey,
            )
            assert r.status_code == 200, r.text
            a_angelegt += r.json()["zustellungen_angelegt"]

    # A allein darf hoechstens sein KONTO-Kontingent (2) belegt haben --
    # NICHT die volle Geraete-Obergrenze (3), egal wie viele eigene Geraete
    # er dafuer einsetzt.
    assert a_angelegt == 2, (
        f"A hat {a_angelegt} Zustellungen angelegt -- die Absender-Grenze "
        "haengt am Konto, nicht am einzelnen Geraet, und darf durch "
        "mehrere eigene Geraete nicht umgangen werden"
    )

    # Der echte, unbeteiligte Freund B muss noch durchkommen: vom
    # Opfergeraet ist nach A's kontobezogen gedeckeltem Anteil noch ein
    # Platz frei (3 gesamt - 2 durch A = 1).
    daten_b = _b64_unpadded(b"b-nicht-durch-drei-teilbar-umschlag")
    r = await _einliefern(
        client, token=token_b, channel_id=dm_b,
        nutzlasten=[{"art": 1, "daten": daten_b, "empfaenger": ["opfer-geraet"]}],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 1, (
        "B haette noch zustellen duerfen -- A's Kontingent ist kontobezogen "
        "auf 2 begrenzt, unabhaengig von der Geraetezahl"
    )


# ---------------------------------------------------------------------------
# Bughunt 2026-08-28 (Missbrauch) — billig vor teuer (FIX 4)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_billige_grenzen_vor_der_geraetepruefung(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings,
):
    """FIX 4: ``postfach_max_nutzlasten_je_anfrage`` ist ein reiner Strukturcheck
    auf dem Rumpf und muss VOR der Geraetepruefung laufen (die zwei Abfragen
    kostet, eine davon schreibend).

    Nachgewiesen mit einer Geraetekennung, die zu KEINEM Buendel gehoert:
    laeuft die Pruefung zuerst, kommt 403; laufen die billigen Grenzen
    zuerst, kommt 400 (zu viele Nutzlasten).

    **Die frueheren Fassung dieses Tests nutzte eine falsche Unterschrift.**
    Die gibt es seit Spec §3b nicht mehr — das billig/teuer-Gefaelle ist
    seither kleiner, die Reihenfolge aber unveraendert richtig."""
    settings = _isolate_chat_settings
    settings.postfach_max_nutzlasten_je_anfrage = 1

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    daten = _b64_unpadded(b"umschlag-eins-nicht-durch-drei-teilb")
    r = await client.post(
        "/postfach",
        json={
            "channel_id": str(dm_id), "device_pubkey": _make_device(),
            "nutzlasten": [
                {"art": 1, "daten": daten, "empfaenger": ["empf-egal"]},
                {"art": 1, "daten": daten, "empfaenger": ["empf-egal"]},
            ],
        },
        headers=_auth(token_a),
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "zu_viele_nutzlasten"


# ---------------------------------------------------------------------------
# Task 3 — Abholen und Quittieren
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_abholen_liefert_nur_die_eigenen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Das Geraet eines anderen Nutzers darf nichts davon sehen — und das
    Geraet DESSELBEN Nutzers auch nicht: ein Umschlag ist fuer genau ein
    Geraet verschluesselt."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Zwei Geraete des Empfaengers — nur eines bekommt den Umschlag.
    pub_1 = await _bundel_seeden_geraet(session_factory, user_id=uid_b)
    pub_2 = await _bundel_seeden_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub_1]}],
    )
    assert r.status_code == 200, r.text

    # Das belieferte Geraet sieht genau eine Zustellung.
    r = await _abholen(client, token=token_b, pubkey=pub_1)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["daten"] == daten

    # Das ZWEITE Geraet DESSELBEN Nutzers sieht nichts.
    r = await _abholen(client, token=token_b, pubkey=pub_2)
    assert r.status_code == 200, r.text
    assert r.json() == []


@pytest.mark.asyncio
async def test_abholen_loescht_noch_nichts(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Zweimal abholen ohne Quittung liefert dasselbe. Wer beim Ausliefern
    loescht, verliert die Nachricht, wenn die Antwort unterwegs verlorengeht
    — und genau das passiert bei einem Handy im Funkloch staendig."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub = await _bundel_seeden_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub]}],
    )
    assert r.status_code == 200, r.text

    erster = await _abholen(client, token=token_b, pubkey=pub)
    zweiter = await _abholen(client, token=token_b, pubkey=pub)
    assert [z["id"] for z in erster.json()] == [z["id"] for z in zweiter.json()]
    assert len(zweiter.json()) == 1


@pytest.mark.asyncio
async def test_quittung_loescht_die_zustellung(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Der Normalfall."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub = await _bundel_seeden_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub]}],
    )
    assert r.status_code == 200, r.text

    abgeholt = await _abholen(client, token=token_b, pubkey=pub)
    zustellung_id = abgeholt.json()[0]["id"]

    r = await _quittieren(
        client, token=token_b, pubkey=pub,
        zustellung_ids=[zustellung_id],
    )
    assert r.status_code == 204, r.text

    rest = await _abholen(client, token=token_b, pubkey=pub)
    assert rest.json() == []


@pytest.mark.asyncio
async def test_letzte_quittung_raeumt_die_nutzlast_mit(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Eine Nutzlast, die niemand mehr abholen kann, ist Muell. Bei einer
    Gruppe faellt sie erst mit der LETZTEN Zustellung."""
    from dcc_chat_gateway.models import DmNutzlast
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Zwei Geraete desselben Empfaengers -> EINE Nutzlast, ZWEI Zustellungen
    # (der Gruppenfall im Kleinen, s. test_eine_nutzlast_traegt_mehrere_zustellungen).
    pub_1 = await _bundel_seeden_geraet(session_factory, user_id=uid_b)
    pub_2 = await _bundel_seeden_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub_1, pub_2]}],
    )
    assert r.status_code == 200, r.text

    async def _nutzlasten_anzahl() -> int:
        async with session_factory() as s:
            return len((await s.execute(select(DmNutzlast))).scalars().all())

    assert await _nutzlasten_anzahl() == 1

    id_1 = (await _abholen(
        client, token=token_b, pubkey=pub_1
    )).json()[0]["id"]
    id_2 = (await _abholen(
        client, token=token_b, pubkey=pub_2
    )).json()[0]["id"]

    # Erste Quittung: die Nutzlast bleibt (Geraet 2 hat noch nicht quittiert).
    r = await _quittieren(
        client, token=token_b, pubkey=pub_1,
        zustellung_ids=[id_1],
    )
    assert r.status_code == 204, r.text
    assert await _nutzlasten_anzahl() == 1

    # Zweite (letzte) Quittung: jetzt faellt auch die Nutzlast.
    r = await _quittieren(
        client, token=token_b, pubkey=pub_2,
        zustellung_ids=[id_2],
    )
    assert r.status_code == 204, r.text
    assert await _nutzlasten_anzahl() == 0


@pytest.mark.asyncio
async def test_fremdes_konto_kann_nicht_unter_fremder_kennung_abholen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """**Der Riegel, der das Zertifikat ersetzt** (Spec §3b): die
    Geraetekennung im Rumpf muss zu einem Geraet DES ANGEMELDETEN Kontos
    gehoeren.

    Eine Kennung ist oeffentlich — jeder Gespraechspartner bekommt sie ueber
    ``POST /keys/claim``. Ohne den Nachschlag in ``DeviceKeyBundle`` genuegte
    sie, um das Postfach eines fremden Geraets zu leeren: abholen und
    quittieren, und der rechtmaessige Empfaenger bekaeme seine Umschlaege nie
    (es gibt keine zweite Kopie). Oeffnen koennte der Fremde sie nicht — aber
    wegnehmen."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub_b = await _bundel_seeden_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub_b]}],
    )
    assert r.status_code == 200, r.text

    # A kennt ``pub_b`` (aus dem eigenen Sendeweg) und meldet sich damit.
    r = await _abholen(client, token=token_a, pubkey=pub_b)
    assert r.status_code == 403, r.text
    r = await _quittieren(
        client, token=token_a, pubkey=pub_b, zustellung_ids=["1"]
    )
    assert r.status_code == 403, r.text

    # Der rechtmaessige Empfaenger kommt weiterhin an seine Zustellung — und
    # quittiert sie weg.
    r = await _abholen(client, token=token_b, pubkey=pub_b)
    assert r.status_code == 200, r.text
    ids = [z["id"] for z in r.json()]
    assert len(ids) == 1
    r = await _quittieren(client, token=token_b, pubkey=pub_b, zustellung_ids=ids)
    assert r.status_code == 204, r.text
    assert (await _abholen(client, token=token_b, pubkey=pub_b)).json() == []


@pytest.mark.asyncio
async def test_fremde_zustellungs_id_quittiert_nichts(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Eine erratene ID darf nicht die Zustellung eines anderen loeschen.
    Die Quittung filtert auf das eigene Geraet, nicht nur auf die ID."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    token_fremd, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub = await _bundel_seeden_geraet(session_factory, user_id=uid_b)
    # Ein Geraet, das mit dieser Zustellung nichts zu tun hat.
    pub_fremd = await _bundel_seeden_geraet(
        session_factory, user_id=uid_fremd
    )

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub]}],
    )
    assert r.status_code == 200, r.text
    async with session_factory() as s:
        zustellung_id = (
            (await s.execute(select(DmZustellung))).scalars().one().id
        )

    # Der Fremde reicht die (erratene oder abgelauschte) ID mit SEINEM
    # eigenen, nachgewiesenen Geraet ein.
    r = await _quittieren(
        client, token=token_fremd, pubkey=pub_fremd,
        zustellung_ids=[str(zustellung_id)],
    )
    assert r.status_code == 204, r.text  # stilles Uebergehen, kein Fehler

    async with session_factory() as s:
        rest = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(rest) == 1
        assert rest[0].id == zustellung_id


@pytest.mark.asyncio
async def test_absender_user_id_zeigt_das_sendegeraet_auch_beim_eigenen_zweitgeraet(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Der Kern des Bugs, den die Etappe D2 offen liess: eine verschluesselte
    DM liefert denselben Umschlag auch an die EIGENEN anderen Geraete des
    Senders aus (so kommt eine vom Handy gesendete Nachricht auf dem
    Desktop an). `absender_user_id` muss in diesem Fall den SENDER
    zuschreiben — NICHT den Kanal-Gegenpart, den ein rein clientseitiger
    Kanal->User-Lookup faelschlich liefern wuerde."""
    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Sendegeraet UND Empfaengergeraet gehoeren BEIDE A — der Gegenpart des
    # Kanals ist B, aber der Absender dieser Zustellung ist A selbst.
    sender_pub = await _bundel_seeden_geraet(session_factory, user_id=uid_a)
    empf_pub = await _bundel_seeden_geraet(session_factory, user_id=uid_a)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern_mit_geraet(
        client, token=token_a, channel_id=dm_id, pubkey=sender_pub,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [empf_pub]}],
    )
    assert r.status_code == 200, r.text

    r = await _abholen(client, token=token_a, pubkey=empf_pub)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["absender_user_id"] == str(uid_a)


@pytest.mark.asyncio
async def test_absender_user_id_ist_null_wenn_sendegeraet_abgemeldet_ist(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Das Sendegeraet kann sich zwischen Einliefern und Abholen abmelden —
    sein Schluessel-Buendel ist dann weg, und der OUTER Join findet nichts
    mehr. `absender_user_id` wird `None`, statt dass die Abholung crasht
    oder die Zustellung verschwindet (der Klient faellt in diesem Fall auf
    den Kanal-Gegenpart zurueck, s. `absenderErmitteln.ts`)."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import delete

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    sender_pub = await _bundel_seeden_geraet(session_factory, user_id=uid_a)
    empf_pub = await _bundel_seeden_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern_mit_geraet(
        client, token=token_a, channel_id=dm_id, pubkey=sender_pub,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [empf_pub]}],
    )
    assert r.status_code == 200, r.text

    # Das Sendegeraet meldet sich ab — sein Buendel verschwindet, die
    # Zustellung selbst bleibt unberuehrt liegen (kein Fremdschluessel
    # zwischen den beiden Tabellen, s. Modul-Docstring von models/postfach.py).
    async with session_factory() as s:
        await s.execute(
            delete(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == sender_pub)
        )
        await s.commit()

    r = await _abholen(client, token=token_b, pubkey=empf_pub)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["absender_user_id"] is None


# ---------------------------------------------------------------------------
# Task 4 — Verfall
# ---------------------------------------------------------------------------


async def _nutzlast_mit_zustellung(
    session_factory, *, verfaellt_am, nutzlast_id=None
):
    """Legt eine Nutzlast mit genau einer Zustellung an und gibt beide IDs
    zurueck — Hilfsfunktion fuer die Task-4-Tests, die direkt auf der DB
    arbeiten (keine Route dafuer noetig, s. Vorbild Task 1)."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    nid = nutzlast_id if nutzlast_id is not None else next_id()
    zid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=zid, nutzlast_id=nid,
            empfaenger_device_pubkey="G1", empfaenger_user_id=2,
            verfaellt_am=verfaellt_am,
        ))
        await s.commit()
    return nid, zid


@pytest.mark.asyncio
async def test_verfallene_zustellung_wird_gefegt(session_factory):
    """Ein Geraet, das nie wiederkommt, darf den Server nicht dauerhaft
    belegen."""
    import datetime as dt

    from dcc_chat_gateway.models import DmZustellung
    from dcc_chat_gateway.postfach_pflege import sweep_verfallene_zustellungen
    from sqlalchemy import select

    _, zid = await _nutzlast_mit_zustellung(
        session_factory, verfaellt_am=dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    )

    async with session_factory() as s:
        anzahl = await sweep_verfallene_zustellungen(s)
    assert anzahl == 1

    async with session_factory() as s:
        rest = (await s.execute(select(DmZustellung).where(DmZustellung.id == zid))).scalar_one_or_none()
        assert rest is None


@pytest.mark.asyncio
async def test_nicht_verfallene_bleibt_stehen(session_factory):
    """Die Gegenprobe. Ohne sie faengt der Fegelauf im Zweifel alles weg,
    und das faellt erst auf, wenn Nachrichten verschwinden."""
    import datetime as dt

    from dcc_chat_gateway.models import DmZustellung
    from dcc_chat_gateway.postfach_pflege import sweep_verfallene_zustellungen
    from sqlalchemy import select

    _, zid = await _nutzlast_mit_zustellung(
        session_factory, verfaellt_am=dt.datetime.now(dt.UTC) + dt.timedelta(days=1)
    )

    async with session_factory() as s:
        anzahl = await sweep_verfallene_zustellungen(s)
    assert anzahl == 0

    async with session_factory() as s:
        rest = (await s.execute(select(DmZustellung).where(DmZustellung.id == zid))).scalar_one_or_none()
        assert rest is not None


@pytest.mark.asyncio
async def test_verwaiste_nutzlast_wird_gefegt(session_factory):
    """Eine Nutzlast, deren letzte Zustellung verfiel, ist unlesbar
    geworden — sie loescht sich nicht von selbst, weil der Verfall an der
    Zustellung haengt."""
    import datetime as dt

    from dcc_chat_gateway.models import DmNutzlast
    from dcc_chat_gateway.postfach_pflege import (
        sweep_verfallene_zustellungen,
        sweep_verwaiste_nutzlasten,
    )
    from sqlalchemy import select

    nid, _ = await _nutzlast_mit_zustellung(
        session_factory, verfaellt_am=dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    )

    async with session_factory() as s:
        assert await sweep_verfallene_zustellungen(s) == 1
        # Die Nutzlast selbst ist von diesem Lauf unberuehrt.
        assert (
            await s.execute(select(DmNutzlast).where(DmNutzlast.id == nid))
        ).scalar_one_or_none() is not None

    async with session_factory() as s:
        anzahl = await sweep_verwaiste_nutzlasten(s)
    assert anzahl == 1

    async with session_factory() as s:
        rest = (
            await s.execute(select(DmNutzlast).where(DmNutzlast.id == nid))
        ).scalar_one_or_none()
        assert rest is None


# ---------------------------------------------------------------------------
# Etappe G2 — private Gruppen im Postfach
# ---------------------------------------------------------------------------
#
# Bis hierhin trug das Postfach nur DMs: ``_channel_zugriff_pruefen`` liess
# ausschliesslich ``("dm", …)`` durch, eine Gruppen-Kanal-ID fiel mit 403
# ``channel_not_accessible`` heraus. Damit war der verschluesselte Weg fuer
# Gruppen verschlossen — Megolm ist ohne Zustellweg nichts.
#
# Die Nutzlast einer Gruppennachricht ist fuer ALLE dieselbe (Megolm), es
# entsteht also EINE ``DmNutzlast`` mit vielen ``DmZustellung`` — genau das
# Modell, fuer das Nutzlast und Zustellung getrennt wurden.


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    """Wie in ``test_private_gruppen.py``: der Schalter steht per Vorgabe aus,
    wer eine Gruppe braucht, fordert ihn ausdruecklich an."""
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


async def _gruppe_anlegen(client, token_ersteller: str, *mitglied_ids: int) -> str:
    r = await client.post("/gruppen", json={"name": "Testgruppe"}, headers=_auth(token_ersteller))
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    for uid in mitglied_ids:
        r = await client.post(
            f"/gruppen/{gid}/mitglieder",
            json={"user_id": str(uid)},
            headers=_auth(token_ersteller),
        )
        assert r.status_code == 201, r.text
    return gid


@pytest.mark.asyncio
async def test_gruppe_eine_nutzlast_viele_zustellungen(
    client, app, session_factory, _auth_signer, gruppen_an
):
    from sqlalchemy import func, select

    from dcc_chat_gateway.models import DmNutzlast, DmZustellung

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_c = await _register(_auth_signer)
    gid = await _gruppe_anlegen(client, t_a, uid_b, uid_c)

    # Je ein Geraet fuer B und C, plus ein ZWEITES Geraet von A (der eigene
    # Zweitrechner gehoert dazu — sonst saehe er nie, was das Erstgeraet
    # geschrieben hat).
    pk_b = _make_device()
    pk_c = _make_device()
    pk_a2 = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)
    await _bundel_seeden(session_factory, user_id=uid_c, device_pubkey=pk_c)
    await _bundel_seeden(session_factory, user_id=uid_a, device_pubkey=pk_a2)

    r = await _einliefern(
        client, token=t_a, channel_id=gid,
        nutzlasten=[{
            # Art 2 = Megolm-Gruppennachricht (``ART_GRUPPENNACHRICHT`` im
            # Klienten). Der Server unterscheidet die Arten nie, er reicht
            # die Zahl durch — der Test haelt nur fest, dass ein anderer
            # Wert als 0/1 nicht abgewiesen wird.
            "art": 2,
            "daten": _b64_unpadded(b"megolm-geheimtext"),
            "empfaenger": [pk_b, pk_c, pk_a2],
        }],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 3

    async with session_factory() as s:
        nutzlasten = (
            await s.execute(select(func.count()).select_from(DmNutzlast).where(
                DmNutzlast.channel_id == int(gid)
            ))
        ).scalar_one()
        zustellungen = (
            await s.execute(select(DmZustellung.empfaenger_user_id).join(
                DmNutzlast, DmNutzlast.id == DmZustellung.nutzlast_id
            ).where(DmNutzlast.channel_id == int(gid)))
        ).scalars().all()
    assert nutzlasten == 1, "Megolm verschluesselt EINMAL — eine Nutzlast, viele Zustellungen"
    assert sorted(zustellungen) == sorted([uid_b, uid_c, uid_a])


@pytest.mark.asyncio
async def test_gruppe_ohne_freundschaft(client, app, session_factory, _auth_signer, gruppen_an):
    """Eine Gruppe ist kein Freundespaar. Wuerde das Freundschafts-Gate der
    DM hier mitlaufen, koennte in einer frisch angelegten Gruppe niemand
    schreiben — Mitglieder sind untereinander in aller Regel nicht
    befreundet, und ``_gruppe_anlegen`` stiftet keine Freundschaft."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    gid = await _gruppe_anlegen(client, t_a, uid_b)
    pk_b = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)

    r = await _einliefern(
        client, token=t_a, channel_id=gid,
        nutzlasten=[{"art": 2, "daten": _b64_unpadded(b"geheim"), "empfaenger": [pk_b]}],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 1


@pytest.mark.asyncio
async def test_nichtmitglied_liefert_nicht_in_die_gruppe_ein(
    client, app, session_factory, _auth_signer, gruppen_an
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    t_x, uid_x = await _register(_auth_signer)
    gid = await _gruppe_anlegen(client, t_a, uid_b)
    pk_b = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)

    r = await _einliefern(
        client, token=t_x, channel_id=gid,
        nutzlasten=[{"art": 2, "daten": _b64_unpadded(b"geheim"), "empfaenger": [pk_b]}],
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "channel_not_accessible"


@pytest.mark.asyncio
async def test_entferntes_mitglied_bekommt_nichts_mehr_zugestellt(
    client, app, session_factory, _auth_signer, gruppen_an
):
    """Der serverseitige Teil der Aussperrung. Den Gruppenschluessel, den ein
    Ausgeschiedener schon hat, kann niemand zurueckholen — deshalb wechselt
    der Absender die Sitzung (``krypto/gruppe/sitzungswahl.ts``). Der Server
    steuert bei, dass der Geheimtext gar nicht erst in seinem Postfach
    landet.

    **Bughunt 2026-08-28/29 (belegter Fehler):** vorher kippte C's global
    weiterhin existierendes, aber nicht mehr kanalgehoeriges Buendel die
    GANZE Anfrage mit 403 ``empfaenger_nicht_im_kanal`` — auch fuer B, der
    weiterhin Mitglied ist und im selben Umschlag stand. In einer Gruppe ist
    ein gerade Entfernter der Alltagsfall (der Absender hatte die
    Mitgliederliste nur einen Moment frueher gelesen), kein Angriff — anders
    als bei einer DM (dort bleibt der 403 unveraendert, s.
    ``test_zustellung_an_ein_kanalfremdes_geraet_wird_abgewiesen``). Der
    Server ueberspringt C jetzt wie ein unbekanntes Geraet, die Anfrage
    liefert an B trotzdem aus, und der Absender erfaehrt ueber
    ``uebersprungene_empfaenger``, dass C nichts bekommen hat."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_c = await _register(_auth_signer)
    gid = await _gruppe_anlegen(client, t_a, uid_b, uid_c)
    pk_b = _make_device()
    pk_c = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)
    await _bundel_seeden(session_factory, user_id=uid_c, device_pubkey=pk_c)

    r = await client.delete(f"/gruppen/{gid}/mitglieder/{uid_c}", headers=_auth(t_a))
    assert r.status_code == 200, r.text

    r = await _einliefern(
        client, token=t_a, channel_id=gid,
        nutzlasten=[{
            "art": 2, "daten": _b64_unpadded(b"geheim"), "empfaenger": [pk_b, pk_c],
        }],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 1
    assert body["uebersprungene_empfaenger"] == [pk_c]

    async with session_factory() as s:
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(zustellungen) == 1
        assert zustellungen[0].empfaenger_device_pubkey == pk_b


@pytest.mark.asyncio
async def test_dm_kanalfremdes_geraet_bleibt_fail_closed_trotz_gruppen_fix(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Gegenprobe zum Fix oben: der DM-Zweig darf sich NICHT mitveraendert
    haben. Dieselbe Situation wie
    ``test_zustellung_an_ein_kanalfremdes_geraet_wird_abgewiesen``, hier
    direkt neben dem Gruppen-Fix platziert, damit ein kuenftiger Umbau beide
    Faelle nebeneinander sieht."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-ok-2")
    await _bundel_seeden(session_factory, user_id=uid_fremd, device_pubkey="empf-fremd-2")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, token=token_a, channel_id=dm_id,
        nutzlasten=[{
            "art": 1, "daten": daten, "empfaenger": ["empf-ok-2", "empf-fremd-2"],
        }],
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "empfaenger_nicht_im_kanal"

    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []
        assert (await s.execute(select(DmZustellung))).scalars().all() == []


@pytest.mark.asyncio
async def test_abgeschalteter_schalter_verschliesst_das_gruppen_postfach(
    client, app, session_factory, _auth_signer, _isolate_chat_settings
):
    _isolate_chat_settings.private_groups_enabled = True
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    gid = await _gruppe_anlegen(client, t_a, uid_b)
    pk_b = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)
    _isolate_chat_settings.private_groups_enabled = False

    r = await _einliefern(
        client, token=t_a, channel_id=gid,
        nutzlasten=[{"art": 2, "daten": _b64_unpadded(b"geheim"), "empfaenger": [pk_b]}],
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "channel_not_accessible"


# ---------------------------------------------------------------------------
# Etappe E6, Aufgabe 1 — Ablage-Kanaele im Postfach
# ---------------------------------------------------------------------------
#
# Ein Guild-Kanal mit ``ablage=true`` ist ab hier ein drittes zulaessiges
# Postfach-Ziel, neben DM und privater Gruppe. Berechtigung ist
# ``VIEW_CHANNEL`` ueber den vorhandenen Rechte-Resolver
# (``permissions.members_who_can_view``) — keine neue Mitgliedertabelle. Ein
# gewoehnlicher Textkanal (``ablage=false``) bleibt gesperrt: genau dieser
# Mischzustand war auf diesem Zweig schon einmal offen (``ws_op_send.py``,
# schneller Pfad umging die Klartext-Sperre). Der Ereignisweg (zweite
# Pruefstelle) steht eigens in
# ``test_ablage_kanal_postfach_ereignisweg.py``.


async def _guild_mit_kanal(client, token_ersteller: str, *, ablage: bool) -> tuple[str, str]:
    """Legt eine Community und darin einen Kanal an — ``ablage`` steuert das
    Merkmal, das ``_channel_zugriff_pruefen`` fuer das Postfach verlangt."""
    r = await client.post("/guilds", json={"name": "g"}, headers=_auth(token_ersteller))
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    r = await client.post(
        f"/guilds/{gid}/channels",
        json={"name": "kanal", "ablage": ablage},
        headers=_auth(token_ersteller),
    )
    assert r.status_code == 201, r.text
    return gid, r.json()["id"]


async def _guild_mitglied_hinzufuegen(session_factory, guild_id: str, user_id: int) -> None:
    """Traegt ``user_id`` direkt als Mitglied ein (mit der @everyone-Rolle,
    die per Vorgabe VIEW_CHANNEL traegt) — die Beitritts-Route wird bereits
    anderswo geprueft, hier geht es nur um die Postfach-Zugriffspruefung
    darueber."""
    from dcc_chat_gateway.models import GuildMember

    async with session_factory() as s:
        s.add(GuildMember(guild_id=int(guild_id), user_id=user_id))
        await s.commit()


@pytest.mark.asyncio
async def test_ablage_kanal_mitglied_kann_einliefern_und_abholen(
    client, app, session_factory, _auth_signer
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    gid, cid = await _guild_mit_kanal(client, t_a, ablage=True)
    await _guild_mitglied_hinzufuegen(session_factory, gid, uid_b)
    pk_b = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)

    r = await _einliefern(
        client, token=t_a, channel_id=cid,
        nutzlasten=[{
            "art": 2, "daten": _b64_unpadded(b"ablage-geheim"), "empfaenger": [pk_b],
        }],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 1

    r = await _abholen(client, token=t_b, pubkey=pk_b)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["channel_id"] == str(cid)


@pytest.mark.asyncio
async def test_ablage_kanal_nichtmitglied_kann_nicht_einliefern_und_bekommt_nichts_ab(
    client, app, session_factory, _auth_signer
):
    t_a, uid_a = await _register(_auth_signer)
    t_fremd, uid_fremd = await _register(_auth_signer)
    gid, cid = await _guild_mit_kanal(client, t_a, ablage=True)
    pk_fremd = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_fremd, device_pubkey=pk_fremd)

    r = await _einliefern(
        client, token=t_fremd, channel_id=cid,
        nutzlasten=[{"art": 2, "daten": _b64_unpadded(b"geheim"), "empfaenger": [pk_fremd]}],
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "channel_not_accessible"

    # Abholen ist nicht ueber ``_channel_zugriff_pruefen`` gegated (es
    # filtert ausschliesslich auf das eigene Empfaengergeraet/Konto, s.
    # ``postfach_abholen.py``-Docstring) — fail-closed zeigt sich hier daran,
    # dass fuer den Fremden schlicht NICHTS drinsteht, weil die Route oben
    # nie eine Zustellung an ihn angelegt hat.
    r = await _abholen(client, token=t_fremd, pubkey=pk_fremd)
    assert r.status_code == 200, r.text
    assert r.json() == []


@pytest.mark.asyncio
async def test_klartextkanal_wird_nicht_zum_postfach_ziel(
    client, app, session_factory, _auth_signer
):
    """Der wichtigste Test dieser Aufgabe (Regel 1): OHNE das
    ``ablage``-Merkmal bleibt ein Guild-Kanal gesperrt, auch wenn der
    Absender darin regulaeres Mitglied ist und VIEW_CHANNEL haelt. Genau
    dieser Mischzustand war auf diesem Zweig schon einmal offen
    (``ws_op_send.py``, schneller Pfad umging die Klartext-Sperre fuer
    Ablage-Kanaele) — er darf hier nicht durch die Hintertuer zurueckkommen."""
    from sqlalchemy import select

    from dcc_chat_gateway.models import DmNutzlast, DmZustellung

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    gid, cid = await _guild_mit_kanal(client, t_a, ablage=False)
    await _guild_mitglied_hinzufuegen(session_factory, gid, uid_b)
    pk_b = _make_device()
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pk_b)

    r = await _einliefern(
        client, token=t_a, channel_id=cid,
        nutzlasten=[{"art": 2, "daten": _b64_unpadded(b"geheim"), "empfaenger": [pk_b]}],
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "channel_not_accessible"

    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []
        assert (await s.execute(select(DmZustellung))).scalars().all() == []
