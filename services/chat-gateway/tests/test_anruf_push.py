"""Wann klingelt wessen Telefon — der Teil, der leicht falsch ist.

Der Kern dieser Datei ist EIN Befund: der Offline-Check der Pushs hing an
``SOCKET_STALE_SEKUNDEN`` (95 s), ein Anruf klingelt aber nur 45 s. Mit dieser
Vorgabe gilt ein im Hintergrund suspendiertes Telefon die ganze Klingelzeit
als online, der VoIP-Push bleibt aus, und der Anruf ist verpasst, ohne dass
irgendwo etwas schiefgeht. Der Anruf-Pfad fragt deshalb mit dem engeren
Fenster (``anruf_push.ANRUF_FRISCHE_S``) — und genau DAS halten die Tests
hier fest, weil diese Klasse Fehler in diesem Projekt schon mehrfach Tage
gekostet hat: es wird nichts rot.
"""

from __future__ import annotations

import pytest

from dcc_chat_gateway import anruf_push
from dcc_chat_gateway.pubsub import ConnectionManager


class Mitschnitt:
    """Ein Manager, der sich nur merkt, mit welchem Fenster gefragt wurde."""

    def __init__(self, antwort: int = 1) -> None:
        self.fenster: list[float | None] = []
        self.antwort = antwort

    def user_socket_count(self, user_id: int, frische_s: float | None = None) -> int:
        self.fenster.append(frische_s)
        return self.antwort


def test_offline_check_fragt_mit_dem_engeren_fenster():
    """DIE Zusicherung dieser Datei: nicht die Vorgabe (95 s), sondern das enge
    Fenster. Der erste Anlauf prüfte das über ``fan_out_klingeln`` und war
    wirkungslos — der Fan-out bricht ohne APNs-Schlüssel vorher ab, der
    Manager wurde nie gefragt, und der Test wäre grün geblieben, egal welches
    Fenster im Code steht."""
    manager = Mitschnitt(antwort=1)  # „online"
    assert anruf_push.offline_empfaenger({7}, manager) == set()
    assert manager.fenster == [anruf_push.ANRUF_FRISCHE_S]


def test_ohne_manager_gilt_jeder_als_offline():
    """Lieber ein Push zu viel als ein verpasster Anruf — dieselbe Richtung
    wie im FCM-Weg."""
    assert anruf_push.offline_empfaenger({7, 8}, None) == {7, 8}


def test_stille_sockets_bekommen_den_push():
    manager = Mitschnitt(antwort=0)  # keine frische Verbindung
    assert anruf_push.offline_empfaenger({7, 8}, manager) == {7, 8}


def test_das_enge_fenster_liegt_unter_der_klingelzeit():
    """45 s klingelt es (KLINGEL_TIMEOUT_MS im Klienten). Läge die Schwelle
    darüber, wäre der Push-Weg wirkungslos — er entschiede erst, wenn der
    Anruf schon vorbei ist."""
    assert anruf_push.ANRUF_FRISCHE_S < 45.0
    # Und über einem Ping-Abstand (25 s), sonst würde ein einzelner
    # ausgefallener Ping einen lebendigen Socket für tot erklären und ein
    # doppeltes Klingeln auslösen.
    assert anruf_push.ANRUF_FRISCHE_S > 25.0


def test_die_vorgabe_des_managers_ist_weiter_als_die_klingelzeit():
    """Der Beleg für den Befund selbst: mit der Vorgabe wäre der Push-Weg im
    Anruf-Fall blind. Fällt dieser Test, weil jemand die Vorgabe gesenkt hat,
    gehört die Sonderbehandlung hier überprüft — nicht dieser Test angepasst."""
    assert ConnectionManager.SOCKET_STALE_SEKUNDEN > 45.0


@pytest.mark.asyncio
async def test_abbruch_prueft_NICHT_auf_offline():
    """Wer das Klingeln per Push bekam, muss den Abbruch bekommen — auch wenn
    seine WebSocket zwischenzeitlich aufgewacht ist. Ein überzähliger
    Abbruch-Push beendet einen Anruf, den es nicht mehr gibt; ein fehlender
    lässt CallKit weiter klingeln."""
    manager = Mitschnitt(antwort=1)
    await anruf_push.fan_out_abbruch(empfaenger_ids={7}, call_id="1", manager=manager)
    assert manager.fenster == []


@pytest.mark.asyncio
async def test_ohne_apns_schluessel_passiert_nichts_und_nichts_fliegt():
    """Fail-open ist die Zusage: eine Installation ohne APNs-Schlüssel ruft
    weiter über die WebSocket, und zwar ohne Ausnahme im Anruf-Pfad."""
    manager = Mitschnitt(antwort=0)  # offline → würde senden wollen
    gesendet = await anruf_push.fan_out_klingeln(
        empfaenger_ids={7},
        call_id="1",
        art="audio",
        channel_id="2",
        einleiter_id="3",
        einleiter_name="Michael",
        manager=manager,
    )
    assert gesendet == 0


@pytest.mark.asyncio
async def test_leere_empfaengermenge_fragt_gar_nicht_erst():
    manager = Mitschnitt()
    gesendet = await anruf_push.fan_out_klingeln(
        empfaenger_ids=set(),
        call_id="1",
        art="audio",
        channel_id="2",
        einleiter_id="3",
        einleiter_name="M",
        manager=manager,
    )
    assert gesendet == 0
    assert manager.fenster == []
