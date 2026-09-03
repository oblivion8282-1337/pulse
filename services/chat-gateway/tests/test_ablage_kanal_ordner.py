"""Der Ableger — ein Postfach-Umschlag landet als Datei im Kanal-Ordner
seines Erstellers (Entwurf 2026-09-02, §2-3).

Reine Modultests: kein HTTP-Client, direkter Zugriff ueber
``session_factory`` — die Route (Task 4) ruft ``ablegen`` nur noch auf.
"""

from __future__ import annotations

import json

import pytest
from dcc_chat_gateway import ablage_kanal_ordner as ordner_mod
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    DmNutzlast,
)
from dcc_chat_gateway.postfach_pflege import sweep_verwaiste_nutzlasten
from dcc_chat_gateway.snowflake import next_id


async def _nutzlast_anlegen(
    session_factory, *, channel_id: int, absender_user_id: int = 1
) -> DmNutzlast:
    nutzlast = DmNutzlast(
        id=next_id(),
        channel_id=channel_id,
        absender_device_pubkey="geraet-a",
        absender_curve25519="curve-a",
        absender_user_id=absender_user_id,
        art=1,
        daten="ZGF0ZW4",  # b64("daten") ohne Polsterung
        groesse=5,
    )
    async with session_factory() as s:
        s.add(nutzlast)
        await s.commit()
        await s.refresh(nutzlast)
    return nutzlast


async def _ordner_eintragen(session_factory, *, channel_id: int, ersteller_id: int) -> None:
    async with session_factory() as s:
        s.add(AblageKanalOrdner(channel_id=channel_id, ersteller_id=ersteller_id))
        await s.commit()


async def _laufwerk_eintragen(session_factory, *, user_id: int, adresse: str) -> None:
    async with session_factory() as s:
        s.add(AblageKontoLaufwerk(user_id=user_id, freigabe_adresse=adresse))
        await s.commit()


class _LaufwerkMock:
    def __init__(self, *, fehler: str | None = None) -> None:
        self.ordner_anlegen_calls: list[tuple[str, str]] = []
        self.schreiben_calls: list[tuple[str, str, bytes]] = []
        self.fehler = fehler

    async def ordner_anlegen(self, *, basis, pfad, **_rest):
        if self.fehler:
            raise AblageAbrufFehler(self.fehler)
        self.ordner_anlegen_calls.append((basis, pfad))

    async def schreibe(self, *, basis, pfad, inhalt, **_rest):
        if self.fehler:
            raise AblageAbrufFehler(self.fehler)
        self.schreiben_calls.append((basis, pfad, inhalt))


@pytest.fixture
def mock_laufwerk(monkeypatch):
    m = _LaufwerkMock()
    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", m.ordner_anlegen)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", m.schreibe)
    return m


# ---------------------------------------------------------------------------
# Reine Rechnungen — kein DB-Zugriff
# ---------------------------------------------------------------------------


def test_ordner_pfad_und_datei_name():
    assert ordner_mod.ordner_pfad(42) == "kanaele/42"
    assert ordner_mod.datei_name(123) == "123.puls"


def test_datei_inhalt_traegt_ids_als_strings():
    nutzlast = DmNutzlast(
        id=9007199254740993,
        channel_id=555,
        absender_device_pubkey="geraet-a",
        absender_curve25519="curve-a",
        absender_user_id=777,
        art=1,
        daten="ZGF0ZW4",
        groesse=5,
    )
    inhalt = ordner_mod.datei_inhalt(nutzlast)
    geladen = json.loads(inhalt)
    assert geladen["id"] == "9007199254740993"
    assert geladen["channel_id"] == "555"
    assert geladen["absender_user_id"] == "777"
    assert geladen["daten"] == "ZGF0ZW4"
    assert geladen["art"] == 1
    assert geladen["groesse"] == 5


@pytest.mark.asyncio
async def test_datei_inhalt_traegt_created_at(session_factory):
    """Befund 2026-09-03: ohne dieses Feld setzt der Klient beim Nachziehen
    aus dem Ordner das LESEdatum statt des echten Sendedatums ein (Entwurf
    §2). ``DmNutzlast.created_at`` ist server-seitig gesetzt (``server_default``)
    — die Zeile muss deshalb aus der DB kommen, nicht bloss im Speicher
    konstruiert sein."""
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=555)
    inhalt = ordner_mod.datei_inhalt(nutzlast)
    geladen = json.loads(inhalt)
    assert geladen["created_at"] is not None
    # ISO-8601 mit Datumsanteil — kein Zeitstempel-Rateformat.
    assert geladen["created_at"].startswith(str(nutzlast.created_at.year))


# ---------------------------------------------------------------------------
# ablegen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ablegen_ohne_ordner_zeile_ist_false_und_schreibt_nichts(
    session_factory, mock_laufwerk
):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=1)
    async with session_factory() as s:
        ergebnis = await ordner_mod.ablegen(s, nutzlast)
    assert ergebnis is False
    assert mock_laufwerk.schreiben_calls == []
    assert mock_laufwerk.ordner_anlegen_calls == []


@pytest.mark.asyncio
async def test_ablegen_mit_ordner_und_laufwerk_legt_ordner_an_und_schreibt(
    session_factory, mock_laufwerk
):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=42, absender_user_id=1)
    await _ordner_eintragen(session_factory, channel_id=42, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")

    async with session_factory() as s:
        ergebnis = await ordner_mod.ablegen(s, nutzlast)

    assert ergebnis is True
    assert mock_laufwerk.ordner_anlegen_calls == [
        ("https://wolke.example/9", "kanaele/42")
    ]
    assert len(mock_laufwerk.schreiben_calls) == 1
    basis, pfad, inhalt = mock_laufwerk.schreiben_calls[0]
    assert basis == "https://wolke.example/9"
    assert pfad == f"kanaele/42/{nutzlast.id}.puls"
    assert json.loads(inhalt)["id"] == str(nutzlast.id)


@pytest.mark.asyncio
async def test_ablegen_ohne_laufwerk_wirft(session_factory, mock_laufwerk):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=42)
    await _ordner_eintragen(session_factory, channel_id=42, ersteller_id=9)

    async with session_factory() as s:
        with pytest.raises(AblageAbrufFehler) as exc:
            await ordner_mod.ablegen(s, nutzlast)
    assert exc.value.code == "kein_laufwerk"
    assert mock_laufwerk.schreiben_calls == []


@pytest.mark.asyncio
async def test_mkcol_laeuft_je_kanal_nur_einmal(session_factory, mock_laufwerk):
    """I8: der Ordner entsteht genau einmal; jedes weitere MKCOL waere eine
    Netzrunde zu einer fremden Cloud fuer eine Antwort, die feststeht."""
    await _ordner_eintragen(session_factory, channel_id=4545, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    erste = await _nutzlast_anlegen(session_factory, channel_id=4545)
    zweite = await _nutzlast_anlegen(session_factory, channel_id=4545)

    async with session_factory() as s:
        await ordner_mod.ablegen(s, erste)
        await ordner_mod.ablegen(s, zweite)

    assert mock_laufwerk.ordner_anlegen_calls == [("https://wolke.example/9", "kanaele/4545")]
    assert len(mock_laufwerk.schreiben_calls) == 2


@pytest.mark.asyncio
async def test_gescheitertes_mkcol_wird_nicht_als_erledigt_gemerkt(
    session_factory, monkeypatch
):
    """Der Zwischenspeicher darf sich nur einen ERFOLG merken — sonst waere
    ein einmaliger Ausfall der fremden Cloud gleichbedeutend damit, dass der
    Ordner in diesem Prozess nie mehr angelegt wird."""
    await _ordner_eintragen(session_factory, channel_id=4646, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=4646)

    kaputt = _LaufwerkMock(fehler="upstream_nicht_erreichbar")
    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", kaputt.ordner_anlegen)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", kaputt.schreibe)
    async with session_factory() as s:
        with pytest.raises(AblageAbrufFehler):
            await ordner_mod.ablegen(s, nutzlast)

    heil = _LaufwerkMock()
    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", heil.ordner_anlegen)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", heil.schreibe)
    async with session_factory() as s:
        assert await ordner_mod.ablegen(s, nutzlast) is True

    assert heil.ordner_anlegen_calls == [("https://wolke.example/9", "kanaele/4646")]


# ---------------------------------------------------------------------------
# Zusammenspiel mit der Postfach-Pflege (I5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_nutzlast_mit_nachtrag_ueberlebt_den_verwaisten_sweep(session_factory):
    """I5: eine quittierte Nutzlast hat keine Zustellung mehr und faellt
    normalerweise dem Verwaisten-Sweep zum Opfer. Steht ihre Festigung noch
    aus, waere das der endgueltige Verlust genau der Nachricht, die der
    Ordner-Kanal dauerhaft halten soll."""
    mit_nachtrag = await _nutzlast_anlegen(session_factory, channel_id=4747)
    ohne_nachtrag = await _nutzlast_anlegen(session_factory, channel_id=4747)
    async with session_factory() as s:
        s.add(AblageKanalNachtrag(nutzlast_id=mit_nachtrag.id, channel_id=4747))
        await s.commit()

    async with session_factory() as s:
        await sweep_verwaiste_nutzlasten(s)

    async with session_factory() as s:
        assert await s.get(DmNutzlast, mit_nachtrag.id) is not None
        # Gegenprobe: ohne Nachtrag greift der Sweep unveraendert.
        assert await s.get(DmNutzlast, ohne_nachtrag.id) is None
