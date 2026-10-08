"""UDP-Gateway: Grenze gleichzeitiger Flows (Security-Scan 2026-10-08).

Vorher startete jede TCP-Verbindung zwei Threads, ohne Obergrenze. Der Test
fährt den echten Annahme-Pfad (`serve`) mit kleiner Grenze und prüft, dass die
Verbindung über der Grenze sofort geschlossen wird und ein frei gewordener
Platz wieder angenommen wird — und dass ein angenommener Flow wirklich UDP
zustellt (sonst bewiese die Grenze nichts über den Normalbetrieb).
"""

from __future__ import annotations

import importlib.util
import pathlib
import socket
import struct
import threading
import time

SKRIPT = (
    pathlib.Path(__file__).resolve().parents[1]
    / "s6/etc/s6-overlay/scripts/udp-gateway.py"
)


def _lade():
    spec = importlib.util.spec_from_file_location("udp_gateway", SKRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # main() läuft nur unter __main__
    return mod


def _server(mod, max_flows):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(16)
    threading.Thread(target=mod.serve, args=(srv, max_flows), daemon=True).start()
    return srv.getsockname()[1]


def _ist_geschlossen(conn: socket.socket) -> bool:
    conn.settimeout(1.0)
    try:
        return conn.recv(1) == b""
    except TimeoutError:
        return False
    except ConnectionResetError:
        return True


def test_flow_stellt_udp_zu():
    mod = _lade()
    port = _server(mod, 4)
    ziel = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ziel.bind(("127.0.0.1", 0))
    ziel.settimeout(2.0)
    c = socket.create_connection(("127.0.0.1", port))
    c.sendall(struct.pack(">H", ziel.getsockname()[1]))
    c.sendall(struct.pack(">H", 5) + b"hallo")
    daten, _ = ziel.recvfrom(100)
    assert daten == b"hallo"
    c.close()
    ziel.close()


def test_verbindung_ueber_der_grenze_wird_geschlossen():
    mod = _lade()
    port = _server(mod, 2)
    offen = [socket.create_connection(("127.0.0.1", port)) for _ in range(2)]
    time.sleep(0.2)  # beide Flows angenommen
    dritte = socket.create_connection(("127.0.0.1", port))
    assert _ist_geschlossen(dritte), "dritte Verbindung trotz Grenze 2 angenommen"
    for c in offen:
        assert not _ist_geschlossen(c), "angenommener Flow wurde geschlossen"

    offen[0].close()  # Platz frei → Flow endet, Semaphore wird freigegeben
    time.sleep(0.3)
    vierte = socket.create_connection(("127.0.0.1", port))
    assert not _ist_geschlossen(vierte), "frei gewordener Platz nicht wiederverwendet"
    for c in (offen[1], dritte, vierte):
        c.close()
