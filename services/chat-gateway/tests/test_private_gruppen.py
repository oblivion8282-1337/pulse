"""Private Gruppenkanaele (Etappe G1).

Task 1 deckt die Modelle (Eindeutigkeit + CASCADE), Task 2 die Routen und die
Mitgliederverwaltung. Task 3 (Nachrichten in einer Gruppe) ist bewusst NICHT
hier — s. Umsetzungsplan.
"""

from __future__ import annotations

import asyncio
import random

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError

# ---------------------------------------------------------------------------
# Task 1 — Modelle und Migration
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung — derselbe Weg wie ``test_schluessel.py``/``test_postfach.py``.
    Die Test-Engine nutzt ``StaticPool`` (eine geteilte In-Memory-Verbindung),
    deshalb genuegt ein einmaliges PRAGMA auf dieser einen Verbindung."""
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_dieselbe_person_ist_nur_einmal_mitglied(session_factory):
    """Sonst zaehlt die Gruppe falsch, und beim Verteilen des
    Gruppenschluessels (G2) bekaeme dasselbe Konto zwei Umschlaege."""
    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
    from dcc_chat_gateway.snowflake import next_id

    gid = next_id()
    async with session_factory() as s:
        s.add(PrivateGroupChannel(id=gid, ersteller_id=1, name="Testgruppe"))
        s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=2))
        await s.commit()

    with pytest.raises(IntegrityError):
        async with session_factory() as s:
            s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=2))
            await s.commit()


@pytest.mark.asyncio
async def test_mitglieder_verschwinden_mit_der_gruppe(session_factory):
    """Aufgeloeste Gruppe, verwaiste Mitgliedszeilen — dieselbe CASCADE-
    Pruefung wie beim Schluesselverzeichnis."""
    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import delete, select

    gid = next_id()
    async with session_factory() as s:
        s.add(PrivateGroupChannel(id=gid, ersteller_id=3, name="Gruppe"))
        s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=3))
        s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=4))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(PrivateGroupChannel).where(PrivateGroupChannel.id == gid))
        await s.commit()

    async with session_factory() as s:
        uebrig = (
            await s.execute(select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gid))
        ).scalars().all()
    assert uebrig == []


# ---------------------------------------------------------------------------
# Task 2 — Routen und Mitgliedschaft
# ---------------------------------------------------------------------------
#
# Der Router ist Cloud-only (``routes/private_gruppen.py``-Docstring: eine
# private Gruppe prueft dieselbe globale Block-Liste wie eine DM). Jeder
# Route-Test braucht deshalb ``cloud_mode``. Der Schalter selbst
# (``private_groups_enabled``) ist DAVON getrennt und steht per Vorgabe aus —
# nur wer ``gruppen_an`` anfordert, bekommt ihn fuer die Dauer eines Tests an.


pytestmark = pytest.mark.usefixtures("cloud_mode")


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    """Schaltet ``private_groups_enabled`` fuer die Dauer eines Tests ein.

    Vorgabe ist AUS (s. config.py) — jeder Test, der eine Gruppe tatsaechlich
    anlegen will, muss das ausdruecklich anfordern. Das ist Absicht: der
    Standardzustand jedes Tests, der diese Fixture NICHT anfordert, ist der
    Produktivzustand (abgeschaltet)."""
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


async def _install_block(session_factory, blocker_id: int, blocked_id: int) -> None:
    from dcc_chat_gateway.models import UserBlock

    async with session_factory() as s:
        s.add(UserBlock(blocker_id=blocker_id, blocked_id=blocked_id))
        await s.commit()


@pytest.mark.asyncio
async def test_abgeschaltet_gibt_es_keine_gruppen(client, _auth_signer):
    """Der wichtigste Test dieser Etappe. Die Vorgabe ist AUS, und solange
    sie aus ist, darf keine Gruppe entstehen — sonst gaebe es
    unverschluesselten Altbestand, und die Spec verliert ihren groessten
    Vorteil (Gruppen sind von Geburt an verschluesselt, weil es sie vorher
    nicht gab)."""
    token, _ = await _register(_auth_signer)
    r = await client.post("/gruppen", json={"name": "Testgruppe"}, headers=_auth(token))
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "private_groups_disabled"


@pytest.mark.asyncio
async def test_nur_der_ersteller_fuegt_hinzu_und_entfernt(
    client, _auth_signer, gruppen_an
):
    """Keine Rollen, keine Overwrites — das ist der Unterschied zu einer
    Community. Aber auch keine Selbstbedienung."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    t_c, uid_c = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]

    # A darf B hinzufuegen.
    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text

    # B (Mitglied, nicht Ersteller) darf NICHT C hinzufuegen.
    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_c)}, headers=_auth(t_b)
    )
    assert r.status_code == 403, r.text

    # B darf auch nicht entfernen.
    r = await client.delete(f"/gruppen/{gid}/mitglieder/{uid_a}", headers=_auth(t_b))
    assert r.status_code == 403, r.text

    # A (Ersteller) darf entfernen.
    r = await client.delete(f"/gruppen/{gid}/mitglieder/{uid_b}", headers=_auth(t_a))
    assert r.status_code == 200, r.text
    assert [m["user_id"] for m in r.json()["members"]] == [str(uid_a)]


@pytest.mark.asyncio
async def test_jedes_mitglied_darf_selbst_gehen(client, _auth_signer, gruppen_an):
    """Auch der Ersteller."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]
    await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_b))
    assert r.status_code == 200, r.text
    assert [m["user_id"] for m in r.json()["members"]] == [str(uid_a)]

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_a))
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_nichtmitglied_sieht_die_gruppe_nicht(client, _auth_signer, gruppen_an):
    """Weder in der Liste noch einzeln. Zwei Wege, zwei Pruefungen."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, _ = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "geheim"}, headers=_auth(t_a))
    gid = r.json()["id"]

    r = await client.get(f"/gruppen/{gid}", headers=_auth(t_b))
    assert r.status_code == 404, r.text

    r = await client.get("/gruppen", headers=_auth(t_b))
    assert r.status_code == 200, r.text
    assert r.json() == []


@pytest.mark.asyncio
async def test_geblockte_person_kann_nicht_hinzugefuegt_werden(
    client, session_factory, _auth_signer, gruppen_an
):
    """Sonst waere die Gruppe ein Weg, eine Blockierung zu umgehen."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await _install_block(session_factory, uid_b, uid_a)  # B blockiert A.

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]

    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "blocked"


@pytest.mark.asyncio
async def test_obergrenze_der_mitgliederzahl(
    client, session_factory, _auth_signer, gruppen_an
):
    """In G2 wird der Gruppenschluessel an JEDES Geraet JEDES Mitglieds
    verteilt. Ohne Obergrenze ist eine Mitgliedschaftsaenderung in einer
    grossen Gruppe ein Schwall."""
    t_a, uid_a = await _register(_auth_signer)
    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]

    from dcc_chat_gateway import config as chat_config

    settings = chat_config.get_settings()
    settings.private_group_max_members = 2

    t_b, uid_b = await _register(_auth_signer)
    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text  # Ersteller + B = 2, passt noch.

    t_c, uid_c = await _register(_auth_signer)
    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_c)}, headers=_auth(t_a)
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "member_limit_reached"


@pytest.mark.asyncio
async def test_ersteller_geht_dienstaeltestes_mitglied_erbt(
    client, _auth_signer, gruppen_an
):
    """Festlegung 1: die Gruppe bleibt, das dienstaelteste verbleibende
    Mitglied erbt — eine Gruppe, die mit ihrem Gruender verschwindet, nimmt
    allen anderen ihren Verlauf mit (der ab Etappe C nur noch auf Geraeten
    liegt, ohne Server-Backup)."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    t_c, uid_c = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]
    # B tritt vor C bei — B ist dienstaelter.
    await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_c)}, headers=_auth(t_a)
    )

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_a))
    assert r.status_code == 200, r.text
    assert r.json()["ersteller_id"] == str(uid_b)

    # Der Erbe darf jetzt hinzufuegen/entfernen — die Rolle ist echt uebergegangen.
    r = await client.delete(f"/gruppen/{gid}/mitglieder/{uid_c}", headers=_auth(t_b))
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_letztes_mitglied_loescht_die_gruppe(client, _auth_signer, gruppen_an):
    """Festlegung 2: eine Gruppe mit null Mitgliedern ist nichts."""
    t_a, uid_a = await _register(_auth_signer)
    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_a))
    assert r.status_code == 200, r.text
    assert r.json() is None

    r = await client.get(f"/gruppen/{gid}", headers=_auth(t_a))
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Bughunt Etappe G1 (2026-08-28) — FIX 1 + FIX 2 (Route-Haelfte)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_abgeschaltet_blockiert_auch_die_anderen_fuenf_routen(
    client, _auth_signer, gruppen_an
):
    """FIX 1: der Schalter galt bisher nur fuer ``POST /gruppen`` — Liste,
    Einzelabruf, Hinzufuegen, Entfernen und Verlassen liefen bei
    ausgeschaltetem Schalter ungehindert weiter. Die Gruppe entsteht hier
    WAEHREND der Schalter an ist, wird danach ausgeschaltet — jede der fuenf
    anderen Routen muss jetzt 403 liefern, nicht nur die Erstellung."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]
    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text

    gruppen_an.private_groups_enabled = False

    r = await client.get("/gruppen", headers=_auth(t_a))
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "private_groups_disabled"

    r = await client.get(f"/gruppen/{gid}", headers=_auth(t_a))
    assert r.status_code == 403, r.text

    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 403, r.text

    r = await client.delete(f"/gruppen/{gid}/mitglieder/{uid_b}", headers=_auth(t_a))
    assert r.status_code == 403, r.text

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_a))
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_gleichzeitiges_verlassen_verwaist_die_gruppe_nicht(
    client, _auth_signer, gruppen_an, session_factory
):
    """FIX 2 (Route): zwei Mitglieder einer Zweiergruppe gehen ECHT
    gleichzeitig (``asyncio.gather``, zwei ``client.post``-Aufrufe — jeder
    bekommt ueber ``SessionDep`` eine EIGENE ``AsyncSession``, s.
    ``test_schluessel.py::test_zwei_gleichzeitige_abholungen_bekommen_
    verschiedene`` fuer die Begruendung, warum das auf der gemeinsamen
    SQLite-Verbindung trotzdem echte Nebenlaeufigkeit ist: die Koroutinen
    werden vom Event-Loop verzahnt ausgefuehrt, und zwischen den vielen
    Commits in ``_entferne_mitglied`` liegen genug Await-Punkte fuer echtes
    Verzahnen — beim Entwickeln dieses Fixes loeste genau diese Verzahnung
    tatsaechlich einen ``session.refresh``-Fehlschlag aus, der erst den
    Wechsel auf ``session.get(..., populate_existing=True)`` erzwang).

    **Ehrlich zur Grenze der Gegenprobe:** gegen den ALTEN Code (ein
    einziger Commit ganz am Ende von ``_entferne_mitglied``) faellt dieser
    Test auf dieser Test-Infrastruktur NICHT zuverlaessig rot. Die
    Test-Engine ist ein einziges SQLite-``:memory:`` an einem
    ``StaticPool`` — eine geteilte, physische Verbindung ohne echte
    Transaktionsisolation zwischen den beiden „gleichzeitigen" Sitzungen:
    jede Sitzung sieht die Schreibzugriffe der anderen sofort, auch vor
    deren Commit. Der alte Code haelt seine gesamte Rechnung in EINER
    Transaktion, die dadurch faktisch als Ganzes serialisiert wird (die
    zweite Anfrage sieht beim eigenen Lesen laengst den fertigen Stand der
    ersten) — genau das Fenster, das den Bug unter echtem READ COMMITTED
    (Produktion: Postgres, getrennte Verbindungen) ausloest, entsteht auf
    dieser einen Verbindung nicht zuverlaessig. Wiederholtes Ausfuehren
    gegen den alten Code zeigt das: der Test besteht durchgaengig, aber
    SQLAlchemy warnt dabei sichtbar („DELETE statement on table
    'private_group_channels' expected to delete 1 row(s); 0 were
    matched") — der Beleg, dass BEIDE Anfragen den Loeschversuch machten
    (Zufalls-Selbstheilung dieser Verbindung), nicht dass die Bedingung
    selbst atomar war. Dieser Test bleibt trotzdem sinnvoll: er ist eine
    echte Nebenlaeufigkeits-Regression fuer den NEUEN Code (s. o., der
    ``populate_existing``-Fund), und die Atomaritaet des Fixes folgt direkt
    aus der SQL-Semantik von ``NOT EXISTS``/``EXISTS`` im selben Statement
    wie die Aenderung — unabhaengig von dieser Testinfrastruktur."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]
    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text

    ergebnis_a, ergebnis_b = await asyncio.gather(
        client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_a)),
        client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_b)),
    )
    assert ergebnis_a.status_code == 200, ergebnis_a.text
    assert ergebnis_b.status_code == 200, ergebnis_b.text

    from sqlalchemy import select

    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember

    async with session_factory() as s:
        gruppe = await s.get(PrivateGroupChannel, int(gid))
        mitglieder = (
            (
                await s.execute(
                    select(PrivateGroupMember).where(
                        PrivateGroupMember.gruppe_id == int(gid)
                    )
                )
            )
            .scalars()
            .all()
        )

    # Keine verwaiste Gruppe: entweder ist die Zeile ganz weg, oder sie hat
    # noch mindestens ein Mitglied. "existiert, aber niemand mehr drin" ist
    # genau der Fehlerzustand, den dieser Fix schliesst.
    assert gruppe is None or len(mitglieder) > 0, (
        f"Gruppe {gid} existiert mit {len(mitglieder)} Mitgliedern — verwaist"
    )


@pytest.mark.asyncio
async def test_gleichzeitiges_hinzufuegen_derselben_person_gibt_409(
    client, session_factory, _auth_signer, gruppen_an, monkeypatch
):
    """FIX 3: **wie das Rennen hergestellt wird** — derselbe Trick wie
    ``test_dropbox_races.py::test_kollision_nach_bestandener_vorpruefung_
    gibt_409``. In das Fenster zwischen der ``bereits``-Vorpruefung und dem
    Commit legt der Test die konkurrierende Mitgliedszeile hinein (ueber
    eine eigene Sitzung, aus ``block_exists_either_way`` heraus — der
    einzige Await zwischen Vorpruefung und INSERT). Die Anfrage hat ihre
    Pruefung dann nachweislich bestanden und laeuft trotzdem in
    ``uq_private_group_members_mitglied``. Gegen den alten Code (kein
    ``except IntegrityError`` um den Commit) ist das ein unbehandelter
    500er."""
    import dcc_chat_gateway.routes.private_gruppen as pg_mod
    from dcc_chat_gateway.models import PrivateGroupMember
    from dcc_chat_gateway.snowflake import next_id

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = int(r.json()["id"])

    echt = pg_mod.block_exists_either_way
    gelegt = False

    async def dazwischen(session, a, b):
        nonlocal gelegt
        if not gelegt:
            gelegt = True
            async with session_factory() as s:
                s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=uid_b))
                await s.commit()
        return await echt(session, a, b)

    monkeypatch.setattr(pg_mod, "block_exists_either_way", dazwischen)

    r = await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "already_a_member"


@pytest.mark.asyncio
async def test_gruppenname_wird_gegen_pfad_traversal_gehaertet(
    client, _auth_signer, gruppen_an
):
    """FIX 4: der Gruppenname ist ein Display-string-sink genau wie ein
    Kanalname (dieselbe UI zeigt ihn identisch an) und muss deshalb durch
    ``validate_name`` (``routes/_dropbox_helpers.py``) — derselbe Fall wie
    ``test_dropbox_races.py::test_ordner_mit_vollbreiten_punkten_wird_
    abgelehnt``. Vor dem Fix lief ein solcher Name unveraendert durch."""
    token, _ = await _register(_auth_signer)
    r = await client.post("/gruppen", json={"name": "../evil"}, headers=_auth(token))
    assert r.status_code == 422, r.text


# ---------------------------------------------------------------------------
# Konto-Loeschung (user_purge.py)
# ---------------------------------------------------------------------------

_PURGE_SECRET = "test-internal-secret-private-gruppen"


@pytest_asyncio.fixture
async def _internal_secret_set(_isolate_chat_settings):
    settings = _isolate_chat_settings
    original = settings.internal_service_secret
    settings.internal_service_secret = _PURGE_SECRET
    yield _PURGE_SECRET
    settings.internal_service_secret = original


@pytest.mark.asyncio
async def test_purge_raeumt_gruppenmitgliedschaften_und_vererbt_ersteller(
    client, session_factory, _auth_signer, gruppen_an, _internal_secret_set
):
    """Genau die Stelle, die bei Migration 0063 fuer die Einladungs-Inbox
    uebersehen wurde (die Zeilen blieben nach dem Loeschen stehen) — hier
    gibt es dafuer einen Test: Mitgliedschaften raeumen UND, wenn der
    Geloeschte Ersteller war, die Erb-Regel anwenden."""
    from dcc_chat_gateway.models import PrivateGroupMember

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = r.json()["id"]
    await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )

    r = await client.post(
        f"/internal/users/{uid_a}/purge",
        headers={"X-Pulse-Internal-Secret": _PURGE_SECRET},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        from sqlalchemy import select

        uebrig = (
            await s.execute(select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gid))
        ).scalars().all()
    assert [m.user_id for m in uebrig] == [uid_b]

    r = await client.get(f"/gruppen/{gid}", headers=_auth(t_b))
    assert r.status_code == 200, r.text
    assert r.json()["ersteller_id"] == str(uid_b)


@pytest.mark.asyncio
async def test_purge_loescht_gruppe_ohne_verbleibendes_mitglied(
    client, session_factory, _auth_signer, gruppen_an, _internal_secret_set
):
    """Derselbe Purge-Pfad, aber die Gruppe hatte nur den Geloeschten — die
    Zeile darf nicht als Geisterkanal stehen bleiben."""
    from dcc_chat_gateway.models import PrivateGroupChannel

    t_a, uid_a = await _register(_auth_signer)
    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = int(r.json()["id"])

    r = await client.post(
        f"/internal/users/{uid_a}/purge",
        headers={"X-Pulse-Internal-Secret": _PURGE_SECRET},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        rest = await s.get(PrivateGroupChannel, gid)
    assert rest is None


@pytest.mark.asyncio
async def test_gleichzeitiger_purge_und_austritt_verwaisen_den_ersteller_nicht(
    client, session_factory, _auth_signer, gruppen_an, _internal_secret_set
):
    """FIX 2 (Purge-Haelfte, ``user_purge_gruppen.py``): die Konto-Loeschung
    des Erstellers und der Austritt eines ANDEREN Mitglieds laufen ECHT
    gleichzeitig (``asyncio.gather``, zwei unabhaengige Anfragen mit je
    eigener Sitzung — dieselbe Begruendung wie bei der Routen-Gegenprobe
    ``test_gleichzeitiges_verlassen_verwaist_die_gruppe_nicht`` oben).

    Der alte Purge-Code berechnete Loeschen/Erben aus einem in Python
    gehaltenen Schnappschuss der verbleibenden Mitglieder. Lief die
    gleichzeitige Austritts-Anfrage dazwischen durch, konnte der
    Schnappschuss veraltet sein: der Purge waehlte als „Erbin" jemanden, der
    im selben Moment schon gegangen war — ``ersteller_id`` zeigte danach auf
    ein Konto, das gar nicht mehr Mitglied ist. Genau das Versprechen des
    Purge-Moduls (keine haengenden Zeilen) waere gebrochen.

    **Ehrlich zur Grenze** (dieselbe wie bei der Routen-Gegenprobe oben):
    das genaue Interleaving, das den alten Bug ausloest, laesst sich auf der
    einzigen SQLite-Testverbindung nicht erzwingen, nur beobachten. Die
    Zusicherung unten ist deshalb bewusst eine Invariante, die in JEDER
    moeglichen Ausfuehrungsreihenfolge gelten muss — nicht nur in der einen,
    die den alten Bug ausloeste: existiert die Gruppe noch, muss
    ``ersteller_id`` auf ein wirklich verbleibendes Mitglied zeigen."""
    from sqlalchemy import select

    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    t_c, uid_c = await _register(_auth_signer)

    r = await client.post("/gruppen", json={"name": "g"}, headers=_auth(t_a))
    gid = int(r.json()["id"])
    await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    await client.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_c)}, headers=_auth(t_a)
    )

    purge_ergebnis, verlassen_ergebnis = await asyncio.gather(
        client.post(
            f"/internal/users/{uid_a}/purge",
            headers={"X-Pulse-Internal-Secret": _PURGE_SECRET},
        ),
        client.post(f"/gruppen/{gid}/verlassen", headers=_auth(t_b)),
    )
    assert purge_ergebnis.status_code == 204, purge_ergebnis.text
    # B ist die ganze Zeit Mitglied (der Purge betrifft nur A) — der eigene
    # Austritt gelingt unabhaengig von der Verzahnung.
    assert verlassen_ergebnis.status_code == 200, verlassen_ergebnis.text

    async with session_factory() as s:
        gruppe = await s.get(PrivateGroupChannel, gid)
        # Mindestens C ist immer noch da — die Gruppe muss ueberleben.
        assert gruppe is not None
        mitglieder_ids = {
            m.user_id
            for m in (
                await s.execute(
                    select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gid)
                )
            )
            .scalars()
            .all()
        }
    assert gruppe.ersteller_id in mitglieder_ids, (
        f"ersteller_id={gruppe.ersteller_id} ist kein Mitglied mehr ({mitglieder_ids})"
    )
