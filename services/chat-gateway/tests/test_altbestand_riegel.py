"""Der Start-Riegel gegen Daten aus der Pseudonym-Zeit.

Die Entscheidung „bestehende Server werden neu aufgesetzt" ist richtig, verlangt
aber eine Handlung, die niemand ausloest: Ein Self-Host zieht sein Update alle
fuenf Minuten unbeaufsichtigt. Ohne Riegel laeuft er danach still halb kaputt an.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from dcc_chat_gateway.altbestand_riegel import pruefe_altbestand


async def _mitglied(session_factory, kennung: str) -> None:
    async with session_factory() as s:
        await s.execute(
            text(
                "INSERT INTO instance_members (user_identifier, joined_at, joined_via) "
                "VALUES (:k, '2026-08-28 00:00:00', 'owner')"
            ).bindparams(k=kennung)
        )
        await s.commit()


@pytest.mark.asyncio
async def test_leerer_bestand_laesst_starten(session_factory):
    await pruefe_altbestand(session_factory)


@pytest.mark.asyncio
async def test_neue_kennungen_lassen_starten(session_factory):
    await _mitglied(session_factory, "73315227868860416")
    await pruefe_altbestand(session_factory)


@pytest.mark.asyncio
async def test_ein_pseudonym_haelt_den_start_an(session_factory):
    """Ein Base64url-Pseudonym aus der alten Zeit.

    Der Server MUSS hier stehenbleiben. Liefe er an, faenden seine Mitglieder
    keinen Zugang mehr und der Betreiber besaesse keine seiner Communities — und
    beides saehe nach einem Rechteproblem aus, nicht nach einem Datenstand.
    """
    await _mitglied(session_factory, "Zm9vYmFyYmF6cXV4")
    with pytest.raises(RuntimeError, match="vor dem Ticket-Weg"):
        await pruefe_altbestand(session_factory)


@pytest.mark.asyncio
async def test_die_meldung_nennt_den_handgriff(session_factory):
    """Ein Riegel ohne Handgriff ist eine Sackgasse — dieselbe Regel wie bei
    ``diagnose_texte``."""
    await _mitglied(session_factory, "Zm9vYmFyYmF6cXV4")
    with pytest.raises(RuntimeError) as e:
        await pruefe_altbestand(session_factory)
    text_ = str(e.value)
    assert "neu aufsetzen" in text_
    assert "self-host" in text_
    assert "Kopie der Datenbank" in text_, "der Betreiber muss seine Daten retten koennen"


@pytest.mark.asyncio
async def test_fehlende_tabelle_ist_kein_altbestand(session_factory):
    """Ein frischer Server hat die Tabelle womoeglich noch nicht — der Riegel
    darf ihn nicht aussperren."""

    class KaputteFactory:
        def __call__(self):
            raise RuntimeError("keine Tabelle")

    await pruefe_altbestand(KaputteFactory())
