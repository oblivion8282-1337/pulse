"""Private Gruppenkanaele (Etappe G1).

Task 1 deckt die Modelle (Eindeutigkeit + CASCADE), Task 2 die Routen und die
Mitgliederverwaltung. Task 3 (Nachrichten in einer Gruppe) ist bewusst NICHT
hier — s. Umsetzungsplan.
"""

from __future__ import annotations

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
# Bughunt Etappe G1 (2026-08-28) — FIX 1
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
