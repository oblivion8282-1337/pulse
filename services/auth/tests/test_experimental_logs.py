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
async def test_aufruf_ganz_ohne_inhalt_wird_abgelehnt(client):
    """Seit `log_text` optional ist, ist `{"reason": ...}` allein syntaktisch
    gueltig — und traegt nichts bei. Eine Zeile ohne Inhalt ist genau das, was
    die Aufbewahrungsgrenzen sonst mit echten Berichten verdraengt."""
    r = await client.post("/experimental-logs", json={"reason": "stream_end"})
    assert r.status_code == 422


# --------------------------------------------------------------------------
# Der strukturierte Bericht (seit 2026-08-06)
# --------------------------------------------------------------------------


def _bericht(**ueberschreibungen) -> dict:
    grund = {
        "kopf": {"rolle": "viewer", "codec": "AV1", "aufloesung": "1920x1080", "fps": 60},
        "bilanz": {"dauer_s": 42.0, "bilder_gesamt": 2500, "bilder_ausgelassen": 3},
        "ereignisse": [{"s": 12.5, "art": "einfrieren", "anzahl": 4, "werte": {"dauer_ms": 480}}],
        "abschluss": {"grund": "beendet"},
    }
    grund.update(ueberschreibungen)
    return grund


@pytest.mark.asyncio
async def test_bericht_wird_angenommen_und_gespeichert(client, session_factory):
    """Der Kern des neuen Wegs: ein Bericht OHNE `log_text` muss durchgehen und
    vollstaendig in der Spalte landen."""
    r = await client.post(
        "/experimental-logs",
        json={
            "reason": "stream_end",
            "role": "viewer",
            "channel_id": "57540999622172672",
            "report": _bericht(),
        },
    )
    assert r.status_code == 201

    async with session_factory() as s:
        eintrag = (await s.execute(select(ExperimentalLog))).scalars().one()
    assert eintrag.log_text is None, "ein Zuschauerbericht hat keine sidecar.log"
    assert eintrag.role == "viewer"
    assert eintrag.channel_id == "57540999622172672", "der Schluessel zur Serversicht muss suchbar sein"
    assert eintrag.report is not None
    assert eintrag.report["ereignisse"][0]["art"] == "einfrieren"
    assert eintrag.report["ereignisse"][0]["anzahl"] == 4


@pytest.mark.asyncio
async def test_verworfene_ereignisse_werden_uebernommen(client, session_factory):
    """Die Kappung MUSS im Bericht stehen. Eine still gekappte Liste liest sich
    spaeter wie "danach war nichts mehr" — also wie eine beruhigte Verbindung,
    genau im Moment des groessten Aergers."""
    r = await client.post(
        "/experimental-logs",
        json={"role": "viewer", "report": _bericht(ereignisse_verworfen=137)},
    )
    assert r.status_code == 201

    async with session_factory() as s:
        eintrag = (await s.execute(select(ExperimentalLog))).scalars().one()
    assert eintrag.report["ereignisse_verworfen"] == 137


@pytest.mark.asyncio
async def test_fehlender_zaehler_ist_null_nicht_unbekannt(client, session_factory):
    """Gegenprobe zum Test darueber: ein Bericht OHNE das Feld muss als "nichts
    verworfen" ankommen, nicht als fehlender Wert. Sonst waere in der Auswertung
    nicht unterscheidbar, ob nichts gekappt wurde oder ob ein alter Client
    nichts dazu sagt."""
    r = await client.post("/experimental-logs", json={"role": "viewer", "report": _bericht()})
    assert r.status_code == 201

    async with session_factory() as s:
        eintrag = (await s.execute(select(ExperimentalLog))).scalars().one()
    assert eintrag.report["ereignisse_verworfen"] == 0


@pytest.mark.asyncio
async def test_zu_viele_ereignisse_werden_abgelehnt(client):
    """Die zweite Verteidigungslinie. Der Client deckelt selbst, aber der
    Endpoint ist offen und darf sich darauf nicht verlassen."""
    zuviel = [{"s": float(i), "art": "einfrieren"} for i in range(rel.MAX_EVENTS + 1)]
    r = await client.post(
        "/experimental-logs",
        json={"role": "viewer", "report": _bericht(ereignisse=zuviel)},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_deckel_wird_nicht_zu_frueh_ausgeloest(client):
    """Gegenprobe: genau am Deckel muss es noch durchgehen. Ohne diesen Test
    wuerde ein Off-by-one den ganzen Bericht verwerfen, und zwar lautlos —
    422 sieht der Nutzer nie."""
    grade_noch = [{"s": float(i), "art": "einfrieren"} for i in range(rel.MAX_EVENTS)]
    r = await client.post(
        "/experimental-logs",
        json={"role": "viewer", "report": _bericht(ereignisse=grade_noch)},
    )
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_unbekannte_felder_verwerfen_den_bericht_nicht(client, session_factory):
    """`extra="ignore"`. Bestandsclients erneuern sich nur ueber den
    Auto-Updater — ein neuerer Client, der ein Feld mehr schickt, darf nicht mit
    422 abgewiesen werden. Das Unbekannte fliegt raus, der Rest kommt an."""
    r = await client.post(
        "/experimental-logs",
        json={
            "role": "viewer",
            "report": _bericht(
                ereignisse=[{"s": 1.0, "art": "einfrieren", "was_ganz_neues": 5}],
                noch_ein_neues_feld={"x": 1},
            ),
        },
    )
    assert r.status_code == 201

    async with session_factory() as s:
        eintrag = (await s.execute(select(ExperimentalLog))).scalars().one()
    assert "noch_ein_neues_feld" not in eintrag.report
    assert eintrag.report["ereignisse"][0]["art"] == "einfrieren"


@pytest.mark.asyncio
async def test_bericht_und_rohtext_gemeinsam(client, session_factory):
    """Die Senderseite darf beides schicken: den Bericht als Hauptweg und den
    Rohtext als Auffangnetz fuer das, was kein Schema vorhersieht."""
    r = await client.post(
        "/experimental-logs",
        json={
            "role": "sender",
            "sidecar_version": "0.4.2",
            "report": _bericht(),
            "log_text": "ffmpeg: irgendwas Unerwartetes",
        },
    )
    assert r.status_code == 201

    async with session_factory() as s:
        eintrag = (await s.execute(select(ExperimentalLog))).scalars().one()
    assert eintrag.role == "sender"
    assert eintrag.sidecar_version == "0.4.2", "das Feld war bis 2026-08-06 immer NULL"
    assert eintrag.report is not None
    assert eintrag.log_text is not None


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
