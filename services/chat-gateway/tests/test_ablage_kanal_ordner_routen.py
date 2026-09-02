"""Die drei Routen des Ordner-Kanals: Anlegen + Lesen (Entwurf 2026-09-02,
§2-3, Task 5).

``_kanal_fuer_mitglied``/``_ablage_kanal_oder_404`` kommen aus
``ablage_kanal.py`` (importiert, nicht kopiert) — Rechte-Reihenfolge und
Fehlercodes sind dort schon geprueft; hier geht es um das, was NUR diese
drei Routen tun: Ordner-Zeile anlegen, Dateiliste filtern/sortieren/
schneiden, einzelne Datei durchreichen.

Guild/Kanal-Aufbau wie in ``test_ablage_kanal_zugriff.py::_guild_mit_kanal``
— direkt ueber die Modelle, nicht ueber Routen (die Guild-Erstellroute
kennt kein ``ablage``-Feld).
"""

from __future__ import annotations

import random
from datetime import datetime, timezone

import pytest
from dcc_chat_gateway import ratelimit as ratelimit_mod
from dcc_chat_gateway.models import (
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    Channel,
    Guild,
    GuildMember,
    Role,
)
from dcc_chat_gateway.permissions import Permissions
from dcc_chat_gateway.routes import ablage_kanal_ordner as routen_mod
from dcc_chat_gateway.snowflake import next_id

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _guild_mit_kanal(
    session_factory,
    *,
    owner_id: int,
    mitglieder: tuple[int, ...],
    ablage: bool,
    everyone_view: bool = True,
) -> tuple[int, int]:
    gid = next_id()
    everyone_id = next_id()
    channel_id = next_id()
    everyone_perms = int(Permissions.VIEW_CHANNEL) if everyone_view else 0
    async with session_factory() as s:
        s.add(Guild(id=gid, name="g", owner_id=owner_id))
        await s.flush()
        s.add(
            Role(
                id=everyone_id,
                guild_id=gid,
                name="@everyone",
                permissions=everyone_perms,
                position=0,
                is_everyone=True,
            )
        )
        s.add(Channel(id=channel_id, guild_id=gid, name="k", type=0, ablage=ablage))
        for uid in mitglieder:
            s.add(GuildMember(guild_id=gid, user_id=uid, joined_at=datetime.now(timezone.utc)))
        await s.commit()
    return gid, channel_id


async def _ordner_eintragen(session_factory, *, channel_id: int, ersteller_id: int) -> None:
    async with session_factory() as s:
        s.add(AblageKanalOrdner(channel_id=channel_id, ersteller_id=ersteller_id))
        await s.commit()


async def _laufwerk_eintragen(session_factory, *, user_id: int, adresse: str) -> None:
    async with session_factory() as s:
        s.add(AblageKontoLaufwerk(user_id=user_id, freigabe_adresse=adresse))
        await s.commit()


# ---------------------------------------------------------------------------
# PUT .../ablage/ordner — anlegen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anlegen_ohne_ablage_kanal_ist_404(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=False
    )

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 404, antwort.text


@pytest.mark.asyncio
async def test_anlegen_ohne_mitgliedschaft_ist_403(client, session_factory, _auth_signer):
    token_owner, uid_owner = await _register(_auth_signer)
    token_fremd, _uid_fremd = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid_owner, mitglieder=(uid_owner,), ablage=True
    )
    # 404 vor 403: der Kanal existiert und ist ein Ablage-Kanal — der
    # Fremde ist nur kein Mitglied.

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token_fremd))

    assert antwort.status_code == 403, antwort.text


@pytest.mark.asyncio
async def test_anlegen_ohne_konto_laufwerk_ist_412(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 412, antwort.text
    assert antwort.json()["detail"] == "no account drive"


@pytest.mark.asyncio
async def test_anlegen_legt_zeile_an_und_gibt_204(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text
    async with session_factory() as s:
        zeile = await s.get(AblageKanalOrdner, cid)
    assert zeile is not None
    assert zeile.ersteller_id == uid


@pytest.mark.asyncio
async def test_anlegen_ist_idempotent_fuer_denselben_ersteller(
    client, session_factory, _auth_signer
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text


@pytest.mark.asyncio
async def test_anlegen_mit_fremder_ersteller_zeile_ist_409(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    _tb, uid_b = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid, uid_b), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid_b)

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 409, antwort.text


# ---------------------------------------------------------------------------
# GET .../ablage/ordner — Dateiliste
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_liste_ohne_ordner_kanal_ist_404(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=False
    )

    antwort = await client.get(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 404, antwort.text


@pytest.mark.asyncio
async def test_liste_sortiert_filtert_und_schneidet(
    client, session_factory, _auth_signer, monkeypatch
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _mock_liste(*, basis, ordner=None, **_rest):
        return ["3.puls", "10.puls", "x.txt", "2.puls"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mock_liste)

    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"nach": "2", "limit": 200}, headers=_auth(token)
    )

    assert antwort.status_code == 200, antwort.text
    assert antwort.json() == ["3.puls", "10.puls"]


@pytest.mark.asyncio
async def test_liste_ohne_nach_gibt_alle_puls_dateien_sortiert(
    client, session_factory, _auth_signer, monkeypatch
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _mock_liste(*, basis, ordner=None, **_rest):
        return ["10.puls", "2.puls", "nicht-passend.puls.bak"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mock_liste)

    antwort = await client.get(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 200, antwort.text
    assert antwort.json() == ["2.puls", "10.puls"]


# ---------------------------------------------------------------------------
# GET .../ablage/ordner/{name} — einzelne Datei
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_datei_route_lehnt_traversal_mit_422_ab(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    # Doppelt kodierter Schraegstrich: der ASGI-Transport dekodiert die
    # Anfrage-URL genau EINMAL, das Ergebnis ist ein einzelnes Pfadsegment
    # mit dem Literal ``..%2Fkey.puls`` — ein echtes ``../key.puls`` waere
    # bereits vom HTTP-Klienten selbst wegnormalisiert worden und haette die
    # Route nie erreicht. Beide Formen bestehen ``_DATEI_MUSTER`` nicht.
    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner/..%252Fkey.puls", headers=_auth(token)
    )

    assert antwort.status_code == 422, antwort.text


@pytest.mark.asyncio
async def test_datei_route_holt_ueber_ablage_abruf_antwort(
    client, session_factory, _auth_signer, monkeypatch
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    aufrufe: list[tuple[str, str]] = []

    from fastapi import Response

    async def _mock_antwort(basis, pfad):
        aufrufe.append((basis, pfad))
        return Response(content=b"chiffrat", media_type="application/octet-stream")

    monkeypatch.setattr(routen_mod, "ablage_abruf_antwort", _mock_antwort)

    antwort = await client.get(f"/channels/{cid}/ablage/ordner/7.puls", headers=_auth(token))

    assert antwort.status_code == 200, antwort.text
    assert antwort.content == b"chiffrat"
    assert aufrufe == [("https://wolke.example/x", f"kanaele/{cid}/7.puls")]


@pytest.mark.asyncio
async def test_ratenbegrenzer_greift_bei_liste_und_datei(
    client, session_factory, _auth_signer, monkeypatch
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)
    monkeypatch.setattr(ratelimit_mod, "check", lambda *_a, **_k: False)

    liste_antwort = await client.get(f"/channels/{cid}/ablage/ordner", headers=_auth(token))
    datei_antwort = await client.get(
        f"/channels/{cid}/ablage/ordner/1.puls", headers=_auth(token)
    )

    assert liste_antwort.status_code == 429, liste_antwort.text
    assert datei_antwort.status_code == 429, datei_antwort.text
