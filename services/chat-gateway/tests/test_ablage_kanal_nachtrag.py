"""Der Nachtrag-Sweep — Wiederholung mit Abstand (Entwurf 2026-09-02 §3,
Fixwelle 2 R4).

Reine Modultests wie beim Ableger nebenan (``test_ablage_kanal_ordner.py``):
kein HTTP-Client, direkter Zugriff ueber ``session_factory``. Die Helfer sind
von dort **kopiert, nicht importiert** — Testmodule laufen unter
``--import-mode=importlib`` und sind untereinander nicht verlaesslich
importierbar.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from dcc_chat_gateway import ablage_kanal_nachtrag as nachtrag_mod
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


async def _nachtrag_eintragen(
    session_factory, *, nutzlast_id: int, channel_id: int, **felder
) -> None:
    async with session_factory() as s:
        s.add(
            AblageKanalNachtrag(nutzlast_id=nutzlast_id, channel_id=channel_id, **felder)
        )
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
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    assert (erledigt, aufgegeben) == (1, 0)
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
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    assert (erledigt, aufgegeben) == (0, 0)
    async with session_factory() as s:
        zeile = await s.get(AblageKanalNachtrag, nutzlast.id)
        assert zeile is not None
        # R4: der Fehlversuch ist gezaehlt und der naechste Termin geschoben.
        assert zeile.versuche == 1


@pytest.mark.asyncio
async def test_nachtrag_ohne_ordner_zeile_wird_aufgegeben(session_factory, mock_laufwerk):
    """I6: der Kanal ist kein Ordner-Kanal mehr — dieser Nachtrag kann nie
    mehr gelingen. Ohne das Aufgeben belegte er in JEDEM Lauf einen Platz im
    Stapel von 100 und hungerte die uebrigen aus."""
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=4242)
    async with session_factory() as s:
        s.add(AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=4242))
        await s.commit()

    async with session_factory() as s:
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    assert (erledigt, aufgegeben) == (0, 1)
    assert mock_laufwerk.schreiben_calls == []
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast.id) is None


@pytest.mark.asyncio
async def test_nachtrag_ohne_konto_laufwerk_des_erstellers_wird_aufgegeben(
    session_factory, mock_laufwerk
):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=4343)
    await _ordner_eintragen(session_factory, channel_id=4343, ersteller_id=99)
    async with session_factory() as s:
        s.add(AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=4343))
        await s.commit()

    async with session_factory() as s:
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    assert (erledigt, aufgegeben) == (0, 1)
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast.id) is None


@pytest.mark.asyncio
async def test_nachtrag_sweep_nimmt_hoechstens_hundert_zeilen(
    session_factory, mock_laufwerk, monkeypatch
):
    """I6: der Stapel ist gedeckelt. Gegen die Grenze selbst geprueft
    (``nachtrag_mod._NACHTRAG_BATCH``), nicht gegen die Zahl 100 im Test — sonst
    behauptete der Test einen Wert, den er selbst gesetzt hat."""
    monkeypatch.setattr(nachtrag_mod, "_NACHTRAG_BATCH", 3)
    await _ordner_eintragen(session_factory, channel_id=4444, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    for _ in range(5):
        nutzlast = await _nutzlast_anlegen(session_factory, channel_id=4444)
        async with session_factory() as s:
            s.add(AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=4444))
            await s.commit()

    async with session_factory() as s:
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    assert (erledigt, aufgegeben) == (3, 0)
    assert len(mock_laufwerk.schreiben_calls) == 3


# ---------------------------------------------------------------------------
# R4 — Wiederholung mit Abstand, Aufgeben, Laufwerk-Ueberspringen, try je Zeile
# ---------------------------------------------------------------------------


def test_backoff_verdoppelt_und_deckelt():
    """Die reine Rechnung, ohne Datenbank. Gegen den Deckel selbst geprueft,
    nicht gegen die Zahl 1440 im Test."""
    assert nachtrag_mod.backoff_minuten(1) == 2
    assert nachtrag_mod.backoff_minuten(2) == 4
    assert nachtrag_mod.backoff_minuten(10) == 1024
    assert nachtrag_mod.backoff_minuten(11) == nachtrag_mod._BACKOFF_DECKEL_MINUTEN
    assert nachtrag_mod.backoff_minuten(60) == nachtrag_mod._BACKOFF_DECKEL_MINUTEN


@pytest.mark.asyncio
async def test_noch_nicht_faellige_zeile_wird_nicht_angefasst(session_factory, mock_laufwerk):
    """Der Kern des Abstands: eine Zeile, deren Termin in der Zukunft liegt,
    kommt im naechsten Takt gar nicht erst an die Reihe — sonst liefe eine
    unerreichbare Cloud in JEDER Runde erneut in ihre Zeitueberschreitung."""
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=5151)
    await _ordner_eintragen(session_factory, channel_id=5151, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    await _nachtrag_eintragen(
        session_factory,
        nutzlast_id=nutzlast.id,
        channel_id=5151,
        versuche=1,
        naechster_versuch_at=datetime.now(UTC) + timedelta(hours=1),
    )

    async with session_factory() as s:
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    assert (erledigt, aufgegeben) == (0, 0)
    assert mock_laufwerk.schreiben_calls == []
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast.id) is not None


@pytest.mark.asyncio
async def test_fehlversuch_schiebt_den_termin_um_den_backoff(session_factory, monkeypatch):
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=5252)
    await _ordner_eintragen(session_factory, channel_id=5252, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    await _nachtrag_eintragen(
        session_factory,
        nutzlast_id=nutzlast.id,
        channel_id=5252,
        versuche=3,
        naechster_versuch_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    kaputt = _LaufwerkMock(fehler="upstream_nicht_erreichbar")
    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", kaputt.ordner_anlegen)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", kaputt.schreibe)

    vorher = datetime.now(UTC)
    async with session_factory() as s:
        assert await nachtrag_mod.nachtrag_sweep(s) == (0, 0)

    async with session_factory() as s:
        zeile = await s.get(AblageKanalNachtrag, nutzlast.id)
    assert zeile.versuche == 4
    # Der Termin liegt mindestens den frisch berechneten Abstand voraus. Gegen
    # die Funktion geprueft, nicht gegen die Zahl 16.
    abstand = timedelta(minutes=nachtrag_mod.backoff_minuten(4))
    assert zeile.naechster_versuch_at.replace(tzinfo=UTC) >= vorher + abstand - timedelta(
        seconds=5
    )


@pytest.mark.asyncio
async def test_letzter_versuch_gibt_die_zeile_auf(session_factory, monkeypatch):
    """Ohne Obergrenze bliebe eine Zeile, deren Cloud nie zurueckkommt, fuer
    immer stehen — und hielte ueber den Nachtrag-Riegel auch die quittierte
    Nutzlast am Leben."""
    nutzlast = await _nutzlast_anlegen(session_factory, channel_id=5353)
    await _ordner_eintragen(session_factory, channel_id=5353, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    await _nachtrag_eintragen(
        session_factory,
        nutzlast_id=nutzlast.id,
        channel_id=5353,
        versuche=nachtrag_mod._MAX_VERSUCHE - 1,
        naechster_versuch_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    kaputt = _LaufwerkMock(fehler="upstream_nicht_erreichbar")
    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", kaputt.ordner_anlegen)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", kaputt.schreibe)

    async with session_factory() as s:
        assert await nachtrag_mod.nachtrag_sweep(s) == (0, 1)

    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, nutzlast.id) is None


@pytest.mark.asyncio
async def test_stummes_laufwerk_wird_im_selben_lauf_uebersprungen(
    session_factory, monkeypatch
):
    """Antwortet ein Laufwerk einmal nicht, antwortet es auch bei der
    naechsten Zeile nicht — es sind dieselbe Gegenstelle und dieselben
    Sekunden. Genau EIN Schreibversuch je Laufwerk und Lauf."""
    await _ordner_eintragen(session_factory, channel_id=5454, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    ids = []
    for _ in range(3):
        nutzlast = await _nutzlast_anlegen(session_factory, channel_id=5454)
        ids.append(nutzlast.id)
        await _nachtrag_eintragen(
            session_factory, nutzlast_id=nutzlast.id, channel_id=5454
        )

    versuche: list[str] = []

    async def _kaputt(*, basis, pfad, **_rest):
        versuche.append(pfad)
        raise AblageAbrufFehler("upstream_nicht_erreichbar")

    monkeypatch.setattr(ordner_mod, "ordner_anlegen_am_laufwerk", _kaputt)
    monkeypatch.setattr(ordner_mod, "schreibe_aufs_laufwerk", _kaputt)

    async with session_factory() as s:
        assert await nachtrag_mod.nachtrag_sweep(s) == (0, 0)

    assert len(versuche) == 1
    async with session_factory() as s:
        gezaehlt = [(await s.get(AblageKanalNachtrag, i)).versuche for i in ids]
    # Nur die eine tatsaechlich versuchte Zeile zaehlt einen Fehlversuch; die
    # uebersprungenen bleiben unangetastet und sind im naechsten Takt dran.
    assert sorted(gezaehlt) == [0, 0, 1]


@pytest.mark.asyncio
async def test_unerwarteter_fehler_einer_zeile_stoppt_den_lauf_nicht(
    session_factory, mock_laufwerk, monkeypatch
):
    """Vorher riss ein Programmfehler in Zeile 1 jede Zeile dahinter mit —
    und zwar in JEDEM Takt aufs Neue, weil dieselbe Zeile dieselbe Stelle
    wieder als erste erreichte."""
    await _ordner_eintragen(session_factory, channel_id=5555, ersteller_id=9)
    await _laufwerk_eintragen(session_factory, user_id=9, adresse="https://wolke.example/9")
    erste = await _nutzlast_anlegen(session_factory, channel_id=5555)
    zweite = await _nutzlast_anlegen(session_factory, channel_id=5555)
    await _nachtrag_eintragen(
        session_factory,
        nutzlast_id=erste.id,
        channel_id=5555,
        naechster_versuch_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    await _nachtrag_eintragen(
        session_factory,
        nutzlast_id=zweite.id,
        channel_id=5555,
        naechster_versuch_at=datetime.now(UTC) - timedelta(minutes=5),
    )

    echt = ordner_mod.ablegen

    async def _erste_wirft(session, nutzlast):
        if nutzlast.id == erste.id:
            raise TypeError("kaputter Ableger")
        return await echt(session, nutzlast)

    monkeypatch.setattr(ordner_mod, "ablegen", _erste_wirft)

    async with session_factory() as s:
        erledigt, aufgegeben = await nachtrag_mod.nachtrag_sweep(s)

    # Die zweite Zeile ist trotzdem durchgelaufen.
    assert (erledigt, aufgegeben) == (1, 0)
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, zweite.id) is None
        assert await s.get(AblageKanalNachtrag, erste.id) is not None
