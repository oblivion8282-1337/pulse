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


# ---------------------------------------------------------------------------
# nachtrag_sweep
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_nachtrag_sweep_schreibt_und_loescht(session_factory, mock_laufwerk):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=42)
    await _ordner_eintragen(session_factory, channel_id=42, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    async with session_factory() as s:
        s.add(AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=42))
        await s.commit()

    async with session_factory() as s:
        erledigt = await ordner_mod.nachtrag_sweep(s)

    assert erledigt == 1
    assert len(mock_laufwerk.schreiben_calls) == 1
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast.id) is None


@pytest.mark.asyncio
async def test_nachtrag_sweep_laesst_zeile_bei_fehler_stehen(session_factory, monkeypatch):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=42)
    await _ordner_eintragen(session_factory, channel_id=42, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    async with session_factory() as s:
        s.add(AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=42))
        await s.commit()

    kaputt = _LaufwerkMock(fehler="upstream_nicht_erreichbar")
    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", kaputt.ordner_anlegen)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", kaputt.schreibe)

    async with session_factory() as s:
        erledigt = await ordner_mod.nachtrag_sweep(s)

    assert erledigt == 0
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast.id) is not None
