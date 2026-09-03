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
from datetime import UTC, datetime

import pytest
from dcc_chat_gateway import ratelimit as ratelimit_mod
from dcc_chat_gateway.models import (
    AblageKanalLaufwerk,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    Channel,
    DmNutzlast,
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
            s.add(GuildMember(guild_id=gid, user_id=uid, joined_at=datetime.now(UTC)))
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
    """Nur der Nextcloud-Weg braucht ein Konto-Laufwerk — er legt dort
    Dateien ab. Die Gegenprobe (Pulse ohne Laufwerk) steht darunter."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )

    antwort = await client.put(
        f"/channels/{cid}/ablage/ordner",
        json={"speicher": "nextcloud"},
        headers=_auth(token),
    )

    assert antwort.status_code == 412, antwort.text
    assert antwort.json()["detail"] == "no account drive"


@pytest.mark.asyncio
async def test_anlegen_bei_pulse_braucht_kein_laufwerk(client, session_factory, _auth_signer):
    """Ein verschluesselter Kanal mit Bestand bei Pulse (Vorgabe seit dem
    2026-09-03) haengt an keiner fremden Cloud — ohne Konto-Laufwerk, ohne
    Rumpf."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text
    async with session_factory() as s:
        zeile = await s.get(AblageKanalOrdner, cid)
    assert zeile is not None
    assert zeile.speicher == "pulse"


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

    # ``_ordner_eintragen`` legt eine Nextcloud-Zeile an (Vorgabe der
    # Spalte) — dieselbe Angabe im Rumpf, sonst waere es ein Wechsel des
    # Speichers und damit ein 409 (Test darunter).
    antwort = await client.put(
        f"/channels/{cid}/ablage/ordner",
        json={"speicher": "nextcloud"},
        headers=_auth(token),
    )

    assert antwort.status_code == 204, antwort.text


@pytest.mark.asyncio
async def test_anlegen_mit_anderem_speicher_ist_409(client, session_factory, _auth_signer):
    """Derselbe Ersteller, anderer Speicher: ein 204 waere eine Luege — der
    Bestand laege danach weiter, wo er lag."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.put(
        f"/channels/{cid}/ablage/ordner", json={"speicher": "pulse"}, headers=_auth(token)
    )

    assert antwort.status_code == 409, antwort.text
    async with session_factory() as s:
        zeile = await s.get(AblageKanalOrdner, cid)
    assert zeile is not None and zeile.speicher == "nextcloud"


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


@pytest.mark.asyncio
async def test_anlegen_ohne_manage_channels_ist_403(client, session_factory, _auth_signer):
    """I11: das PUT entscheidet, in wessen Cloud-Laufwerk der dauerhafte
    Bestand dieses Kanals liegt — eine Kanal-Verwaltungsentscheidung. Ohne
    ``MANAGE_CHANNELS`` konnte sie bisher jedes einfache Mitglied treffen,
    solange noch niemand anders sie getroffen hatte."""
    _token_owner, uid_owner = await _register(_auth_signer)
    token_mitglied, uid_mitglied = await _register(_auth_signer)
    # @everyone traegt nur VIEW_CHANNEL (Vorgabe von ``_guild_mit_kanal``),
    # also kein MANAGE_CHANNELS fuer das gewoehnliche Mitglied.
    _gid, cid = await _guild_mit_kanal(
        session_factory,
        owner_id=uid_owner,
        mitglieder=(uid_owner, uid_mitglied),
        ablage=True,
    )
    await _laufwerk_eintragen(
        session_factory, user_id=uid_mitglied, adresse="https://wolke.example/m"
    )

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token_mitglied))

    assert antwort.status_code == 403, antwort.text
    async with session_factory() as s:
        assert await s.get(AblageKanalOrdner, cid) is None


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


@pytest.mark.asyncio
async def test_liste_limit_schneidet_wirklich(
    client, session_factory, _auth_signer, monkeypatch
):
    """``limit`` muss tatsaechlich abschneiden, nicht nur durchgereicht
    werden — der Mock liefert mehr Treffer, als ``limit`` erlaubt."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _mock_liste(*, basis, ordner=None, **_rest):
        return ["1.puls", "2.puls", "3.puls", "4.puls"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mock_liste)

    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"limit": 2}, headers=_auth(token)
    )

    assert antwort.status_code == 200, antwort.text
    assert antwort.json() == ["1.puls", "2.puls"]


@pytest.mark.asyncio
async def test_zweites_mitglied_ohne_eigenes_laufwerk_liest_ueber_die_adresse_des_erstellers(
    client, session_factory, _auth_signer, monkeypatch
):
    """Kern-Invariante: der Aufrufer der GET-Route ist NICHT der Ersteller
    und hat selbst gar kein Konto-Laufwerk — gelesen wird trotzdem, weil die
    Basis-Adresse aus der Ersteller-Zeile kommt, nie aus der des Aufrufers."""
    token_ersteller, uid_ersteller = await _register(_auth_signer)
    token_mitglied, uid_mitglied = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory,
        owner_id=uid_ersteller,
        mitglieder=(uid_ersteller, uid_mitglied),
        ablage=True,
    )
    await _laufwerk_eintragen(
        session_factory, user_id=uid_ersteller, adresse="https://wolke.example/ersteller"
    )
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid_ersteller)

    gesehene_basis: list[str] = []

    async def _mock_liste(*, basis, ordner=None, **_rest):
        gesehene_basis.append(basis)
        return ["1.puls"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mock_liste)

    liste_antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", headers=_auth(token_mitglied)
    )

    assert liste_antwort.status_code == 200, liste_antwort.text
    assert liste_antwort.json() == ["1.puls"]
    assert gesehene_basis == ["https://wolke.example/ersteller"]

    from fastapi import Response

    gesehene_abruf: list[tuple[str, str]] = []

    async def _mock_antwort(basis, pfad):
        gesehene_abruf.append((basis, pfad))
        return Response(content=b"chiffrat", media_type="application/octet-stream")

    monkeypatch.setattr(routen_mod, "ablage_abruf_antwort", _mock_antwort)

    datei_antwort = await client.get(
        f"/channels/{cid}/ablage/ordner/1.puls", headers=_auth(token_mitglied)
    )

    assert datei_antwort.status_code == 200, datei_antwort.text
    assert gesehene_abruf == [("https://wolke.example/ersteller", f"kanaele/{cid}/1.puls")]


@pytest.mark.asyncio
async def test_liste_ohne_konto_laufwerk_des_erstellers_ist_412(
    client, session_factory, _auth_signer
):
    """Der Ersteller hatte einmal ein Laufwerk (sonst gaebe es die
    Ordner-Zeile nicht), hat es aber inzwischen widerrufen — die Liste kann
    dann niemand mehr abrufen, auch der Ersteller selbst nicht."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.get(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 412, antwort.text
    assert antwort.json()["detail"] == "no account drive"


# ---------------------------------------------------------------------------
# GET .../ablage/ordner/{name} — einzelne Datei
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_datei_route_ohne_konto_laufwerk_des_erstellers_ist_412(
    client, session_factory, _auth_signer
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.get(f"/channels/{cid}/ablage/ordner/1.puls", headers=_auth(token))

    assert antwort.status_code == 412, antwort.text
    assert antwort.json()["detail"] == "no account drive"


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


@pytest.mark.asyncio
async def test_liste_mit_unlesbarem_cursor_ist_422(
    client, session_factory, _auth_signer, monkeypatch
):
    """C1: ein Cursor, der keine Nutzlast-ID ist, blendete frueher schlicht
    nichts aus. Der Klient bekam damit ewig dieselbe erste Seite — entweder
    eine Endlosschleife oder jede Nachricht doppelt, beides ohne eine
    einzige Fehlermeldung."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _mock_liste(*, basis, ordner=None, **_rest):
        return ["1.puls", "2.puls"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mock_liste)

    # Der Dateiname statt der ID ist der Fehler, der tatsaechlich passiert
    # ist (der Klient reichte den letzten NAMEN als Cursor weiter).
    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"nach": "2.puls"}, headers=_auth(token)
    )

    assert antwort.status_code == 422, antwort.text
    assert antwort.json()["detail"] == "invalid cursor"


@pytest.mark.asyncio
async def test_liste_mit_numerischem_cursor_schneidet_weiterhin(
    client, session_factory, _auth_signer, monkeypatch
):
    """Gegenprobe zum 422 oben: die ID als Cursor bleibt der gueltige Weg."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _mock_liste(*, basis, ordner=None, **_rest):
        return ["1.puls", "2.puls", "3.puls"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mock_liste)

    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"nach": "2"}, headers=_auth(token)
    )

    assert antwort.status_code == 200, antwort.text
    assert antwort.json() == ["3.puls"]


# ---------------------------------------------------------------------------
# R2 — die beiden Ablage-Wege schliessen einander aus
# ---------------------------------------------------------------------------


async def _kanal_laufwerk_eintragen(
    session_factory, *, channel_id: int, ersteller_id: int
) -> None:
    async with session_factory() as s:
        s.add(
            AblageKanalLaufwerk(
                channel_id=channel_id,
                ersteller_id=ersteller_id,
                freigabe_adresse="https://wolke.example/kanal",
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_ordner_anlegen_ist_409_wenn_der_kanal_ein_eigenes_laufwerk_hat(
    client, session_factory, _auth_signer
):
    """R2: ein Kanal liegt entweder an einer eigenen Freigabe-Adresse (der
    Google-/Dropbox-Weg) ODER als Ordner im Konto-Laufwerk seines Erstellers.
    Beides zugleich hiesse zwei Bestaende an zwei Orten, von denen keiner
    vollstaendig ist."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _kanal_laufwerk_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.put(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 409, antwort.text
    async with session_factory() as s:
        assert await s.get(AblageKanalOrdner, cid) is None


@pytest.mark.asyncio
async def test_freigabe_adresse_setzen_ist_409_wenn_der_kanal_ein_ordner_kanal_ist(
    client, session_factory, _auth_signer
):
    """R2, die andere Richtung — dieselbe Begruendung."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.put(
        f"/channels/{cid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://wolke.example/kanal"},
        headers=_auth(token),
    )

    assert antwort.status_code == 409, antwort.text
    async with session_factory() as s:
        assert await s.get(AblageKanalLaufwerk, cid) is None


# ---------------------------------------------------------------------------
# R7 — Cursor einmal vorab, Dateiname strikt
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unlesbarer_cursor_ist_auch_bei_leerem_ordner_422(
    client, session_factory, _auth_signer, monkeypatch
):
    """R7: der Cursor wurde in der Filter-Schleife geparst — bei einem LEEREN
    Ordner lief sie gar nicht durch, und derselbe kaputte Cursor kam als 200
    mit leerer Liste zurueck. Genau die stumme Sackgasse, gegen die die 422
    gebaut ist."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _leer(*, basis, ordner=None, **_rest):
        return []

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _leer)

    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"nach": "2.puls"}, headers=_auth(token)
    )

    assert antwort.status_code == 422, antwort.text
    assert antwort.json()["detail"] == "invalid cursor"


@pytest.mark.asyncio
async def test_dateiname_mit_zeilenumbruch_faellt_aus_liste_und_route(
    client, session_factory, _auth_signer, monkeypatch
):
    """R7: ``re.match`` mit ``$`` traf auch VOR einem abschliessenden
    Zeilenumbruch — ``12.puls\\n`` haette den Filter bestanden und waere als
    Pfadsegment an die fremde Cloud gegangen. ``fullmatch`` schliesst das aus,
    an BEIDEN Stellen."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _laufwerk_eintragen(session_factory, user_id=uid, adresse="https://wolke.example/x")
    await _ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    async def _mit_umbruch(*, basis, ordner=None, **_rest):
        return ["12.puls\n", "13.puls"]

    monkeypatch.setattr(routen_mod, "liste_vom_laufwerk", _mit_umbruch)

    liste = await client.get(f"/channels/{cid}/ablage/ordner", headers=_auth(token))
    assert liste.status_code == 200, liste.text
    assert liste.json() == ["13.puls"]

    datei = await client.get(
        f"/channels/{cid}/ablage/ordner/12.puls%0A", headers=_auth(token)
    )
    assert datei.status_code == 422, datei.text


@pytest.mark.asyncio
async def test_freigabe_adresse_setzen_ohne_manage_channels_ist_403(
    client, session_factory, _auth_signer
):
    """Der Freigabe-Link-Weg (``PUT .../ablage/laufwerk``) bindet den Bestand
    genauso an ein Laufwerk wie der Ordner-Weg — bis zum 2026-09-03 verlangte
    nur der Ordner-Weg ``MANAGE_CHANNELS``, der Kommentar in
    ``KanalDateiablageVerbinden.svelte`` behauptete es fuer beide."""
    _token_owner, uid_owner = await _register(_auth_signer)
    token_mitglied, uid_mitglied = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory,
        owner_id=uid_owner,
        mitglieder=(uid_owner, uid_mitglied),
        ablage=True,
    )

    antwort = await client.put(
        f"/channels/{cid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://wolke.example/m"},
        headers=_auth(token_mitglied),
    )

    assert antwort.status_code == 403, antwort.text
    async with session_factory() as s:
        assert await s.get(AblageKanalLaufwerk, cid) is None


# ---------------------------------------------------------------------------
# Pulse-Speicher — dieselben zwei Leserouten, Bestand aus Postgres
# (Entscheidung 2026-09-03)
# ---------------------------------------------------------------------------


async def _pulse_ordner_eintragen(session_factory, *, channel_id: int, ersteller_id: int) -> None:
    async with session_factory() as s:
        s.add(
            AblageKanalOrdner(
                channel_id=channel_id, ersteller_id=ersteller_id, speicher="pulse"
            )
        )
        await s.commit()


async def _nutzlast_seeden(
    session_factory, *, channel_id: int, archiv: bool = True, absender_id: int = 1
) -> int:
    nid = next_id()
    async with session_factory() as s:
        s.add(
            DmNutzlast(
                id=nid,
                channel_id=channel_id,
                absender_device_pubkey=f"geraet-{nid}",
                absender_user_id=absender_id,
                art=1,
                daten="Y2hpZmZyYXQ",
                groesse=7,
                archiv=archiv,
            )
        )
        await s.commit()
    return nid


@pytest.mark.asyncio
async def test_pulse_liste_gibt_die_archiv_zeilen_sortiert_und_ohne_laufwerk(
    client, session_factory, _auth_signer
):
    """Kein Konto-Laufwerk im Spiel (kein 412), keine fremde Cloud — und eine
    Nicht-Archiv-Zeile desselben Kanals gehoert NICHT dazu: sie ist Post an
    ein einzelnes Geraet, nicht Bestand."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _pulse_ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)
    erste = await _nutzlast_seeden(session_factory, channel_id=cid)
    zweite = await _nutzlast_seeden(session_factory, channel_id=cid)
    await _nutzlast_seeden(session_factory, channel_id=cid, archiv=False)

    antwort = await client.get(f"/channels/{cid}/ablage/ordner", headers=_auth(token))

    assert antwort.status_code == 200, antwort.text
    assert antwort.json() == [f"{erste}.puls", f"{zweite}.puls"]


@pytest.mark.asyncio
async def test_pulse_liste_schneidet_an_cursor_und_limit(
    client, session_factory, _auth_signer
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _pulse_ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)
    erste = await _nutzlast_seeden(session_factory, channel_id=cid)
    zweite = await _nutzlast_seeden(session_factory, channel_id=cid)
    dritte = await _nutzlast_seeden(session_factory, channel_id=cid)

    nach_erster = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"nach": str(erste)}, headers=_auth(token)
    )
    mit_limit = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"limit": 1}, headers=_auth(token)
    )

    assert nach_erster.json() == [f"{zweite}.puls", f"{dritte}.puls"]
    assert mit_limit.json() == [f"{erste}.puls"]


@pytest.mark.asyncio
async def test_pulse_liste_mit_unlesbarem_cursor_ist_422(
    client, session_factory, _auth_signer
):
    """Derselbe Fehlermodus wie im Nextcloud-Weg: ein Cursor, der keine
    Nutzlast-ID ist, darf nicht stumm dieselbe erste Seite liefern."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _pulse_ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)

    antwort = await client.get(
        f"/channels/{cid}/ablage/ordner", params={"nach": "7.puls"}, headers=_auth(token)
    )

    assert antwort.status_code == 422, antwort.text
    assert antwort.json()["detail"] == "invalid cursor"


@pytest.mark.asyncio
async def test_pulse_datei_liefert_den_umschlag_als_json(
    client, session_factory, _auth_signer
):
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _pulse_ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)
    nid = await _nutzlast_seeden(session_factory, channel_id=cid, absender_id=uid)

    antwort = await client.get(f"/channels/{cid}/ablage/ordner/{nid}.puls", headers=_auth(token))

    assert antwort.status_code == 200, antwort.text
    rumpf = antwort.json()
    # IDs als Strings ueber die Grenze, ``daten`` unveraendert — dieselbe
    # Form wie beim Abholen aus dem Postfach.
    assert rumpf["id"] == str(nid)
    assert rumpf["channel_id"] == str(cid)
    assert rumpf["daten"] == "Y2hpZmZyYXQ"


@pytest.mark.asyncio
async def test_pulse_datei_ist_404_bei_fremdem_kanal_und_ohne_archiv(
    client, session_factory, _auth_signer
):
    """Die Nutzlast-ID ist ratbar: Kanal UND ``archiv`` gehoeren beide zur
    Pruefung, sonst reichte diese Route Post aus fremden Gespraechen
    heraus."""
    token, uid = await _register(_auth_signer)
    _gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    _gid2, fremd_cid = await _guild_mit_kanal(
        session_factory, owner_id=uid, mitglieder=(uid,), ablage=True
    )
    await _pulse_ordner_eintragen(session_factory, channel_id=cid, ersteller_id=uid)
    ohne_archiv = await _nutzlast_seeden(session_factory, channel_id=cid, archiv=False)
    fremde = await _nutzlast_seeden(session_factory, channel_id=fremd_cid)

    a = await client.get(
        f"/channels/{cid}/ablage/ordner/{ohne_archiv}.puls", headers=_auth(token)
    )
    b = await client.get(f"/channels/{cid}/ablage/ordner/{fremde}.puls", headers=_auth(token))

    assert a.status_code == 404, a.text
    assert b.status_code == 404, b.text
