"""Diagnose-Log-Upload: Annahme und Aufbewahrung.

Der Endpoint hatte bis 2026-08-06 keine Tests — und keine Aufbewahrungsfrist.
Beides gehoert zusammen: eine Loeschregel, die niemand prueft, ist genau die
Sorte Mechanik, die still ausfaellt und erst auffaellt, wenn die Platte voll
ist.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from dcc_auth import routes_experimental_logs as rel
from dcc_auth.models_experimental import ExperimentalLog


async def _anzahl(session_factory) -> int:
    async with session_factory() as s:
        return (
            await s.execute(select(func.count()).select_from(ExperimentalLog))
        ).scalar_one()


async def _texte(session_factory) -> set[str]:
    async with session_factory() as s:
        return set((await s.execute(select(ExperimentalLog.log_text))).scalars().all())


async def _einfuegen(session_factory, ident: int, text: str, tage_alt: float) -> None:
    async with session_factory() as s:
        s.add(
            ExperimentalLog(
                id=ident,
                reason='stream_end',
                log_text=text,
                created_at=datetime.now(timezone.utc) - timedelta(days=tage_alt),
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_upload_wird_angenommen(client):
    r = await client.post(
        "/experimental-logs",
        json={"reason": "error", "log_text": "irgendein Protokoll"},
    )
    assert r.status_code == 201
    assert r.json()["status"] == "received"


@pytest.mark.asyncio
async def test_leerer_text_wird_abgelehnt(client):
    """`min_length=1` — ein leerer Bericht traegt nichts bei und soll nicht
    einmal Platz kosten."""
    r = await client.post("/experimental-logs", json={"log_text": ""})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_zu_langer_text_wird_abgelehnt(client):
    r = await client.post(
        "/experimental-logs",
        json={"log_text": "x" * (rel.MAX_LOG_CHARS + 1)},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_alte_berichte_werden_beim_schreiben_entfernt(client, session_factory):
    """Die Frist. Ein Eintrag jenseits von `RETENTION_DAYS` muss beim naechsten
    Upload verschwinden — der Schreibpfad raeumt auf, nicht ein Zeitgeber."""
    await _einfuegen(session_factory, 1, "uralt", rel.RETENTION_DAYS + 1)
    assert await _anzahl(session_factory) == 1

    r = await client.post("/experimental-logs", json={"log_text": "frisch"})
    assert r.status_code == 201

    assert await _texte(session_factory) == {"frisch"}, "der alte Bericht haette weg sein muessen"


@pytest.mark.asyncio
async def test_junge_berichte_bleiben(client, session_factory):
    """Die Gegenprobe. Ohne sie wuerde ein Aufraeumen, das ALLES loescht, als
    bestanden durchgehen — der Test oben allein kann das nicht unterscheiden."""
    await _einfuegen(session_factory, 2, "von gestern", 1)

    r = await client.post("/experimental-logs", json={"log_text": "frisch"})
    assert r.status_code == 201

    assert await _texte(session_factory) == {"von gestern", "frisch"}


@pytest.mark.asyncio
async def test_zeilenzahl_wird_gedeckelt(client, session_factory, monkeypatch):
    """Die zweite Grenze, die die Frist nicht abdeckt: viele Berichte in kurzer
    Zeit. `MAX_ROWS` wird fuer den Test klein gesetzt, damit er nicht 5000
    Eintraege schreiben muss."""
    monkeypatch.setattr(rel, "MAX_ROWS", 3)

    for i in range(5):
        r = await client.post("/experimental-logs", json={"log_text": f"bericht {i}"})
        assert r.status_code == 201

    assert await _anzahl(session_factory) == 3

    # Und es muessen die JUENGSTEN drei sein, nicht irgendwelche drei.
    assert await _texte(session_factory) == {"bericht 2", "bericht 3", "bericht 4"}
