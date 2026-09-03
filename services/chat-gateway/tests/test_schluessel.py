"""Das Geraete-Schluesselverzeichnis."""

from __future__ import annotations

import asyncio
import itertools
import random

import pytest
import pytest_asyncio

# ---------------------------------------------------------------------------
# Geraete-Helfer. Seit dem Wegfall der Zertifikate (Spec §3b) ist eine
# Geraetekennung nichts weiter als eine stabile Zeichenkette: der Server
# prueft nicht mehr, dass der Aufrufer dieses Geraet IST, sondern nur, dass es
# zu seinem Konto gehoert (``schluessel_nachweis.py``). Ein echtes
# Schluesselpaar zu erzeugen waere hier deshalb Theater — die Tests wuerden
# eine Bindung nachstellen, die es nicht mehr gibt.
# ---------------------------------------------------------------------------

_geraete_zaehler = itertools.count()


def _make_device() -> str:
    """Eine frische, eindeutige Geraetekennung (Laenge wie ein Base64url-
    Ed25519-Pubkey, 43 Zeichen — die Rumpf-Modelle verlangen mindestens 16)."""
    return f"geraet-{next(_geraete_zaehler):036d}"


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung. Postgres (Prod) erzwingt das ohnehin — dieselbe Falle wie
    in ``services/auth/tests/test_account_delete.py``. Die Test-Engine nutzt
    ``StaticPool`` (eine geteilte In-Memory-Verbindung), deshalb genuegt ein
    einmaliges PRAGMA auf dieser einen Verbindung, ohne Dispose+Neuanlage.
    """
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_ein_geraet_hat_hoechstens_ein_buendel(session_factory):
    """Zweimal dasselbe Geraet darf keine zweite Zeile anlegen.

    Sonst hielte das Verzeichnis zwei Identitaeten fuer dasselbe Geraet, und
    welche ein Absender bekaeme, entschiede die Zeilenreihenfolge.
    """
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy.exc import IntegrityError

    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=next_id(), user_id=1, device_pubkey="AAA", curve25519="BBB",
        ))
        await s.commit()

    with pytest.raises(IntegrityError):
        async with session_factory() as s:
            s.add(DeviceKeyBundle(
                id=next_id(), user_id=1, device_pubkey="AAA", curve25519="XXX",
            ))
            await s.commit()


@pytest.mark.asyncio
async def test_einmalschluessel_verschwinden_mit_ihrem_buendel(session_factory):
    """Ein Geraet abmelden heisst: sein Vorrat ist weg, nicht verwaist."""
    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import delete, select

    bid = next_id()
    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=bid, user_id=2, device_pubkey="DDD", curve25519="EEE",
        ))
        s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel="k1"))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DeviceKeyBundle).where(DeviceKeyBundle.id == bid))
        await s.commit()

    async with session_factory() as s:
        uebrig = (await s.execute(
            select(DeviceOneTimeKey).where(DeviceOneTimeKey.bundle_id == bid)
        )).scalars().all()
        assert uebrig == []


# ---------------------------------------------------------------------------
# Task 2 — Veroeffentlichen mit Nachweis
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_buendel_veroeffentlichen_und_wieder_abrufen(
    client, app, cloud_mode, access_token
):
    """Der Normalfall — und zugleich die AUSNAHME aus Spec §3b: beim
    allerersten Veroeffentlichen gibt es zu diesem ``device_pubkey`` noch
    keine Zeile, gegen die ``pruefe_geraet`` nachschlagen koennte. Sie
    entsteht ja genau hier."""
    token, uid = access_token
    pubkey = _make_device()

    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-pub"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    r = await client.get(
        "/keys/onetime/count",
        params={"device_pubkey": pubkey},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"vorrat": 0}


@pytest.mark.asyncio
async def test_fremdes_konto_kann_nicht_unter_fremder_kennung_handeln(
    client, session_factory, cloud_mode, _auth_signer
):
    """**Der Riegel, der das Zertifikat ersetzt** (Spec §3b): eine
    Geraetekennung, die zu einem ANDEREN Konto gehoert, gilt nicht — 403,
    bevor die Route ueberhaupt eine Zeile auswaehlt.

    **Was dieser Test NICHT zeigt, und das gehoert dazu:** ohne den Riegel
    schriebe B hier trotzdem nichts in A's Buendel — die Auswahl darunter ist
    ihrerseits auf ``user_id == user.id`` skopiert, B bekaeme bloss ein 404
    statt eines 403. Die Stelle, an der der Riegel wirklich traegt, ist das
    Postfach: dort entscheidet die Kennung ALLEIN, wessen Zustellungen
    herausgegeben und geloescht werden (``test_postfach.py::
    test_fremdes_konto_kann_nicht_unter_fremder_kennung_abholen``). Hier steht
    er, weil dieselbe eine Funktion beide Routen bewacht und ihr Verhalten an
    der billigsten Stelle festgehalten gehoert.
    """
    _, uid_a = _register(_auth_signer)
    token_b, _uid_b = _register(_auth_signer)
    await _buendel_seeden(session_factory, user_id=uid_a, device_pubkey="geraet-von-a-0000")

    r = await client.post(
        "/keys/onetime",
        json={"device_pubkey": "geraet-von-a-0000", "schluessel": ["otk-fremd"]},
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_kennung_eines_fremden_kontos_laesst_sich_nicht_eintragen(
    client, session_factory, cloud_mode, _auth_signer
):
    """``PUT /keys/bundle`` ist die Ausnahme ohne Nachschlag — genau deshalb
    braucht sie ihren eigenen Riegel.

    Ohne ihn traegt B die (oeffentlich ueber ``POST /keys/claim`` abholbare)
    Kennung von A fuer sich ein; ``_bundle_laden`` faende in einem gemeinsamen
    Gespraech danach ZWEI Zeilen zu einem Pubkey und risse mit
    ``MultipleResultsFound`` jede Einlieferung in diesem Kanal mit — auch die
    des Opfers.
    """
    _, uid_a = _register(_auth_signer)
    token_b, _uid_b = _register(_auth_signer)
    await _buendel_seeden(session_factory, user_id=uid_a, device_pubkey="geraet-von-a-0001")

    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": "geraet-von-a-0001", "curve25519": "curve-b"},
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_erneutes_veroeffentlichen_ersetzt_statt_zu_haeufen(
    client, app, session_factory, cloud_mode, access_token
):
    """Dasselbe Geraet, zweimal veroeffentlicht: eine Zeile, nicht zwei."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select

    token, uid = access_token
    pubkey = _make_device()

    for curve in ("erste-runde", "zweite-runde"):
        r = await client.put(
            "/keys/bundle",
            json={"device_pubkey": pubkey, "curve25519": curve},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 204, r.text

    async with session_factory() as s:
        zeilen = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == pubkey)
            )
        ).scalars().all()
        assert len(zeilen) == 1
        assert zeilen[0].curve25519 == "zweite-runde"


@pytest.mark.asyncio
async def test_rueckfallschluessel_wird_mit_veroeffentlicht_und_gespeichert(
    client, app, session_factory, cloud_mode, access_token
):
    """Der Lueckenschluss dieses PRs: ein Geraet, das seinen
    Rueckfallschluessel mitschickt, bekommt ihn auch gespeichert — und die
    HAUPT-Signatur (kein separates ``rueckfall_signatur``-Feld mehr) deckt
    ihn ab, weil er als drittes Stueck Teil derselben Nutzlast ist.
    """
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select

    token, uid = access_token
    pubkey = _make_device()

    r = await client.put(
        "/keys/bundle",
        json={
            "device_pubkey": pubkey,
            "curve25519": "curve-pub",
            "rueckfallschluessel": "rueckfall-pub",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        zeile = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == pubkey)
            )
        ).scalar_one()
        assert zeile.rueckfallschluessel == "rueckfall-pub"


@pytest.mark.asyncio
async def test_dauerhaft_wird_gespeichert_und_beim_abholen_zurueckgegeben(
    client, app, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Der eigentliche Lueckenschluss dieses Nachtrags: ein Geraet, das sich
    als dauerhaft meldet (Electron/Android, ``veroeffentlichen.ts``), bekommt
    das Flag auch ueber ``POST /keys/claim`` zurueck — ohne diesen Rundweg
    bleibt die Koexistenz-Regel im Klienten (``empfaengerGeraete.ts``) inert,
    weil jedes Geraet dort als nicht-dauerhaft ankommt."""
    sender_token, sender_uid = _register(_auth_signer)
    empf_token, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    pubkey = _make_device()

    r = await client.put(
        "/keys/bundle",
        json={
            "device_pubkey": pubkey,
            "curve25519": "curve-dauerhaft",
            "dauerhaft": True,
        },
        headers={"Authorization": f"Bearer {empf_token}"},
    )
    assert r.status_code == 204, r.text

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    buendel = r.json()[str(empf_uid)][0]
    assert buendel["dauerhaft"] is True


@pytest.mark.asyncio
async def test_dauerhaft_ist_ohne_angabe_false(
    client, app, session_factory, cloud_mode, access_token
):
    """Fail closed: ein Geraet, das ``dauerhaft`` gar nicht mitschickt (alter
    Klient, oder ein Browser-Tab ohne die Koexistenz-Regel im Kopf), gilt als
    NICHT dauerhaft — nie als Vorgabe ``True``, sonst waere die ganze Regel
    aus Spec §3 wirkungslos."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select

    token, uid = access_token
    pubkey = _make_device()

    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-pub"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        zeile = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == pubkey)
            )
        ).scalar_one()
        assert zeile.dauerhaft is False


# ---------------------------------------------------------------------------
# Task 3 — Abholen: einmal ist einmal
# ---------------------------------------------------------------------------


def _register(_auth_signer) -> tuple[str, int]:
    """Wie in ``test_dm_friend_gate.py`` / ``test_dropbox_races.py``: kein
    echtes ``/register``, nur ein ausgestelltes Access-Token fuer eine
    synthetische Nutzer-ID."""
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _buendel_seeden(
    session_factory,
    *,
    user_id: int,
    device_pubkey: str = "pub-empfaenger",
    rueckfallschluessel: str | None = None,
    einmalschluessel: list[str] = (),
    dauerhaft: bool = False,
    zuletzt_benutzt=None,
    gekoppelt_am=None,
) -> int:
    """Legt ein Buendel direkt in die DB, ohne den Nachweis-Umweg — Task 3
    prueft das ABHOLEN, nicht das Veroeffentlichen; das ist bereits in
    Task 2 abgedeckt."""
    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id

    from datetime import UTC, datetime

    bid = next_id()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=bid,
                user_id=user_id,
                device_pubkey=device_pubkey,
                curve25519="curve-empfaenger",
                rueckfallschluessel=rueckfallschluessel,
                dauerhaft=dauerhaft,
                gekoppelt_am=gekoppelt_am,
                # ``server_default`` greift nur, wenn die Spalte gar nicht
                # mitgeschickt wird — deshalb hier ausdruecklich "jetzt",
                # sonst schriebe SQLAlchemy ``NULL`` in eine NOT-NULL-Spalte.
                zuletzt_benutzt=zuletzt_benutzt or datetime.now(UTC),
            )
        )
        for schl in einmalschluessel:
            s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel=schl))
        await s.commit()
    return bid


@pytest.mark.asyncio
async def test_abholen_verbraucht_den_einmalschluessel(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Zweimal abholen darf nie denselben Schluessel liefern."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-1",
        einmalschluessel=["otk-1"],
    )

    r1 = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r1.status_code == 200, r1.text
    b1 = r1.json()[str(empf_uid)][0]
    assert b1["einmalschluessel"] == "otk-1"
    assert b1["rueckfallschluessel"] is None

    r2 = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r2.status_code == 200, r2.text
    b2 = r2.json()[str(empf_uid)][0]
    # Vorrat ist leer -> Rueckfall, NICHT derselbe (oder irgendein) Einmalschluessel.
    assert b2["einmalschluessel"] is None
    assert b2["rueckfallschluessel"] == "rueckfall-1"


@pytest.mark.asyncio
async def test_zwei_gleichzeitige_abholungen_bekommen_verschiedene(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Der Kern der Sache. Zwei Abholungen gleichzeitig (asyncio.gather)
    duerfen NIE denselben Einmalschluessel liefern — sonst benutzen zwei
    Absender dasselbe Geheimnis. Ein blosses SELECT-dann-DELETE hat genau
    dieses Loch, und es faellt in keinem seriellen Test auf.

    **Wie hier echte Nebenlaeufigkeit entsteht:** zwei ``client.post``-Aufrufe
    werden ueber ``asyncio.gather`` gestartet, nicht nacheinander erwartet.
    Jede Anfrage bekommt ueber ``SessionDep`` eine EIGENE ``AsyncSession``
    (s. ``app``-Fixture: ``get_session`` liefert bei jedem Aufruf eine neue
    Sitzung aus ``session_factory``) — es sind zwei unabhaengige Koroutinen,
    die um denselben Vorrat konkurrieren, kein sequenzieller Anruf, der nur
    wie ein Rennen aussieht. Dasselbe Muster benutzt bereits
    ``test_tamagotchi_state.py::test_concurrent_feeds_are_serialised``.

    **Ehrlich zur Grenze:** die Test-DB ist ein einziges SQLite-``:memory:``
    an einem ``StaticPool`` (eine geteilte Verbindung, s.
    ``test_dropbox_races.py``) — echte parallele Schreibzugriffe auf zwei
    Verbindungen finden hier nicht statt. Was ECHT nebenlaeufig ist: die
    beiden Koroutinen werden vom Event-Loop verzahnt ausgefuehrt, und
    zwischen dem SELECT und dem bedingten DELETE in
    ``_einmalschluessel_holen`` liegt ein ``await`` — genau das Fenster, in
    dem die andere Koroutine dieselbe Zeile sehen und zuerst loeschen kann.
    Das bedingte DELETE (rowcount-Pruefung + Retry-Schleife) ist exakt der
    Code, der dieses Fenster schliesst; ein simples ungeschuetztes
    SELECT-dann-DELETE wuerde hier reproduzierbar denselben Schluessel an
    beide Anfragen ausliefern, weil beide Koroutinen dieselbe Zeile lesen,
    bevor irgendeine sie loescht."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-race",
        einmalschluessel=["otk-a", "otk-b"],
    )

    async def _abholen() -> str | None:
        r = await client.post(
            "/keys/claim",
            json={"user_ids": [str(empf_uid)]},
            headers={"Authorization": f"Bearer {sender_token}"},
        )
        assert r.status_code == 200, r.text
        return r.json()[str(empf_uid)][0]["einmalschluessel"]

    ergebnis_a, ergebnis_b = await asyncio.gather(_abholen(), _abholen())

    assert ergebnis_a is not None
    assert ergebnis_b is not None
    assert ergebnis_a != ergebnis_b
    assert {ergebnis_a, ergebnis_b} == {"otk-a", "otk-b"}


@pytest.mark.asyncio
async def test_leerer_vorrat_liefert_den_rueckfallschluessel(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Sonst koennte niemand mehr an ein laenger ausgeschaltetes Geraet
    schreiben. Der Rueckfallschluessel wird NICHT verbraucht."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory, user_id=empf_uid, rueckfallschluessel="rueckfall-dauerhaft"
    )

    for _ in range(3):
        r = await client.post(
            "/keys/claim",
            json={"user_ids": [str(empf_uid)]},
            headers={"Authorization": f"Bearer {sender_token}"},
        )
        assert r.status_code == 200, r.text
        buendel = r.json()[str(empf_uid)][0]
        assert buendel["einmalschluessel"] is None
        assert buendel["rueckfallschluessel"] == "rueckfall-dauerhaft"


@pytest.mark.asyncio
async def test_nutzer_ohne_geraete_liefert_leer_statt_fehler(
    client, cloud_mode, _auth_signer, friend_pair
):
    """Jemand, der die App nie installiert hat. Das ist der Normalfall der
    Koexistenz-Regel, kein Fehlerfall."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {str(empf_uid): []}


@pytest.mark.asyncio
async def test_nicht_erreichbares_ziel_liefert_leer_statt_403(
    client, session_factory, cloud_mode, _auth_signer
):
    """Wer darf abholen? Dieselbe Regel wie beim DM-Anlegen
    (``routes/dms.py::create_or_get_dm_channel``): ohne Freundschaft (und ohne
    Sperre) darf man nicht mit jemandem schreiben — und deshalb auch keine
    Schluessel fuer ihn abholen. Anders als beim DM-Anlegen gibt es dafuer
    KEINE 403: die Liste bleibt leer, wie beim Nutzer ohne Geraete — sonst
    wuerde ein einzelnes unzulaessiges Ziel in einer Mehrfachanfrage
    (``user_ids``) die anderen, zulaessigen Ziele mit zu Fall bringen."""
    sender_token, sender_uid = _register(_auth_signer)
    _, fremd_uid = _register(_auth_signer)
    # Bewusst KEIN friend_pair — die beiden sind einander fremd.
    await _buendel_seeden(session_factory, user_id=fremd_uid, einmalschluessel=["otk-fremd"])

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(fremd_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {str(fremd_uid): []}


# ---------------------------------------------------------------------------
# Bughunt 2026-08-28 (Missbrauch) — Obergrenze gespeicherter Buendel (FIX 1)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_buendel_obergrenze_evictiert_das_aelteste(
    client, app, session_factory, cloud_mode, access_token
):
    """Ohne Obergrenze haeuft ein Konto, das seinen Geraete-Signierschluessel
    oft wechselt, fuer immer Buendelzeilen an — hier mit einer kuenstlich
    kleinen Grenze von 2 nachgestellt: das DRITTE Geraet darf noch
    veroeffentlichen, aber das ERSTE (am laengsten unangetastete) muss dafuer
    weichen, nicht das zweite."""
    from dcc_chat_gateway import config as chat_config
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select

    settings = chat_config.get_settings()
    settings.schluessel_max_buendel_je_konto = 2

    token, uid = access_token

    pubkeys = []
    for i in range(3):
        pubkey = _make_device()
        pubkeys.append(pubkey)
        r = await client.put(
            "/keys/bundle",
            json={"device_pubkey": pubkey, "curve25519": f"curve-{i}"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 204, r.text

    async with session_factory() as s:
        uebrig = (
            await s.execute(
                select(DeviceKeyBundle.device_pubkey).where(DeviceKeyBundle.user_id == uid)
            )
        ).scalars().all()
    assert set(uebrig) == {pubkeys[1], pubkeys[2]}, uebrig


# ---------------------------------------------------------------------------
# Spec §3a (Entscheidung 2026-08-29) — Verdraengung nach BENUTZUNG, nicht
# nach Veroeffentlichung
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verdraengung_trifft_benutztes_geraet_nicht(
    client, app, session_factory, cloud_mode, access_token
):
    """Beleg fuer den Fehler in Spec §3a: Geraet 0 veroeffentlicht sein
    Buendel einmal und wird danach lange nicht mehr aktiv (kein erneutes
    ``PUT /keys/bundle``), holt aber treu sein Postfach ab — das ist
    Benutzung. Geraet 1 veroeffentlicht sein Buendel und wird danach nie
    wieder gesehen. Bei der Verdraengung (Grenze read auf 2 gesetzt) muss
    Geraet 1 weichen, nicht Geraet 0 — Geraet 0 wurde zuletzt BENUTZT, auch
    wenn sein Buendel laengst nicht mehr das juengste ist.

    Vor Migration 0077 sortierte die Verdraengung nach ``updated_at``
    (Veroeffentlichungszeit) und traf deshalb Geraet 0 statt Geraet 1 — genau
    verkehrt herum."""
    from datetime import UTC, datetime, timedelta

    from dcc_chat_gateway import config as chat_config
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select, update

    settings = chat_config.get_settings()
    settings.schluessel_max_buendel_je_konto = 2

    token, uid = access_token

    pubkey0 = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey0, "curve25519": "curve-0"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    pubkey1 = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey1, "curve25519": "curve-1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    # Geraet 0 hat sein Buendel lange nicht mehr veroeffentlicht (simuliert
    # durch Zuruecksetzen BEIDER Zeitspalten) — holt aber jetzt sein Postfach
    # ab. Die grobe Aufloesung (eine Stunde, s. schluessel_nachweis.py)
    # greift nur, wenn der bisherige Wert schon aelter ist, deshalb weit
    # genug in die Vergangenheit setzen.
    alt = datetime.now(UTC) - timedelta(days=30)
    async with session_factory() as s:
        await s.execute(
            update(DeviceKeyBundle)
            .where(DeviceKeyBundle.device_pubkey == pubkey0)
            .values(updated_at=alt, zuletzt_benutzt=alt)
        )
        await s.commit()

    r = await client.post(
        "/postfach/abholen",
        json={"device_pubkey": pubkey0},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text

    # Ein DRITTES Geraet veroeffentlicht — loest die Verdraengung aus.
    pubkey2 = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey2, "curve25519": "curve-2"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        uebrig = (
            await s.execute(
                select(DeviceKeyBundle.device_pubkey).where(DeviceKeyBundle.user_id == uid)
            )
        ).scalars().all()
    # Geraet 0 (benutzt) und Geraet 2 (gerade veroeffentlicht) bleiben,
    # Geraet 1 (nie wieder gesehen) weicht.
    assert set(uebrig) == {pubkey0, pubkey2}, uebrig


@pytest.mark.asyncio
async def test_zuletzt_benutzt_schreibt_nicht_bei_jedem_nachweis(
    client, app, session_factory, cloud_mode, access_token
):
    """Die grobe Aufloesung (eine Stunde) soll genau das ersparen, wofuer sie
    gebaut wurde: ein Geraet, das kurz hintereinander zweimal nachweist (hier
    ueber ``POST /postfach/abholen``), loest nur beim ERSTEN Mal einen
    Schreibzugriff aus. Frisch veroeffentlicht ist ``zuletzt_benutzt`` schon
    aktuell, also darf schon der erste Abholversuch nichts mehr aendern."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select

    token, uid = access_token

    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async def _stand() -> object:
        async with session_factory() as s:
            return (
                await s.execute(
                    select(DeviceKeyBundle.zuletzt_benutzt).where(
                        DeviceKeyBundle.device_pubkey == pubkey
                    )
                )
            ).scalar_one()

    vor_abholen = await _stand()

    r = await client.post(
        "/postfach/abholen",
        json={"device_pubkey": pubkey},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text

    nach_abholen = await _stand()
    # Innerhalb der Aufloesung (frisch veroeffentlicht, also < 1 Stunde alt)
    # darf sich NICHTS geaendert haben — kein Schreibzugriff.
    assert nach_abholen == vor_abholen


# ---------------------------------------------------------------------------
# Bughunt 2026-08-28 (Missbrauch) — Budget je (Absender, Ziel) (FIX 2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_budget_bremst_das_leerziehen_fremder_vorraete(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Ohne Deckel leeren wenige billige ``POST /keys/claim``-Aufrufe den
    gesamten Einmalschluessel-Vorrat eines Ziels — hier mit einem kuenstlich
    kleinen Budget von 2 nachgestellt: der DRITTE Abholversuch bekommt den
    Rueckfallschluessel, OBWOHL der Vorrat noch einen echten Einmalschluessel
    haette liefern koennen."""
    from dcc_chat_gateway import config as chat_config
    from dcc_chat_gateway.models import DeviceOneTimeKey
    from sqlalchemy import select

    settings = chat_config.get_settings()
    settings.schluessel_claim_budget_je_ziel = 2

    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-budget",
        einmalschluessel=["otk-1", "otk-2", "otk-3"],
    )

    ergebnisse = []
    for _ in range(3):
        r = await client.post(
            "/keys/claim",
            json={"user_ids": [str(empf_uid)]},
            headers={"Authorization": f"Bearer {sender_token}"},
        )
        assert r.status_code == 200, r.text
        ergebnisse.append(r.json()[str(empf_uid)][0])

    assert ergebnisse[0]["einmalschluessel"] is not None
    assert ergebnisse[1]["einmalschluessel"] is not None
    # Budget erschoepft -> Rueckfall, obwohl otk-3 noch im Vorrat liegt.
    assert ergebnisse[2]["einmalschluessel"] is None
    assert ergebnisse[2]["rueckfallschluessel"] == "rueckfall-budget"

    async with session_factory() as s:
        uebrig = (await s.execute(select(DeviceOneTimeKey))).scalars().all()
    # Das Budget hat den dritten Schluessel VERWEIGERT, nicht VERBRAUCHT.
    assert len(uebrig) == 1


@pytest.mark.asyncio
async def test_claim_budget_gilt_nicht_fuer_die_eigenen_geraete(
    client, session_factory, cloud_mode, access_token
):
    """Multi-Geraet-Sync (Abholen der eigenen anderen Buendel) darf vom
    FIX-2-Budget nicht gebremst werden — das ist kein Angriff auf ein
    fremdes Konto."""
    from dcc_chat_gateway import config as chat_config

    settings = chat_config.get_settings()
    settings.schluessel_claim_budget_je_ziel = 1

    token, uid = access_token
    await _buendel_seeden(
        session_factory,
        user_id=uid,
        device_pubkey="mein-zweitgeraet",
        einmalschluessel=["otk-eigen-1", "otk-eigen-2", "otk-eigen-3"],
    )

    for erwartet in ("otk-eigen-1", "otk-eigen-2", "otk-eigen-3"):
        r = await client.post(
            "/keys/claim",
            json={"user_ids": [str(uid)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        assert r.json()[str(uid)][0]["einmalschluessel"] == erwartet


# ---------------------------------------------------------------------------
# Schloss-Kennzeichen — GET /keys/verschluesselbar/{ziel_id}
#
# Der Kern des Vorhabens: die Auskunft, ob ein Gespraech verschluesselt laufen
# kann, darf den Vorrat der Gegenseite NICHT anfassen. Ueber ``POST
# /keys/claim`` (die einzige Auskunft, die es vorher gab) wuerde das blosse
# Oeffnen eines Gespraechs je Geraet einen Einmalschluessel kosten.
# ---------------------------------------------------------------------------


async def _vorrat_zaehlen(session_factory, bundle_id: int) -> int:
    from dcc_chat_gateway.models import DeviceOneTimeKey
    from sqlalchemy import func, select

    async with session_factory() as s:
        return (
            await s.execute(
                select(func.count())
                .select_from(DeviceOneTimeKey)
                .where(DeviceOneTimeKey.bundle_id == bundle_id)
            )
        ).scalar_one()


@pytest.mark.asyncio
async def test_auskunft_verbraucht_keinen_einmalschluessel(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """DIE Gegenprobe des Vorhabens: dreimal fragen laesst den Vorrat
    unangetastet. Ueber ``POST /keys/claim`` waeren nach denselben drei
    Aufrufen alle drei Schluessel weg (das haelt
    ``test_abholen_verbraucht_den_einmalschluessel`` fest) — und genau deshalb
    gab es bis heute kein Schloss im Kopf des Gespraechs."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    bid = await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        einmalschluessel=["otk-1", "otk-2", "otk-3"],
        dauerhaft=True,
    )
    assert await _vorrat_zaehlen(session_factory, bid) == 3

    for _ in range(3):
        r = await client.get(
            f"/keys/verschluesselbar/{empf_uid}",
            headers={"Authorization": f"Bearer {sender_token}"},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"verschluesselbar": True}

    assert await _vorrat_zaehlen(session_factory, bid) == 3


@pytest.mark.asyncio
async def test_auskunft_bleibt_einem_fremden_verschlossen(
    client, session_factory, cloud_mode, _auth_signer
):
    """Wer nicht abholen darf, bekommt auch keine Auskunft — dieselbe
    ``darf_schluessel_holen``-Regel wie beim Abholen (``schluessel_zugriff.py``).

    Das Ziel hat hier sehr wohl ein dauerhaftes Geraet: ohne die Pruefung
    stuende hier ``True``, und ein Fremder koennte fuer ein beliebiges Konto
    ablesen, ob die Person die App installiert hat."""
    sender_token, sender_uid = _register(_auth_signer)
    _, fremd_uid = _register(_auth_signer)
    # Bewusst KEIN friend_pair — die beiden sind einander fremd.
    await _buendel_seeden(session_factory, user_id=fremd_uid, dauerhaft=True)

    r = await client.get(
        f"/keys/verschluesselbar/{fremd_uid}",
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"verschluesselbar": False}


@pytest.mark.asyncio
async def test_konto_ohne_dauerhaftes_geraet_ist_nicht_verschluesselbar(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Die Koexistenz-Regel (Spec §3) und nicht blosses "irgendein Buendel
    existiert": ein Konto, das nur aus einem Browser-Tab heraus veroeffentlicht
    hat, kann nichts verlaesslich behalten. Wuerde das Schloss hier erscheinen,
    verspraeche es etwas, das der Sendeweg gleich darauf verweigert
    (``empfaengerGeraete.ts::zielgeraeteBerechnen`` liefert dann eine leere
    Liste und faellt auf Klartext zurueck)."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory, user_id=empf_uid, einmalschluessel=["otk-1"], dauerhaft=False
    )

    r = await client.get(
        f"/keys/verschluesselbar/{empf_uid}",
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"verschluesselbar": False}


# ---------------------------------------------------------------------------
# Spec §3a, Punkt 2 — gekoppelte Browser verfallen nach 14 Tagen
# ---------------------------------------------------------------------------


def _lange_her(tage: int):
    from datetime import UTC, datetime, timedelta

    return datetime.now(UTC) - timedelta(days=tage)


@pytest.mark.asyncio
async def test_verfallener_browser_kommt_nicht_mehr_aus_claim(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Der Kern der Regel: ein Browser, den 15 Tage niemand geoeffnet hat, ist
    kein Empfaenger mehr. Kaeme sein Buendel weiter aus ``claim``, gingen
    Nachrichten an ein Geraet, das sie nie abholt — verschluesselt, ohne
    Empfaenger, unwiederbringlich."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-alt",
        gekoppelt_am=_lange_her(40),
        zuletzt_benutzt=_lange_her(15),
    )

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()[str(empf_uid)] == []


@pytest.mark.asyncio
async def test_unbenutzte_app_bleibt_erreichbar(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Die Gegenprobe zur Regel, und der Grund, warum sie an ``dauerhaft``
    haengt: ein Telefon, das 40 Tage in der Schublade lag, behaelt seine
    Gespraeche. Ein Verfall, der auch Apps traefe, waere kein Ablauf einer
    Kopplung mehr, sondern ein Datenverlust nach Urlaub."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-app",
        dauerhaft=True,
        zuletzt_benutzt=_lange_her(40),
    )

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    buendel = r.json()[str(empf_uid)]
    assert len(buendel) == 1
    assert buendel[0]["rueckfallschluessel"] == "rueckfall-app"


@pytest.mark.asyncio
async def test_verfall_ueberlebt_den_naechsten_nachweis(
    client, app, session_factory, cloud_mode, access_token, _auth_signer, friend_pair
):
    """Der Grabstein klebt — sonst hoebe der zurueckkehrende Browser den
    Verfall selbst auf, bevor irgendjemand ihn mitteilen konnte.

    Ablauf: ein 15 Tage unbenutztes Geraet meldet sich wieder (``PUT
    /keys/bundle`` weist es nach, das frischt ``zuletzt_benutzt`` auf). Die
    reine Zeitrechnung saehe danach ein gesundes Geraet. Es muss trotzdem
    verfallen bleiben."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select, update

    token, uid = access_token
    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-verfall"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        await s.execute(
            update(DeviceKeyBundle)
            .where(DeviceKeyBundle.device_pubkey == pubkey)
            .values(zuletzt_benutzt=_lange_her(15), gekoppelt_am=_lange_her(40))
        )
        await s.commit()

    # Das Geraet meldet sich wieder — derselbe Weg wie beim Start des Klienten.
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-verfall"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        zeile = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == pubkey)
            )
        ).scalar_one()
        assert zeile.verfallen_am is not None, "der Nachweis haette stempeln muessen"

    # Und die Auskunft sagt es dem Geraet ausdruecklich.
    r = await client.get(
        "/keys/geraetestand",
        params={"device_pubkey": pubkey},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"stand": "verfallen"}


@pytest.mark.asyncio
async def test_geraetestand_trennt_unbekannt_von_verfallen(
    client, app, cloud_mode, access_token
):
    """Die drei Werte muessen unterscheidbar bleiben: nur ``verfallen`` darf
    einen Verlauf loeschen. Ein frisches Geraet ist ``gueltig``, ein
    unbekannter Pubkey ``unbekannt`` — beides loest nichts aus."""
    token, uid = access_token
    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-frisch"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    r = await client.get(
        "/keys/geraetestand",
        params={"device_pubkey": pubkey},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.json() == {"stand": "gueltig"}

    r = await client.get(
        "/keys/geraetestand",
        params={"device_pubkey": "pub-gibt-es-nicht"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.json() == {"stand": "unbekannt"}


@pytest.mark.asyncio
async def test_gekoppelter_browser_zaehlt_als_geraet(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Spec §3a: ein gekoppelter Browser ist ein vollwertiges Geraet. Ohne
    diese Zeile bliebe der Verfall eine leere Geste — man kann nichts
    ablaufen lassen, was nie gezaehlt hat."""
    frager_token, frager_uid = _register(_auth_signer)
    _, ziel_uid = _register(_auth_signer)
    await friend_pair(frager_uid, ziel_uid)
    await _buendel_seeden(
        session_factory,
        user_id=ziel_uid,
        device_pubkey="pub-gekoppelt",
        gekoppelt_am=_lange_her(1),
    )

    r = await client.get(
        f"/keys/verschluesselbar/{ziel_uid}",
        headers={"Authorization": f"Bearer {frager_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"verschluesselbar": True}


@pytest.mark.asyncio
async def test_verfallener_browser_zaehlt_nicht_mehr(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Und nach dem Verfall zaehlt er nicht mehr — sonst behauptete die
    Auskunft eine Erreichbarkeit, die ``claim`` gleich darauf verweigert."""
    frager_token, frager_uid = _register(_auth_signer)
    _, ziel_uid = _register(_auth_signer)
    await friend_pair(frager_uid, ziel_uid)
    await _buendel_seeden(
        session_factory,
        user_id=ziel_uid,
        device_pubkey="pub-gekoppelt-alt",
        gekoppelt_am=_lange_her(40),
        zuletzt_benutzt=_lange_her(15),
    )

    r = await client.get(
        f"/keys/verschluesselbar/{ziel_uid}",
        headers={"Authorization": f"Bearer {frager_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"verschluesselbar": False}


@pytest.mark.asyncio
async def test_sweep_stempelt_und_raeumt_die_einmalschluessel(
    session_factory, cloud_mode, _auth_signer
):
    """Der Aufraeumlauf: stempeln UND die Einmalschluessel loeschen. Die
    Buendelzeile bleibt als Grabstein stehen — ohne sie waere der Verfall dem
    Geraet nicht mehr mitteilbar (``schluessel_verfall.py``)."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.schluessel_verfall import sweep_verfallene_geraete
    from sqlalchemy import select

    _, uid = _register(_auth_signer)
    bid_alt = await _buendel_seeden(
        session_factory,
        user_id=uid,
        device_pubkey="pub-sweep-alt",
        einmalschluessel=["otk-a", "otk-b"],
        zuletzt_benutzt=_lange_her(20),
    )
    bid_frisch = await _buendel_seeden(
        session_factory,
        user_id=uid,
        device_pubkey="pub-sweep-frisch",
        einmalschluessel=["otk-c"],
    )

    async with session_factory() as s:
        anzahl = await sweep_verfallene_geraete(s)
    assert anzahl == 1

    async with session_factory() as s:
        zeilen = {
            z.device_pubkey: z
            for z in (
                await s.execute(
                    select(DeviceKeyBundle).where(DeviceKeyBundle.user_id == uid)
                )
            ).scalars().all()
        }
    assert zeilen["pub-sweep-alt"].verfallen_am is not None
    assert zeilen["pub-sweep-frisch"].verfallen_am is None
    assert await _vorrat_zaehlen(session_factory, bid_alt) == 0
    assert await _vorrat_zaehlen(session_factory, bid_frisch) == 1


# ---------------------------------------------------------------------------
# POST /keys/geraeteliste — verbrauchsfreie Geraeteliste (Fixwelle 2 R5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_geraeteliste_verbraucht_keinen_einmalschluessel(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """R5: der Klient rief bisher ``claim`` fuer ALLE Mitglieder, bevor
    ueberhaupt feststand, ob etwas nachzuliefern ist — jeder Kanalwechsel
    kostete das Gegenueber je Geraet einen Einmalschluessel. Diese Route
    liefert dieselbe Auskunft, ohne den Vorrat anzuruehren."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    bid = await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        device_pubkey="pub-liste-1",
        einmalschluessel=["otk-1", "otk-2"],
        dauerhaft=True,
    )

    r = await client.post(
        "/keys/geraeteliste",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )

    assert r.status_code == 200, r.text
    assert r.json() == {str(empf_uid): ["pub-liste-1"]}
    assert await _vorrat_zaehlen(session_factory, bid) == 2


@pytest.mark.asyncio
async def test_geraeteliste_ohne_berechtigung_ist_leer_statt_403(
    client, session_factory, cloud_mode, _auth_signer
):
    """Dieselbe Regel wie bei ``claim``: ein einzelner unzulaessiger Eintrag
    darf die zulaessigen einer Mehrfachanfrage nicht mitreissen."""
    sender_token, _sender_uid = _register(_auth_signer)
    _, fremd_uid = _register(_auth_signer)
    await _buendel_seeden(
        session_factory, user_id=fremd_uid, device_pubkey="pub-fremd", dauerhaft=True
    )

    r = await client.post(
        "/keys/geraeteliste",
        json={"user_ids": [str(fremd_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )

    assert r.status_code == 200, r.text
    assert r.json() == {str(fremd_uid): []}
